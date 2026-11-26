import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ApiResponse, Transport, parseBody } from './transport.js';

export interface CliResult { code: number; stdout: string; stderr: string }

/** How to start the Flagsmith CLI on this machine: an executable plus leading arguments. */
interface CliCommand { command: string; prefix: string[] }
let resolved: CliCommand | null | undefined;

/**
 * Finds the Flagsmith CLI without going through a shell, so no argument is ever
 * interpreted by one. On Windows an npm install puts a `flagsmith.cmd` shim on
 * PATH, which Node cannot start directly. The shim only runs the index.js of the
 * package with node, so Verdict does the same.
 */
export function resolveFlagsmithCli(env: NodeJS.ProcessEnv = process.env): CliCommand | null {
  if (env.FLAGSMITH_CLI_PATH) return { command: env.FLAGSMITH_CLI_PATH, prefix: [] };
  if (process.platform !== 'win32') return { command: 'flagsmith', prefix: [] };
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'flagsmith.exe');
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
    if (fs.existsSync(path.join(dir, 'flagsmith.cmd'))) {
      const script = path.join(dir, 'node_modules', '@flagsmith', 'cli', 'index.js');
      if (fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
    }
  }
  return null;
}

function cliCommand(): CliCommand | null {
  if (resolved === undefined) resolved = resolveFlagsmithCli();
  return resolved;
}

/** Runs the Flagsmith CLI. Arguments are passed as an array, never through a shell. */
export function runFlagsmithCli(args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const cli = cliCommand();
    if (!cli) return resolve({ code: 127, stdout: '', stderr: 'The Flagsmith CLI was not found on PATH.' });
    const child = spawn(cli.command, [...cli.prefix, ...args], { env: env ?? process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/** True when the CLI is installed and logged in. */
export function cliAvailable(): boolean {
  const cli = cliCommand();
  if (!cli) return false;
  try {
    const r = spawnSync(cli.command, [...cli.prefix, 'auth', 'status', '--no-input'], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Sends requests through `flagsmith api`, so the credential stays inside the CLI
 * (OS keychain or OIDC) and Verdict never reads it.
 */
export class CliTransport implements Transport {
  readonly name = 'flagsmith-cli';

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const args = ['api', `api/v1/${path}`, '-X', method, '--include', '--no-input'];
    if (body !== undefined) args.push('--input', '-');
    const r = await runFlagsmithCli(args, body !== undefined ? JSON.stringify(body) : undefined);
    return parseCliApiOutput(r);
  }
}

/** Turns the output of `flagsmith api --include` into a status and a parsed body. */
export function parseCliApiOutput(r: CliResult): ApiResponse {
  const out = r.stdout.replace(/\r\n/g, '\n');
  // --include prints the status line and headers, a blank line, then the body.
  const m = out.match(/^HTTP\/[\d.]+\s+(\d{3})[^\n]*\n([\s\S]*?)(?:\n\n([\s\S]*))?$/);
  if (m) return { status: Number(m[1]), json: parseBody(m[3] ?? '') };
  // On an error status the CLI prints the response body and then
  // "Error: POST <url> returned 403 Forbidden" to stderr, and nothing to stdout.
  const err = r.stderr.replace(/\r\n/g, '\n');
  const statusInErr = err.match(/returned (\d{3})/);
  if (statusInErr) {
    const body = out.trim() || err.slice(0, Math.max(0, err.indexOf('Error:'))).trim();
    return { status: Number(statusInErr[1]), json: parseBody(body) };
  }
  if (r.code === 0) return { status: 200, json: parseBody(out) };
  return { status: 0, json: (r.stderr || out).trim().split('\n')[0] };
}

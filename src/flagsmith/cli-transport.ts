import { spawn, spawnSync } from 'node:child_process';
import { ApiResponse, Transport, parseBody } from './transport.js';

export interface CliResult { code: number; stdout: string; stderr: string }

/** Runs the Flagsmith CLI. Arguments are passed as an array, never through a shell. */
export function runFlagsmithCli(args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('flagsmith', args, { env: env ?? process.env, windowsHide: true });
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
  try {
    const r = spawnSync('flagsmith', ['auth', 'status', '--no-input'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
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
  // On an error status the CLI prints the body to stdout and "... returned 403 Forbidden" to stderr.
  const statusInErr = r.stderr.match(/returned (\d{3})/);
  if (statusInErr) return { status: Number(statusInErr[1]), json: parseBody(out) };
  if (r.code === 0) return { status: 200, json: parseBody(out) };
  return { status: 0, json: (r.stderr || out).trim().split('\n')[0] };
}

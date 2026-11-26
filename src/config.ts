import fs from 'node:fs';
import path from 'node:path';
import { FlagsmithClient } from './flagsmith/client.js';
import { CliTransport, cliAvailable } from './flagsmith/cli-transport.js';
import { HttpTransport } from './flagsmith/http-transport.js';
import { Transport } from './flagsmith/transport.js';

export interface GlobalOptions {
  environment?: string;
  envFile?: string;
  transport?: 'auto' | 'cli' | 'api-key';
  cwd?: string;
}

/** Reads KEY=value lines into process.env without overriding values that are already set. */
export function loadEnvFile(file: string): void {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** flagsmith.json is written by `flagsmith init` and holds the project and environment binding. */
function readCliBinding(cwd: string): { environment?: string } {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, 'flagsmith.json');
    if (fs.existsSync(file)) {
      try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        const environment = json.environment ?? json.environmentKey ?? json.environment_key ?? json.environmentID;
        return typeof environment === 'string' ? { environment } : {};
      } catch { return {}; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export class ConfigError extends Error {}

export function resolveEnvironmentKey(opts: GlobalOptions): string {
  const key = opts.environment ?? process.env.FLAGSMITH_ENVIRONMENT ?? process.env.FLAGSMITH_ENVIRONMENT_KEY ?? readCliBinding(opts.cwd ?? process.cwd()).environment;
  if (!key) {
    throw new ConfigError('No Flagsmith environment. Pass --environment <client-side key>, set FLAGSMITH_ENVIRONMENT, or run "flagsmith init" to write flagsmith.json.');
  }
  return key;
}

/**
 * Credentials, in order: the Flagsmith CLI when it is installed and logged in
 * (the credential never leaves the CLI), then FLAGSMITH_API_KEY.
 */
export function resolveTransport(opts: GlobalOptions): Transport {
  const want = opts.transport ?? 'auto';
  const apiKey = process.env.FLAGSMITH_API_KEY;
  if (want === 'api-key') {
    if (!apiKey) throw new ConfigError('--transport api-key needs FLAGSMITH_API_KEY in the environment or in --env-file.');
    return new HttpTransport(apiKey, process.env.FLAGSMITH_API_URL);
  }
  if (want === 'cli') {
    if (!cliAvailable()) throw new ConfigError('The Flagsmith CLI is not installed or not logged in. Run "flagsmith login".');
    return new CliTransport();
  }
  if (cliAvailable()) return new CliTransport();
  if (apiKey) return new HttpTransport(apiKey, process.env.FLAGSMITH_API_URL);
  throw new ConfigError('No Flagsmith credentials. Run "flagsmith login" (Flagsmith CLI v2), or set FLAGSMITH_API_KEY. Use "verdict preflight --offline" to run only the code rules.');
}

export function makeClient(opts: GlobalOptions): FlagsmithClient {
  if (opts.envFile) loadEnvFile(opts.envFile);
  return new FlagsmithClient(resolveTransport(opts), resolveEnvironmentKey(opts));
}

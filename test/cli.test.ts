import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, here } from './helpers.js';

// End-to-end tests of the built CLI (`npm test` builds first). They use the
// saved snapshot, so they need no Flagsmith credentials and make no network calls.
const root = path.join(here, '..');
const cli = path.join(root, 'dist', 'cli.js');
const snapshot = path.join(root, 'examples', 'demo-snapshot.json');
const env = { ...process.env, NO_COLOR: '1', FLAGSMITH_API_KEY: '', FLAGSMITH_ENVIRONMENT: '' };
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, cwd: root });

describe('verdict CLI', () => {
  it('preflight exits 1 on the broken app and 0 on the fixed app', () => {
    const broken = run('preflight', fixture('broken-app'), '--snapshot', snapshot);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('ERROR VD005 Event name does not match the metric');
    expect(broken.stdout).toContain('FAIL: 3 errors');
    expect(run('preflight', fixture('fixed-app'), '--snapshot', snapshot).status).toBe(0);
  });
  it('preflight --offline runs without credentials; --fail-on warning tightens the gate', () => {
    expect(run('preflight', fixture('fixed-app'), '--offline').status).toBe(0);
    expect(run('preflight', fixture('fixed-app'), '--snapshot', snapshot, '--fail-on', 'warning').status).toBe(1);
  });
  it('preflight --format json is valid JSON', () => {
    const out = JSON.parse(run('preflight', fixture('broken-app'), '--snapshot', snapshot, '--format', 'json').stdout);
    expect(out.counts.error).toBe(3);
  });
  it('status exit codes: 0 SHIP, 10 KEEP RUNNING, 20 DO NOT ACT', () => {
    expect(run('status', 'CTA copy', '--snapshot', snapshot).status).toBe(0);
    expect(run('status', 'Hero layout', '--snapshot', snapshot).status).toBe(10);
    expect(run('status', 'Plan toggle', '--snapshot', snapshot).status).toBe(20);
  });
  it('status without credentials or snapshot exits 2 with a clear message', () => {
    const r = run('--transport', 'api-key', 'status');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('FLAGSMITH_API_KEY');
  });
  it('ship --dry-run prints the plan and exits 0', () => {
    const r = run('ship', 'CTA copy', '--dry-run', '--snapshot', snapshot, '--path', fixture('fixed-app'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1. End the experiment and roll out start_free to everyone');
    expect(r.stdout).toContain('Dry run: nothing was changed');
  });
  it('ship has no --yes flag', () => {
    const r = run('ship', 'CTA copy', '--yes');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--yes'");
  });
  it('ship refuses an experiment that is not SHIP', () => {
    const r = run('ship', 'Plan toggle', '--dry-run', '--snapshot', snapshot);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not SHIP');
  });
  it('rules lists all 14 rules', () => {
    expect(run('rules').stdout.match(/^VD0\d\d/gm)).toHaveLength(14);
  });
});

describe('verdict mcp (stdio)', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: 'verdict-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--snapshot', snapshot], cwd: root, env: env as Record<string, string> }));
  }, 30000);
  afterAll(async () => { await client?.close(); });

  const textOf = (result: any): string => result.content.map((c: any) => c.text).join('\n');

  it('lists exactly three tools, none of which ships', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['verdict_preflight', 'verdict_ship_plan', 'verdict_status']);
    expect(tools.find((t) => t.name === 'verdict_ship_plan')!.description).toContain('cannot change anything in Flagsmith');
  });
  it('verdict_preflight returns the findings', async () => {
    const result = await client.callTool({ name: 'verdict_preflight', arguments: { path: fixture('broken-app') } });
    expect(textOf(result)).toContain('VD009');
    expect(textOf(result)).toContain('FAIL: 3 errors');
  });
  it('verdict_status returns one decision per experiment', async () => {
    const one = await client.callTool({ name: 'verdict_status', arguments: { experiment: 'cta_copy' } });
    expect(textOf(one)).toContain('CTA copy (cta_copy): SHIP start_free');
    const all = await client.callTool({ name: 'verdict_status', arguments: {} });
    expect(textOf(all)).toContain('DO NOT ACT: sample ratio mismatch');
  });
  it('verdict_ship_plan returns the plan and the command a human must run', async () => {
    const result = await client.callTool({ name: 'verdict_ship_plan', arguments: { experiment: 'CTA copy' } });
    expect(textOf(result)).toContain('A human must run: verdict ship "CTA copy"');
    expect(textOf(result)).toContain('This tool has not changed anything.');
  });
  it('verdict_ship_plan refuses when the decision is not SHIP', async () => {
    const result: any = await client.callTool({ name: 'verdict_ship_plan', arguments: { experiment: 'Plan toggle' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not SHIP');
  });
});

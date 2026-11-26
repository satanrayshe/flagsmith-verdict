import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FlagsmithClient, RefreshOutcome } from '../src/flagsmith/client.js';
import { ApiResponse, Transport } from '../src/flagsmith/transport.js';
import { Results, Warehouse } from '../src/model.js';
import { statusLive } from '../src/status.js';
import { experiment, results } from './helpers.js';

const warehouse: Warehouse = { id: 1, type: 'flagsmith', status: 'connected', statusDetail: null, totalEvents: 10, lastEventAt: null };
const win = { lift: 0.4, ciLow: 0.1, ciHigh: 0.7, chanceToWin: 0.995 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** A client whose reads and refreshes are scripted, to test the refresh rules without a network. */
class FakeClient {
  refreshCalls = 0;
  reads = 0;
  constructor(private sequence: (Results | null)[], private refreshOutcome: RefreshOutcome = { requested: true, status: 202 }) {}
  async getExposures() { return null; }
  async getResults() { const r = this.sequence[Math.min(this.reads, this.sequence.length - 1)]; this.reads += 1; return r; }
  async refreshResults() { this.refreshCalls += 1; return this.refreshOutcome; }
  async refreshExposures() { return this.refreshOutcome; }
  async projectId() { return 7; }
  dashboardUrl(projectId: number, id: number) { return `https://app.flagsmith.com/project/${projectId}/environment/ENV/experiments/${id}`; }
}
const asClient = (c: FakeClient) => c as unknown as FlagsmithClient;

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-status-')); });
const opts = () => ({ cwd, waitMs: 200, pollMs: 5 });

describe('status: results refresh', () => {
  it('fresh results are used as they are', async () => {
    const client = new FakeClient([results([600, 48], [600, 80], win, { asOf: minutesAgo(1) })]);
    const r = await statusLive(asClient(client), experiment(), warehouse, opts());
    expect(client.refreshCalls).toBe(0);
    expect(r.refresh).toContain('less than 5 minutes old');
    expect(r.decision.code).toBe('SHIP');
    expect(r.dashboardUrl).toBe('https://app.flagsmith.com/project/7/environment/ENV/experiments/1');
  });

  it('stale results trigger one refresh and the new results are used', async () => {
    const stale = results([22, 3], [18, 3], null, { asOf: minutesAgo(9) });
    const fresh = results([600, 48], [600, 80], win, { asOf: minutesAgo(0) });
    const client = new FakeClient([stale, stale, fresh]);
    const r = await statusLive(asClient(client), experiment(), warehouse, opts());
    expect(client.refreshCalls).toBe(1);
    expect(r.refresh).toBe('refreshed just now');
    expect(r.decision.code).toBe('SHIP');
  });

  it('does not ask again within 5 minutes of its own last request', async () => {
    const stale = results([22, 3], [18, 3], null, { asOf: minutesAgo(9) });
    const client = new FakeClient([stale]);
    const first = await statusLive(asClient(client), experiment(), warehouse, opts());
    expect(first.refresh).toContain('still computing');
    const second = await statusLive(asClient(client), experiment(), warehouse, opts());
    expect(client.refreshCalls).toBe(1);
    expect(second.refresh).toContain('requested less than 5 minutes ago');
  });

  it('reports the wait when Flagsmith answers 429', async () => {
    const client = new FakeClient([results([22, 3], [18, 3], null, { asOf: minutesAgo(9) })], { requested: false, status: 429, retryAfterSeconds: 181 });
    const r = await statusLive(asClient(client), experiment(), warehouse, opts());
    expect(r.refresh).toContain('try again in 181 s');
    expect(r.decision.code).toBe('KEEP_RUNNING');
  });

  it('--no-refresh never asks; a draft is never read', async () => {
    const client = new FakeClient([results([22, 3], [18, 3], null, { asOf: minutesAgo(9) })]);
    const r = await statusLive(asClient(client), experiment(), warehouse, { ...opts(), refresh: false });
    expect(client.refreshCalls).toBe(0);
    expect(r.refresh).toContain('--no-refresh');
    const draft = await statusLive(asClient(client), experiment({ status: 'created' }), warehouse, opts());
    expect(draft.decision.code).toBe('NOT_STARTED');
    expect(client.reads).toBe(1);
  });

  it('warns when excluded identities grow or the rollout changes between runs', async () => {
    const client = new FakeClient([results([600, 48], [600, 80], win, { asOf: minutesAgo(1) })]);
    const withExcluded = (n: number) => Object.assign(client, { getExposures: async () => ({ asOf: null, lastErrorAt: null, excludedIdentities: n, perVariation: {} }) });
    withExcluded(2);
    await statusLive(asClient(client), experiment(), warehouse, opts());
    withExcluded(9);
    const changed = experiment();
    changed.variations[0].allocation = 80;
    changed.variations[1].allocation = 20;
    const r = await statusLive(asClient(client), changed, warehouse, opts());
    expect(r.decision.notes.join(' ')).toContain('grew from 2 to 9');
    expect(r.decision.notes.join(' ')).toContain('rollout changed');
  });
});

describe('client over a scripted transport', () => {
  const transport = (routes: Record<string, ApiResponse>): Transport & { calls: string[] } => ({
    name: 'fake', calls: [],
    async request(method: string, p: string) { this.calls.push(`${method} ${p}`); return routes[`${method} ${p}`] ?? { status: 404, json: { detail: 'Not found.' } }; },
  });

  it('parses the wait from a 429 refresh answer', async () => {
    const t = transport({ 'POST environments/ENV/experiments/5/results/refresh/': { status: 429, json: { detail: 'A refresh was requested recently. Try again later. Expected available in 104 seconds.' } } });
    expect(await new FlagsmithClient(t, 'ENV').refreshResults(5)).toEqual({ requested: false, retryAfterSeconds: 104, status: 429 });
  });
  it('a 202 refresh is requested; errors hide the environment key', async () => {
    const t = transport({ 'POST environments/ENV-SECRET/experiments/5/results/refresh/': { status: 202, json: null } });
    const client = new FlagsmithClient(t, 'ENV-SECRET');
    expect(await client.refreshResults(5)).toEqual({ requested: true, status: 202 });
    await expect(client.getExperiment(9)).rejects.toThrow(/404 on environments\/<environment>\/experiments\/9\//);
  });
  it('sends the rollout decision to complete/', async () => {
    const t = transport({});
    const seen: unknown[] = [];
    t.request = async (method, p, body) => { seen.push([method, p, body]); return { status: 200, json: { status: 'completed' } }; };
    await new FlagsmithClient(t, 'ENV').completeExperiment(5, { rollout_decision: 'variant', rollout_variant: 100 });
    expect(seen).toEqual([['POST', 'environments/ENV/experiments/5/complete/', { rollout_decision: 'variant', rollout_variant: 100 }]]);
  });
});

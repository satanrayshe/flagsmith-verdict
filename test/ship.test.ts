import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { decide } from '../src/decide/decide.js';
import { NoTtyError, requestApproval } from '../src/ship/approve.js';
import { PlanError, buildPlan, planText } from '../src/ship/plan.js';
import { ShipDeps, ship } from '../src/ship/ship.js';
import { experiment, factsOf, results } from './helpers.js';

const win = { lift: 0.4, ciLow: 0.1, ciHigh: 0.7, chanceToWin: 0.995 };
const shipDecision = () => decide({ experiment: experiment(), exposures: null, results: results([600, 48], [600, 80], win) });
const inconclusive = () => decide({ experiment: experiment(), exposures: null, results: results([600, 48], [600, 52], { lift: 0.08, ciLow: -0.3, ciHigh: 0.46, chanceToWin: 0.66 }) });
const facts = () => factsOf({ 'src/cta.js': `const flag = flagsmith.getExperimentFlag('cta_copy');\nif (flag.variant === 'control') { old(); }\nif (flag.variant === 'start_free') { fresh(); }` });

let cwd: string;
let calls: any[];
let lines: string[];
const deps = (over: Partial<ShipDeps> = {}): ShipDeps => ({
  cwd,
  log: (l) => lines.push(l),
  io: { isTTY: true, ask: async () => 'CTA copy' },
  client: { completeExperiment: async (id, body) => { calls.push({ id, body }); return { status: 200, json: { status: 'completed', rollout_decision: body.rollout_decision } }; } },
  evaluate: async (_flag, identity) => ({ identity, variant: 'start_free', value: 'start_free' }),
  verifyTimeoutMs: 0, verifyIntervalMs: 0,
  ...over,
});
const audit = () => fs.readFileSync(path.join(cwd, '.verdict', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-ship-'));
  calls = [];
  lines = [];
});

describe('ship plan', () => {
  it('SHIP: one complete call with the winning variation id, verify, cleanup list, undo', () => {
    const plan = buildPlan(experiment(), shipDecision(), facts());
    expect(plan.winner).toBe('start_free');
    expect(plan.completeBody).toEqual({ rollout_decision: 'variant', rollout_variant: 100 });
    expect(plan.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(plan.cleanup).toEqual([
      { file: 'src/cta.js', line: 2, snippet: "if (flag.variant === 'control') { old(); }", variation: 'control', kind: 'losing' },
      { file: 'src/cta.js', line: 3, snippet: "if (flag.variant === 'start_free') { fresh(); }", variation: 'start_free', kind: 'winner' },
    ]);
    expect(plan.undo).toContain('flagsmith flag update cta_copy --weight start_free=0');
    expect(planText(plan)).toContain('POST experiments/1/complete/');
  });
  it('KEEP CONTROL: completes with rollout_decision control', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([600, 80], [600, 48], { lift: -0.4, ciLow: -0.7, ciHigh: -0.1, chanceToWin: 0.004 }) });
    expect(buildPlan(experiment(), d, null).completeBody).toEqual({ rollout_decision: 'control' });
  });
  it('refuses when the decision is not SHIP', () => {
    expect(() => buildPlan(experiment(), inconclusive(), null)).toThrow(PlanError);
    expect(() => buildPlan(experiment(), inconclusive(), null)).toThrow(/INCONCLUSIVE, not SHIP/);
  });
  it('--override needs a winner, and records the reason', () => {
    expect(() => buildPlan(experiment(), inconclusive(), null, { override: 'launch date' })).toThrow(/--winner/);
    const plan = buildPlan(experiment(), inconclusive(), null, { override: 'launch date', winner: 'start_free' });
    expect(plan.override).toBe('launch date');
    expect(() => buildPlan(experiment(), shipDecision(), null, { winner: 'control' })).toThrow(/--override/);
    expect(() => buildPlan(experiment(), inconclusive(), null, { override: 'x', winner: 'nope' })).toThrow(/not a variation/);
  });
  it('refuses a draft or an ended experiment', () => {
    expect(() => buildPlan(experiment({ status: 'completed' }), shipDecision(), null)).toThrow(/already ended/);
    expect(() => buildPlan(experiment({ status: 'created' }), shipDecision(), null)).toThrow(/not been started/);
  });
});

describe('approval', () => {
  it('refuses without a terminal', async () => {
    await expect(requestApproval('CTA copy', { isTTY: false, ask: async () => 'CTA copy' })).rejects.toBeInstanceOf(NoTtyError);
  });
  it('only an exact match approves', async () => {
    const ask = (answer: string) => requestApproval('CTA copy', { isTTY: true, ask: async () => answer });
    expect(await ask('CTA copy')).toBe(true);
    expect(await ask(' CTA copy\n')).toBe(true);
    expect(await ask('cta copy')).toBe(false);
    expect(await ask('y')).toBe(false);
    expect(await ask('')).toBe(false);
  });
});

describe('ship', () => {
  it('dry run prints the plan, calls nothing and writes no audit line', async () => {
    const out = await ship(experiment(), shipDecision(), facts(), { dryRun: true }, deps());
    expect(out).toMatchObject({ exitCode: 0, outcome: 'dry-run' });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(cwd, '.verdict'))).toBe(false);
    expect(lines.join('\n')).toContain('Dry run: nothing was changed');
  });
  it('no terminal: exit 3, nothing called, refusal audited', async () => {
    const out = await ship(experiment(), shipDecision(), null, {}, deps({ io: { isTTY: false, ask: async () => 'CTA copy' } }));
    expect(out.exitCode).toBe(3);
    expect(calls).toEqual([]);
    expect(audit()[0].outcome).toBe('refused');
  });
  it('wrong text: exit 4, nothing called, abort audited', async () => {
    const out = await ship(experiment(), shipDecision(), null, {}, deps({ io: { isTTY: true, ask: async () => 'yes' } }));
    expect(out.exitCode).toBe(4);
    expect(calls).toEqual([]);
    expect(audit()[0]).toMatchObject({ outcome: 'aborted', steps: [] });
  });
  it('approved: completes, verifies five identities, writes the cleanup file and the audit line', async () => {
    const probes: string[] = [];
    const out = await ship(experiment(), shipDecision(), facts(), {}, deps({ evaluate: async (_f, identity) => { probes.push(identity); return { identity, variant: 'start_free', value: 'start_free' }; } }));
    expect(out).toMatchObject({ exitCode: 0, outcome: 'shipped' });
    expect(calls).toEqual([{ id: 1, body: { rollout_decision: 'variant', rollout_variant: 100 } }]);
    expect(new Set(probes).size).toBe(5);
    expect(fs.readFileSync(path.join(cwd, '.verdict', 'cleanup-cta_copy.md'), 'utf8')).toContain('src/cta.js:2');
    const [line] = audit();
    expect(line).toMatchObject({ action: 'ship', outcome: 'shipped', winner: 'start_free', override: null, experiment: { id: 1, name: 'CTA copy', flag: 'cta_copy' } });
    expect(line.steps.map((s: any) => [s.n, s.ok])).toEqual([[1, true], [2, true], [3, true]]);
    expect(line.steps[0].status).toBe(200);
    expect(line.decision.arms[1]).toMatchObject({ variation: 'start_free', identities: 600, chance: 0.995 });
    expect(typeof line.approver).toBe('string');
    expect(JSON.stringify(line)).not.toMatch(/@|Api-Key|ser\./);
  });
  it('stops at the first failure: a rejected complete call means no verification', async () => {
    let evaluated = 0;
    const out = await ship(experiment(), shipDecision(), null, {}, deps({
      client: { completeExperiment: async () => ({ status: 400, json: { rollout_decision: ['This field is required.'] } }) },
      evaluate: async (_f, identity) => { evaluated += 1; return { identity, variant: null, value: null }; },
    }));
    expect(out).toMatchObject({ exitCode: 1, outcome: 'failed' });
    expect(evaluated).toBe(0);
    expect(audit()[0].steps).toHaveLength(1);
    // The plan shows the undo command once; it is not repeated when nothing was changed.
    expect(lines.join('\n').match(/Undo:/g)).toHaveLength(1);
  });
  it('failed verification: exit 1, undo printed, no cleanup file', async () => {
    const out = await ship(experiment(), shipDecision(), null, {}, deps({ evaluate: async (_f, identity) => ({ identity, variant: 'control', value: 'control' }) }));
    expect(out.exitCode).toBe(1);
    expect(audit()[0].steps.map((s: any) => s.ok)).toEqual([true, false]);
    // Once in the plan, and again after the failure because step 1 did change the flag.
    expect(lines.join('\n').match(/Undo: flagsmith flag update cta_copy/g)).toHaveLength(2);
    expect(fs.existsSync(path.join(cwd, '.verdict', 'cleanup-cta_copy.md'))).toBe(false);
  });
  it('override reason is written to the audit log', async () => {
    await ship(experiment(), inconclusive(), null, { override: 'legal deadline', winner: 'start_free' }, deps());
    expect(audit()[0]).toMatchObject({ outcome: 'shipped', override: 'legal deadline' });
  });
});

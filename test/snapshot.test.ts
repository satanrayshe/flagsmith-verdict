import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSnapshot } from '../src/live.js';
import { preflight, preflightExitCode } from '../src/preflight.js';
import { preflightMarkdown, preflightText, summaryLine } from '../src/render/preflight.js';
import { statusJson, statusMarkdown, statusText } from '../src/render/status.js';
import { buildPlan } from '../src/ship/plan.js';
import { combinedExitCode, findInState, statusFromSnapshot } from '../src/status.js';
import { fixture, here } from './helpers.js';

// examples/demo-snapshot.json was written by `verdict snapshot` from the demo
// Flagsmith environment on 26 Nov 2026. Its traffic is SIMULATED (see
// examples/simulate.mjs); the numbers are what Flagsmith computed from it.
const state = readSnapshot(path.join(here, '..', 'examples', 'demo-snapshot.json'));
const decisionFor = (ref: string) => statusFromSnapshot(state, findInState(state, ref));

describe('preflight against the recorded demo environment', () => {
  it('broken sample app: the four planted mistakes are found and the run fails', async () => {
    const report = await preflight(fixture('broken-app'), state);
    const errors = report.findings.filter((f) => f.severity === 'error');
    expect(errors.map((f) => f.ruleId)).toEqual(['VD001', 'VD005', 'VD009']);
    expect(errors.map((f) => `${f.file}:${f.line}`)).toEqual(['src/flags.js:6', 'src/pricing.js:17', 'src/pricing.js:9']);
    expect(report.findings.filter((f) => f.severity === 'warning').map((f) => f.ruleId)).toContain('VD011');
    expect(preflightExitCode(report)).toBe(1);
    expect(summaryLine(report)).toMatch(/^FAIL: 3 errors/);
  });

  it('fixed sample app passes', async () => {
    const report = await preflight(fixture('fixed-app'), state);
    expect(report.counts.error).toBe(0);
    expect(preflightExitCode(report)).toBe(0);
  });

  it('the keyless variation that Flagsmith accepted is reported (VD004)', async () => {
    const report = await preflight(fixture('fixed-app'), state);
    const f = report.findings.find((x) => x.ruleId === 'VD004')!;
    expect(f.message).toContain('no_key_variant');
    expect(f.severity).toBe('warning'); // the sample app does not read that flag
    expect(preflightExitCode(report, 'warning')).toBe(1);
  });

  it('the sample pricing page passes', async () => {
    const report = await preflight(path.join(here, '..', 'examples', 'pricing-page'), state);
    expect(report.counts.error).toBe(0);
  });

  it('offline run needs no Flagsmith data and still finds the code mistakes', async () => {
    const report = await preflight(fixture('broken-app'), null);
    expect(report.findings.map((f) => f.ruleId)).toEqual(['VD001', 'VD011']);
  });

  it('renders text and markdown with file, line, fix and doc link', async () => {
    const report = await preflight(fixture('broken-app'), state);
    const text = preflightText(report);
    expect(text).toContain("src/pricing.js:17");
    expect(text).toContain("Fix: Rename the event to 'signup'.");
    expect(text).toContain('https://docs.flagsmith.com/experimentation/run-an-experiment#track-conversions');
    const md = preflightMarkdown(report);
    expect(md).toContain('| ERROR | [VD009](https://docs.flagsmith.com/experimentation/example-paypal-button)');
  });
});

describe('status against the recorded demo environment', () => {
  it('CTA copy: SHIP start_free', () => {
    const r = decisionFor('CTA copy');
    expect(r.decision.code).toBe('SHIP');
    expect(r.decision.winner).toBe('start_free');
    const arm = r.decision.arms.find((a) => a.label === 'start_free')!;
    expect(arm.chance).toBeGreaterThanOrEqual(0.95);
    expect(arm.inference!.ciLow).toBeGreaterThan(0);
  });
  it('Hero layout: KEEP RUNNING with the shortfall', () => {
    const r = decisionFor('hero_layout');
    expect(r.decision.code).toBe('KEEP_RUNNING');
    expect(r.decision.arms.every((a) => a.identitiesShort > 0)).toBe(true);
  });
  it('Plan toggle: DO NOT ACT, sample ratio mismatch', () => {
    const r = decisionFor('Plan toggle');
    expect(r.decision.code).toBe('DO_NOT_ACT');
    expect(r.decision.srm!.pValue).toBeLessThan(0.001);
  });
  it('ended experiment: ENDED, serving the rolled-out variation', () => {
    const r = decisionFor('Scratch ship');
    expect(r.decision.code).toBe('ENDED');
    expect(r.decision.winner).toBe('variant_b');
  });
  it('finds experiments by id, name in any case, or flag name', () => {
    expect(findInState(state, 'cta copy').flag.name).toBe('cta_copy');
    expect(findInState(state, 'cta_copy').name).toBe('CTA copy');
    expect(findInState(state, String(findInState(state, 'cta_copy').id)).name).toBe('CTA copy');
    expect(() => findInState(state, 'nope')).toThrow(/No experiment matches/);
  });
  it('exit code for a list is the worst one; renderers include the rule and numbers', () => {
    const reports = state.experiments.map((e) => statusFromSnapshot(state, e));
    expect(combinedExitCode(reports)).toBe(20);
    const ship = decisionFor('CTA copy');
    expect(statusText(ship)).toContain('SHIP start_free');
    expect(statusText(ship)).toContain('chance to beat control');
    expect(statusMarkdown([ship])).toContain('### CTA copy: SHIP start_free');
    expect(JSON.parse(statusJson([ship]))[0]).toMatchObject({ decision: 'SHIP', winner: 'start_free', exitCode: 0 });
  });
  it('ship plan for CTA copy rolls out the start_free variation id', () => {
    const r = decisionFor('CTA copy');
    const plan = buildPlan(r.experiment, r.decision, null);
    const id = r.experiment.variations.find((v) => v.key === 'start_free')!.id;
    expect(plan.completeBody).toEqual({ rollout_decision: 'variant', rollout_variant: id });
  });
  it('ship plan is refused for Plan toggle', () => {
    const r = decisionFor('Plan toggle');
    expect(() => buildPlan(r.experiment, r.decision, null)).toThrow(/not SHIP/);
  });
});

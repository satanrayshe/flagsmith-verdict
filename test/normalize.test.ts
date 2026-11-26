import { describe, expect, it } from 'vitest';
import { decide } from '../src/decide/decide.js';
import { parseCliApiOutput } from '../src/flagsmith/cli-transport.js';
import { listOf, normalizeExperiment, normalizeExposures, normalizeMetric, normalizeResults, normalizeWarehouse } from '../src/flagsmith/normalize.js';
import { labelOf } from '../src/model.js';
import { raw } from './helpers.js';

// Every fixture under test/fixtures/live/raw is a real response recorded from
// the demo environment on 26 Nov 2026 (SIMULATED traffic), with keys scrubbed.
describe('normalize: recorded Flagsmith responses', () => {
  it('experiment detail: control first, allocation from the rollout', () => {
    const e = normalizeExperiment(raw('experiment-562-detail'));
    expect(e.name).toBe('CTA copy');
    expect(e.flag.name).toBe('cta_copy');
    expect(e.status).toBe('running');
    expect(e.variations.map(labelOf)).toEqual(['control', 'start_free']);
    expect(e.variations.map((v) => v.allocation)).toEqual([50, 50]);
    expect(e.variations[0].isControl).toBe(true);
    expect(e.metrics[0]).toMatchObject({ name: 'Sign-ups', aggregation: 'occurrence', expectedDirection: 'increase' });
    expect(e.rolloutPercentage).toBe(100);
  });

  it('list endpoint: items without a rollout still normalise', () => {
    const list = listOf(raw('experiments-list')).map(normalizeExperiment);
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.every((e) => e.rolloutPercentage === null)).toBe(true);
  });

  it('a variation created without a key has key null', () => {
    const e = normalizeExperiment(raw('experiment-566-nokey'));
    const v = e.variations.find((x) => !x.isControl)!;
    expect(v.key).toBeNull();
    expect(v.value).toBe('no_key_variant');
  });

  it('completed experiment carries the rollout decision', () => {
    const e = normalizeExperiment(raw('experiment-565-completed'));
    expect(e.status).toBe('completed');
    expect(e.rolloutDecision).toBe('variant');
    expect(e.rolloutVariant).toBe(e.variations[1].id);
  });

  it('exposures: identities per variation are summed over the time buckets', () => {
    const x = normalizeExposures(raw('exposures-564'))!;
    expect(x.perVariation).toEqual({ control: 204, annual_first: 111 });
    expect(x.excludedIdentities).toBe(0);
  });

  it('results: variants, inference and null inference while collecting', () => {
    const srm = normalizeResults(raw('results-564'))!;
    expect(srm.metrics[0].variants.control.n).toBe(204);
    expect(srm.metrics[0].inference.annual_first?.chanceToWin).toBeGreaterThan(0);
    expect(srm.srmPValue).toBeNull();
    const small = normalizeResults(raw('results-563'))!;
    expect(small.metrics[0].inference.split_hero).toBeNull();
  });

  it('"results": null and "exposures": null mean not computed', () => {
    expect(normalizeResults(raw('results-565-final'))).toBeNull();
    expect(normalizeResults({ results: null })).toBeNull();
    expect(normalizeExposures({ exposures: null })).toBeNull();
  });

  it('metric and warehouse', () => {
    const m = listOf(raw('experiment-metrics')).map(normalizeMetric)[0];
    expect(m).toMatchObject({ name: 'Sign-ups', event: 'signup', aggregation: 'occurrence' });
    const w = normalizeWarehouse(raw('warehouse-connections')[0]);
    expect(w.type).toBe('flagsmith');
    expect(w.totalEvents).toBeGreaterThan(0);
  });
});

describe('flagsmith api output parsing', () => {
  it('reads the status line and body printed by --include', () => {
    const r = parseCliApiOutput({ code: 0, stderr: '', stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nServer: gunicorn\r\n\r\n{"count":1,"results":[]}' });
    expect(r).toEqual({ status: 200, json: { count: 1, results: [] } });
  });
  it('reads an empty 202 body', () => {
    expect(parseCliApiOutput({ code: 0, stderr: '', stdout: 'HTTP/2.0 202 Accepted\nContent-Length: 0\n\n' })).toEqual({ status: 202, json: null });
  });
  it('reads the status from stderr when the CLI reports an error', () => {
    // As printed by flagsmith CLI v2.0.0: the body and the error line both go to stderr.
    const stderr = '{"detail":"A refresh was requested recently. Try again later. Expected available in 181 seconds."}\nError: POST https://api.flagsmith.com/api/v1/x/ returned 429 Too Many Requests\nThink this should not happen? Tell us.\n';
    const r = parseCliApiOutput({ code: 1, stdout: '', stderr });
    expect(r.status).toBe(429);
    expect(r.json.detail).toContain('in 181 seconds');
  });
  it('reports status 0 when the CLI could not run', () => {
    expect(parseCliApiOutput({ code: 127, stdout: '', stderr: 'spawn flagsmith ENOENT' }).status).toBe(0);
  });
});

describe('decisions from recorded responses', () => {
  const cta = () => normalizeExperiment(raw('experiment-562-detail'));
  it('CTA copy after 600 simulated identities was INCONCLUSIVE', () => {
    const d = decide({ experiment: cta(), exposures: normalizeExposures(raw('exposures-562-early')), results: normalizeResults(raw('results-562-inconclusive')) });
    expect(d.code).toBe('INCONCLUSIVE');
    expect(d.arms.map((a) => a.identities)).toEqual([293, 307]);
  });
  it('CTA copy after 6,000 simulated identities is SHIP start_free', () => {
    const d = decide({ experiment: cta(), exposures: normalizeExposures(raw('exposures-562')), results: normalizeResults(raw('results-562-ship')) });
    expect(d.code).toBe('SHIP');
    expect(d.winner).toBe('start_free');
    expect(d.srm?.mismatch).toBe(false);
  });
  it('an ended experiment with no results is ENDED', () => {
    const d = decide({ experiment: normalizeExperiment(raw('experiment-565-completed')), exposures: null, results: normalizeResults(raw('results-565-final')) });
    expect(d.code).toBe('ENDED');
  });
});

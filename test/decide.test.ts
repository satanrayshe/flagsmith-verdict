import { describe, expect, it } from 'vitest';
import { chanceOfIncrease, decide } from '../src/decide/decide.js';
import { Warehouse } from '../src/model.js';
import { experiment, results } from './helpers.js';

const connected: Warehouse = { id: 1, type: 'flagsmith', status: 'connected', statusDetail: null, totalEvents: 100, lastEventAt: null };
const win = { lift: 0.4, ciLow: 0.1, ciHigh: 0.7, chanceToWin: 0.995 };

describe('decision table, one test per row', () => {
  it('row 1: draft experiment is NOT STARTED (exit 10)', () => {
    const d = decide({ experiment: experiment({ status: 'created' }), exposures: null, results: null, warehouse: connected });
    expect(d.code).toBe('NOT_STARTED');
    expect(d.exitCode).toBe(10);
  });

  it('row 2: completed experiment is ENDED and names what every user gets (exit 0)', () => {
    const d = decide({ experiment: experiment({ status: 'completed', rolloutDecision: 'variant', rolloutVariant: 100, endedAt: '2026-11-26T08:06:39Z' }), exposures: null, results: null, warehouse: connected });
    expect(d.code).toBe('ENDED');
    expect(d.winner).toBe('start_free');
    expect(d.reason).toContain('Every user now gets "start_free"');
    expect(d.exitCode).toBe(0);
  });

  it('row 3: no warehouse is BLOCKED (exit 20)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: null, warehouse: null });
    expect(d.code).toBe('BLOCKED');
    expect(d.exitCode).toBe(20);
  });

  it('row 3: errored warehouse is BLOCKED; pending with no events is BLOCKED', () => {
    expect(decide({ experiment: experiment(), exposures: null, results: null, warehouse: { ...connected, status: 'errored', statusDetail: 'bad credentials' } }).code).toBe('BLOCKED');
    expect(decide({ experiment: experiment(), exposures: null, results: null, warehouse: { ...connected, status: 'pending_connection', totalEvents: 0 } }).code).toBe('BLOCKED');
  });

  it('row 3: pending warehouse that has received events does not block, and says so', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([600, 48], [600, 80], win), warehouse: { ...connected, status: 'pending_connection', totalEvents: 65 } });
    expect(d.code).toBe('SHIP');
    expect(d.notes.join(' ')).toContain('pending_connection');
  });

  it('row 4: results not computed is NO DATA YET (exit 10)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: null, warehouse: connected });
    expect(d.code).toBe('NO_DATA');
    expect(d.exitCode).toBe(10);
  });

  it('row 4: a payload computed before any exposure is NO DATA YET', () => {
    const empty = { asOf: 'x', lastErrorAt: null, isFinal: false, srmPValue: null, metrics: [{ metricId: 5, variants: {}, inference: {} }] };
    expect(decide({ experiment: experiment(), exposures: null, results: empty, warehouse: connected }).code).toBe('NO_DATA');
  });

  it('row 5: sample ratio mismatch is DO NOT ACT, even when a variation looks like a winner (exit 20)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([204, 19], [111, 30], win), warehouse: connected });
    expect(d.code).toBe('DO_NOT_ACT');
    expect(d.exitCode).toBe(20);
    expect(d.srm?.source).toBe('verdict');
    expect(d.reason).toContain('control 204 (expected 158)');
  });

  it("row 5: Flagsmith's own srm_p_value is used when present", () => {
    const flagged = decide({ experiment: experiment(), exposures: null, results: results([300, 30], [300, 45], win, { srmPValue: 0.0001 }), warehouse: connected });
    expect(flagged.code).toBe('DO_NOT_ACT');
    expect(flagged.srm?.source).toBe('flagsmith');
    const fine = decide({ experiment: experiment(), exposures: null, results: results([204, 19], [111, 30], win, { srmPValue: 0.4 }), warehouse: connected });
    expect(fine.code).not.toBe('DO_NOT_ACT');
  });

  it('row 5: the mismatch check waits for 100 identities', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([70, 6], [20, 6], null), warehouse: connected });
    expect(d.code).toBe('KEEP_RUNNING');
    expect(d.srm).toBeNull();
  });

  it('row 6: fewer than 50 identities is KEEP RUNNING with the shortfall (exit 10)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([22, 3], [18, 3], null), warehouse: connected });
    expect(d.code).toBe('KEEP_RUNNING');
    expect(d.exitCode).toBe(10);
    expect(d.reason).toContain('control needs 28 more identities (has 22) and 2 more conversions (has 3)');
    expect(d.reason).toContain('start_free needs 32 more identities (has 18)');
  });

  it('row 6: fewer than 5 conversions on an occurrence metric is KEEP RUNNING', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([80, 6], [80, 2], null), warehouse: connected });
    expect(d.code).toBe('KEEP_RUNNING');
    expect(d.reason).toContain('start_free needs 3 more conversions (has 2)');
  });

  it('row 7: a guardrail moving the wrong way is DO NOT SHIP, even with a winner (exit 20)', () => {
    const e = experiment();
    e.metrics.push({ metricId: 6, name: 'Refunds', aggregation: 'occurrence', direction: 'down', expectedDirection: 'not_increase' });
    const r = results([600, 48], [600, 80], win);
    r.metrics.push({ metricId: 6, variants: { control: { n: 600, sum: 10, sumSquares: 10 }, start_free: { n: 600, sum: 30, sumSquares: 30 } }, inference: { start_free: { lift: 2, ciLow: 0.8, ciHigh: 3.2, chanceToWin: 0.001 } } });
    const d = decide({ experiment: e, exposures: null, results: r, warehouse: connected });
    expect(d.code).toBe('DO_NOT_SHIP');
    expect(d.exitCode).toBe(20);
    expect(d.guardrail?.metric).toBe('Refunds');
  });

  it('row 7: a quiet guardrail does not block', () => {
    const e = experiment();
    e.metrics.push({ metricId: 6, name: 'Refunds', aggregation: 'occurrence', direction: 'down', expectedDirection: 'not_increase' });
    const r = results([600, 48], [600, 80], win);
    r.metrics.push({ metricId: 6, variants: { control: { n: 600, sum: 10, sumSquares: 10 }, start_free: { n: 600, sum: 11, sumSquares: 11 } }, inference: { start_free: { lift: 0.1, ciLow: -0.7, ciHigh: 0.9, chanceToWin: 0.4 } } });
    expect(decide({ experiment: e, exposures: null, results: r, warehouse: connected }).code).toBe('SHIP');
  });

  it('row 8: 95% chance and an interval clear of zero is SHIP <variation> (exit 0)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([600, 48], [600, 80], win), warehouse: connected });
    expect(d.code).toBe('SHIP');
    expect(d.headline).toBe('SHIP start_free');
    expect(d.winner).toBe('start_free');
    expect(d.exitCode).toBe(0);
    expect(d.reason).toContain('lift +40.0%');
  });

  it('row 8: 95% chance with an interval that still touches zero is not SHIP', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([600, 48], [600, 62], { lift: 0.29, ciLow: -0.01, ciHigh: 0.59, chanceToWin: 0.951 }), warehouse: connected });
    expect(d.code).toBe('INCONCLUSIVE');
  });

  it('row 9: every variation under 5% is KEEP CONTROL (exit 0)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([600, 80], [600, 48], { lift: -0.4, ciLow: -0.7, ciHigh: -0.1, chanceToWin: 0.004 }), warehouse: connected });
    expect(d.code).toBe('KEEP_CONTROL');
    expect(d.winner).toBe('control');
    expect(d.exitCode).toBe(0);
  });

  it('row 10: otherwise INCONCLUSIVE, showing the interval (exit 10)', () => {
    const d = decide({ experiment: experiment(), exposures: null, results: results([293, 35], [307, 32], { lift: -0.127, ciLow: -0.522, ciHigh: 0.268, chanceToWin: 0.264 }), warehouse: connected });
    expect(d.code).toBe('INCONCLUSIVE');
    expect(d.exitCode).toBe(10);
    expect(d.reason).toContain('-52.2% to +26.8%');
  });

  it('a metric expected to decrease wins on a negative lift', () => {
    const e = experiment();
    e.metrics[0].expectedDirection = 'decrease';
    const d = decide({ experiment: e, exposures: null, results: results([600, 80], [600, 48], { lift: -0.4, ciLow: -0.7, ciHigh: -0.1, chanceToWin: 0.004 }), warehouse: connected });
    expect(d.code).toBe('SHIP');
  });

  it('notes excluded identities and a paused experiment', () => {
    const d = decide({
      experiment: experiment({ status: 'paused' }),
      exposures: { asOf: null, lastErrorAt: null, excludedIdentities: 7, perVariation: { control: 22, start_free: 18 } },
      results: results([22, 3], [18, 3], null), warehouse: connected,
    });
    expect(d.excludedIdentities).toBe(7);
    expect(d.notes.join(' ')).toMatch(/7 identities.*paused/);
  });
});

describe('chance of increase from the interval', () => {
  it('reproduces chance_to_win as returned by Flagsmith for a recorded result', () => {
    // Recorded on 26 Nov 2026 from the demo environment (plan_toggle, annual_first).
    const recorded = { lift: -0.22617354196301567, ciLow: -0.8422676466535886, ciHigh: 0.38992056272755726, chanceToWin: 0.2359103087628624 };
    expect(chanceOfIncrease(recorded)).toBeCloseTo(recorded.chanceToWin, 4);
  });
});

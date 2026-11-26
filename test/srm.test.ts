import { describe, expect, it } from 'vitest';
import { chiSquarePValue, normalCdf, sampleRatioTest } from '../src/decide/srm.js';

describe('chi-square p-value', () => {
  // Critical values at p = 0.001 for df 1 to 5 (standard tables).
  it.each([[10.828, 1], [13.816, 2], [16.266, 3], [18.467, 4], [20.515, 5]])('chi2 %f with df %i gives p = 0.001', (chi2, df) => {
    expect(chiSquarePValue(chi2, df)).toBeCloseTo(0.001, 4);
  });
  it('matches other table values', () => {
    expect(chiSquarePValue(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquarePValue(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquarePValue(0, 1)).toBe(1);
  });
});

describe('sample ratio test', () => {
  it('hand-computed 50/50 case: 204 vs 111', () => {
    // expected 157.5 each; chi2 = 2 * 46.5^2 / 157.5 = 27.457
    const r = sampleRatioTest({ control: 204, annual_first: 111 }, { control: 50, annual_first: 50 })!;
    expect(r.chi2).toBeCloseTo(27.457, 2);
    expect(r.df).toBe(1);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.arms[0].expected).toBeCloseTo(157.5, 5);
  });
  it('balanced traffic is not a mismatch', () => {
    const r = sampleRatioTest({ control: 293, start_free: 307 }, { control: 50, start_free: 50 })!;
    expect(r.chi2).toBeCloseTo(0.3267, 3); // 2 * 7^2 / 300
    expect(r.pValue).toBeGreaterThan(0.5);
  });
  it('respects an uneven configured split (hand-computed 80/20)', () => {
    // n = 1000, expected 800 and 200; observed 760 and 240; chi2 = 1600/800 + 1600/200 = 10
    const r = sampleRatioTest({ control: 760, b: 240 }, { control: 80, b: 20 })!;
    expect(r.chi2).toBeCloseTo(10, 6);
    expect(r.pValue).toBeGreaterThan(0.001);
    expect(r.pValue).toBeLessThan(0.002);
  });
  it('three arms use two degrees of freedom', () => {
    // n = 300, expected 100 each; chi2 = (400 + 100 + 900) / 100 = 14
    const r = sampleRatioTest({ control: 120, b: 110, c: 70 }, { control: 1, b: 1, c: 1 })!;
    expect(r.df).toBe(2);
    expect(r.chi2).toBeCloseTo(14, 6);
    expect(r.pValue).toBeLessThan(0.001);
  });
  it('returns null when there is nothing to test', () => {
    expect(sampleRatioTest({ control: 0, b: 0 }, { control: 50, b: 50 })).toBeNull();
    expect(sampleRatioTest({ control: 10 }, { control: 100 })).toBeNull();
  });
});

describe('normal cdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 4);
  });
});

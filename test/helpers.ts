import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveState } from '../src/live.js';
import { Experiment, FlagInfo, Results } from '../src/model.js';
import { emptyFacts, Facts } from '../src/scan/facts.js';
import { extractFromPackageJson, extractFromSource } from '../src/scan/extract.js';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (...p: string[]) => path.join(here, 'fixtures', ...p);
export const raw = (name: string) => JSON.parse(fs.readFileSync(fixture('live', 'raw', `${name}.json`), 'utf8'));

/** Facts from inline source files: { 'a.js': '...' }. */
export function factsOf(files: Record<string, string>): Facts {
  const facts = emptyFacts('/virtual');
  for (const [file, code] of Object.entries(files)) {
    if (file.endsWith('package.json')) extractFromPackageJson(code, file, facts);
    else extractFromSource(code, file, facts);
  }
  facts.filesScanned = Object.keys(files).length;
  return facts;
}

export function experiment(over: Partial<Experiment> = {}): Experiment {
  return {
    id: 1, name: 'CTA copy', hypothesis: '', status: 'running',
    flag: { id: 10, name: 'cta_copy', type: 'MULTIVARIATE' },
    variations: [
      { id: null, key: 'control', value: 'control', isControl: true, allocation: 50 },
      { id: 100, key: 'start_free', value: 'start_free', isControl: false, allocation: 50 },
    ],
    metrics: [{ metricId: 5, name: 'Sign-ups', aggregation: 'occurrence', direction: 'up', expectedDirection: 'increase', event: 'signup' }],
    rolloutPercentage: 100, startedAt: '2026-11-26T08:00:00Z', endedAt: null, rolloutDecision: null, rolloutVariant: null,
    ...over,
  };
}

export const flag = (over: Partial<FlagInfo> = {}): FlagInfo => ({
  id: 10, name: 'cta_copy', type: 'MULTIVARIATE', defaultValue: 'control',
  variations: [{ id: 100, key: 'start_free', value: 'start_free' }], ...over,
});

export function liveState(over: Partial<LiveState> = {}): LiveState {
  return {
    capturedAt: '2026-11-26T09:00:00Z', source: 'snapshot', projectId: 1,
    experiments: [experiment()], flags: [flag()],
    metrics: [{ id: 5, name: 'Sign-ups', aggregation: 'occurrence', direction: 'up', event: 'signup' }],
    warehouse: { id: 1, type: 'flagsmith', status: 'connected', statusDetail: null, totalEvents: 10, lastEventAt: null },
    warehouseEvents: ['$flag_exposure', 'signup'],
    ...over,
  };
}

/** Results for one occurrence metric: [n, conversions] per arm, plus inference for the variation. */
export function results(control: [number, number], variant: [number, number], inference: { lift: number; ciLow: number; ciHigh: number; chanceToWin: number } | null, over: Partial<Results> = {}): Results {
  return {
    asOf: '2026-11-26T09:00:00Z', lastErrorAt: null, isFinal: false, srmPValue: null,
    metrics: [{
      metricId: 5,
      variants: { control: { n: control[0], sum: control[1], sumSquares: control[1] }, start_free: { n: variant[0], sum: variant[1], sumSquares: variant[1] } },
      inference: { start_free: inference },
    }],
    ...over,
  };
}

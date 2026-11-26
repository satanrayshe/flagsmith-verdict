import fs from 'node:fs';
import { FlagsmithClient } from './flagsmith/client.js';
import { Experiment, Exposures, FlagInfo, MetricInfo, Results, Warehouse } from './model.js';

/**
 * Everything Verdict reads from Flagsmith, in the internal model. It holds no
 * credentials or environment keys, so it can be saved to a file (`verdict
 * snapshot`) and used later with `--snapshot` where no credentials exist.
 */
export interface LiveState {
  capturedAt: string;
  source: 'live' | 'snapshot';
  projectId: number | null;
  experiments: Experiment[];
  flags: FlagInfo[];
  metrics: MetricInfo[];
  warehouse: Warehouse | null;
  /** Event names the warehouse has received; null when it cannot list them. */
  warehouseEvents: string[] | null;
  /** Present in snapshots taken with results, keyed by experiment id. */
  exposures?: Record<string, Exposures | null>;
  results?: Record<string, Results | null>;
}

function attachEvents(experiments: Experiment[], metrics: MetricInfo[]): void {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  for (const e of experiments) for (const m of e.metrics) m.event = byId.get(m.metricId)?.event ?? undefined;
}

export async function loadLiveState(client: FlagsmithClient, opts: { withResults?: boolean } = {}): Promise<LiveState> {
  const [list, metrics, warehouses, flags, projectId] = await Promise.all([
    client.listExperiments(), client.listMetrics(), client.listWarehouses(), client.listFlags(), client.projectId(),
  ]);
  const warehouse = warehouses.find((w) => w.status === 'connected') ?? warehouses[0] ?? null;
  const warehouseEvents = warehouse ? await client.warehouseEvents(warehouse.id) : null;
  // The list endpoint omits the rollout, so load the detail of every experiment that is not finished.
  const experiments = await Promise.all(list.map((e) => (e.status === 'completed' && !opts.withResults ? e : client.getExperiment(e.id))));
  attachEvents(experiments, metrics);
  const state: LiveState = {
    capturedAt: new Date().toISOString(), source: 'live', projectId, experiments, flags, metrics, warehouse, warehouseEvents,
  };
  if (opts.withResults) {
    state.exposures = {};
    state.results = {};
    for (const e of experiments) {
      if (e.status === 'created') continue;
      state.exposures[e.id] = await client.getExposures(e.id);
      state.results[e.id] = await client.getResults(e.id);
    }
  }
  return state;
}

export function readSnapshot(file: string): LiveState {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveState;
  if (!Array.isArray(state.experiments) || !Array.isArray(state.flags)) throw new Error(`${file} is not a Verdict snapshot.`);
  return { ...state, source: 'snapshot' };
}

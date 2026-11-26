// Maps raw Flagsmith API JSON to the internal model (src/model.ts).
//
// Shapes observed on Flagsmith Cloud (API version 2.295, 26 Nov 2026). The
// experimentation API is in beta, so every assumption lives in this one file.
//
// - GET experiments/{id}/ : feature {id, name, type, initial_value,
//   multivariate_options[{id, key, string_value, integer_value, boolean_value}]},
//   metrics[{metric, metric_name, aggregation, direction, expected_direction}],
//   experiment_rollout {rollout_percentage, multivariate_feature_state_values[
//   {multivariate_feature_option, percentage_allocation}]}, status, started_at,
//   ended_at, rollout_decision, rollout_variant. The list endpoint returns the
//   same items without experiment_rollout.
// - Control is the flag's own value. It has no multivariate option and gets
//   100 minus the sum of the variation allocations.
// - GET exposures/ : {"exposures": null} until first computed, then
//   {as_of, last_error_at, refresh_requested_at, payload: {excluded_identities,
//   timeseries: {granularity, points: [{bucket, new_identities: {<label>: n}}]}}}.
//   Identities per variation is the sum of new_identities over all buckets.
// - GET results/ : {"results": null} until first computed, then {as_of, is_final,
//   payload: {srm_p_value, metrics: [{metric_id, variants: {<label>: {n, sum,
//   sum_squares}}, inference: {<label>: {lift, ci_low, ci_high, chance_to_win}
//   | null}}], exposures_timeseries}}. A payload computed before any event
//   arrived has empty `variants` and `points`.
// - <label> is the variation key, and "control" for the flag's own value.
// - POST complete/ needs {rollout_decision: control|variant|disable,
//   rollout_variant?: <option id>} and applies the rollout itself.
// - Refresh endpoints answer 202 with no body, or 429 with
//   "Expected available in N seconds" inside the 5 minute window.
import {
  CONTROL, Experiment, ExperimentMetric, Exposures, FlagInfo, MetricInfo, MetricResult, Results, Variation, Warehouse,
} from '../model.js';

function optionValue(o: any): string {
  if (o.string_value !== null && o.string_value !== undefined) return String(o.string_value);
  if (o.integer_value !== null && o.integer_value !== undefined) return String(o.integer_value);
  if (o.boolean_value !== null && o.boolean_value !== undefined) return String(o.boolean_value);
  return '';
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function normalizeExperiment(raw: any): Experiment {
  const feature = raw.feature ?? {};
  const options: any[] = feature.multivariate_options ?? [];
  const rollout = raw.experiment_rollout ?? null;
  const allocations = new Map<number, number>();
  for (const a of rollout?.multivariate_feature_state_values ?? []) {
    allocations.set(a.multivariate_feature_option, num(a.percentage_allocation));
  }
  const variations: Variation[] = options.map((o) => ({
    id: o.id,
    key: typeof o.key === 'string' && o.key.trim() !== '' ? o.key : null,
    value: optionValue(o),
    isControl: false,
    allocation: allocations.get(o.id) ?? num(o.default_percentage_allocation),
  }));
  const used = variations.reduce((s, v) => s + v.allocation, 0);
  const controlValue = rollout?.feature_state_value?.value ?? feature.initial_value ?? CONTROL;
  variations.unshift({ id: null, key: CONTROL, value: String(controlValue), isControl: true, allocation: Math.max(0, 100 - used) });

  const metrics: ExperimentMetric[] = (raw.metrics ?? []).map((m: any) => ({
    metricId: m.metric,
    name: m.metric_name ?? `metric ${m.metric}`,
    aggregation: m.aggregation ?? 'occurrence',
    direction: m.direction ?? 'up',
    expectedDirection: m.expected_direction ?? 'increase',
  }));

  return {
    id: raw.id,
    name: raw.name ?? `experiment ${raw.id}`,
    hypothesis: raw.hypothesis ?? '',
    status: raw.status,
    flag: { id: feature.id, name: feature.name, type: feature.type ?? '' },
    variations,
    metrics,
    rolloutPercentage: rollout ? num(rollout.rollout_percentage, 100) : null,
    startedAt: raw.started_at ?? null,
    endedAt: raw.ended_at ?? null,
    rolloutDecision: raw.rollout_decision ?? null,
    rolloutVariant: raw.rollout_variant ?? null,
  };
}

function sumTimeseries(points: any[] | undefined, field: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const p of points ?? []) {
    for (const [label, n] of Object.entries(p?.[field] ?? {})) totals[label] = (totals[label] ?? 0) + num(n);
  }
  return totals;
}

/** Returns null when Flagsmith has not computed exposures yet. */
export function normalizeExposures(raw: any): Exposures | null {
  const e = raw && typeof raw === 'object' && 'exposures' in raw ? raw.exposures : raw;
  if (!e || !e.payload) return null;
  return {
    asOf: e.as_of ?? null,
    lastErrorAt: e.last_error_at ?? null,
    excludedIdentities: num(e.payload.excluded_identities),
    perVariation: sumTimeseries(e.payload.timeseries?.points, 'new_identities'),
  };
}

/** Returns null when Flagsmith has not computed results yet. */
export function normalizeResults(raw: any): Results | null {
  const r = raw && typeof raw === 'object' && 'results' in raw ? raw.results : raw;
  if (!r || !r.payload) return null;
  const metrics: MetricResult[] = (r.payload.metrics ?? []).map((m: any) => {
    const variants: MetricResult['variants'] = {};
    for (const [label, s] of Object.entries<any>(m.variants ?? {})) {
      variants[label] = { n: num(s?.n), sum: num(s?.sum), sumSquares: num(s?.sum_squares) };
    }
    const inference: MetricResult['inference'] = {};
    for (const [label, i] of Object.entries<any>(m.inference ?? {})) {
      inference[label] = i && typeof i.chance_to_win === 'number'
        ? { lift: num(i.lift), ciLow: num(i.ci_low), ciHigh: num(i.ci_high), chanceToWin: i.chance_to_win }
        : null;
    }
    return { metricId: m.metric_id, variants, inference };
  });
  return {
    asOf: r.as_of ?? null,
    lastErrorAt: r.last_error_at ?? null,
    isFinal: Boolean(r.is_final),
    srmPValue: typeof r.payload.srm_p_value === 'number' ? r.payload.srm_p_value : null,
    metrics,
  };
}

export function normalizeWarehouse(raw: any): Warehouse {
  return {
    id: raw.id,
    type: raw.warehouse_type ?? 'unknown',
    status: raw.status ?? 'unknown',
    statusDetail: raw.status_detail ?? null,
    totalEvents: num(raw.total_events_received),
    lastEventAt: raw.last_event_received_at ?? null,
  };
}

export function normalizeFlag(raw: any): FlagInfo {
  return {
    id: raw.id,
    name: raw.name,
    type: String(raw.type ?? '').toUpperCase(),
    defaultValue: raw.initial_value ?? null,
    variations: (raw.multivariate_options ?? []).map((o: any) => ({
      id: o.id,
      key: typeof o.key === 'string' && o.key.trim() !== '' ? o.key : null,
      value: optionValue(o),
    })),
  };
}

export function normalizeMetric(raw: any): MetricInfo {
  return {
    id: raw.id,
    name: raw.name,
    aggregation: raw.aggregation,
    direction: raw.direction,
    event: typeof raw.definition?.event === 'string' ? raw.definition.event : null,
  };
}

/** Unwraps a paginated list or a bare array. */
export function listOf(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  return [];
}

// Internal model. Everything outside src/flagsmith works on these types only,
// so a change in the (beta) experimentation API is absorbed in normalize.ts.

export type ExperimentStatus = 'created' | 'running' | 'paused' | 'completed';
export type Aggregation = 'count' | 'sum' | 'mean' | 'occurrence';
export type ExpectedDirection = 'increase' | 'decrease' | 'not_increase' | 'not_decrease';

export interface Variation {
  /** Multivariate option id; null for control (the flag's own value). */
  id: number | null;
  /** Stable key. Null means the variation was created without one and is not counted. */
  key: string | null;
  value: string;
  isControl: boolean;
  /** Share of experiment traffic in percent, from the experiment rollout. */
  allocation: number;
}

export interface ExperimentMetric {
  metricId: number;
  name: string;
  aggregation: Aggregation;
  direction: string;
  expectedDirection: ExpectedDirection;
  /** Event name the metric listens for, when the metric definition was loaded. */
  event?: string;
}

export interface Experiment {
  id: number;
  name: string;
  hypothesis: string;
  status: ExperimentStatus;
  flag: { id: number; name: string; type: string };
  /** Control first, then variations in API order. */
  variations: Variation[];
  metrics: ExperimentMetric[];
  rolloutPercentage: number | null;
  startedAt: string | null;
  endedAt: string | null;
  rolloutDecision: 'control' | 'variant' | 'disable' | null;
  rolloutVariant: number | null;
}

export interface Exposures {
  asOf: string | null;
  lastErrorAt: string | null;
  /** Identities excluded from analysis (seen in more than one variation). */
  excludedIdentities: number;
  /** Identities per variation label (see Variation label rules in normalize.ts). */
  perVariation: Record<string, number>;
}

export interface VariantStats { n: number; sum: number; sumSquares: number }
export interface Inference { lift: number; ciLow: number; ciHigh: number; chanceToWin: number }

export interface MetricResult {
  metricId: number;
  variants: Record<string, VariantStats>;
  /** Keyed by variation label; control has no entry. Null while Flagsmith is still collecting data. */
  inference: Record<string, Inference | null>;
}

export interface Results {
  asOf: string | null;
  lastErrorAt: string | null;
  isFinal: boolean;
  srmPValue: number | null;
  metrics: MetricResult[];
}

export interface Warehouse {
  id: number;
  type: string;
  status: 'created' | 'pending_connection' | 'connected' | 'errored' | string;
  statusDetail: string | null;
  totalEvents: number;
  lastEventAt: string | null;
}

export interface FlagInfo {
  id: number;
  name: string;
  type: string;
  defaultValue: string | null;
  variations: { id: number; key: string | null; value: string }[];
}

export interface MetricInfo { id: number; name: string; aggregation: Aggregation; direction: string; event: string | null }

/** The label used for a variation in output and as the key of per-variation maps. */
export const CONTROL = 'control';
export function labelOf(v: Variation): string {
  return v.isControl ? CONTROL : v.key ?? v.value;
}

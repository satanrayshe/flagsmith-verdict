import { CONTROL, Experiment, ExperimentMetric, Exposures, Inference, Results, Warehouse, labelOf } from '../model.js';
import { SrmResult, normalCdf, sampleRatioTest } from './srm.js';

export type DecisionCode =
  | 'NOT_STARTED' | 'ENDED' | 'BLOCKED' | 'NO_DATA' | 'DO_NOT_ACT'
  | 'KEEP_RUNNING' | 'DO_NOT_SHIP' | 'SHIP' | 'KEEP_CONTROL' | 'INCONCLUSIVE';

export const DOCS = {
  create: 'https://docs.flagsmith.com/experimentation/create-an-experiment',
  warehouse: 'https://docs.flagsmith.com/experimentation/connect-a-warehouse',
  run: 'https://docs.flagsmith.com/experimentation/run-an-experiment',
  analyse: 'https://docs.flagsmith.com/experimentation/analyse-an-experiment',
  statistics: 'https://docs.flagsmith.com/experimentation/statistics',
};

// Thresholds from Flagsmith's analyse page and statistics glossary.
export const MIN_IDENTITIES = 50;
export const MIN_CONVERSIONS = 5;
export const SRM_MIN_IDENTITIES = 100;
export const SRM_P_THRESHOLD = 0.001;
export const WIN_CHANCE = 0.95;
export const LOSE_CHANCE = 0.05;

export interface ArmSummary {
  label: string;
  isControl: boolean;
  allocation: number;
  identities: number;
  /** Sum of the primary metric for this variation (conversions for an occurrence metric). */
  metricSum: number | null;
  identitiesShort: number;
  conversionsShort: number;
  inference: Inference | null;
  /** Chance that the primary metric moved in the expected direction against control. */
  chance: number | null;
}

export interface Decision {
  code: DecisionCode;
  /** Short label such as "SHIP start_free". */
  headline: string;
  reason: string;
  exitCode: number;
  rule: { quote: string; url: string };
  winner: string | null;
  primaryMetric: string | null;
  arms: ArmSummary[];
  srm: (SrmResult & { source: 'flagsmith' | 'verdict'; mismatch: boolean }) | null;
  guardrail: { metric: string; variation: string; chanceWrongWay: number } | null;
  excludedIdentities: number;
  asOf: string | null;
  notes: string[];
}

const EXIT: Record<DecisionCode, number> = {
  SHIP: 0, KEEP_CONTROL: 0, ENDED: 0,
  NOT_STARTED: 10, NO_DATA: 10, KEEP_RUNNING: 10, INCONCLUSIVE: 10,
  BLOCKED: 20, DO_NOT_ACT: 20, DO_NOT_SHIP: 20,
};

const isGuardrail = (m: ExperimentMetric) => m.expectedDirection === 'not_increase' || m.expectedDirection === 'not_decrease';

/** Chance that the true lift is above zero, from the lift and its 95% interval. */
export function chanceOfIncrease(i: Inference): number {
  const sd = (i.ciHigh - i.ciLow) / (2 * 1.959964);
  if (!(sd > 0)) return i.lift > 0 ? 1 : i.lift < 0 ? 0 : 0.5;
  return normalCdf(i.lift / sd);
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const signedPct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

export interface DecideInput {
  experiment: Experiment;
  exposures: Exposures | null;
  results: Results | null;
  /** Undefined means the warehouse was not checked. Null means the environment has none. */
  warehouse?: Warehouse | null;
}

/** Pure decision function. Rows are applied in order and the first match wins. */
export function decide({ experiment, exposures, results, warehouse }: DecideInput): Decision {
  const notes: string[] = [];
  const primaryMeta = experiment.metrics.find((m) => !isGuardrail(m)) ?? null;
  const primary = primaryMeta ? results?.metrics.find((m) => m.metricId === primaryMeta.metricId) ?? null : null;
  const anyMetric = primary ?? results?.metrics[0] ?? null;

  const arms: ArmSummary[] = experiment.variations.map((v) => {
    const label = labelOf(v);
    const identities = anyMetric?.variants[label]?.n ?? exposures?.perVariation[label] ?? 0;
    const metricSum = primary?.variants[label]?.sum ?? null;
    const inference = v.isControl ? null : primary?.inference[label] ?? null;
    let chance: number | null = null;
    if (inference) {
      chance = primaryMeta?.expectedDirection === 'decrease' ? 1 - chanceOfIncrease(inference) : inference.chanceToWin;
    }
    return {
      label, isControl: v.isControl, allocation: v.allocation, identities, metricSum,
      identitiesShort: Math.max(0, MIN_IDENTITIES - identities),
      conversionsShort: primaryMeta?.aggregation === 'occurrence' && metricSum !== null ? Math.max(0, MIN_CONVERSIONS - metricSum) : 0,
      inference, chance,
    };
  });
  const totalIdentities = arms.reduce((s, a) => s + a.identities, 0);
  const excluded = exposures?.excludedIdentities ?? 0;
  if (excluded > 0) notes.push(`${excluded} identities were seen in more than one variation and are excluded from the analysis.`);
  if (experiment.status === 'paused') notes.push('The experiment is paused, so no new identities are being enrolled.');

  const base = {
    winner: null as string | null,
    primaryMetric: primaryMeta?.name ?? null,
    arms,
    srm: null as Decision['srm'],
    guardrail: null as Decision['guardrail'],
    excludedIdentities: excluded,
    asOf: results?.asOf ?? exposures?.asOf ?? null,
    notes,
  };
  const out = (code: DecisionCode, headline: string, reason: string, quote: string, url: string, extra: Partial<Decision> = {}): Decision => ({
    ...base, code, headline, reason, exitCode: EXIT[code], rule: { quote, url }, ...extra,
  });

  // Row 1
  if (experiment.status === 'created') {
    return out('NOT_STARTED', 'NOT STARTED', 'The experiment is still a draft. Start it to begin enrolling identities.',
      'The flag is locked while the experiment is running.', `${DOCS.run}#while-it-runs`);
  }

  // Row 2
  if (experiment.status === 'completed') {
    const rolled = experiment.variations.find((v) => v.id !== null && v.id === experiment.rolloutVariant);
    const served = experiment.rolloutDecision === 'variant' && rolled ? `Every user now gets "${labelOf(rolled)}".`
      : experiment.rolloutDecision === 'control' ? 'Every user now gets control.'
      : experiment.rolloutDecision === 'disable' ? 'The flag was disabled when the experiment ended.'
      : 'No rollout decision is recorded on the experiment.';
    return out('ENDED', 'ENDED', `The experiment ended${experiment.endedAt ? ` on ${experiment.endedAt.slice(0, 10)}` : ''}. ${served}`,
      'To roll out the winner, update the flag so every user gets the winning variation.', `${DOCS.analyse}#ending-the-experiment`,
      { winner: experiment.rolloutDecision === 'variant' && rolled ? labelOf(rolled) : null });
  }

  // Row 3
  if (warehouse !== undefined) {
    if (warehouse === null) {
      return out('BLOCKED', 'BLOCKED: no warehouse', 'This environment has no warehouse connection, so exposures and events are rejected.',
        'The event ingestion service rejects events for environments without one.', `${DOCS.run}#troubleshooting`);
    }
    if (warehouse.status !== 'connected') {
      if (warehouse.status === 'pending_connection' && warehouse.totalEvents > 0) {
        notes.push(`Warehouse status is still "pending_connection", but it has received ${warehouse.totalEvents} events, so results can be computed.`);
      } else {
        const why = warehouse.status === 'pending_connection'
          ? 'The warehouse is waiting for its first event. Nothing has been received yet.'
          : `The warehouse connection status is "${warehouse.status}"${warehouse.statusDetail ? ` (${warehouse.statusDetail})` : ''}.`;
        return out('BLOCKED', 'BLOCKED: warehouse not connected', why,
          warehouse.status === 'pending_connection' ? 'Pending Connection: waiting for the first event to arrive.' : 'Connected: events have been received; you are ready to run experiments.',
          `${DOCS.warehouse}#connection-statuses`);
      }
    }
  }

  // Row 4
  if (!results || totalIdentities === 0) {
    return out('NO_DATA', 'NO DATA YET',
      results ? 'Flagsmith has computed results, but no exposures were recorded when it did. If traffic has been flowing for a while, run "verdict preflight".'
        : 'Flagsmith has not computed results for this experiment yet.',
      'Results are computed on demand: click Refresh results (at most once every 5 minutes).', `${DOCS.analyse}#results`);
  }

  // Row 5
  if (totalIdentities >= SRM_MIN_IDENTITIES) {
    const observed = Object.fromEntries(arms.map((a) => [a.label, a.identities]));
    const split = Object.fromEntries(arms.map((a) => [a.label, a.allocation]));
    const test = sampleRatioTest(observed, split);
    if (test) {
      const fromApi = results.srmPValue !== null;
      const pValue = fromApi ? results.srmPValue! : test.pValue;
      const mismatch = pValue < SRM_P_THRESHOLD;
      base.srm = { ...test, pValue, source: fromApi ? 'flagsmith' : 'verdict', mismatch };
      if (mismatch) {
        const detail = test.arms.map((a) => `${a.label} ${a.observed} (expected ${Math.round(a.expected)})`).join(', ');
        return out('DO_NOT_ACT', 'DO NOT ACT: sample ratio mismatch',
          `The traffic split does not match the configured split: ${detail}. p = ${pValue.toExponential(1)} (${fromApi ? 'reported by Flagsmith' : `chi-square ${test.chi2.toFixed(2)}, computed by Verdict from the identities per variation`}). Something is dropping exposures for one variation, so the comparison is not trustworthy.`,
          "If a sample ratio mismatch warning appears, traffic didn't split the way you configured. Don't act on the results.", `${DOCS.analyse}#results`);
      }
    }
  }

  // Row 6
  const short = arms.filter((a) => a.identitiesShort > 0 || a.conversionsShort > 0);
  const collecting = arms.filter((a) => !a.isControl).every((a) => a.inference === null);
  if (short.length > 0 || collecting) {
    const parts = short.map((a) => {
      const bits: string[] = [];
      if (a.identitiesShort > 0) bits.push(`${a.identitiesShort} more identities (has ${a.identities})`);
      if (a.conversionsShort > 0) bits.push(`${a.conversionsShort} more conversions (has ${a.metricSum})`);
      return `${a.label} needs ${bits.join(' and ')}`;
    });
    return out('KEEP_RUNNING', 'KEEP RUNNING',
      parts.length ? `Not enough data yet: ${parts.join('; ')}.` : 'Flagsmith is still collecting data for every variation.',
      'While a variation has fewer than 50 identities (or fewer than 5 conversions, for occurrence metrics), it shows Collecting data. Keep the experiment running.', `${DOCS.analyse}#results`);
  }

  // Row 7
  for (const meta of experiment.metrics.filter(isGuardrail)) {
    const result = results.metrics.find((m) => m.metricId === meta.metricId);
    if (!result) continue;
    for (const arm of arms.filter((a) => !a.isControl)) {
      const inf = result.inference[arm.label];
      if (!inf) continue;
      const up = chanceOfIncrease(inf);
      const wrong = meta.expectedDirection === 'not_increase' ? up : 1 - up;
      if (wrong >= WIN_CHANCE) {
        return out('DO_NOT_SHIP', `DO NOT SHIP: guardrail "${meta.name}"`,
          `Guardrail metric "${meta.name}" has a ${pct(wrong)} chance of moving the wrong way for ${arm.label} (lift ${signedPct(inf.lift)}, interval ${signedPct(inf.ciLow)} to ${signedPct(inf.ciHigh)}).`,
          "Guardrail metric: A metric you want to keep an eye on so the change doesn't make it worse.", `${DOCS.statistics}#terms-youll-see`,
          { guardrail: { metric: meta.name, variation: arm.label, chanceWrongWay: wrong } });
      }
    }
  }

  const candidates = arms.filter((a) => !a.isControl && a.inference !== null && a.chance !== null);
  const decrease = primaryMeta?.expectedDirection === 'decrease';
  const describe = (a: ArmSummary) =>
    `lift ${signedPct(a.inference!.lift)}, 95% interval ${signedPct(a.inference!.ciLow)} to ${signedPct(a.inference!.ciHigh)}, chance to beat control ${pct(a.chance!)}`;

  // Row 8
  const winners = candidates
    .filter((a) => a.chance! >= WIN_CHANCE && (decrease ? a.inference!.ciHigh < 0 : a.inference!.ciLow > 0))
    .sort((x, y) => y.chance! - x.chance! || Math.abs(y.inference!.lift) - Math.abs(x.inference!.lift));
  if (winners.length > 0) {
    const w = winners[0];
    return out('SHIP', `SHIP ${w.label}`, `${w.label} beats control on "${primaryMeta!.name}": ${describe(w)}.`,
      'When a variation reaches a 95% chance of beating control, a recommendation banner suggests rolling it out.', `${DOCS.analyse}#results`,
      { winner: w.label });
  }

  // Row 9
  if (candidates.length > 0 && candidates.every((a) => a.chance! <= LOSE_CHANCE)) {
    const worst = candidates.map((a) => `${a.label}: ${describe(a)}`).join('; ');
    return out('KEEP_CONTROL', 'KEEP CONTROL', `No variation beats control on "${primaryMeta!.name}". ${worst}.`,
      'Winning = over 95% chance to win. Losing = under 5%.', `${DOCS.statistics}#terms-youll-see`, { winner: CONTROL });
  }

  // Row 10
  const summary = candidates.map((a) => `${a.label}: ${describe(a)}`).join('; ');
  return out('INCONCLUSIVE', 'INCONCLUSIVE',
    `No variation has reached a ${pct(WIN_CHANCE, 0)} chance of beating control and the interval still includes zero. ${summary}. Keep the experiment running.`,
    'Credible Interval (95%): the range the true delta sits in with 95% certainty. If it crosses zero, the result is inconclusive.', `${DOCS.analyse}#results`);
}

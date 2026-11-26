import { Decision } from '../decide/decide.js';
import { CONTROL, Experiment, labelOf } from '../model.js';
import { Facts } from '../scan/facts.js';

export interface PlanStep { n: number; title: string; action: string; detail: string }
export interface CleanupItem {
  file: string; line: number; snippet: string; variation: string;
  /** 'losing': the branch is dead after the rollout. 'winner': the comparison is now always true. */
  kind: 'losing' | 'winner';
}

export interface ShipPlan {
  experiment: { id: number; name: string; flag: string };
  winner: string;
  winnerIsControl: boolean;
  /** Body for POST experiments/{id}/complete/. */
  completeBody: { rollout_decision: 'control' | 'variant'; rollout_variant?: number };
  steps: PlanStep[];
  cleanup: CleanupItem[];
  undo: string;
  override: string | null;
  decision: { code: string; headline: string; reason: string; asOf: string | null };
  /** The command a human runs to carry out the plan. */
  command: string;
}

export class PlanError extends Error {}

export interface PlanOptions { override?: string; winner?: string }

/**
 * Builds the change plan. Refuses unless the decision is SHIP or KEEP CONTROL,
 * or a human gave a reason with --override (which is written to the audit log).
 */
export function buildPlan(experiment: Experiment, decision: Decision, facts: Facts | null, opts: PlanOptions = {}): ShipPlan {
  if (experiment.status === 'completed') throw new PlanError(`"${experiment.name}" has already ended. Nothing to ship.`);
  if (experiment.status === 'created') throw new PlanError(`"${experiment.name}" has not been started.`);
  const shippable = decision.code === 'SHIP' || decision.code === 'KEEP_CONTROL';
  if (!shippable && !opts.override) {
    throw new PlanError(`The decision for "${experiment.name}" is ${decision.headline}, not SHIP. ${decision.reason}\nTo go ahead anyway, a human must pass --override "<reason>"${decision.winner ? '' : ' and --winner <variation>'}. The reason is written to the audit log.`);
  }
  const winner = opts.winner ?? decision.winner;
  if (!winner) throw new PlanError('There is no winner to ship. Pass --winner <variation> together with --override "<reason>".');
  if (opts.winner && opts.winner !== decision.winner && !opts.override) throw new PlanError('--winner needs --override "<reason>" when it differs from the decision.');
  const variation = experiment.variations.find((v) => labelOf(v) === winner);
  if (!variation) throw new PlanError(`"${winner}" is not a variation of ${experiment.flag.name}. Variations: ${experiment.variations.map(labelOf).join(', ')}.`);

  const winnerIsControl = variation.isControl;
  const completeBody: ShipPlan['completeBody'] = winnerIsControl
    ? { rollout_decision: 'control' }
    : { rollout_decision: 'variant', rollout_variant: variation.id! };

  const winnerLabels = new Set([winner, variation.value]);
  const known = new Set(experiment.variations.flatMap((v) => [labelOf(v), v.value]));
  const cleanup: CleanupItem[] = (facts?.compares ?? [])
    .filter((c) => c.flag === experiment.flag.name && known.has(c.literal))
    .map((c) => ({ file: c.file, line: c.line, snippet: c.snippet, variation: c.literal, kind: winnerLabels.has(c.literal) ? 'winner' as const : 'losing' as const }));

  const flag = experiment.flag.name;
  const steps: PlanStep[] = [
    {
      n: 1, title: `End the experiment and roll out ${winner} to everyone`,
      action: `POST experiments/${experiment.id}/complete/ ${JSON.stringify(completeBody)}`,
      detail: winnerIsControl
        ? 'Results are frozen as final, the flag is unlocked, and every user gets control.'
        : `Results are frozen as final, the flag is unlocked, and the weight of ${winner} is set to 100%.`,
    },
    {
      n: 2, title: 'Verify what users get',
      action: `flagsmith eval ${flag} --identity verdict-probe-1 ... verdict-probe-5`,
      detail: `Five fresh identities must all resolve to ${winner}. Retries for up to 40 seconds while the change propagates.`,
    },
    {
      n: 3, title: 'List code to clean up',
      action: `write .verdict/cleanup-${flag}.md`,
      detail: facts
        ? cleanup.length ? `${cleanup.length} variation check${cleanup.length === 1 ? '' : 's'} on this flag found in the code.` : 'No variation checks on this flag were found in the scanned code.'
        : 'No code path was scanned; pass a path to list the branches.',
    },
  ];

  const undo = winnerIsControl
    ? 'Nothing to undo on the flag: control was already the default. An ended experiment cannot be restarted.'
    : `flagsmith flag update ${flag} --weight ${winner}=0   (returns everyone to ${CONTROL}; an ended experiment cannot be restarted)`;

  return {
    experiment: { id: experiment.id, name: experiment.name, flag },
    winner, winnerIsControl, completeBody, steps, cleanup, undo,
    override: opts.override ?? null,
    decision: { code: decision.code, headline: decision.headline, reason: decision.reason, asOf: decision.asOf },
    command: `verdict ship "${experiment.name}"`,
  };
}

export function planText(plan: ShipPlan): string {
  const out: string[] = [];
  out.push(`Ship plan for "${plan.experiment.name}" (flag ${plan.experiment.flag}, experiment ${plan.experiment.id})`);
  out.push(`Decision: ${plan.decision.headline}`);
  out.push(`  ${plan.decision.reason}`);
  if (plan.override) out.push(`OVERRIDE by a human: ${plan.override}`);
  out.push('');
  for (const s of plan.steps) {
    out.push(`${s.n}. ${s.title}`);
    out.push(`   ${s.action}`);
    out.push(`   ${s.detail}`);
  }
  for (const c of plan.cleanup) out.push(`   - ${c.file}:${c.line}  ${c.snippet}  (${c.kind === 'winner' ? 'now always true' : 'dead after rollout'})`);
  out.push('');
  out.push(`Undo: ${plan.undo}`);
  return out.join('\n');
}

export function cleanupMarkdown(plan: ShipPlan): string {
  const out = [`# Cleanup after "${plan.experiment.name}"`, '', `Flag \`${plan.experiment.flag}\` now serves \`${plan.winner}\` to everyone.`, '',
    'Flagsmith: "Once it\'s permanent, clean up the flag and remove the losing variations."', ''];
  if (plan.cleanup.length === 0) out.push('No variation checks on this flag were found in the scanned code.');
  else {
    out.push('Variation checks on this flag:', '');
    for (const c of plan.cleanup) {
      const what = c.kind === 'winner' ? 'now always true; keep the body, drop the check' : 'dead after the rollout; remove the branch';
      out.push(`- [ ] \`${c.file}:${c.line}\` \`${c.snippet}\` (${c.variation}: ${what})`);
    }
  }
  return out.join('\n') + '\n';
}

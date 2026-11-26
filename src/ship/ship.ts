import { Decision } from '../decide/decide.js';
import { Experiment } from '../model.js';
import { Facts } from '../scan/facts.js';
import { ApprovalIo, NoTtyError, requestApproval } from './approve.js';
import { AuditEntry, appendAudit, approverName } from './audit.js';
import { ExecuteDeps, executePlan } from './execute.js';
import { PlanOptions, ShipPlan, buildPlan, planText } from './plan.js';

export interface ShipDeps extends ExecuteDeps { io: ApprovalIo }
export interface ShipOutcome { exitCode: number; outcome: AuditEntry['outcome'] | 'dry-run'; plan: ShipPlan; auditFile?: string }

function snapshot(decision: Decision): Record<string, unknown> {
  return {
    code: decision.code, headline: decision.headline, asOf: decision.asOf, primaryMetric: decision.primaryMetric,
    arms: decision.arms.map((a) => ({
      variation: a.label, identities: a.identities, metricSum: a.metricSum,
      lift: a.inference?.lift ?? null, ciLow: a.inference?.ciLow ?? null, ciHigh: a.inference?.ciHigh ?? null, chance: a.chance,
    })),
  };
}

/**
 * plan -> typed approval -> execute -> audit. Exit codes: 0 shipped, 1 a step
 * failed, 3 no terminal, 4 approval text did not match.
 */
export async function ship(experiment: Experiment, decision: Decision, facts: Facts | null, opts: PlanOptions & { dryRun?: boolean }, deps: ShipDeps): Promise<ShipOutcome> {
  const plan = buildPlan(experiment, decision, facts, opts);
  deps.log(planText(plan));
  deps.log('');
  if (opts.dryRun) {
    deps.log(`Dry run: nothing was changed. To carry this out, a human runs: ${plan.command}`);
    return { exitCode: 0, outcome: 'dry-run', plan };
  }

  const entry: AuditEntry = {
    time: new Date().toISOString(), action: 'ship', outcome: 'aborted',
    experiment: plan.experiment, winner: plan.winner, decision: snapshot(decision),
    override: plan.override, approver: approverName(deps.cwd), steps: [],
  };

  let approved: boolean;
  try {
    approved = await requestApproval(experiment.name, deps.io);
  } catch (err) {
    if (!(err instanceof NoTtyError)) throw err;
    deps.log(err.message);
    entry.outcome = 'refused';
    return { exitCode: 3, outcome: 'refused', plan, auditFile: appendAudit(deps.cwd, entry) };
  }
  if (!approved) {
    deps.log('The text did not match the experiment name. Aborted; nothing was changed.');
    return { exitCode: 4, outcome: 'aborted', plan, auditFile: appendAudit(deps.cwd, entry) };
  }

  const result = await executePlan(plan, deps);
  entry.steps = result.steps;
  entry.outcome = result.ok ? 'shipped' : 'failed';
  entry.time = new Date().toISOString();
  const auditFile = appendAudit(deps.cwd, entry);
  deps.log('');
  if (result.ok) {
    deps.log(`Shipped: ${plan.experiment.flag} now serves ${plan.winner} to everyone. Approved by ${entry.approver}.`);
  } else {
    const done = result.steps.filter((s) => s.ok).map((s) => s.n);
    deps.log(`Stopped at the first failure. Steps completed: ${done.length ? done.join(', ') : 'none'}.`);
  }
  if (result.steps[0]?.ok) deps.log(`Undo: ${plan.undo}`);
  deps.log(`Audit log: ${auditFile}`);
  return { exitCode: result.ok ? 0 : 1, outcome: entry.outcome, plan, auditFile };
}

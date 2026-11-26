import fs from 'node:fs';
import path from 'node:path';
import { FlagsmithClient } from '../flagsmith/client.js';
import { runFlagsmithCli } from '../flagsmith/cli-transport.js';
import { AuditEntry } from './audit.js';
import { ShipPlan, cleanupMarkdown } from './plan.js';

export interface EvalResult { identity: string; variant: string | null; value: string | null }

/** Resolves the flag for one identity, the way an SDK would. */
export type Evaluator = (flag: string, identity: string) => Promise<EvalResult>;

/** Uses `flagsmith eval`, so verification shows exactly what the CLI reports. */
export function cliEvaluator(environmentKey: string): Evaluator {
  return async (flag, identity) => {
    const r = await runFlagsmithCli(['eval', flag, '--identity', identity, '--json', '--no-input'], undefined, { ...process.env, FLAGSMITH_ENVIRONMENT: environmentKey });
    try {
      const json = JSON.parse(r.stdout);
      return { identity, variant: json.variant ?? null, value: json.value === undefined ? null : String(json.value) };
    } catch {
      return { identity, variant: null, value: null };
    }
  };
}

/** Uses the SDK API directly with the client-side environment key. Identities are transient (not stored). */
export function httpEvaluator(environmentKey: string, baseUrl = 'https://edge.api.flagsmith.com'): Evaluator {
  return async (flag, identity) => {
    try {
      const res = await fetch(`${baseUrl}/api/v1/identities/?identifier=${encodeURIComponent(identity)}&transient=true`, { headers: { 'X-Environment-Key': environmentKey } });
      const json: any = await res.json();
      const f = (json.flags ?? []).find((x: any) => x.feature?.name === flag);
      return { identity, variant: f?.variant ?? null, value: f ? String(f.feature_state_value) : null };
    } catch {
      return { identity, variant: null, value: null };
    }
  };
}

export interface ExecuteDeps {
  client: Pick<FlagsmithClient, 'completeExperiment'>;
  evaluate: Evaluator;
  cwd: string;
  log: (line: string) => void;
  /** Total time to wait for the rollout to reach the SDK API. */
  verifyTimeoutMs?: number;
  verifyIntervalMs?: number;
}

export interface ExecuteResult { ok: boolean; steps: AuditEntry['steps']; cleanupFile: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the plan in order and stops at the first failure. */
export async function executePlan(plan: ShipPlan, deps: ExecuteDeps): Promise<ExecuteResult> {
  const steps: AuditEntry['steps'] = [];
  const [s1, s2, s3] = plan.steps;

  // 1. End the experiment and apply the rollout.
  const res = await deps.client.completeExperiment(plan.experiment.id, plan.completeBody);
  const ok1 = res.status >= 200 && res.status < 300 && res.json?.status === 'completed';
  steps.push({ n: s1.n, title: s1.title, ok: ok1, status: res.status, detail: ok1 ? `rollout_decision=${res.json.rollout_decision}` : JSON.stringify(res.json).slice(0, 300) });
  deps.log(`${ok1 ? 'done  ' : 'FAILED'} 1. ${s1.title} (HTTP ${res.status})`);
  if (!ok1) return { ok: false, steps, cleanupFile: null };

  // 2. Verify with fresh identities. The change takes a few seconds to reach the SDK API.
  const stamp = Date.now().toString(36);
  const deadline = Date.now() + (deps.verifyTimeoutMs ?? 40000);
  let attempt = 0;
  let results: EvalResult[] = [];
  let ok2 = false;
  for (;;) {
    attempt += 1;
    results = [];
    for (let i = 1; i <= 5; i++) results.push(await deps.evaluate(plan.experiment.flag, `verdict-probe-${stamp}-${attempt}-${i}`));
    ok2 = results.every((r) => r.variant === plan.winner || (r.variant === null && r.value === plan.winner));
    if (ok2 || Date.now() >= deadline) break;
    await sleep(deps.verifyIntervalMs ?? 5000);
  }
  const got = results.map((r) => r.variant ?? r.value ?? 'no answer').join(', ');
  steps.push({ n: s2.n, title: s2.title, ok: ok2, detail: `5 identities resolved to: ${got} (attempt ${attempt})` });
  deps.log(`${ok2 ? 'done  ' : 'FAILED'} 2. ${s2.title}: ${got}`);
  if (!ok2) return { ok: false, steps, cleanupFile: null };

  // 3. Cleanup list.
  const file = path.join(deps.cwd, '.verdict', `cleanup-${plan.experiment.flag}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cleanupMarkdown(plan));
  steps.push({ n: s3.n, title: s3.title, ok: true, detail: `${plan.cleanup.length} variation checks listed` });
  deps.log(`done   3. ${s3.title}: ${path.relative(deps.cwd, file)}`);
  return { ok: true, steps, cleanupFile: file };
}

import fs from 'node:fs';
import path from 'node:path';
import { Decision, decide } from './decide/decide.js';
import { FlagsmithClient } from './flagsmith/client.js';
import { LiveState } from './live.js';
import { Experiment, Exposures, Results, Warehouse } from './model.js';

export interface StatusReport {
  experiment: Experiment;
  decision: Decision;
  dashboardUrl: string | null;
  /** What happened with the results refresh on this run. */
  refresh: string;
  source: 'live' | 'snapshot';
}

interface Cache { experiments: Record<string, { refreshedAt?: string; excluded?: number; rollout?: string }> }

const STALE_MS = 5 * 60 * 1000;

function cachePath(cwd: string): string { return path.join(cwd, '.verdict', 'cache.json'); }
function readCache(cwd: string): Cache {
  try { return JSON.parse(fs.readFileSync(cachePath(cwd), 'utf8')); } catch { return { experiments: {} }; }
}
function writeCache(cwd: string, cache: Cache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath(cwd)), { recursive: true });
    fs.writeFileSync(cachePath(cwd), JSON.stringify(cache, null, 2));
  } catch { /* the cache is an optimisation; a read-only checkout must not break status */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rolloutFingerprint = (e: Experiment) => `${e.rolloutPercentage}|${e.variations.map((v) => `${v.key ?? v.value}:${v.allocation}`).join(',')}`;

export interface StatusOptions { refresh?: boolean; cwd?: string; waitMs?: number }

/** Reads one experiment from Flagsmith, refreshes stale results when allowed, and decides. */
export async function statusLive(client: FlagsmithClient, experiment: Experiment, warehouse: Warehouse | null, opts: StatusOptions = {}): Promise<StatusReport> {
  const cwd = opts.cwd ?? process.cwd();
  const cache = readCache(cwd);
  const entry = (cache.experiments[experiment.id] ??= {});
  let exposures: Exposures | null = null;
  let results: Results | null = null;
  let refresh = 'not needed';

  if (experiment.status !== 'created') {
    [exposures, results] = await Promise.all([client.getExposures(experiment.id), client.getResults(experiment.id)]);
    const asOf = results?.asOf ? Date.parse(results.asOf) : 0;
    const lastAsked = entry.refreshedAt ? Date.parse(entry.refreshedAt) : 0;
    const active = experiment.status === 'running' || experiment.status === 'paused';
    const stale = Date.now() - asOf > STALE_MS;
    if (opts.refresh === false) refresh = 'skipped (--no-refresh)';
    else if (!active) refresh = 'not needed (results are final)';
    else if (!stale) refresh = 'not needed (results are less than 5 minutes old)';
    else if (Date.now() - lastAsked < STALE_MS) refresh = 'skipped (a refresh was requested less than 5 minutes ago)';
    else {
      const [r] = await Promise.all([client.refreshResults(experiment.id), client.refreshExposures(experiment.id)]);
      entry.refreshedAt = new Date().toISOString();
      if (r.requested) {
        refresh = 'requested';
        const deadline = Date.now() + (opts.waitMs ?? 20000);
        while (Date.now() < deadline) {
          await sleep(4000);
          const next = await client.getResults(experiment.id);
          if (next?.asOf && next.asOf !== results?.asOf) {
            results = next;
            exposures = await client.getExposures(experiment.id);
            refresh = 'refreshed just now';
            break;
          }
        }
        if (refresh === 'requested') refresh = 'requested; Flagsmith is still computing, run status again shortly';
      } else if (r.status === 429) {
        refresh = `not allowed yet (Flagsmith allows one every 5 minutes; try again in ${r.retryAfterSeconds} s)`;
      } else {
        refresh = `failed (HTTP ${r.status})`;
      }
    }
  }

  const decision = decide({ experiment, exposures, results, warehouse });

  if (entry.excluded !== undefined && decision.excludedIdentities > entry.excluded) {
    decision.notes.push(`Excluded identities grew from ${entry.excluded} to ${decision.excludedIdentities} since the last run. A growing number means users are slipping between variations.`);
  }
  entry.excluded = decision.excludedIdentities;
  if (experiment.rolloutPercentage !== null && experiment.status === 'running') {
    const fp = rolloutFingerprint(experiment);
    if (entry.rollout && entry.rollout !== fp) decision.notes.push('The rollout changed since Verdict first saw this experiment. Changing it mid-experiment can affect the statistical validity of the results.');
    entry.rollout ??= fp;
  }
  writeCache(cwd, cache);

  const projectId = await client.projectId();
  return { experiment, decision, dashboardUrl: client.dashboardUrl(projectId, experiment.id), refresh, source: 'live' };
}

/** Decides from a saved snapshot. Makes no network calls. */
export function statusFromSnapshot(state: LiveState, experiment: Experiment): StatusReport {
  const decision = decide({
    experiment,
    exposures: state.exposures?.[experiment.id] ?? null,
    results: state.results?.[experiment.id] ?? null,
    warehouse: state.warehouse,
  });
  return { experiment, decision, dashboardUrl: null, refresh: `none (snapshot taken ${state.capturedAt})`, source: 'snapshot' };
}

export function findInState(state: LiveState, ref: string): Experiment {
  const lower = ref.toLowerCase();
  const all = state.experiments;
  const match = all.find((e) => String(e.id) === ref) ?? all.find((e) => e.name === ref) ?? all.find((e) => e.name.toLowerCase() === lower)
    ?? all.find((e) => e.flag.name === ref && e.status !== 'completed') ?? all.find((e) => e.flag.name === ref);
  if (!match) throw new Error(`No experiment matches "${ref}". Experiments: ${all.map((e) => `"${e.name}" (${e.flag.name})`).join(', ') || 'none'}.`);
  return match;
}

/** Worst exit code across several reports, for `verdict status` without an argument. */
export function combinedExitCode(reports: StatusReport[]): number {
  return reports.reduce((worst, r) => Math.max(worst, r.decision.exitCode), 0);
}

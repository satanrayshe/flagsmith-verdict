import { LiveState } from './live.js';
import { PreflightReport, runRules } from './rules/index.js';
import { scan } from './scan/extract.js';

/** Scans `root` and runs the rules. With `live` null only the code rules run. */
export async function preflight(root: string, live: LiveState | null): Promise<PreflightReport> {
  const started = Date.now();
  const facts = await scan(root);
  const report = runRules(facts, live);
  report.notes.unshift(`Scanned ${facts.filesScanned} files in ${Date.now() - started} ms.`);
  return report;
}

export function preflightExitCode(report: PreflightReport, failOn: 'error' | 'warning' = 'error'): number {
  if (report.counts.error > 0) return 1;
  if (failOn === 'warning' && report.counts.warning > 0) return 1;
  return 0;
}

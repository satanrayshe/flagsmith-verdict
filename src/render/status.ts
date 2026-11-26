import pc from 'picocolors';
import { Decision, DecisionCode } from '../decide/decide.js';
import { StatusReport } from '../status.js';

const COLOR: Record<DecisionCode, (s: string) => string> = {
  SHIP: pc.green, KEEP_CONTROL: pc.green, ENDED: pc.cyan,
  NOT_STARTED: pc.yellow, NO_DATA: pc.yellow, KEEP_RUNNING: pc.yellow, INCONCLUSIVE: pc.yellow,
  BLOCKED: pc.red, DO_NOT_ACT: pc.red, DO_NOT_SHIP: pc.red,
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function armRows(d: Decision): string[][] {
  const rows = [['variation', 'split', 'identities', d.primaryMetric ?? 'metric', 'lift', '95% interval', 'chance to beat control']];
  for (const a of d.arms) {
    rows.push([
      a.label, `${a.allocation}%`, String(a.identities), a.metricSum === null ? '-' : String(a.metricSum),
      a.isControl ? 'baseline' : a.inference ? signed(a.inference.lift) : 'collecting',
      a.inference ? `${signed(a.inference.ciLow)} to ${signed(a.inference.ciHigh)}` : '-',
      a.chance === null ? '-' : pct(a.chance),
    ]);
  }
  return rows;
}

function table(rows: string[][], indent = '  '): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => indent + r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

export function statusText(r: StatusReport): string {
  const d = r.decision;
  const e = r.experiment;
  const out: string[] = [];
  out.push(`${pc.bold(e.name)}  ${pc.dim(`flag ${e.flag.name}, experiment ${e.id}, ${e.status}`)}`);
  out.push(`  ${COLOR[d.code](pc.bold(d.headline))}`);
  out.push(`  ${d.reason}`);
  if (d.arms.some((a) => a.identities > 0)) out.push('', ...table(armRows(d)));
  if (d.srm && !d.srm.mismatch) out.push(pc.dim(`  Traffic split check: ok (p = ${d.srm.pValue.toFixed(3)}, ${d.srm.source === 'flagsmith' ? 'reported by Flagsmith' : 'chi-square computed by Verdict'}).`));
  for (const n of d.notes) out.push(`  note: ${n}`);
  out.push('');
  out.push(pc.dim(`  Rule: "${d.rule.quote}"`));
  out.push(pc.dim(`        ${d.rule.url}`));
  out.push(pc.dim(`  Results as of ${d.asOf ?? 'n/a'}. Refresh: ${r.refresh}.`));
  if (r.dashboardUrl) out.push(pc.dim(`  Dashboard: ${r.dashboardUrl}`));
  return out.join('\n');
}

export function statusLine(r: StatusReport): string {
  return `${r.experiment.name} (${r.experiment.flag.name}): ${r.decision.headline}. ${r.decision.reason}`;
}

export function statusListText(reports: StatusReport[]): string {
  if (reports.length === 0) return 'No experiments in this environment.';
  return reports.map(statusText).join('\n\n');
}

export function statusMarkdown(reports: StatusReport[]): string {
  const out: string[] = ['## Verdict status', ''];
  if (reports.length === 0) out.push('No experiments in this environment.');
  for (const r of reports) {
    const d = r.decision;
    out.push(`### ${r.experiment.name}: ${d.headline}`, '', d.reason, '');
    if (d.arms.some((a) => a.identities > 0)) {
      const rows = armRows(d);
      out.push(`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`), '');
    }
    for (const n of d.notes) out.push(`- ${n}`);
    out.push(`Rule: "${d.rule.quote}" ([docs](${d.rule.url}))`, '', `Results as of ${d.asOf ?? 'n/a'}.${r.dashboardUrl ? ` [Open in Flagsmith](${r.dashboardUrl})` : ''}`, '');
  }
  return out.join('\n');
}

export function statusJson(reports: StatusReport[]): string {
  return JSON.stringify(reports.map((r) => ({
    experiment: { id: r.experiment.id, name: r.experiment.name, flag: r.experiment.flag.name, status: r.experiment.status },
    decision: r.decision.code, headline: r.decision.headline, reason: r.decision.reason, exitCode: r.decision.exitCode,
    winner: r.decision.winner, rule: r.decision.rule, primaryMetric: r.decision.primaryMetric, arms: r.decision.arms,
    srm: r.decision.srm, guardrail: r.decision.guardrail, excludedIdentities: r.decision.excludedIdentities,
    asOf: r.decision.asOf, notes: r.decision.notes, refresh: r.refresh, dashboardUrl: r.dashboardUrl, source: r.source,
  })), null, 2);
}

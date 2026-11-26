import pc from 'picocolors';
import { PreflightReport } from '../rules/index.js';
import { Finding, Severity } from '../rules/types.js';

const LABEL: Record<Severity, string> = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' };
const paint: Record<Severity, (s: string) => string> = { error: pc.red, warning: pc.yellow, info: pc.cyan };

const where = (f: Finding) => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function modeLine(r: PreflightReport): string {
  if (r.mode === 'offline') return `Mode: offline (code rules only; skipped ${r.rulesSkipped.join(', ')})`;
  if (r.mode === 'snapshot') return 'Mode: code + saved Flagsmith snapshot';
  return 'Mode: code + live Flagsmith configuration';
}

export function summaryLine(r: PreflightReport): string {
  const { error, warning, info } = r.counts;
  if (error + warning + info === 0) return 'PASS: no problems found.';
  const parts = [plural(error, 'error'), plural(warning, 'warning'), ...(info ? [`${info} info`] : [])].join(', ');
  return error > 0 ? `FAIL: ${parts}.` : `PASS with notes: ${parts}.`;
}

export function preflightText(r: PreflightReport): string {
  const out: string[] = [pc.bold('verdict preflight'), modeLine(r), ''];
  for (const f of r.findings) {
    out.push(`${paint[f.severity](pc.bold(LABEL[f.severity]))} ${pc.bold(f.ruleId)} ${f.title}`);
    if (f.file) out.push(`  ${where(f)}${f.snippet ? `  ${pc.dim(f.snippet)}` : ''}`);
    out.push(`  ${f.message}`);
    if (f.fix) out.push(`  Fix: ${f.fix}`);
    out.push(pc.dim(`  Docs: "${f.quote}"`));
    out.push(pc.dim(`        ${f.docUrl}`));
    out.push('');
  }
  for (const n of r.notes) out.push(pc.dim(`note: ${n}`));
  if (r.notes.length) out.push('');
  const line = summaryLine(r);
  out.push(r.counts.error > 0 ? pc.red(pc.bold(line)) : pc.green(pc.bold(line)));
  return out.join('\n');
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function preflightMarkdown(r: PreflightReport): string {
  const out: string[] = ['## Verdict preflight', '', `**${summaryLine(r)}**`, '', modeLine(r), ''];
  if (r.findings.length) {
    out.push('| Level | Rule | Where | Problem | Fix |', '|---|---|---|---|---|');
    for (const f of r.findings) {
      out.push(`| ${LABEL[f.severity].trim()} | [${f.ruleId}](${f.docUrl}) ${cell(f.title)} | ${f.file ? `\`${cell(where(f))}\`` : ''} | ${cell(f.message)} | ${cell(f.fix ?? '')} |`);
    }
    out.push('');
  }
  if (r.notes.length) out.push(...r.notes.map((n) => `- ${n}`), '');
  return out.join('\n');
}

export function preflightJson(r: PreflightReport): string {
  return JSON.stringify({ summary: summaryLine(r), ...r }, null, 2);
}

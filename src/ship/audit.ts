import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AuditEntry {
  time: string;
  action: 'ship';
  outcome: 'shipped' | 'failed' | 'aborted' | 'refused';
  experiment: { id: number; name: string; flag: string };
  winner: string | null;
  decision: Record<string, unknown>;
  override: string | null;
  approver: string;
  steps: { n: number; title: string; ok: boolean; status?: number; detail?: string }[];
}

/** Name of the person approving: git user.name, else the OS user. Never an email or a key. */
export function approverName(cwd: string): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (name) return name;
  } catch { /* not a git checkout */ }
  try { return os.userInfo().username; } catch { return 'unknown'; }
}

export function auditPath(cwd: string): string { return path.join(cwd, '.verdict', 'audit.jsonl'); }

export function appendAudit(cwd: string, entry: AuditEntry): string {
  const file = auditPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return file;
}

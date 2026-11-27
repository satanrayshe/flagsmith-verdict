import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, here } from './helpers.js';

// The skill in skills/flagsmith-ship-winner is checked against the Agent Skills
// specification (https://agentskills.io/specification), and its script is run
// against a stand-in for the Flagsmith CLI. No network calls.
const skillsDir = path.join(here, '..', 'skills');
const skillDir = path.join(skillsDir, 'flagsmith-ship-winner');
const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

/** Splits SKILL.md into its frontmatter (top-level keys, with one level of nested maps) and body. */
function parseSkill(text: string): { front: Record<string, string | Record<string, string>>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter between --- lines');
  const front: Record<string, string | Record<string, string>> = {};
  let map: Record<string, string> | null = null;
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (const line of m[1].split('\n')) {
    const nested = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(.*)$/);
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && map) map[nested[1]] = unquote(nested[2]);
    else if (top && top[2] === '') front[top[1]] = map = {};
    else if (top) { front[top[1]] = unquote(top[2]); map = null; }
    else throw new Error(`Unexpected frontmatter line: ${line}`);
  }
  return { front, body: m[2] };
}

describe('skill follows the Agent Skills specification', () => {
  const { front, body } = parseSkill(skillMd);

  it('every folder under skills/ is a skill with a SKILL.md', () => {
    for (const dir of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      expect(dir.isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(skillsDir, dir.name, 'SKILL.md'))).toBe(true);
    }
  });
  it('uses only the fields the specification defines', () => {
    const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
    expect(Object.keys(front).filter((k) => !allowed.includes(k))).toEqual([]);
  });
  it('name: 1-64 characters, lowercase letters, digits and single hyphens, same as the folder', () => {
    const name = front.name as string;
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).toBe(path.basename(skillDir));
  });
  it('description: 1-1024 characters, says what it does and when to use it', () => {
    const description = front.description as string;
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
    expect(description).toMatch(/Flagsmith/);
  });
  it('compatibility is at most 500 characters and metadata maps strings to strings', () => {
    expect((front.compatibility as string).length).toBeLessThanOrEqual(500);
    expect(typeof front.license).toBe('string');
    expect(typeof front.metadata).toBe('object');
    for (const v of Object.values(front.metadata as Record<string, string>)) expect(typeof v).toBe('string');
  });
  it('SKILL.md stays small: under 500 lines and well under 5000 tokens', () => {
    expect(skillMd.split('\n').length).toBeLessThan(500);
    // About 4 characters per token. The budget here is much tighter than the specification's.
    expect(Math.ceil(skillMd.length / 4)).toBeLessThan(1500);
    expect(body.trim().length).toBeGreaterThan(0);
  });
  it('only the specification folders are used, and every file is referenced from SKILL.md', () => {
    const entries = fs.readdirSync(skillDir).sort();
    expect(entries).toEqual(['SKILL.md', 'references', 'scripts']);
    for (const folder of ['references', 'scripts']) {
      for (const file of fs.readdirSync(path.join(skillDir, folder))) {
        expect(fs.statSync(path.join(skillDir, folder, file)).isFile()).toBe(true);
        expect(body).toContain(`${folder}/${file}`);
      }
    }
  });
  it('file references are relative, one level deep, and exist', () => {
    const links = [...skillMd.matchAll(/\]\(([^)]+)\)/g)].map((x) => x[1]).filter((l) => !/^https?:/.test(l));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toMatch(/^(references|scripts)\/[^/]+$/);
      expect(fs.existsSync(path.join(skillDir, link))).toBe(true);
    }
    // Reference files do not chain to further reference files.
    for (const file of fs.readdirSync(path.join(skillDir, 'references'))) {
      const text = fs.readFileSync(path.join(skillDir, 'references', file), 'utf8');
      expect(text).not.toMatch(/\]\((?!https?:)[^)]*\)/);
    }
  });
  it('keeps the safety rules: the agent never runs the write', () => {
    expect(body).toMatch(/a human runs it in their own terminal/);
    expect(body).toMatch(/Never run it yourself/);
    expect(body).toContain('--dry-run');
    // Every command block in SKILL.md is read-only.
    const blocks = [...body.matchAll(/```sh\n([\s\S]*?)```/g)].map((x) => x[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const block of blocks) {
      expect(block).not.toMatch(/-X\s+(POST|PUT|PATCH|DELETE)|flag update|flag disable|--yes|--override/);
      if (block.includes('verdict ship')) expect(block).toContain('--dry-run');
    }
  });
});

describe('scripts/verify.mjs', () => {
  const script = path.join(skillDir, 'scripts', 'verify.mjs');
  const KEY = 'FakeEnvKey1234567890';
  const exp = (over: Record<string, unknown> = {}) => ({
    id: 77, name: 'CTA copy', status: 'completed', rollout_decision: 'variant', rollout_variant: 100, ended_at: '2026-11-27T10:00:00Z',
    feature: { id: 10, name: 'cta_copy', initial_value: 'control', multivariate_options: [{ id: 100, key: 'start_free', string_value: 'Start free' }] },
    ...over,
  });
  function verify(state: Record<string, unknown>, ...args: string[]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-skill-'));
    const r = spawnSync(process.execPath, [script, ...args], {
      cwd, encoding: 'utf8',
      env: { ...process.env, FLAGSMITH_CLI_PATH: fixture('fake-flagsmith.mjs'), FAKE_FLAGSMITH: JSON.stringify({ environment: KEY, ...state }) },
    });
    const file = path.join(cwd, '.verdict', 'audit.jsonl');
    const audit = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    fs.rmSync(cwd, { recursive: true, force: true });
    return { ...r, audit };
  }

  it('VERIFIED: one line, exit 0, one audit line', () => {
    const r = verify({ experiments: [exp()], evals: { cta_copy: ['start_free'] } }, 'CTA copy', '--wait', '0');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/^VERIFIED cta_copy \(experiment 77 "CTA copy"\): 5 of 5 fresh identities get start_free\./);
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ action: 'verify', outcome: 'verified', winner: 'start_free', identities: 5, matched: 5, experiment: { id: 77, name: 'CTA copy', flag: 'cta_copy' } });
    expect(typeof r.audit[0].checked_by).toBe('string');
  });
  it('finds the experiment by id or by flag name, and honours --identities', () => {
    const state = { experiments: [exp({ id: 5, name: 'Old', status: 'running' }), exp()], evals: { cta_copy: ['start_free'] } };
    expect(verify(state, '77', '--identities', '3', '--wait', '0').stdout).toContain('3 of 3 fresh identities get start_free');
    expect(verify(state, '--identities', '2', 'cta_copy', '--wait', '0').stdout).toContain('experiment 77');
  });
  it('NOT SHIPPED: a running experiment exits 3, evaluates nothing and writes no audit line', () => {
    const r = verify({ experiments: [exp({ status: 'running', rollout_decision: null, rollout_variant: null })], evals: {} }, 'CTA copy');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/^NOT SHIPPED cta_copy .*status is running/);
    expect(r.audit).toHaveLength(0);
  });
  it('MISMATCH: exit 1, says what identities got, and records it', () => {
    const r = verify({ experiments: [exp()], evals: { cta_copy: ['start_free', 'control'] } }, 'CTA copy', '--identities', '4', '--wait', '0');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^MISMATCH cta_copy .*expected start_free, 2 of 4 fresh identities got it \(start_free, control, start_free, control\)/);
    expect(r.audit[0]).toMatchObject({ outcome: 'mismatch', matched: 2, got: ['start_free', 'control', 'start_free', 'control'] });
  });
  it('a rollout to control expects the flag default; --no-audit writes nothing', () => {
    const r = verify({ experiments: [exp({ rollout_decision: 'control', rollout_variant: null })], evals: { cta_copy: ['control'] } }, 'CTA copy', '--wait', '0', '--no-audit');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5 of 5 fresh identities get control');
    expect(r.stdout).not.toContain('audit');
    expect(r.audit).toHaveLength(0);
  });
  it('errors exit 2 with a plain message and never print the environment key', () => {
    const unknown = verify({ experiments: [exp()] }, 'Nope');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('no experiment matches "Nope". Known: 77 "CTA copy".');
    const noEnv = verify({ environment: null }, 'CTA copy');
    expect(noEnv.status).toBe(2);
    expect(noEnv.stderr).toContain('no environment is set');
    expect(verify({}).status).toBe(2);
    const all = [unknown, noEnv, verify({ experiments: [exp()], evals: { cta_copy: ['start_free'] } }, 'CTA copy', '--wait', '0')];
    for (const r of all) expect(r.stdout + r.stderr + JSON.stringify(r.audit)).not.toContain(KEY);
  });
});

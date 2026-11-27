#!/usr/bin/env node
// Read-only check after a human has shipped an experiment winner.
//
//   node scripts/verify.mjs <experiment id | name | flag> [--identities N] [--wait SECONDS] [--no-audit]
//
// It confirms the experiment is completed, asks `flagsmith eval` what fresh
// identities now get, prints ONE line, and appends ONE line to
// .verdict/audit.jsonl in the current directory. It never writes to Flagsmith.
//
// Needs Node 20+ and the Flagsmith CLI v2, logged in, with an environment set
// (flagsmith.json or FLAGSMITH_ENVIRONMENT). No npm packages.
//
// Exit codes: 0 verified, 1 identities get something else, 3 the experiment has
// not been completed, 2 anything that stopped the check.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flagAt = (name) => args.indexOf(name);
const opt = (name, fallback) => (flagAt(name) >= 0 ? args[flagAt(name) + 1] : fallback);
const valueFlags = ['--identities', '--wait'];
const ref = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
const identities = Number(opt('--identities', 5));
const waitSeconds = Number(opt('--wait', 40));

function stop(message, code = 2) {
  console.error(`verify: ${message}`);
  process.exit(code);
}

if (!ref || !(identities >= 1 && identities <= 20) || !(waitSeconds >= 0)) {
  stop('usage: node scripts/verify.mjs <experiment id | name | flag> [--identities 1-20] [--wait SECONDS] [--no-audit]');
}

// Start the Flagsmith CLI without a shell, so nothing in an experiment or flag
// name is ever interpreted by one. An npm install on Windows leaves a .cmd shim
// that Node cannot start directly; the shim only runs index.js, so do the same.
function findCli() {
  const override = process.env.FLAGSMITH_CLI_PATH;
  if (override) return /\.(c|m)?js$/.test(override) ? [process.execPath, override] : [override];
  if (process.platform !== 'win32') return ['flagsmith'];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'flagsmith.exe'))) return [path.join(dir, 'flagsmith.exe')];
    const script = path.join(dir, 'node_modules', '@flagsmith', 'cli', 'index.js');
    if (fs.existsSync(path.join(dir, 'flagsmith.cmd')) && fs.existsSync(script)) return [process.execPath, script];
  }
  return ['flagsmith'];
}
const [command, ...prefix] = findCli();

function flagsmith(...cliArgs) {
  const r = spawnSync(command, [...prefix, ...cliArgs, '--json', '--no-input'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error) stop(`could not start the Flagsmith CLI (${r.error.code ?? r.error.message}). Install it and run "flagsmith login".`);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim().split('\n').pop() };
  try { return { ok: true, json: JSON.parse(r.stdout) }; } catch { return { ok: false, error: 'the CLI did not return JSON' }; }
}

const config = flagsmith('config');
const environment = config.ok ? config.json?.environment?.value : null;
if (!environment) stop('no environment is set. Run "flagsmith init", or set FLAGSMITH_ENVIRONMENT to the client-side environment key.');
// The key is only ever placed in the request path. It is never printed or stored.
const scrub = (text) => String(text).split(environment).join('<environment>');

const list = flagsmith('api', `api/v1/environments/${environment}/experiments/?page_size=100`);
if (!list.ok) stop(`could not list experiments: ${scrub(list.error)}`);
const all = list.json.results ?? [];
const lower = ref.toLowerCase();
const experiment =
  all.find((e) => String(e.id) === ref) ??
  all.find((e) => e.name === ref) ??
  all.find((e) => e.name.toLowerCase() === lower) ??
  all.find((e) => e.feature?.name === ref && e.status === 'completed') ??
  all.find((e) => e.feature?.name === ref);
if (!experiment) stop(`no experiment matches "${ref}". Known: ${all.map((e) => `${e.id} "${e.name}"`).join(', ') || 'none'}.`);

const flag = experiment.feature.name;
const label = `${flag} (experiment ${experiment.id} "${experiment.name}")`;
if (experiment.status !== 'completed') {
  console.log(`NOT SHIPPED ${label}: status is ${experiment.status}. A human has not completed it; nothing to verify.`);
  process.exit(3);
}

let expected;
if (experiment.rollout_decision === 'variant') {
  const option = (experiment.feature.multivariate_options ?? []).find((o) => o.id === experiment.rollout_variant);
  if (!option) stop(`the rolled-out variation ${experiment.rollout_variant} is not on flag ${flag}.`);
  expected = option.key ?? String(option.string_value ?? option.integer_value ?? option.boolean_value);
} else if (experiment.rollout_decision === 'control') {
  expected = String(experiment.feature.initial_value ?? 'control');
} else {
  stop(`rollout decision is "${experiment.rollout_decision}", which this check does not cover. Check the flag in the dashboard.`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36);
const deadline = Date.now() + waitSeconds * 1000;
let got = [];
let attempt = 0;
for (;;) {
  attempt += 1;
  got = [];
  for (let i = 1; i <= identities; i++) {
    // Evaluated transiently: these probe identities are not stored in Flagsmith.
    const r = flagsmith('eval', flag, '--identity', `skill-probe-${stamp}-${attempt}-${i}`);
    got.push(r.ok ? String(r.json.variant ?? r.json.value) : 'no answer');
  }
  if (got.every((g) => g === expected) || Date.now() >= deadline) break;
  await sleep(5000); // a rollout takes a few seconds to reach the SDK API
}
const matched = got.filter((g) => g === expected).length;
const ok = matched === identities;

function who() {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (name) return name;
  } catch { /* not a git checkout */ }
  try { return os.userInfo().username; } catch { return 'unknown'; }
}

let audit = '';
if (!args.includes('--no-audit')) {
  const file = path.join(process.cwd(), '.verdict', 'audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    time: new Date().toISOString(), action: 'verify', outcome: ok ? 'verified' : 'mismatch',
    experiment: { id: experiment.id, name: experiment.name, flag }, winner: expected,
    identities, matched, got: ok ? undefined : got, attempts: attempt, ended_at: experiment.ended_at ?? null, checked_by: who(),
  }) + '\n');
  audit = ' Audit line added to .verdict/audit.jsonl.';
}

if (ok) {
  console.log(`VERIFIED ${label}: ${matched} of ${identities} fresh identities get ${expected}.${audit}`);
} else {
  console.log(`MISMATCH ${label}: expected ${expected}, ${matched} of ${identities} fresh identities got it (${got.join(', ')}).${audit} Tell the human; see references/rollback.md.`);
  process.exitCode = 1;
}

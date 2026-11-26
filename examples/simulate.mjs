#!/usr/bin/env node
// SIMULATED TRAFFIC for the Verdict demo project.
//
// Everything this script sends is synthetic: made-up identities ("sim-...") and
// conversions drawn from fixed probabilities with a seeded random generator.
// It exists so the demo experiments have data to analyse. Do not point it at a
// production environment.
//
// Usage:
//   FLAGSMITH_SERVER_KEY=ser.xxx node examples/simulate.mjs <preset> [--count N] [--env-file path]
// Presets: cta_copy | hero_layout | plan_toggle | warmup
import fs from 'node:fs';
import { Flagsmith } from '@flagsmith/nodejs';

const PRESETS = {
  // Reaches a clear winner: start_free converts more often than control.
  cta_copy: { flag: 'cta_copy', prefix: 'sim-cta', count: 600, rates: { control: 0.08, start_free: 0.12 } },
  // Too few identities to act on.
  hero_layout: { flag: 'hero_layout', prefix: 'sim-hero', count: 40, rates: { control: 0.08, split_hero: 0.1 } },
  // Sample ratio mismatch: about 40% of annual_first exposures are never
  // recorded, as if that variation crashed before it rendered.
  plan_toggle: {
    flag: 'plan_toggle', prefix: 'sim-plan', count: 400,
    rates: { control: 0.08, annual_first: 0.08 }, dropExposure: { annual_first: 0.4 },
  },
  // A small first batch to check the event pipeline.
  warmup: { flag: 'cta_copy', prefix: 'sim-cta', count: 60, rates: { control: 0.08, start_free: 0.12 } },
};

const args = process.argv.slice(2);
const presetName = args.find((a) => !a.startsWith('--'));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const preset = PRESETS[presetName];
if (!preset) {
  console.error(`Usage: node examples/simulate.mjs <${Object.keys(PRESETS).join('|')}> [--count N] [--start N] [--env-file path]`);
  process.exit(2);
}

const envFile = opt('--env-file');
if (envFile) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const environmentKey = process.env.FLAGSMITH_SERVER_KEY || process.env.FLAGSMITH_ENVIRONMENT_KEY;
if (!environmentKey) {
  console.error('Set FLAGSMITH_SERVER_KEY (or FLAGSMITH_ENVIRONMENT_KEY), or pass --env-file.');
  process.exit(2);
}

const count = Number(opt('--count') ?? preset.count);
const start = Number(opt('--start') ?? 1);

// Seeded generator (mulberry32) so a rerun makes the same choices per identity.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

console.log(`=== SIMULATED TRAFFIC: ${count} synthetic identities on "${preset.flag}" ===`);

const flagsmith = new Flagsmith({ environmentKey, enableEvents: true });
const tally = {};
const bump = (variant, field) => { tally[variant] ??= { identities: 0, exposures: 0, conversions: 0 }; tally[variant][field] += 1; };

async function visit(n) {
  const identifier = `${preset.prefix}-${String(n).padStart(4, '0')}`;
  const random = rng(hash(identifier));
  let variant;
  if (preset.dropExposure) {
    // Evaluate without recording, then record the exposure by hand so some can be dropped.
    const flags = await flagsmith.getIdentityFlags(identifier);
    const flag = flags.getFlag(preset.flag);
    variant = flag.variant ?? String(flag.value);
    bump(variant, 'identities');
    if (!flag.experiment?.inExperiment) return;
    if (random() < (preset.dropExposure[variant] ?? 0)) return; // SIMULATED crash before render
    flagsmith.trackExposureEvent(preset.flag, { identifier, value: flag.value });
  } else {
    const flag = await flagsmith.getExperimentFlag(preset.flag, identifier);
    variant = flag.variant ?? String(flag.value);
    bump(variant, 'identities');
  }
  bump(variant, 'exposures');
  if (random() < (preset.rates[variant] ?? 0)) {
    flagsmith.trackEvent('signup', { identifier });
    bump(variant, 'conversions');
  }
}

const CONCURRENCY = 5;
let next = start;
const end = start + count;
let failures = 0;
async function worker() {
  while (next < end) {
    const n = next++;
    try { await visit(n); } catch (err) { failures += 1; if (failures <= 3) console.error(`identity ${n} failed: ${err.message}`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await flagsmith.close(30000);

console.table(tally);
if (failures) console.log(`${failures} identities failed.`);
console.log('=== SIMULATED TRAFFIC sent. These numbers are what the script sent, not Flagsmith results. ===');

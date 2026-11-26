import { describe, expect, it } from 'vitest';
import { RULES, editDistance, runRules } from '../src/rules/index.js';
import { experiment, factsOf, flag, liveState } from './helpers.js';

const ids = (r: ReturnType<typeof runRules>, severity?: string) =>
  r.findings.filter((f) => !severity || f.severity === severity).map((f) => f.ruleId);

const BROWSER_OK = `
import flagsmith from '@flagsmith/flagsmith';
await flagsmith.init({ environmentID: 'x', enableEvents: true });
await flagsmith.identify(localStorage.getItem('uid'));
const flag = flagsmith.getExperimentFlag('cta_copy');
if (flag.variant === 'start_free') { show(); }
button.onclick = () => flagsmith.trackEvent('signup');
`;

describe('rule catalogue', () => {
  it('has 14 rules with stable ids, a doc link and a quote each', () => {
    expect(RULES.map((r) => r.id)).toEqual(Array.from({ length: 14 }, (_, i) => `VD${String(i + 1).padStart(3, '0')}`));
    for (const r of RULES) {
      expect(r.docUrl).toMatch(/^https:\/\/docs\.flagsmith\.com\/experimentation\//);
      expect(r.quote.length).toBeGreaterThan(20);
    }
  });
  it('a correct app has no findings', () => {
    const r = runRules(factsOf({ 'app.js': BROWSER_OK }), liveState());
    expect(r.findings).toEqual([]);
  });
});

describe('VD001 events not enabled', () => {
  it('fires when init has no enableEvents and the code uses experiments', () => {
    const r = runRules(factsOf({ 'a.js': `flagsmith.init({ environmentID: 'x' }); flagsmith.identify(uid); flagsmith.getExperimentFlag('cta_copy');` }), null);
    expect(ids(r, 'error')).toEqual(['VD001']);
    expect(r.findings[0]).toMatchObject({ file: 'a.js', line: 1 });
  });
  it('fires for enableEvents: false, a Node client and a React provider', () => {
    const r = runRules(factsOf({
      'a.js': `flagsmith.init({ environmentID: 'x', enableEvents: false }); flagsmith.identify(u); flagsmith.trackEvent('signup');`,
      'server.ts': `import { Flagsmith } from '@flagsmith/nodejs'; const fs = new Flagsmith({ environmentKey: k }); await fs.close();`,
      'App.tsx': `export const App = () => <FlagsmithProvider flagsmith={flagsmith} options={{ environmentID: 'x', identity: 'u' }}><Page /></FlagsmithProvider>;`,
    }), null);
    expect(ids(r, 'error')).toEqual(['VD001', 'VD001', 'VD001']);
  });
  it('stays quiet when options are spread, events are on, or no experiment API is used', () => {
    expect(ids(runRules(factsOf({ 'a.js': `flagsmith.init({ ...base, environmentID: 'x' }); flagsmith.identify(u); flagsmith.getExperimentFlag('f');` }), null))).toEqual([]);
    expect(ids(runRules(factsOf({ 'a.js': `flagsmith.init({ environmentID: 'x' }); flagsmith.hasFeature('f');` }), null))).toEqual([]);
  });
});

describe('VD002 SDK version', () => {
  it('flags old versions and old package names', () => {
    const r = runRules(factsOf({
      'package.json': JSON.stringify({ dependencies: { '@flagsmith/flagsmith': '^12.3.1', '@flagsmith/nodejs': '9.0.0', 'flagsmith-nodejs': '^8.0.0', flagsmith: '^10.0.0' } }),
    }), null);
    expect(ids(r)).toEqual(['VD002', 'VD002', 'VD002', 'VD002']);
  });
  it('accepts versions with experiment support and ignores non-semver ranges', () => {
    const r = runRules(factsOf({ 'package.json': JSON.stringify({ dependencies: { '@flagsmith/flagsmith': '^12.4.0', '@flagsmith/nodejs': '~9.4.0' }, devDependencies: { '@flagsmith/flagsmith': 'workspace:*' } }) }), null);
    expect(ids(r)).toEqual([]);
  });
});

describe('VD003 experiment flag unknown', () => {
  it('fires for a flag that does not exist and suggests the near name', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK.replace("getExperimentFlag('cta_copy')", "getExperimentFlag('cta-copy')") }), liveState());
    const f = r.findings.find((x) => x.ruleId === 'VD003')!;
    expect(f.severity).toBe('error');
    expect(f.fix).toContain('cta_copy');
  });
  it('fires for a flag with no variations; info when the flag has no experiment', () => {
    const plain = runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ flags: [flag({ variations: [] })] }));
    expect(plain.findings.find((x) => x.ruleId === 'VD003')?.severity).toBe('error');
    const noExperiment = runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ experiments: [] }));
    expect(noExperiment.findings.find((x) => x.ruleId === 'VD003')?.severity).toBe('info');
  });
});

describe('VD004 variation without a key', () => {
  const noKey = () => {
    const e = experiment();
    e.variations[1].key = null;
    return e;
  };
  it('is an error for a flag the code reads', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ experiments: [noKey()] }));
    expect(r.findings.find((x) => x.ruleId === 'VD004')?.severity).toBe('error');
  });
  it('is a warning for another experiment in the environment, and ignored once completed', () => {
    const other = noKey();
    other.flag.name = 'other_flag';
    expect(runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ experiments: [experiment(), other] })).findings.find((x) => x.ruleId === 'VD004')?.severity).toBe('warning');
    other.status = 'completed';
    expect(ids(runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ experiments: [experiment(), other] })))).toEqual([]);
  });
});

describe('VD005 event name mismatch', () => {
  it('points at the near-miss call and gives the fix', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK.replace("trackEvent('signup')", "trackEvent('Signup')") }), liveState());
    const f = r.findings.find((x) => x.ruleId === 'VD005')!;
    expect(f).toMatchObject({ severity: 'error', file: 'a.js', fix: "Rename the event to 'signup'." });
  });
  it('catches a one-character typo and a missing event', () => {
    expect(ids(runRules(factsOf({ 'a.js': BROWSER_OK.replace("trackEvent('signup')", "trackEvent('signups')") }), liveState()))).toEqual(['VD005']);
    const missing = runRules(factsOf({ 'a.js': BROWSER_OK.replace("button.onclick = () => flagsmith.trackEvent('signup');", '') }), liveState());
    expect(missing.findings[0]).toMatchObject({ ruleId: 'VD005', severity: 'error', line: null });
  });
  it('downgrades to a warning when event names are dynamic, and skips experiments the code does not use', () => {
    const dynamic = runRules(factsOf({ 'a.js': BROWSER_OK.replace("trackEvent('signup')", 'trackEvent(name)') }), liveState());
    expect(dynamic.findings[0]).toMatchObject({ ruleId: 'VD005', severity: 'warning' });
    const unused = runRules(factsOf({ 'a.js': `flagsmith.init({ environmentID: 'x', enableEvents: true });` }), liveState());
    expect(ids(unused)).toEqual([]);
  });
});

describe('VD006 reserved event name', () => {
  it('fires on a name starting with $', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK + `flagsmith.trackEvent('$purchase');` }), null);
    expect(ids(r)).toEqual(['VD006']);
  });
});

describe('VD007 local evaluation', () => {
  const server = (opts: string) => `import { Flagsmith } from '@flagsmith/nodejs';
const fs = new Flagsmith({ environmentKey: k, enableEvents: true${opts} });
const flag = await fs.getExperimentFlag('cta_copy', userId);
fs.trackEvent('signup', { identifier: userId });
await fs.close();`;
  it('warns for enableLocalEvaluation with getExperimentFlag', () => {
    expect(ids(runRules(factsOf({ 's.ts': server(', enableLocalEvaluation: true') }), null))).toEqual(['VD007']);
    expect(ids(runRules(factsOf({ 's.ts': server('') }), null))).toEqual([]);
  });
});

describe('VD008 warehouse', () => {
  const run = (warehouse: any) => runRules(factsOf({ 'a.js': BROWSER_OK }), liveState({ warehouse })).findings.filter((f) => f.ruleId === 'VD008');
  const base = { id: 1, type: 'flagsmith', statusDetail: null, lastEventAt: null };
  it('error with no warehouse or an errored one', () => {
    expect(run(null)[0].severity).toBe('error');
    expect(run({ ...base, status: 'errored', totalEvents: 0 })[0].severity).toBe('error');
  });
  it('warning while pending with no events; info when pending but events arrive; quiet when connected', () => {
    expect(run({ ...base, status: 'pending_connection', totalEvents: 0 })[0].severity).toBe('warning');
    expect(run({ ...base, status: 'pending_connection', totalEvents: 65 })[0].severity).toBe('info');
    expect(run({ ...base, status: 'connected', totalEvents: 65 })).toEqual([]);
  });
});

describe('VD009 dead variation branch', () => {
  const withBranch = (code: string) => runRules(factsOf({ 'a.js': BROWSER_OK.replace("if (flag.variant === 'start_free') { show(); }", code) }), liveState());
  it('fires on a literal that is not a variation and suggests the near key', () => {
    const f = withBranch(`if (flag.variant === 'start-free') { show(); }`).findings.find((x) => x.ruleId === 'VD009')!;
    expect(f.fix).toBe("Change it to 'start_free'.");
  });
  it('follows a variable, destructuring, a switch and optional chaining', () => {
    expect(ids(withBranch(`const v = flag.variant; if ('startfree' == v) { show(); } if (v === 'start_free') {}`))).toEqual(['VD009']);
    expect(ids(withBranch(`const { variant } = flagsmith.getExperimentFlag('cta_copy'); if (variant !== 'nope') {} if (variant === 'start_free') {}`))).toEqual(['VD009']);
    expect(ids(withBranch(`switch (flag?.variant) { case 'start_free': break; case 'control': break; case 'old_copy': break; }`))).toEqual(['VD009']);
  });
  it('accepts control and comparisons on the value', () => {
    expect(ids(withBranch(`if (flag.variant === 'control') {} if (flag.value === 'start_free') {}`))).toEqual([]);
  });
  it('React: useExperiment result', () => {
    const r = runRules(factsOf({
      'Cta.tsx': `export function Cta() { const cta = useExperiment('cta_copy'); return cta.variant === 'startFree' ? <b>A</b> : <i>B</i>; }`,
      'App.tsx': `export const App = () => <FlagsmithProvider options={{ environmentID: 'x', identity: uid, enableEvents: true }}><Cta /></FlagsmithProvider>;`,
      't.ts': `flagsmith.trackEvent('signup');`,
    }), liveState());
    expect(ids(r)).toEqual(['VD009']);
  });
});

describe('VD010 to VD014 heuristics (warnings)', () => {
  it('VD010: browser code that never identifies', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK.replace("await flagsmith.identify(localStorage.getItem('uid'));", '') }), null);
    expect(ids(r, 'warning')).toEqual(['VD010']);
  });
  it('VD011: random or time-based identity, directly or through a variable', () => {
    expect(ids(runRules(factsOf({ 'a.js': BROWSER_OK.replace("localStorage.getItem('uid')", "'u' + Math.random()") }), null))).toEqual(['VD011']);
    expect(ids(runRules(factsOf({ 'a.js': `const id = String(Date.now()); flagsmith.init({ environmentID: 'x', enableEvents: true, identity: id }); flagsmith.getExperimentFlag('f');` }), null))).toEqual(['VD011']);
    expect(ids(runRules(factsOf({ 'a.js': `const id = crypto.randomUUID(); flagsmith.init({ environmentID: 'x', enableEvents: true }); flagsmith.identify(id); flagsmith.getExperimentFlag('f');` }), null))).toEqual(['VD011']);
  });
  it('VD011: a random id that is persisted is fine', () => {
    const code = `let id = localStorage.getItem('uid'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('uid', id); }
flagsmith.init({ environmentID: 'x', enableEvents: true }); flagsmith.identify(id); flagsmith.getExperimentFlag('f');`;
    expect(ids(runRules(factsOf({ 'a.js': code }), null))).toEqual([]);
  });
  const server = (body: string) => `import { Flagsmith } from '@flagsmith/nodejs';
const fs = new Flagsmith({ environmentKey: k, enableEvents: true });
${body}`;
  it('VD012: server trackEvent without an identifier', () => {
    expect(ids(runRules(factsOf({ 's.ts': server(`fs.trackEvent('signup'); await fs.close();`) }), null))).toEqual(['VD012']);
    expect(ids(runRules(factsOf({ 's.ts': server(`fs.trackEvent('signup', { identifier: id }); await fs.close();`) }), null))).toEqual([]);
  });
  it('VD013: server client with events and no close or flush anywhere', () => {
    expect(ids(runRules(factsOf({ 's.ts': server(`fs.trackEvent('signup', { identifier: id });`) }), null))).toEqual(['VD013']);
    expect(ids(runRules(factsOf({ 's.ts': server(`fs.trackEvent('signup', { identifier: id });`), 'shutdown.ts': `import { Flagsmith } from '@flagsmith/nodejs'; export const stop = (fs: Flagsmith) => fs.flushEvents();` }), null))).toEqual([]);
  });
  it('VD014: trackExposureEvent without an inExperiment check', () => {
    const bad = server(`const flags = await fs.getIdentityFlags(id); function render() { fs.trackExposureEvent('cta_copy', { identifier: id }); } await fs.close();`);
    const good = server(`const flags = await fs.getIdentityFlags(id); function render(flag) { if (flag.experiment?.inExperiment) fs.trackExposureEvent('cta_copy', { identifier: id }); } await fs.close();`);
    expect(ids(runRules(factsOf({ 's.ts': bad }), null))).toEqual(['VD014']);
    expect(ids(runRules(factsOf({ 's.ts': good }), null))).toEqual([]);
  });
});

describe('offline mode and report', () => {
  it('skips the rules that need Flagsmith and says which', () => {
    const r = runRules(factsOf({ 'a.js': BROWSER_OK.replace("trackEvent('signup')", "trackEvent('Signup')") }), null);
    expect(r.mode).toBe('offline');
    expect(r.rulesSkipped).toEqual(['VD003', 'VD004', 'VD005', 'VD008', 'VD009']);
    expect(r.findings).toEqual([]);
  });
  it('sorts errors before warnings and counts them', () => {
    const r = runRules(factsOf({ 'a.js': `flagsmith.init({ environmentID: 'x' }); flagsmith.identify(Math.random()); flagsmith.getExperimentFlag('cta_copy');` }), null);
    expect(r.findings.map((f) => f.severity)).toEqual(['error', 'warning']);
    expect(r.counts).toEqual({ error: 1, warning: 1, info: 0 });
  });
  it('reports a file that cannot be parsed as a note, not a crash', () => {
    const r = runRules(factsOf({ 'bad.js': 'const = ;;; {{{' , 'a.js': BROWSER_OK }), null);
    expect(r.findings).toEqual([]);
  });
  it('edit distance', () => {
    expect(editDistance('signup', 'signups')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

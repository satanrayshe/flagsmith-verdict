import semver from 'semver';
import { LiveState } from '../live.js';
import { Experiment, labelOf } from '../model.js';
import { Facts, Loc } from '../scan/facts.js';
import { Finding, Rule, Severity } from './types.js';

const RUN = 'https://docs.flagsmith.com/experimentation/run-an-experiment';
const AGENT = 'https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent';
const PAYPAL = 'https://docs.flagsmith.com/experimentation/example-paypal-button';
const CREATE = 'https://docs.flagsmith.com/experimentation/create-an-experiment';
const WAREHOUSE = 'https://docs.flagsmith.com/experimentation/connect-a-warehouse';

const at = (l: Loc) => ({ file: l.file, line: l.line, snippet: l.snippet });
const inFlagsmith = (where: string) => ({ file: where, line: null, snippet: null });

const usesExperimentApi = (f: Facts) => f.experimentFlags.length + f.trackEvents.length + f.exposures.length > 0;
const activeExperiments = (live: LiveState) => live.experiments.filter((e) => e.status !== 'completed');

/** Experiments whose flag the scanned code asks for. */
function experimentsInCode(facts: Facts, live: LiveState): Experiment[] {
  const used = new Set(facts.experimentFlags.map((c) => c.flag));
  return activeExperiments(live).filter((e) => used.has(e.flag.name));
}

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A name that is probably meant to be `wanted`: same ignoring case and punctuation, or one edit away. */
const isNear = (candidate: string, wanted: string) =>
  candidate !== wanted && (squash(candidate) === squash(wanted) || editDistance(candidate.toLowerCase(), wanted.toLowerCase()) <= 1);

const MIN_VERSION: Record<string, string> = { '@flagsmith/flagsmith': '12.4.0', '@flagsmith/nodejs': '9.1.0' };

export const RULES: Rule[] = [
  {
    id: 'VD001', severity: 'error', needsLive: false, title: 'Events are not enabled',
    docUrl: `${RUN}#initialise`,
    quote: 'Enable events when you create the client, with the environment key you already use for flags.',
    check(facts) {
      if (!usesExperimentApi(facts)) return [];
      return facts.inits.filter((i) => i.enableEvents === false).map((i) => ({
        ...at(i),
        message: i.kind === 'node'
          ? 'This client is created without enableEvents, so getExperimentFlag and trackEvent throw.'
          : 'The SDK is initialised without enableEvents. getExperimentFlag then works as a plain flag read: the page renders, and no exposure or event is ever sent.',
        fix: 'Add enableEvents: true to the options.',
      }));
    },
  },
  {
    id: 'VD002', severity: 'error', needsLive: false, title: 'SDK cannot send experiment events',
    docUrl: `${RUN}#sdk-overview`,
    quote: 'Experimentation support: @flagsmith/flagsmith 12.4.0+ [...] @flagsmith/nodejs 9.1.0+. The package was called flagsmith-nodejs before 9.0.0.',
    check(facts) {
      const out: Partial<Finding>[] = [];
      for (const d of facts.deps) {
        const where = { file: d.file, line: null, snippet: `"${d.name}": "${d.range}"` };
        if (d.name === 'flagsmith-nodejs') {
          out.push({ ...where, message: 'flagsmith-nodejs is the old package name. It stops at version 8 and cannot send experiment events.', fix: 'Replace it with @flagsmith/nodejs 9.1.0 or later.' });
        } else if (d.name === 'flagsmith') {
          out.push({ ...where, message: 'The unscoped "flagsmith" package is the old name of the JavaScript SDK and predates experiment support.', fix: 'Replace it with @flagsmith/flagsmith 12.4.0 or later.' });
        } else if (MIN_VERSION[d.name]) {
          const min = semver.validRange(d.range) ? semver.minVersion(d.range) : null;
          if (min && semver.lt(min, MIN_VERSION[d.name])) {
            out.push({ ...where, message: `${d.name} ${d.range} allows a version older than ${MIN_VERSION[d.name]}, the first with experiment support.`, fix: `Upgrade to ${d.name} ${MIN_VERSION[d.name]} or later.` });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'VD003', severity: 'error', needsLive: true, title: 'Experiment flag not found in Flagsmith',
    docUrl: `${CREATE}#0-pre-requisites`,
    quote: 'A multivariate flag with a variation for each treatment you want to test.',
    check(facts, live) {
      if (!live) return [];
      const out: Partial<Finding>[] = [];
      for (const call of facts.experimentFlags) {
        const flag = live.flags.find((f) => f.name === call.flag);
        if (!flag) {
          const near = live.flags.find((f) => isNear(f.name, call.flag));
          out.push({ ...at(call), message: `The project has no flag called "${call.flag}".`, fix: near ? `Did you mean "${near.name}"?` : `Create the flag, or correct the name. Flags in the project: ${live.flags.map((f) => f.name).join(', ') || 'none'}.` });
        } else if (flag.variations.length === 0) {
          out.push({ ...at(call), message: `"${call.flag}" has no variations, so it cannot be used in an experiment.`, fix: `Add one with: flagsmith feature variant add ${call.flag} --value <value> --key <key> --weight 0` });
        } else if (!live.experiments.some((e) => e.flag.name === call.flag)) {
          out.push({ ...at(call), severity: 'info', title: 'Flag is not in an experiment', message: `"${call.flag}" is not in any experiment yet, so this call records nothing.`, fix: null });
        }
      }
      return out;
    },
  },
  {
    id: 'VD004', severity: 'error', needsLive: true, title: 'Variation without a key',
    docUrl: `${RUN}#troubleshooting`,
    quote: 'Exposures are attributed by label, so a variation without one, for example one created through the API without a key, is not counted.',
    check(facts, live) {
      if (!live) return [];
      const out: Partial<Finding>[] = [];
      const used = new Set(facts.experimentFlags.map((c) => c.flag));
      for (const e of activeExperiments(live)) {
        for (const v of e.variations.filter((x) => !x.isControl && x.key === null)) {
          out.push({
            // An error for a flag this codebase reads; a warning for other experiments in the environment.
            severity: used.has(e.flag.name) ? 'error' : 'warning',
            ...inFlagsmith(`Flagsmith: flag "${e.flag.name}", experiment "${e.name}"`),
            message: `Variation "${v.value}" (id ${v.id}) has no key. Flagsmith let the experiment be created, and every exposure of this variation is dropped.`,
            fix: 'Give the variation a key in the dashboard, or recreate it with: flagsmith feature variant add <flag> --value <value> --key <key>',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'VD005', severity: 'error', needsLive: true, title: 'Event name does not match the metric',
    docUrl: `${RUN}#track-conversions`,
    quote: "The event name is case-sensitive and must exactly match the metric's configured event name. Unmatched events are silently ignored.",
    check(facts, live) {
      if (!live) return [];
      const out: Partial<Finding>[] = [];
      const sent = facts.trackEvents.filter((t) => t.name !== null);
      const dynamic = facts.trackEvents.some((t) => t.name === null);
      const seen = new Set<string>();
      for (const e of experimentsInCode(facts, live)) {
        for (const m of e.metrics) {
          if (!m.event || seen.has(m.event)) continue;
          seen.add(m.event);
          if (sent.some((t) => t.name === m.event)) continue;
          const near = sent.filter((t) => isNear(t.name!, m.event!));
          if (near.length > 0) {
            for (const t of near) {
              out.push({ ...at(t), message: `Metric "${m.name}" (experiment "${e.name}") listens for "${m.event}". This sends "${t.name}", which Flagsmith ignores.`, fix: `Rename the event to '${m.event}'.` });
            }
          } else {
            out.push({
              ...inFlagsmith(`Flagsmith: metric "${m.name}", experiment "${e.name}"`),
              severity: dynamic ? 'warning' : 'error',
              message: `No trackEvent('${m.event}') call was found, so this metric will never count a conversion.${dynamic ? ' Some trackEvent calls use a name that is not a string literal and could not be checked.' : ''}`,
              fix: `Send the event where the conversion happens: trackEvent('${m.event}').`,
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'VD006', severity: 'error', needsLive: false, title: 'Reserved event name',
    docUrl: `${RUN}#track-conversions`,
    quote: 'Names starting with `$` are reserved for Flagsmith. (@flagsmith/nodejs trackEvent)',
    check(facts) {
      return facts.trackEvents.filter((t) => t.name?.startsWith('$')).map((t) => ({
        ...at(t), message: `"${t.name}" starts with $. The Node SDK throws on such names and they are reserved for Flagsmith's own events.`, fix: 'Rename the event without the leading $.',
      }));
    },
  },
  {
    id: 'VD007', severity: 'warning', needsLive: false, title: 'Experiment flag read by a local-evaluation client',
    docUrl: `${RUN}#record-exposures`,
    quote: 'The experiment running on this feature, if any. Set by identity evaluation only. (@flagsmith/nodejs Flag.experiment)',
    check(facts) {
      if (!facts.experimentFlags.some((c) => c.nodeFile)) return [];
      return facts.inits.filter((i) => i.kind === 'node' && i.localEvaluation).map((i) => ({
        ...at(i), message: 'This client evaluates flags locally and the repo calls getExperimentFlag. Enrolment is decided by the Flagsmith API per identity, so check that exposures are recorded for this client.', fix: 'Use a client without enableLocalEvaluation for experiment flags.',
      }));
    },
  },
  {
    id: 'VD008', severity: 'error', needsLive: true, title: 'No connected warehouse',
    docUrl: `${RUN}#troubleshooting`,
    quote: 'The environment has a connected warehouse. The event ingestion service rejects events for environments without one.',
    check(_facts, live) {
      if (!live) return [];
      const w = live.warehouse;
      if (!w) return [{ ...inFlagsmith('Flagsmith: Environment Settings > Warehouse'), message: 'This environment has no warehouse connection. Every exposure and event is rejected.', fix: `Connect one: ${WAREHOUSE}` }];
      if (w.status === 'connected') return [];
      if (w.status === 'pending_connection' && w.totalEvents > 0) {
        return [{ ...inFlagsmith('Flagsmith: Environment Settings > Warehouse'), severity: 'info', title: 'Warehouse status is still pending', message: `The warehouse status reads "pending_connection" but it has received ${w.totalEvents} events, so data is arriving.`, fix: null }];
      }
      if (w.status === 'pending_connection' || w.status === 'created') {
        return [{ ...inFlagsmith('Flagsmith: Environment Settings > Warehouse'), severity: 'warning', title: 'Warehouse has received no events', message: 'The warehouse is waiting for its first event. Nothing has been received yet.', fix: 'Send an event from an SDK with enableEvents, then check again.' }];
      }
      return [{ ...inFlagsmith('Flagsmith: Environment Settings > Warehouse'), message: `The warehouse connection status is "${w.status}"${w.statusDetail ? `: ${w.statusDetail}` : ''}.`, fix: `See ${WAREHOUSE}#connection-statuses` }];
    },
  },
  {
    id: 'VD009', severity: 'error', needsLive: true, title: 'Branch for a variation that does not exist',
    docUrl: PAYPAL,
    quote: 'Your code will branch on the variation name, not the flag value, so keep names short and stable.',
    check(facts, live) {
      if (!live) return [];
      const out: Partial<Finding>[] = [];
      for (const c of facts.compares) {
        const flag = live.flags.find((f) => f.name === c.flag);
        if (!flag) continue; // VD003 reports the missing flag
        const keys = ['control', ...flag.variations.map((v) => v.key).filter((k): k is string => k !== null)];
        const values = [flag.defaultValue, ...flag.variations.map((v) => v.value)].filter((v): v is string => v !== null);
        const valid = c.property === 'variant' ? keys : [...new Set([...values, ...keys])];
        if (valid.includes(c.literal)) continue;
        const near = valid.find((k) => isNear(k, c.literal));
        out.push({
          ...at(c),
          message: `"${c.flag}" has no variation "${c.literal}", so this branch never runs. Variations: ${keys.join(', ')}.`,
          fix: near ? `Change it to '${near}'.` : 'Use one of the variation keys above, or add the variation in Flagsmith.',
        });
      }
      return out;
    },
  },
  {
    id: 'VD010', severity: 'warning', needsLive: false, title: 'No identity before the experiment flag is requested',
    docUrl: `${RUN}#instrument-your-application`,
    quote: 'Users must be identified. Exposures and conversion events are joined per identity, so use the same identifier for flags and events.',
    check(facts) {
      const browserCalls = facts.experimentFlags.filter((c) => !c.nodeFile);
      if (browserCalls.length === 0) return [];
      if (facts.identifies.length > 0 || facts.inits.some((i) => i.hasIdentityOption)) return [];
      return browserCalls.slice(0, 1).map((c) => ({
        ...at(c), message: 'No identify() call and no identity option was found in this codebase. Exposures without an identity are skipped.', fix: 'Call identify(<stable id>) before asking for the experiment flag, or pass identity in the init options.',
      }));
    },
  },
  {
    id: 'VD011', severity: 'warning', needsLive: false, title: 'Identity changes on every run',
    docUrl: PAYPAL,
    quote: 'If checkout is available to visitors who aren\'t logged in, identify them with a persistent anonymous GUID so bucketing and events stay consistent.',
    check(facts) {
      const fix = 'Generate the id once and keep it, for example in localStorage or a cookie.';
      const message = 'The identity is random or time based and is not stored, so the same visitor becomes a new identity on each load and can land in a different variation.';
      return [
        ...facts.identifies.filter((i) => i.unstable).map((i) => ({ ...at(i), message, fix })),
        ...facts.inits.filter((i) => i.unstableIdentity).map((i) => ({ ...at(i), message, fix })),
      ];
    },
  },
  {
    id: 'VD012', severity: 'warning', needsLive: false, title: 'Server-side event without an identifier',
    docUrl: `${AGENT}`,
    quote: 'Conversions not counted: the event name doesn\'t exactly match the metric\'s event, or the event was sent with a different identifier from the exposure.',
    check(facts) {
      return facts.trackEvents.filter((t) => t.nodeFile && !t.hasIdentifier).map((t) => ({
        ...at(t), message: 'This server-side trackEvent has no identifier, so the event cannot be joined to an exposure.', fix: 'Pass { identifier } with the same id used for getExperimentFlag.',
      }));
    },
  },
  {
    id: 'VD013', severity: 'warning', needsLive: false, title: 'Buffered events may be lost on exit',
    docUrl: `${RUN}#initialise`,
    quote: 'The SDKs buffer events and send them in batches, by default every 10 seconds. Send what is left before your application exits, as shown in each tab.',
    check(facts) {
      const nodeFiles = facts.files.filter((f) => f.nodeFile);
      if (nodeFiles.length === 0 || nodeFiles.some((f) => f.hasFlushOrClose)) return [];
      return facts.inits.filter((i) => i.kind === 'node' && i.enableEvents !== false).map((i) => ({
        ...at(i), message: 'This client buffers events, and no close() or flushEvents() call was found in the server code. Events still in the buffer are lost when the process exits.', fix: 'Call await flagsmith.close() before the process exits.',
      }));
    },
  },
  {
    id: 'VD014', severity: 'warning', needsLive: false, title: 'Exposure recorded without an enrolment check',
    docUrl: `${RUN}#record-exposures`,
    quote: 'Only record it for identities enrolled in the experiment.',
    check(facts) {
      return facts.exposures.filter((e) => !e.guarded).map((e) => ({
        ...at(e), message: 'trackExposureEvent is called without checking flag.experiment.inExperiment in the same function.', fix: 'Wrap the call in: if (flag.experiment?.inExperiment) { ... }',
      }));
    },
  },
];

export interface PreflightReport {
  root: string;
  mode: 'live' | 'snapshot' | 'offline';
  filesScanned: number;
  findings: Finding[];
  notes: string[];
  rulesRun: string[];
  rulesSkipped: string[];
  counts: Record<Severity, number>;
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Notes that help a reader but are not rule findings. */
function infoNotes(facts: Facts, live: LiveState): string[] {
  const notes: string[] = [];
  const active = experimentsInCode(facts, live);
  const metricEvents = new Set(active.flatMap((e) => e.metrics.map((m) => m.event).filter((x): x is string => Boolean(x))));
  const allMetricEvents = new Set(live.metrics.map((m) => m.event).filter((x): x is string => Boolean(x)));
  const sentNames = [...new Set(facts.trackEvents.map((t) => t.name).filter((x): x is string => x !== null))];
  const unused = sentNames.filter((n) => !allMetricEvents.has(n) && ![...allMetricEvents].some((m) => isNear(n, m)));
  if (unused.length) notes.push(`Events sent in code that no metric uses: ${unused.join(', ')}.`);
  if (live.warehouseEvents) {
    for (const ev of metricEvents) {
      notes.push(live.warehouseEvents.includes(ev) ? `The warehouse has received "${ev}" events.` : `The warehouse has not received any "${ev}" event yet.`);
    }
  }
  for (const e of active) {
    const branched = new Set(facts.compares.filter((c) => c.flag === e.flag.name).map((c) => c.literal));
    if (branched.size === 0) continue;
    const missing = e.variations.filter((v) => !v.isControl && v.key && !branched.has(v.key) && !branched.has(v.value)).map(labelOf);
    if (missing.length) notes.push(`"${e.flag.name}": no branch in code for variation ${missing.join(', ')}.`);
  }
  return notes;
}

export function runRules(facts: Facts, live: LiveState | null): PreflightReport {
  const findings: Finding[] = [];
  const rulesRun: string[] = [];
  const rulesSkipped: string[] = [];
  for (const rule of RULES) {
    if (rule.needsLive && !live) { rulesSkipped.push(rule.id); continue; }
    rulesRun.push(rule.id);
    for (const f of rule.check(facts, live) as Partial<Finding>[]) {
      findings.push({
        ruleId: rule.id, severity: f.severity ?? rule.severity, title: f.title ?? rule.title,
        file: f.file ?? null, line: f.line ?? null, snippet: f.snippet ?? null,
        message: f.message ?? '', fix: f.fix ?? null, docUrl: rule.docUrl, quote: rule.quote,
      });
    }
  }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId) || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  const notes = live ? infoNotes(facts, live) : [];
  for (const p of facts.parseErrors) notes.push(`Could not parse ${p.file}: ${p.message}`);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { root: facts.root, mode: live ? live.source : 'offline', filesScanned: facts.filesScanned, findings, notes, rulesRun, rulesSkipped, counts };
}

#!/usr/bin/env node
import fs from 'node:fs';
import { Command, Option } from 'commander';
import { ConfigError, GlobalOptions, loadEnvFile, makeClient } from './config.js';
import { cliAvailable } from './flagsmith/cli-transport.js';
import { ApiError } from './flagsmith/transport.js';
import { LiveState, loadLiveState, readSnapshot } from './live.js';
import { runMcpServer } from './mcp/server.js';
import { preflight, preflightExitCode } from './preflight.js';
import { preflightJson, preflightMarkdown, preflightText } from './render/preflight.js';
import { statusJson, statusListText, statusMarkdown } from './render/status.js';
import { RULES } from './rules/index.js';
import { scan } from './scan/extract.js';
import { terminalIo } from './ship/approve.js';
import { cliEvaluator, httpEvaluator } from './ship/execute.js';
import { PlanError } from './ship/plan.js';
import { ship } from './ship/ship.js';
import { StatusReport, combinedExitCode, findInState, statusFromSnapshot, statusLive } from './status.js';

const program = new Command();
program
  .name('verdict')
  .description('Checks your code against your live Flagsmith experiments, gives one decision when results arrive, and ships the winner only after a human approves.')
  .version('0.1.0')
  .option('-e, --environment <key>', 'client-side environment key (or FLAGSMITH_ENVIRONMENT, or flagsmith.json)')
  .option('--env-file <path>', 'read FLAGSMITH_API_KEY and FLAGSMITH_ENVIRONMENT from a file')
  .addOption(new Option('--transport <kind>', 'how to reach Flagsmith').choices(['auto', 'cli', 'api-key']).default('auto'));

const globals = (): GlobalOptions => {
  const o = program.opts();
  if (o.envFile) loadEnvFile(o.envFile);
  return { environment: o.environment, transport: o.transport, cwd: process.cwd() };
};
const format = () => new Option('--format <format>', 'output format').choices(['text', 'json', 'markdown']).default('text');

function fail(err: unknown): never {
  const known = err instanceof ConfigError || err instanceof ApiError || err instanceof PlanError;
  console.error(`verdict: ${known || !(err instanceof Error) ? (err as Error).message ?? err : err.stack}`);
  process.exit(2);
}

program
  .command('preflight [path]')
  .description('check a JS/TS codebase against the Flagsmith experiment setup; exit 1 on any error')
  .option('--offline', 'run only the code rules, with no Flagsmith credentials')
  .option('--snapshot <file>', 'compare against a saved snapshot instead of calling Flagsmith')
  .addOption(format())
  .addOption(new Option('--fail-on <level>', 'lowest level that fails the run').choices(['error', 'warning']).default('error'))
  .action(async (path: string | undefined, o) => {
    try {
      let live: LiveState | null = null;
      if (o.snapshot) live = readSnapshot(o.snapshot);
      else if (!o.offline) live = await loadLiveState(makeClient(globals()));
      const report = await preflight(path ?? '.', live);
      console.log(o.format === 'json' ? preflightJson(report) : o.format === 'markdown' ? preflightMarkdown(report) : preflightText(report));
      process.exitCode = preflightExitCode(report, o.failOn);
    } catch (err) { fail(err); }
  });

program
  .command('status [experiment]')
  .description('one decision per experiment, with the reason; without an argument, every experiment in the environment')
  .option('--no-refresh', 'never ask Flagsmith to recompute results')
  .option('--snapshot <file>', 'decide from a saved snapshot instead of calling Flagsmith')
  .addOption(format())
  .action(async (ref: string | undefined, o) => {
    try {
      const reports: StatusReport[] = [];
      if (o.snapshot) {
        const state = readSnapshot(o.snapshot);
        for (const e of ref ? [findInState(state, ref)] : state.experiments) reports.push(statusFromSnapshot(state, e));
      } else {
        const client = makeClient(globals());
        const warehouses = await client.listWarehouses();
        const warehouse = warehouses.find((w) => w.status === 'connected') ?? warehouses[0] ?? null;
        const experiments = ref ? [await client.findExperiment(ref)] : await Promise.all((await client.listExperiments()).map((e) => client.getExperiment(e.id)));
        for (const e of experiments) reports.push(await statusLive(client, e, warehouse, { refresh: o.refresh }));
      }
      console.log(o.format === 'json' ? statusJson(reports) : o.format === 'markdown' ? statusMarkdown(reports) : statusListText(reports));
      process.exitCode = combinedExitCode(reports);
    } catch (err) { fail(err); }
  });

program
  .command('ship <experiment>')
  .description('end the experiment and roll out the winner, after a human types the experiment name')
  .option('--dry-run', 'print the plan and change nothing')
  .option('--path <dir>', 'codebase to scan for branches of the losing variations', '.')
  .option('--override <reason>', 'ship although the decision is not SHIP; the reason goes into the audit log')
  .option('--winner <variation>', 'variation to roll out (needs --override when it differs from the decision)')
  .option('--snapshot <file>', 'with --dry-run: plan from a saved snapshot')
  .action(async (ref: string, o) => {
    try {
      const facts = fs.existsSync(o.path) ? await scan(o.path) : null;
      const base = { override: o.override, winner: o.winner, dryRun: Boolean(o.dryRun) };
      const log = (line: string) => console.log(line);
      if (o.snapshot) {
        if (!o.dryRun) throw new PlanError('--snapshot can only be used with --dry-run.');
        const state = readSnapshot(o.snapshot);
        const report = statusFromSnapshot(state, findInState(state, ref));
        const never = { completeExperiment: async () => { throw new Error('not reachable in a dry run'); } };
        const outcome = await ship(report.experiment, report.decision, facts, base, { client: never, evaluate: async (_f, identity) => ({ identity, variant: null, value: null }), cwd: process.cwd(), log, io: terminalIo() });
        process.exitCode = outcome.exitCode;
        return;
      }
      const g = globals();
      const client = makeClient(g);
      const experiment = await client.findExperiment(ref);
      const warehouses = await client.listWarehouses();
      const warehouse = warehouses.find((w) => w.status === 'connected') ?? warehouses[0] ?? null;
      // No forced refresh here: ship acts on the same numbers that `verdict status` showed.
      const report = await statusLive(client, experiment, warehouse, { refresh: false });
      const evaluate = g.transport !== 'api-key' && cliAvailable() ? cliEvaluator(client.environmentKey) : httpEvaluator(client.environmentKey);
      const outcome = await ship(experiment, report.decision, facts, base, { client, evaluate, cwd: process.cwd(), log, io: terminalIo() });
      process.exitCode = outcome.exitCode;
    } catch (err) { fail(err); }
  });

program
  .command('snapshot')
  .description('save the Flagsmith experiment setup and results to a file for use with --snapshot (holds no keys)')
  .option('--out <file>', 'file to write', 'verdict-snapshot.json')
  .action(async (o) => {
    try {
      const state = await loadLiveState(makeClient(globals()), { withResults: true });
      fs.writeFileSync(o.out, JSON.stringify(state, null, 2) + '\n');
      console.log(`Saved ${state.experiments.length} experiments, ${state.flags.length} flags and ${state.metrics.length} metrics to ${o.out}.`);
    } catch (err) { fail(err); }
  });

program
  .command('rules')
  .description('list the preflight rules')
  .addOption(new Option('--format <format>', 'output format').choices(['text', 'markdown']).default('text'))
  .action((o) => {
    if (o.format === 'markdown') {
      console.log('| Rule | Level | Needs Flagsmith | What it catches |\n|---|---|---|---|');
      for (const r of RULES) console.log(`| [${r.id}](${r.docUrl}) | ${r.severity} | ${r.needsLive ? 'yes' : 'no'} | ${r.title} |`);
    } else {
      for (const r of RULES) console.log(`${r.id}  ${r.severity.padEnd(7)}  ${r.needsLive ? 'live' : 'code'}  ${r.title}\n       ${r.docUrl}`);
    }
  });

program
  .command('mcp')
  .description('start a stdio MCP server with three tools: verdict_preflight, verdict_status, verdict_ship_plan')
  .option('--snapshot <file>', 'serve from a saved snapshot instead of calling Flagsmith')
  .action(async (o) => {
    try { await runMcpServer({ ...globals(), snapshot: o.snapshot }); } catch (err) { fail(err); }
  });

program.parseAsync(process.argv).catch(fail);

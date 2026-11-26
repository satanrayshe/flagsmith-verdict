import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GlobalOptions, makeClient } from '../config.js';
import { LiveState, loadLiveState, readSnapshot } from '../live.js';
import { preflight } from '../preflight.js';
import { preflightText, summaryLine } from '../render/preflight.js';
import { statusJson, statusLine } from '../render/status.js';
import { scan } from '../scan/extract.js';
import { buildPlan, planText } from '../ship/plan.js';
import { StatusReport, findInState, statusFromSnapshot, statusLive } from '../status.js';

export interface McpOptions extends GlobalOptions { snapshot?: string }

const READ_ONLY = 'This tool cannot change anything in Flagsmith.';

const text = (...parts: string[]) => ({ content: parts.map((p) => ({ type: 'text' as const, text: p })) });
const failure = (err: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true });

/**
 * Three tools: check, decide, plan. None of them can ship. The plan ends with
 * the exact command a human has to run in a terminal.
 */
export function createServer(opts: McpOptions): McpServer {
  const server = new McpServer({ name: 'flagsmith-verdict', version: '0.1.0' });
  const live = async (withResults = false): Promise<LiveState> => (opts.snapshot ? readSnapshot(opts.snapshot) : loadLiveState(makeClient(opts), { withResults }));

  const statusFor = async (ref: string | undefined, refresh: boolean): Promise<StatusReport[]> => {
    if (opts.snapshot) {
      const state = readSnapshot(opts.snapshot);
      return (ref ? [findInState(state, ref)] : state.experiments).map((e) => statusFromSnapshot(state, e));
    }
    const client = makeClient(opts);
    const warehouses = await client.listWarehouses();
    const warehouse = warehouses.find((w) => w.status === 'connected') ?? warehouses[0] ?? null;
    const experiments = ref ? [await client.findExperiment(ref)] : await Promise.all((await client.listExperiments()).map((e) => client.getExperiment(e.id)));
    const reports: StatusReport[] = [];
    for (const e of experiments) reports.push(await statusLive(client, e, warehouse, { refresh, cwd: opts.cwd, waitMs: 12000 }));
    return reports;
  };

  server.registerTool('verdict_preflight', {
    title: 'Check experiment instrumentation',
    description: `Scans a JavaScript or TypeScript codebase and compares it with the Flagsmith experiments in the environment. Reports each mistake that would make an experiment collect no data (events not enabled, event name that does not match the metric, branch for a variation that does not exist, variation without a key, and more) with file, line, fix and the Flagsmith doc it comes from. ${READ_ONLY}`,
    inputSchema: {
      path: z.string().describe('Directory or file to scan, absolute or relative to the server working directory.'),
      offline: z.boolean().optional().describe('Run only the code rules and make no Flagsmith API calls.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path, offline }) => {
    try {
      const report = await preflight(path, offline ? null : await live());
      return text(preflightText(report), JSON.stringify({ summary: summaryLine(report), counts: report.counts, findings: report.findings, notes: report.notes }, null, 2));
    } catch (err) { return failure(err); }
  });

  server.registerTool('verdict_status', {
    title: 'Decide what to do with an experiment',
    description: 'Reads exposures and results for one experiment (or all of them when no name is given) and returns one decision with its reason: NOT STARTED, NO DATA YET, DO NOT ACT (sample ratio mismatch), KEEP RUNNING, INCONCLUSIVE, DO NOT SHIP (guardrail), KEEP CONTROL or SHIP <variation>. Each decision cites the Flagsmith rule behind it. The only write it can make is asking Flagsmith to recompute results, at most once every 5 minutes; tell the user when that happened. It cannot change flags or experiments.',
    inputSchema: {
      experiment: z.string().optional().describe('Experiment name, id or flag name. Omit to list every experiment.'),
      refresh: z.boolean().optional().describe('Set false to never ask Flagsmith to recompute results.'),
    },
  }, async ({ experiment, refresh }) => {
    try {
      const reports = await statusFor(experiment, refresh !== false);
      return text(reports.map(statusLine).join('\n') || 'No experiments in this environment.', statusJson(reports));
    } catch (err) { return failure(err); }
  });

  server.registerTool('verdict_ship_plan', {
    title: 'Plan the rollout of a winner',
    description: `Builds the change plan for ending an experiment and rolling out its winner: the API call, the verification step, the code branches to clean up and the undo command. It only plans. ${READ_ONLY} Shipping needs a human to run "verdict ship" in a terminal and type the experiment name; always show the user that command and never claim the rollout was done.`,
    inputSchema: {
      experiment: z.string().describe('Experiment name, id or flag name.'),
      path: z.string().optional().describe('Codebase to scan for branches of the losing variations.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ experiment, path }) => {
    try {
      const [report] = await statusFor(experiment, false);
      const facts = path ? await scan(path) : null;
      const plan = buildPlan(report.experiment, report.decision, facts);
      return text(`${planText(plan)}\n\nA human must run: ${plan.command}\nThis tool has not changed anything.`, JSON.stringify(plan, null, 2));
    } catch (err) { return failure(err); }
  });

  return server;
}

export async function runMcpServer(opts: McpOptions): Promise<void> {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
}

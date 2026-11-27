#!/usr/bin/env node
// A stand-in for the Flagsmith CLI, used by test/skill.test.ts. It answers the
// three calls scripts/verify.mjs makes from the JSON in FAKE_FLAGSMITH and
// never touches the network.
const state = JSON.parse(process.env.FAKE_FLAGSMITH ?? '{}');
const args = process.argv.slice(2);
const out = (json) => { console.log(JSON.stringify(json)); process.exit(0); };

if (args[0] === 'config') out({ environment: { value: state.environment ?? null, name: 'Test', source: 'env' } });
if (args[0] === 'api') {
  if (args.includes('-X')) { console.error('Error: the fake CLI refuses writes'); process.exit(1); }
  if (args[1] === `api/v1/environments/${state.environment}/experiments/?page_size=100`) out({ results: state.experiments ?? [] });
  console.error(`Error: GET https://api.flagsmith.com/${args[1]} returned 404 Not Found`);
  process.exit(1);
}
if (args[0] === 'eval') {
  const answers = state.evals?.[args[1]] ?? [];
  const n = Number(args[args.indexOf('--identity') + 1].split('-').pop());
  const variant = answers[(n - 1) % Math.max(answers.length, 1)];
  if (variant === undefined) { console.error('Error: feature not found'); process.exit(1); }
  out({ name: args[1], enabled: true, value: variant, variant });
}
console.error(`Error: unknown command "${args[0]}"`);
process.exit(1);

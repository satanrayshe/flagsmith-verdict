# Without Verdict: the same job with the Flagsmith CLI only

Use this only when `verdict` cannot run. The rules in SKILL.md still hold: you read, a human writes.

`E` is the experiment's API path:

```sh
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT/experiments/<id>"
```

## Decide

Three reads, a few lines each.

```sh
flagsmith api "api/v1/environments/$FLAGSMITH_ENVIRONMENT/warehouse-connections/" --jq '.[] | {status, total_events_received}'
flagsmith api "$E/" --jq '{status, split: [.experiment_rollout.multivariate_feature_state_values[]? | {id: .multivariate_feature_option, pct: .percentage_allocation}], variations: [.feature.multivariate_options[] | {id, key}], metrics: [.metrics[] | {metric_name, aggregation, direction}]}'
flagsmith api "$E/results/" --jq '.results | {as_of, srm: .payload.srm_p_value, arms: .payload.metrics[0].variants, inference: .payload.metrics[0].inference}'
```

In `arms`, `n` is identities and `sum` is conversions. In `inference`, `chance_to_win`, `lift`, `ci_low` and `ci_high` are fractions (0.95 is 95%). Control gets whatever share `split` leaves.

Apply in order and stop at the first that matches:

1. `status` is `created`: NOT STARTED. `completed`: ENDED.
2. No warehouse row, `status` is `errored`, or `total_events_received` is 0: BLOCKED.
3. `results` is null or every `n` is 0: NO DATA YET.
4. `srm` is below 0.001: DO NOT ACT. When `srm` is null and the `n` values are far from the configured split (for example 204 against 111 on a 50/50 split), treat it as DO NOT ACT and ask the human to look at the experiment page.
5. Any arm has `n` below 50, or `sum` below 5 on an `occurrence` metric: KEEP RUNNING.
6. More than one metric: read each one (`.payload.metrics[1]` and so on). A guardrail with a 95% or higher chance of moving the wrong way: DO NOT SHIP.
7. A variation has `chance_to_win` of 0.95 or more and `ci_low` above 0: SHIP that variation.
8. Every variation has `chance_to_win` of 0.05 or less: KEEP CONTROL.
9. Otherwise: INCONCLUSIVE.

Results older than you need (`as_of`)? One refresh is allowed every 5 minutes: `flagsmith api "$E/results/refresh/" -X POST`. It only recomputes; it changes nothing users see.

Continue only on SHIP or KEEP CONTROL.

## Plan and hand over

Print this for the human, filled in, and wait. Do not run it.

```sh
# Ends "<name>" for good and gives <variation> to every user.
flagsmith api "$E/complete/" -X POST -F rollout_decision=variant -F rollout_variant=<variation id>
# To keep control instead: -F rollout_decision=control
# Undo (returns everyone to control): flagsmith flag update <flag> --weight <variation>=0
```

Ask the human to type the experiment name back to you before they run it, and put their answer in the report.

## Verify and record

`scripts/verify.mjs` does not need Verdict:

```sh
node scripts/verify.mjs "<name>"
```

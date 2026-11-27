# Decisions

`verdict status` applies these rows in order; the first match wins. Thresholds are the ones on Flagsmith's [analyse page](https://docs.flagsmith.com/experimentation/analyse-an-experiment) and [statistics glossary](https://docs.flagsmith.com/experimentation/statistics).

| # | Condition | Decision | Exit | What to tell the user |
|---|---|---|---|---|
| 1 | Experiment is a draft | NOT STARTED | 10 | Start it in Flagsmith first |
| 2 | Experiment has ended | ENDED | 0 | Nothing to ship; verify what users get |
| 3 | No warehouse, or one that is errored or has received no events | BLOCKED | 20 | Fix the warehouse connection |
| 4 | Results not computed, or computed with no exposures | NO DATA YET | 10 | Check the instrumentation with `verdict preflight .` |
| 5 | 100 or more identities and the split differs from the configured one, p below 0.001 | DO NOT ACT | 20 | Sample ratio mismatch: one variation is losing exposures. Results are not trustworthy |
| 6 | A variation has fewer than 50 identities, or fewer than 5 conversions on an occurrence metric | KEEP RUNNING | 10 | The line says how many more are needed |
| 7 | A guardrail metric has a 95% or higher chance of moving the wrong way | DO NOT SHIP | 20 | The winner harms a guardrail |
| 8 | A variation has a 95% or higher chance to beat control and its interval is clear of zero | SHIP | 0 | Continue |
| 9 | Every variation is at 5% or lower | KEEP CONTROL | 0 | Continue; control stays |
| 10 | Anything else | INCONCLUSIVE | 10 | Keep running or accept no difference |

More detail for one experiment (about 15 lines, with the per-variation table and the rule quoted from the docs):

```sh
verdict status "<name>"
```

`verdict status` asks Flagsmith to recompute results that are more than 5 minutes old, at most once every 5 minutes. Pass `--no-refresh` to read only.

A human can ship against a decision with `verdict ship "<name>" --override "<reason>"`. The reason goes into the audit log. Do not suggest it; mention it only if the human asks how.

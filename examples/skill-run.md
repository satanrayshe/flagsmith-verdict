# Skill demo run: `flagsmith-ship-winner`

Recorded on 27 Nov 2026 against the Flagsmith Cloud project `verdict-demo`, environment Development, with Flagsmith CLI v2.0.0 logged in through `flagsmith login`.

What was used:

- **A scratch experiment.** Flag `skill_scratch` (control, and a keyed variation `new_copy`) and experiment "Skill scratch" on the existing `Sign-ups` metric, created for this run and deleted after it.
- **SIMULATED traffic.** `node examples/simulate.mjs custom --flag skill_scratch --prefix sim-skill --rates control=0.10,new_copy=0.40 --count 400`. The script sent 190 control identities with 20 conversions and 210 `new_copy` identities with 85. The lift, interval and chance below are what Flagsmith computed from that.
- **A test harness for the approval.** Step 4 needs a person at a terminal. In this run a harness called the same `ship()` function that `verdict ship` calls and answered the typed prompt with the experiment name. No person typed it. The agent's own attempt to run the command was refused (see "Safety checks").

## What the agent ran and read

Four commands. This is everything the agent wrote to a shell and everything that came back.

```
$ export FLAGSMITH_ENVIRONMENT=$(flagsmith config --jq .environment.value)
flagsmith api "api/v1/environments/$FLAGSMITH_ENVIRONMENT/experiments/?page_size=100" \
  --jq '.results[] | "\(.id)\t\(.status)\t\(.name)\t\(.feature.name)"'
1449	running	Skill scratch	skill_scratch
566	paused	Scratch nokey	verdict_scratch_nokey
564	running	Plan toggle	plan_toggle
563	running	Hero layout	hero_layout
562	running	CTA copy	cta_copy

$ verdict status "Skill scratch" --format brief; echo "exit=$?"
SHIP new_copy | Skill scratch | experiment 1449 | flag skill_scratch | new_copy beats control on "Sign-ups": lift +284.5%, 95% interval +112.6% to +456.4%, chance to beat control 99.9%. | results as of 2026-11-27T15:18:23.338888Z
exit=0

$ verdict ship "Skill scratch" --dry-run --path .
Ship plan for "Skill scratch" (flag skill_scratch, experiment 1449)
Decision: SHIP new_copy
  new_copy beats control on "Sign-ups": lift +284.5%, 95% interval +112.6% to +456.4%, chance to beat control 99.9%.

1. End the experiment and roll out new_copy to everyone
   POST experiments/1449/complete/ {"rollout_decision":"variant","rollout_variant":38305}
   Results are frozen as final, the flag is unlocked, and the weight of new_copy is set to 100%.
2. Verify what users get
   flagsmith eval skill_scratch --identity verdict-probe-1 ... verdict-probe-5
   Five fresh identities must all resolve to new_copy. Retries for up to 40 seconds while the change propagates.
3. List code to clean up
   write .verdict/cleanup-skill_scratch.md
   No variation checks on this flag were found in the scanned code.

Undo: flagsmith flag update skill_scratch --weight new_copy=0   (returns everyone to control; an ended experiment cannot be restarted)

Dry run: nothing was changed. To carry this out, a human runs: verdict ship "Skill scratch"

$ node "$SKILL/scripts/verify.mjs" "Skill scratch"; echo "exit=$?"
VERIFIED skill_scratch (experiment 1449 "Skill scratch"): 5 of 5 fresh identities get new_copy. Audit line added to .verdict/audit.jsonl.
exit=0
```

`$SKILL` is the folder the skill is installed in. Between the third and fourth command the agent printed the hand-off message and waited.

## What the human saw (step 4, answered by the harness)

Paths shortened.

```
Type the experiment name to approve (Skill scratch): Skill scratch
done   1. End the experiment and roll out new_copy to everyone (HTTP 200)
done   2. Verify what users get: new_copy, new_copy, new_copy, new_copy, new_copy
done   3. List code to clean up: .verdict/cleanup-skill_scratch.md

Shipped: skill_scratch now serves new_copy to everyone. Approved by satanrayshe.
Undo: flagsmith flag update skill_scratch --weight new_copy=0   (returns everyone to control; an ended experiment cannot be restarted)
Audit log: .verdict/audit.jsonl
```

## Token count

Method: characters divided by 4, rounded up. No tokenizer was used, so treat the figures as estimates.

| Part | Characters | Tokens (about) |
|---|---|---|
| `SKILL.md`, loaded once when the skill starts | 4,118 | 1,030 |
| The four commands the agent wrote | 403 | 101 |
| All output the agent read | 1,603 | 401 |
| **Total** | **6,124** | **1,531** |

No reference file was loaded; they are only needed on a stop, a mismatch, a rollback or a code clean-up. The agent's own messages to the human (the plan is shown as it is, then the hand-off line and a four-line report) are not counted.

For scale, the same experiment list without `--jq` is 4,202 characters of JSON, against 190 for the five lines above.

## Safety checks made during the run

Not part of the count. Both ran before the harness approved.

```
$ verdict ship "Skill scratch" < /dev/null
verdict ship changes what your users see, so it needs a person at a terminal to approve it. No terminal is attached (stdin or stdout is not a TTY). Nothing was changed.
exit=3

$ node scripts/verify.mjs "Skill scratch"
NOT SHIPPED skill_scratch (experiment 1449 "Skill scratch"): status is running. A human has not completed it; nothing to verify.
exit=3
```

## Audit trail

`.verdict/audit.jsonl` held three lines after the run: the refused attempt, the approved ship with the numbers it was based on, and the verification.

```
{"time":"2026-11-27T15:18:43.893Z","action":"ship","outcome":"refused","experiment":{"id":1449,"name":"Skill scratch","flag":"skill_scratch"},"winner":"new_copy", ...}
{"time":"2026-11-27T15:18:55.644Z","action":"ship","outcome":"shipped","experiment":{"id":1449,"name":"Skill scratch","flag":"skill_scratch"},"winner":"new_copy", ... "approver":"satanrayshe", ...}
{"time":"2026-11-27T15:19:02.406Z","action":"verify","outcome":"verified","experiment":{"id":1449,"name":"Skill scratch","flag":"skill_scratch"},"winner":"new_copy","identities":5,"matched":5,"attempts":1, ...}
```

## Rollback, then tidy-up

The undo command was run on the scratch flag (`flagsmith flag update skill_scratch --weight new_copy=0`, confirmed), and three fresh identities evaluated with `flagsmith eval skill_scratch --identity rollback-probe-N --jq .variant` all returned `control`. The Flagsmith CLI asks for confirmation on that command; run without a terminal and without `--yes` it answers `Error: pass --yes to confirm "Update ... in environment Development (...)?" without an interactive terminal` and changes nothing (checked on a second throwaway flag).

Afterwards the scratch experiment and both scratch flags were deleted. The 400 synthetic `sim-skill-` identities and their events remain in the environment; they were never exposed to any other experiment.

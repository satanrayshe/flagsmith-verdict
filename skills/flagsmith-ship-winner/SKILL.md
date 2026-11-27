---
name: flagsmith-ship-winner
description: Takes a Flagsmith experiment from "is it ready?" to "winner shipped and verified" with the Flagsmith CLI. Lists experiments, gets one decision (ship, keep running, do not act), prints the rollout plan, hands the single production write to a human who types the experiment name, then verifies with flagsmith eval, records an audit line and gives the rollback command. Use when asked to check, end, complete, roll out or ship a Flagsmith experiment or A/B test winner, or to remove its flag code afterwards.
license: MIT
compatibility: Requires the Flagsmith CLI v2 (logged in, environment set), Node.js 20+, and Verdict (npx -y github:satanrayshe/flagsmith-verdict). Commands use POSIX shell quoting. A human with a terminal is needed for the approval.
metadata:
  author: satanrayshe
  version: "1.0"
---

# Ship a Flagsmith experiment winner

## Rules for every step

1. You only read. Allowed: `flagsmith config`, `flagsmith api` (GET), `flagsmith eval`, `verdict status`, `verdict ship --dry-run`, `verdict preflight`, `scripts/verify.mjs`.
2. The one write is `verdict ship "<name>"`, and a human runs it in their own terminal. Never run it yourself, pipe input to it, fake a terminal or pass `--override`. Never get the same effect another way (`flagsmith api -X POST`, `flagsmith flag update`, `--yes`).
3. An ended experiment cannot be restarted. Say so before the hand-off.
4. Never print an environment key or API key.
5. Run the commands as written. They return a few lines each; do not fetch raw JSON.

## Setup (once per shell)

```sh
export FLAGSMITH_ENVIRONMENT=$(flagsmith config --jq .environment.value)
```

If it is empty or the CLI reports no login, stop and ask the human to run `flagsmith login` and `flagsmith init`.

`verdict` below means the command on PATH, or `npx -y github:satanrayshe/flagsmith-verdict`. If neither can run, follow [references/without-verdict.md](references/without-verdict.md).

## 1. Find the experiment

```sh
flagsmith api "api/v1/environments/$FLAGSMITH_ENVIRONMENT/experiments/?page_size=100" \
  --jq '.results[] | "\(.id)\t\(.status)\t\(.name)\t\(.feature.name)"'
```

One line each: id, status, name, flag. Only `running` or `paused` can be shipped. If the user named none and several qualify, ask which one.

## 2. Get the decision

```sh
verdict status "<name>" --format brief; echo "exit=$?"
```

One line, decision first.

| Line starts with | Exit | Do |
|---|---|---|
| `SHIP <variation>` | 0 | Go to step 3 |
| `KEEP CONTROL` | 0 | Go to step 3; the plan ends the experiment and keeps control |
| `ENDED` | 0 | Already shipped. Go to step 5 |
| `KEEP RUNNING`, `INCONCLUSIVE`, `NO DATA YET`, `NOT STARTED` | 10 | Stop. Report the line; check again later |
| `DO NOT ACT`, `DO NOT SHIP`, `BLOCKED` | 20 | Stop. Report the line; something must be fixed first |

On a stop, do not look for a way around it. [references/decisions.md](references/decisions.md) explains each decision if the user asks why.

## 3. Show the plan

```sh
verdict ship "<name>" --dry-run --path .
```

Changes nothing. Show the output to the human as it is: the API call, the verification, code to clean up, and the undo command.

## 4. Hand the write to the human

Say this, then wait. Do not poll.

> Run `verdict ship "<name>"` in your own terminal and type the experiment name when asked. It ends the experiment for good and gives `<variation>` to every user. Tell me when it is done.

## 5. Verify

```sh
node scripts/verify.mjs "<name>"
```

Read-only. Prints one line and appends one line to `.verdict/audit.jsonl`.

- `VERIFIED` (exit 0): done.
- `NOT SHIPPED` (exit 3): the human has not completed it. Go back to waiting.
- `MISMATCH` (exit 1): tell the human and show the undo command from step 3. See [references/rollback.md](references/rollback.md).

## 6. Report

At most four lines: the decision line, that a human approved, the verify line, the undo command.

## 7. Remove the dead flag code (only if asked)

Follow [references/cleanup-pr.md](references/cleanup-pr.md): `git grep`, edit, `verdict preflight`, `gh pr create`.

# Rollback

Completing an experiment cannot be undone: Flagsmith does not restart an ended experiment, and its results stay frozen. What can be undone is what users get.

Rolling back is a production write, so a human runs it. Give them the command; do not run it.

`flagsmith flag` commands need the project: a `flagsmith.json` from `flagsmith init`, or `-p <project>`. The project id is `flagsmith api "api/v1/environments/$FLAGSMITH_ENVIRONMENT/" --jq .project`.

## Put everyone back on control

```sh
flagsmith flag update <flag> --weight <variation>=0
```

The CLI asks the human to confirm. Without a terminal it refuses and changes nothing unless `--yes` is passed, and you never pass `--yes`. This is the same line `verdict ship` prints as `Undo:`.

Then check it (read-only, you may run this):

```sh
for i in 1 2 3; do flagsmith eval <flag> --identity rollback-probe-$i --jq .variant; done
```

Every line should read `control`. The change can take a few seconds to reach the SDK API.

## Turn the feature off entirely

```sh
flagsmith flag disable <flag>
```

Use this only when control is also broken. `flagsmith eval <flag> --test` then exits non-zero, which a deploy script can gate on.

## When verification says MISMATCH

1. Run `node scripts/verify.mjs "<name>" --no-audit` once more after 30 seconds. Propagation is the usual cause.
2. Still mismatched: look for an override that outranks the default.

   ```sh
   flagsmith flag get <flag> --jq '{enabled, value, variants, segment_overrides, identity_overrides}'
   ```

   A segment or identity override on the flag wins over the rollout.
3. Tell the human what you found and offer the rollback command above. The decision is theirs.

## Record it

A rollback should leave a trace next to the ship record. After the human has run it:

```sh
printf '{"time":"%s","action":"rollback","flag":"%s","to":"control","by":"%s"}\n' \
  "$(date -u +%FT%TZ)" "<flag>" "$(git config user.name)" >> .verdict/audit.jsonl
```

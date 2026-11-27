# Remove the dead flag code

Do this only after step 5 printed `VERIFIED`, and only if the human asked for it. It changes code, not Flagsmith.

1. Find every use of the flag. `verdict ship` already wrote the variation checks to `.verdict/cleanup-<flag>.md`; `git grep` catches the rest.

   ```sh
   cat .verdict/cleanup-<flag>.md 2>/dev/null; git grep -n "<flag>"
   ```

2. Work on a branch.

   ```sh
   git switch -c chore/remove-<flag>-experiment
   ```

3. Edit. Keep the winner's branch and delete the losing one. A check marked "now always true" loses its `if`; one marked "dead after rollout" is deleted with its body. Leave the `trackEvent` calls that other experiments' metrics still listen for.

4. Check the result against the live setup. This is read-only and must exit 0.

   ```sh
   verdict preflight . ; echo "exit=$?"
   ```

   Exit 1 means the edit broke another experiment's instrumentation (for example, removed an event a metric needs). Fix it before going on. Without credentials, `verdict preflight . --offline` runs the code rules only.

5. Confirm nothing still branches on the losing variation.

   ```sh
   git grep -n "<losing variation>" || echo "none left"
   ```

6. Commit and open the pull request. Show the human the diff summary first.

   ```sh
   git diff --stat
   git commit -am "Remove <flag> experiment code; <variation> shipped"
   gh pr create --fill --body "Experiment \"<name>\" ended; <variation> is rolled out to everyone. Removes the losing branch. verdict preflight: pass."
   ```

Do not delete the flag in Flagsmith here. It still serves the winner to code that has not been deployed yet. Once the pull request is live everywhere, a human can archive it with `flagsmith feature update <flag> --archive`.

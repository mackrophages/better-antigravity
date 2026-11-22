---
name: commit
description: >-
  Split current git changes into logical Conventional Commits on the current or
  a new branch, asking whether to push, commit only, or branch first. Use when
  the user invokes /commit.
disable-model-invocation: true
---

# Commit (`/commit`)

Follow these exact steps when the user runs `/commit`:

1. **Configuration subcommand check**: If the user passed `language <English|Spanish|repo>`, run:
   ```bash
   node "<skill_dir>/../../scripts/commit-context.mjs" --set-language "<value>"
   ```
   and confirm the updated setting.

2. **Gather Git Context**: Run the deterministic context & secret-guard helper in a single command:
   ```bash
   node "<skill_dir>/../../scripts/commit-context.mjs"
   ```
   If there are no changes to commit (or CWD is not a git repository), report that clearly and stop.

3. **Ask What To Do**: Call `ask_question` with a single single-select question:
   - `question`: `"What should I do with these changes?"`
   - `options`:
     1. `"(Recommended) Commit + push"`
     2. `"Commit only"`
     3. `"Commit on a new branch"`
   *(In headless `-p` mode where `ask_question` cannot prompt interactively, default to `Commit + push`.)*

4. **Branch Handling**:
   - Stay on the current branch (`main` included) unless the user chose **Commit on a new branch**.
   - If they chose **Commit on a new branch**, create it before the first commit using `git switch -c <type/short-summary>` (for example, `feat/side-panel`).

5. **Split & Commit Atomically**:
   - Never stage files flagged as `SECRET_CANDIDATE` by `commit-context.mjs` (`.env*`, `*.key`, `*.pem`, `credentials*`, tokens).
   - If unrelated or secret files are already staged in the index, run `git reset` first so the index starts clean.
   - Group changes into logical units (for large diffs, you may optionally consult `commit-splitter` via `invoke_subagent` on `flash`).
   - For each group, stage only its files (`git add -- <files>`) and commit with Conventional Commits (`type(scope): summary`, types: `feat`, `fix`, `refactor`, `style`, `docs`, `test`, `chore`, `build`) in the configured `commitLanguage` (`English` by default, or matching recent commits when set to `repo`):
     - Imperative mood, under 72 characters.
     - No em-dashes.
     - Add a short body only when the *why* is not obvious.
     - **Never** add `Co-Authored-By`, `Generated with`, session links, or any AI/Claude/Antigravity/Google attribution trailers.

6. **Push (unless Commit only)**:
   - Run `git push -u origin HEAD`. If there is no remote or push fails, report the exact error and stop.

7. **Summary**: Print a concise list of the commits created (`sha` + message), the branch, and push status.

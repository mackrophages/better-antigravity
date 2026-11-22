# Commit

Type `/commit` in Antigravity, choose **Commit + push**, **Commit only**, or **Commit on a new branch**, and split your working tree changes into clean, logical Conventional Commits.

```text
> /commit
  1. (Recommended) Commit + push
  2. Commit only
  3. Commit on a new branch
```

## Highlights

- **Deterministic Secret Guard**: `scripts/commit-context.mjs` flags `.env*`, `.key`, `.pem`, `.enc`, and credential files before staging so secrets are never committed.
- **Zero Attribution Clutter**: Never appends `Co-Authored-By`, `Generated with`, or session links.
- **Configurable Commit Language**: Defaults to `English`; run `/commit language repo` to match recent repository commits or `/commit language Spanish` for Spanish.
- **Fast Grouping**: Includes `commit-splitter` on Antigravity's `flash` tier for large multi-module diffs.

## Install

```bash
agy plugin install ./plugins/commit
```

MIT License · Original concept by Miguel Ángel Durán (midudev).

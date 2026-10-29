# shipped

**"What did I ship this year?"** A Claude Code plugin that reads *every* commit you authored
since January 1st, in one repo or a whole folder of repos, and boils it down to a very short
TL;DR of what you actually delivered.

Use it for year-in-review posts, brag docs, performance reviews, promo packets, CV updates, or
just remembering what you did.

You get two things:

1. **A short answer in the chat**, with a commits-per-month chart and a sparkline per repo.
2. **An interactive HTML report** that opens in your browser: a GitHub-style heatmap of every
   day you committed, monthly stacked bars by repo, a month-by-month timeline of what shipped,
   and repo cards you can click to filter everything. It has light and dark themes and a
   "Copy as Markdown" button, and it's a single offline file with no CDN or tracking.

```
> /shipped ~/code

**Shipped Jan 1 to Oct 28, 2026** · 412 commits · 6 repos · 58 PRs · 131 active days

Jan ██████████████████████████ 61
Feb ███████████████████▍       46
Mar ████████████▊              30
...

billing    ▂▅█▇▃▁▁▁▁▁ 140
search     ▁▁▁▂▆█▅▂▁▁ 96

**TL;DR:** Launched the billing service, rebuilt search, and shipped the mobile app beta.

**billing**: usage-based billing for the API
- **Stripe metered billing:** live for all paid plans since March
- **Invoices & dunning:** automatic retries and failed-payment emails

**search**: product search service
- **Typo-tolerant search:** replaced SQL LIKE with an inverted index
- ...

**Upstream:** vitejs/vite: fixed HMR on Windows network drives
**Also:** dotfiles: zsh to fish; blog: 4 posts

Interactive report: /tmp/shipped-x7Qa2b/report.html
```

## Install

As a plugin (recommended, since it gets updates):

```
/plugin marketplace add NathnC/shippedit
/plugin install shipped@shipped
```

As a plain skill (no plugin system):

```bash
git clone https://github.com/NathnC/shippedit
cp -r shippedit/skills/shipped ~/.claude/skills/
```

Requires **git** and **Node.js 18+** on your PATH. No npm install, no API keys, nothing leaves
your machine except what Claude reads.

## Use

Just ask *"what did I ship this year?"*, or call it directly:

| Command | What it does |
|---|---|
| `/shipped` | current repo (plus any repos below it), Jan 1 to today, your commits |
| `/shipped ~/code` | every repo under `~/code` |
| `/shipped 2025` | all of last year |
| `/shipped since March` / `last quarter` | custom range |
| `/shipped --everyone` | whole team, not just you |
| `/shipped --author me@work.com` | a different (or extra) identity |
| `/shipped --save` | also writes `SHIPPED-2026.md` and `shipped-2026.html` here |
| `/shipped --no-report` | chat answer only, no HTML report |

Installed as a plugin, the command is `/shipped:shipped`. Asking in plain words works too.

## How it works

1. **Collect.** `skills/shipped/scripts/collect.mjs` (zero-dependency Node) finds the repos,
   runs `git log` for your identity (`user.email` / `user.name`) over the date range and builds
   a compact digest: every commit's subject, body snippet, the areas of the codebase it
   touched, merged PR titles and release tags. Lockfiles, generated files and bulk data dumps
   are left out of the line counts, typo/format/deps commits are counted rather than listed,
   and a repo cloned twice is counted once.
2. **Distil.** Claude reads the whole digest and clusters commits into deliverables, using
   strict rules: outcomes not activity, 12 words max per bullet, 20 bullets max in total, no
   refactors/CI/deps noise, and nothing that isn't backed by a commit.
3. **Render.** `skills/shipped/scripts/render.mjs` merges the collector's `stats.json` with
   Claude's summary into `assets/report.html` and opens it. Commit text is inserted as plain
   text, never as HTML.

The scripts also work without Claude:

```bash
node skills/shipped/scripts/collect.mjs ~/code --since 2026-01-01 --out digest.txt
node skills/shipped/scripts/render.mjs --stats <stats.json from above> --summary summary.json --open
node skills/shipped/scripts/render.mjs --help   # summary JSON shape
```

## Tips

- **Commits under several emails?** Pass `--author` once per identity (it's a regex):
  `--author you@work.com --author you@personal.dev`. Repos that have commits in the period but
  none from you are listed at the end of the digest, so you can spot a missing identity.
- **Squash-merge or PR workflow?** PR titles are picked up from merge commits; squash merges
  already carry the PR title as the commit subject.
- **Unmerged work?** Only the checked-out branch is read by default; `--all-branches` reads
  every local branch.
- **Big monorepo?** Above 600 commits the digest switches to compact mode automatically
  (`--detail full` to override). Above about 25k characters it goes to a temp file that Claude
  reads in chunks.

## License

MIT

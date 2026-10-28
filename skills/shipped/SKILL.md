---
name: shipped
description: Turn your git history into a very short TL;DR of everything you delivered — "what I shipped this year". Reads every commit you authored (Jan 1 → today by default) across one repo or a whole folder of repos and distils them into outcome bullets. Use for "what did I ship this year/quarter/month", year in review, brag doc, accomplishments list, performance-review or promo prep, CV/LinkedIn update, "summarise my commits", or "what have I built since <date>".
argument-hint: "[path…] [year | since DATE | last quarter] [--everyone] [--author EMAIL] [--save]"
allowed-tools: Bash(node *), Bash(git *), Read, Write
---

# shipped

Produce a **very short** list of what the user delivered, built from *every* commit they
authored in the period. Commits are the evidence; the output is outcomes, not a changelog.

## 1. Collect

Run the bundled collector (zero dependencies — node ≥ 18 and git):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/collect.mjs" [paths…] [options]
```

(If `${CLAUDE_SKILL_DIR}` was not substituted, the script is `scripts/collect.mjs` beside this SKILL.md.)

Map the user's request onto options:

| User says | Pass |
|---|---|
| nothing | (defaults: current dir, Jan 1 → today, your git identity) |
| a folder, "all my repos", "everything in ~/code" | that path — repos below it are found (`--depth 3`) |
| "2025", "last year" | `--year 2025` |
| "since March", "last quarter", "this month" | `--since YYYY-MM-DD [--until YYYY-MM-DD]` (resolve against today's date) |
| "the team", "everyone", a repo they don't own | `--everyone` |
| a specific person / extra email | `--author "name or email"` (repeatable) |
| "include unmerged branches" | `--all-branches` |

If the current directory is not a git repo and no path was given, it still scans the repos
below it. If 0 commits match, read the "repos with commits … none matching your identity"
section: suggest `--author` with the names listed there, or ask which identity is theirs.

**Large output:** above ~25k characters the script writes the digest to a temp file and
prints its path. Read that file **in full, in chunks** (`Read` with offset/limit) — every
commit matters; never summarise from the first chunk alone.

## 2. Read the digest

- Header line: totals (repos, commits, PRs merged, active days, streak, lines, busiest month).
- `## repo` sections, biggest first; `### YYYY-MM` months inside.
- `MM-DD [hash] subject [areas] {files} — body`. `{files}` appears when the subject is terse
  ("fix", "v3", "s") — infer what the work was from the files and areas.
- `⤵ PR #123 Title` = a merged pull request. PR titles are the strongest signal of a
  deliverable; individual commits under the same theme are its implementation.
- `tags:` = releases. A release is a shipped milestone — always worth a mention.
- `noise:` = typo/format/deps commits, already collapsed. Ignore unless it is the only work.

## 3. Distil — the rules

1. **Cluster commits into deliverables.** 30 commits of "live HR: …", "fix HR timeout",
   "HR retries" = ONE bullet: *Live heart-rate measurement*. Never one bullet per commit.
2. **Outcomes, not activity.** "Launched halloween sale with one-click unsubscribe", not
   "worked on email templates". Name the thing a user or stakeholder would recognise.
3. **Ruthlessly short.** Each bullet ≤ 12 words *including* the bold name — count them; a
   list of sub-features gets cut to the best 2–3. 2–5 bullets for a big repo, 1–2 for a
   small one. **Hard caps for the whole answer: ≤ 20 bullets and ≤ 5 repo sections.** Every
   other repo gets a few words in the single **Also:** line. It must fit on one screen —
   when in doubt, cut.
4. **Rank by impact**, not chronology: new products / launches / releases → major features →
   notable infra, performance or reliability wins → everything else (often dropped).
5. **Drop**: refactors, renames, lint, deps bumps, CI/tooling setup, tests-only, docs-only,
   reverts, and the bug fixes that were part of building a feature. Keep a fix only if it was a headline
   (outage, security, data loss, big perf win).
6. **Upstream / open-source contributions** (repo owned by someone else, e.g. `org/project`
   where org ≠ user) get their own line — they are notable even when tiny.
7. **Never invent.** Every bullet must trace back to commits in the digest. No metrics that
   aren't in the digest (users, revenue, %). Unsure what terse commits did? Say less, not more.
8. Use the repo's remote slug or folder name as written; month tags are optional, use them
   only when they help (e.g. a launch date).

## 4. Output format

```
**Shipped {Mon D – Mon D, YYYY}** · {N} commits · {R} repos · {PRs} PRs · {active} active days

**TL;DR:** {one sentence — the 2–4 biggest things, comma-separated}

**{repo}** — {≤8-word description of what the project is}
- **{Deliverable}** — {outcome; whole bullet ≤ 12 words}
- …

**{repo}** …   ← at most 5 repo sections

**Upstream:** {org/repo}: {contribution}; …   ← only if any
**Also:** {repo}: {thing}; {repo}: {thing}   ← every remaining repo, one line total
```

Follow this format exactly — no extra sections (no "Others", no stats tables). Then stop. No closing summary, no methodology notes, no "let me know". If the user asked for
a single repo, drop the per-repo headers and just list bullets.

Optional extras, only on request: `--save` / "save it" → also write the list to
`SHIPPED-{YYYY}.md` in the current directory; "by month" → group bullets under month headers
instead of repos; "for my review" → keep the same bullets but phrase each as impact.

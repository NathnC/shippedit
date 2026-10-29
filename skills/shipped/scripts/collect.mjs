#!/usr/bin/env node
// shipped — collect every commit you authored in a date range, across one or
// many git repos, and print a token-lean digest for Claude to distil into a
// "what I shipped" list. Zero dependencies: needs only node >= 18 and git.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

const HELP = `usage: collect.mjs [paths...] [options]

paths            repos or folders to scan (default: current directory)
--since DATE     start date, YYYY-MM-DD (default: Jan 1 of this year)
--until DATE     end date, YYYY-MM-DD (default: today)
--year YYYY      shorthand for --since YYYY-01-01 --until YYYY-12-31
--author PAT     match author name/email, regex (repeatable; default: your git identity)
--everyone       include commits by all authors
--all-branches   read every local branch, not just the checked-out one
--depth N        how deep to look for repos under a folder (default 3)
--detail MODE    full | compact | auto (default auto: compact above 600 commits)
--out FILE       write the digest to FILE (auto-written to a temp file when large)
`;

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { paths: [], authors: [], since: null, until: null, everyone: false, allBranches: false, depth: 3, detail: 'auto', out: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    return argv[++i];
  };
  if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
  else if (a === '--since') opt.since = next();
  else if (a === '--until') opt.until = next();
  else if (a === '--year') { const y = next(); opt.since = `${y}-01-01`; opt.until = `${y}-12-31`; }
  else if (a === '--author') opt.authors.push(next());
  else if (a === '--everyone') opt.everyone = true;
  else if (a === '--all-branches') opt.allBranches = true;
  else if (a === '--depth') opt.depth = Number(next());
  else if (a === '--detail') opt.detail = next();
  else if (a === '--out') opt.out = next();
  else if (a.startsWith('--')) fail(`unknown option ${a}\n\n${HELP}`);
  else opt.paths.push(a);
}
if (!opt.paths.length) opt.paths.push('.');
const now = new Date();
opt.since ??= `${now.getFullYear()}-01-01`;
opt.until ??= localDate(now);
for (const k of ['since', 'until']) if (!/^\d{4}-\d{2}-\d{2}$/.test(opt[k])) fail(`--${k} must be YYYY-MM-DD, got ${opt[k]}`);
if (!['full', 'compact', 'auto'].includes(opt.detail)) fail('--detail must be full, compact or auto');

function fail(msg) { process.stderr.write(`shipped: ${msg}\n`); process.exit(1); }
function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Resolve git to an absolute path from PATH only. A bare 'git' with cwd set to a scanned
// repo would let Windows pick up a planted git.exe from that folder.
function findGit() {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = join(dir, `git${ext.toLowerCase()}`);
      try { if (statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
const GIT = findGit() ?? fail('git is not on PATH');
const SAFE_DIR = tmpdir(); // run git from a neutral cwd; the repo is passed with -C
// Scanned repos are untrusted: never let their config run programs (fsmonitor, external diff,
// textconv, or a gpg.program reached via log.showSignature).
const HARDEN = [
  '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '--no-pager',
  '-c', 'log.showSignature=false', '-c', 'gpg.program=gpg', '-c', 'gpg.ssh.program=ssh-keygen', '-c', 'gpg.x509.program=gpgsm',
];

function git(repo, args) {
  try {
    return execFileSync(GIT, [...HARDEN, '-C', repo, ...args], {
      cwd: SAFE_DIR, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' },
    });
  } catch {
    return null;
  }
}

// ---------- repo discovery ----------
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '__pycache__', 'Pods', 'bower_components']);

function discover(root, depth, found) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  if (entries.some(e => e.name === '.git')) found.add(resolve(root));
  if (depth <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    discover(join(root, e.name), depth - 1, found);
  }
}

const repoSet = new Set();
for (const p of opt.paths) {
  if (!existsSync(p) || !statSync(p).isDirectory()) fail(`not a directory: ${p}`);
  const top = git(p, ['rev-parse', '--show-toplevel'])?.trim();
  // Inside a repo → that repo. Keep scanning below it too: a folder of projects is
  // often itself a repo, and repos get checked out inside other repos.
  if (top) repoSet.add(resolve(top));
  discover(p, opt.depth, repoSet);
}
const repos = [...repoSet].sort();
if (!repos.length) fail(`no git repositories found under ${opt.paths.join(', ')}`);

// ---------- identity ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function identities(repo) {
  if (opt.everyone) return [];
  if (opt.authors.length) return opt.authors;
  return ['user.email', 'user.name'].map(k => git(repo, ['config', k])?.trim()).filter(Boolean);
}

// ---------- classification helpers ----------
const LOCK_OR_GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|Gemfile\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|node_modules|public\/build)\//;
const BULK_LINES = 3000; // one file adding more than this in one commit is a dump (data, fixtures, vendored lib), not work
const GENERIC_DIRS = new Set(['src', 'app', 'apps', 'lib', 'libs', 'packages', 'pkg', 'internal', 'cmd', 'resources', 'source', 'Sources', 'modules', 'services', 'components', 'crates']);
const NOISE = /^(merge\b|wip$|typo|fix(ed)? typos?|format(ting)?\b|lint\b|prettier|whitespace|bump\b|chore\(deps|update (deps|dependencies|readme|changelog)\b|chore: update changelog|deps?:|\d+(\.\d+)*$|\.+$|updates?$|minor$|cleanup$)/i;
const TRAILER = /^(co-authored-by|signed-off-by|change-id|reviewed-by|acked-by|cc|refs?|closes|fixes):|generated with \[?claude|^🤖/i;
const AUTO_BRANCH = /^(worktree-|agent-|claude\/|codex\/|copilot\/)/i; // tool-named branches with no title carry no signal
const MAINLINE = /^(origin\/)?(main|master|develop|dev|trunk)$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// numstat rename forms: "a/{old => new}/f" and "old => new"
const normPath = p => p.replace(/\{[^}]*=> ([^}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
function areaOf(path) {
  const segs = path.split('/');
  segs.pop();
  if (!segs.length) return '/';
  if (GENERIC_DIRS.has(segs[0]) && segs.length > 1) return `${segs[0]}/${segs[1]}`;
  return segs[0];
}
const kfmt = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const firstLine = text => text.split('\n').map(l => l.trim()).find(l => l && !TRAILER.test(l));
// Commit text is untrusted data: strip control/bidi chars and markup that could fake digest structure.
const clean = s => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/[<>`#]/g, '').replace(/ {2,}/g, ' ').trim();

function remoteSlug(repo) {
  const url = git(repo, ['remote', 'get-url', 'origin'])?.trim();
  return url?.match(/[:/]([^/:]+\/[^/]+?)(\.git)?\/?$/)?.[1] ?? null;
}

// ---------- collect ----------
const seen = new Set(); // commit hashes already counted (clones / nested copies of a repo)
const out = [];
const allIds = new Set();
const sinceArg = `--since=${opt.since} 00:00`;
const untilArg = `--until=${opt.until} 23:59:59`;

for (const repo of repos) {
  if (!git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])) continue; // no commits yet
  const ids = identities(repo);
  ids.forEach(id => allIds.add(id));
  const authorArgs = ids.map(id => `--author=${opt.authors.length ? id : escapeRe(id)}`);
  const range = opt.allBranches ? ['--branches'] : ['HEAD'];
  const logArgs = ['-i', sinceArg, untilArg, ...authorArgs];

  const commits = [];
  let dupes = 0;
  const raw = git(repo, ['log', ...range, '--no-merges', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', ...logArgs, '--format=%x1e%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1f']) ?? '';
  for (const rec of raw.split('\x1e').slice(1)) {
    const [hash, short, date, author, subject, body, stat = ''] = rec.split('\x1f');
    if (seen.has(hash)) { dupes++; continue; }
    seen.add(hash);
    let add = 0, del = 0, bulk = 0;
    const churn = new Map();
    const fileChurn = [];
    for (const line of stat.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const path = normPath(m[3]);
      if (LOCK_OR_GENERATED.test(path)) continue;
      const a = m[1] === '-' ? 0 : +m[1], d = m[2] === '-' ? 0 : +m[2];
      if (!/(^|\/)CHANGELOG/i.test(path)) fileChurn.push([path, a + d]);
      if (a > BULK_LINES) { bulk++; continue; }
      add += a; del += d;
      const ar = areaOf(path);
      churn.set(ar, (churn.get(ar) ?? 0) + a + d + 1);
    }
    const s = clean(subject);
    commits.push({
      short, ts: date, date: date.slice(0, 10), author: clean(author), subject: s, add, del, bulk,
      body: body.split('\n').map(clean).filter(l => l && !TRAILER.test(l)).join(' / '),
      areas: [...churn.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(e => e[0]),
      hint: fileChurn.sort((x, y) => y[1] - x[1]).slice(0, 3).map(f => basename(f[0])),
      noise: NOISE.test(s),
    });
  }

  // First-parent merges = PRs / branches landed on this branch. GitHub puts the PR title in the body.
  const merges = [];
  const mraw = git(repo, ['log', 'HEAD', '--merges', '--first-parent', ...logArgs, '--format=%x1e%H%x1f%aI%x1f%s%x1f%b']) ?? '';
  for (const rec of mraw.split('\x1e').slice(1)) {
    const [hash, date, subject, body = ''] = rec.split('\x1f');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const gh = subject.match(/^Merge pull request (#\d+) from \S+?\/(\S+)/i);
    const br = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/i);
    let text = null;
    if (gh) text = `PR ${gh[1]} ${firstLine(body) ?? gh[2]}`;
    else if (br && !MAINLINE.test(br[1]) && (firstLine(body) || !AUTO_BRANCH.test(br[1]))) text = `merged ${firstLine(body) ?? br[1]}`;
    else if (!br && !/^Merge\b/i.test(subject)) text = `merged ${subject}`;
    if (text) merges.push({ ts: date, date: date.slice(0, 10), text: clean(text) });
  }

  const tags = (git(repo, ['for-each-ref', 'refs/tags', '--sort=creatordate', '--format=%(refname:short)\t%(creatordate:short)']) ?? '')
    .split('\n').map(l => l.split('\t')).filter(([t, d]) => t && d >= opt.since && d <= opt.until).map(([t, d]) => `${clean(t)} (${d})`);

  let otherAuthors = null;
  if (!commits.length && !dupes && ids.length) {
    const any = git(repo, ['shortlog', '-sne', 'HEAD', sinceArg, untilArg])?.trim();
    if (any) otherAuthors = any.split('\n').slice(0, 3).map(l => clean(l).replace(/^(\d+)\s+/, '$1× '));
  }

  if (commits.length || otherAuthors) out.push({ repo, name: basename(repo), slug: remoteSlug(repo), commits, merges, tags, dupes, otherAuthors, ids });
}

// ---------- render ----------
const shipped = out.filter(r => r.commits.length).sort((a, b) => b.commits.length - a.commits.length);
const all = shipped.flatMap(r => r.commits);
const detail = opt.detail === 'auto' ? (all.length > 600 ? 'compact' : 'full') : opt.detail;
const days = [...new Set(all.map(c => c.date))].sort();
const byMonth = new Map();
for (const c of all) byMonth.set(c.date.slice(0, 7), (byMonth.get(c.date.slice(0, 7)) ?? 0) + 1);
const busiest = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
let streak = 0, run = 0, prev = null;
for (const d of days) {
  const t = Date.parse(`${d}T00:00:00Z`);
  run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
  streak = Math.max(streak, run);
  prev = t;
}
const prs = sum(shipped, r => r.merges.length);
const bulk = sum(all, c => c.bulk);

const who = opt.everyone ? 'everyone' : [...allIds].join(' | ') || 'unknown';
const L = [];
L.push(`# shipped digest · ${opt.since} → ${opt.until} · author: ${who} · detail: ${detail}`);
L.push([
  `repos ${shipped.length}`, `commits ${all.length}`, prs && `PRs/branches merged ${prs}`,
  `active days ${days.length}`, `longest streak ${streak}d`,
  `+${kfmt(sum(all, c => c.add))}/−${kfmt(sum(all, c => c.del))} lines (lockfiles, generated & ${bulk} bulk >${BULK_LINES}-line files excluded)`,
  busiest && `busiest ${MONTHS[+busiest[0].slice(5) - 1]} ${busiest[0].slice(0, 4)} (${busiest[1]})`,
].filter(Boolean).join(' · '));
L.push('legend: MM-DD [hash] subject [top areas +added/−deleted] {top files, shown for terse subjects} — body · "⤵" = PR/branch merged · "noise" = typo/format/deps commits, counted not listed');

for (const r of shipped) {
  L.push('');
  L.push(`## ${r.name}${r.slug ? ` (${r.slug})` : ''} · ${r.commits.length} commits · ${r.commits.at(-1).date} → ${r.commits[0].date} · +${kfmt(sum(r.commits, c => c.add))}/−${kfmt(sum(r.commits, c => c.del))}` +
    (r.dupes ? ` · ${r.dupes} more already counted under another repo` : ''));
  L.push(`path: ${r.repo}`);
  if (r.tags.length) L.push(`tags: ${r.tags.join(', ')}`);
  const months = new Map();
  const items = [...r.commits, ...r.merges.map(m => ({ ...m, merge: true }))].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const c of items) {
    const m = c.date.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(c);
  }
  for (const [m, cs] of months) {
    L.push(`### ${m}`);
    for (const c of cs) {
      if (c.merge) { L.push(`${c.date.slice(5)} ⤵ ${clip(c.text, 110)}`); continue; }
      if (c.noise) continue;
      const area = c.areas.length ? ` [${c.areas.join(',')}${detail === 'full' ? ` +${c.add}/−${c.del}` : ''}]` : '';
      // one-word subjects ("fix", "v3", "s") say nothing — the files they touched say more
      const files = c.subject.length < 16 && c.hint.length ? ` {${c.hint.join(', ')}}` : '';
      const body = detail === 'full' && c.body ? ` — ${clip(c.body, 160)}` : '';
      const author = opt.everyone ? ` (${c.author})` : '';
      L.push(`${c.date.slice(5)} ${detail === 'full' ? `${c.short} ` : ''}${clip(c.subject, detail === 'full' ? 100 : 80)}${author}${area}${files}${body}`);
    }
    const noise = cs.filter(c => c.noise && !c.merge);
    if (noise.length) L.push(`noise: ${noise.length} (${clip(noise.map(c => c.subject).join('; '), 90)})`);
  }
}

const unmatched = out.filter(r => !r.commits.length);
if (unmatched.length) {
  L.push('', '## repos with commits in range but none matching your identity (pass --author if any are yours)');
  for (const r of unmatched) L.push(`${r.name}: ${r.otherAuthors.join(', ')}`);
}
if (!all.length) L.push('', 'no commits matched — try --author "<name or email>", --everyone, or a wider --since');

// ---------- chart + stats (for the terminal answer and the HTML report) ----------
const monthKeys = [];
for (let d = new Date(`${opt.since.slice(0, 7)}-01T00:00:00Z`); d <= new Date(`${opt.until}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1)) {
  monthKeys.push(d.toISOString().slice(0, 7));
}
// trim to the active span so a three-week project isn't nine empty rows
if (all.length) {
  const firstM = days[0].slice(0, 7), lastM = days.at(-1).slice(0, 7);
  monthKeys.splice(0, monthKeys.length, ...monthKeys.filter(m => m >= firstM && m <= lastM));
}
const monthsOf = cs => monthKeys.map(m => cs.filter(c => c.date.startsWith(m)).length);
const SPARK = '▁▂▃▄▅▆▇█';
const spark = xs => { const mx = Math.max(...xs, 1); return xs.map(x => (x ? SPARK[Math.min(7, Math.floor((x / mx) * 7.999))] : ' ')).join(''); };
const bar = (x, mx, w) => { const e = Math.round((x / mx) * w * 8); return '█'.repeat(e >> 3) + (e & 7 ? '▏▎▍▌▋▊▉'[(e & 7) - 1] : ''); };
const C = ['```'];
const perMonth = monthsOf(all);
const mx = Math.max(...perMonth, 1);
const multiYear = monthKeys[0].slice(0, 4) !== monthKeys.at(-1).slice(0, 4);
monthKeys.forEach((m, i) => C.push(`${MONTHS[+m.slice(5) - 1]}${multiYear ? ` ${m.slice(2, 4)}` : ''} ${bar(perMonth[i], mx, 28).padEnd(28)} ${perMonth[i]}`));
C.push('');
const nameW = Math.min(18, Math.max(...shipped.slice(0, 8).map(r => r.name.length), 4));
for (const r of shipped.slice(0, 8)) C.push(`${clip(r.name, nameW).padEnd(nameW)} ${spark(monthsOf(r.commits))} ${r.commits.length}`);
if (shipped.length > 8) C.push(`${'+ others'.padEnd(nameW)} ${spark(monthsOf(shipped.slice(8).flatMap(r => r.commits)))} ${sum(shipped.slice(8), r => r.commits.length)}`);
C.push('```');

const stats = {
  since: opt.since, until: opt.until, author: who, generated: new Date().toISOString(),
  totals: { commits: all.length, repos: shipped.length, prs, activeDays: days.length, streak, add: sum(all, c => c.add), del: sum(all, c => c.del) },
  months: monthKeys,
  days: {},
  repos: shipped.map(r => ({
    name: r.name, slug: r.slug, commits: r.commits.length, prs: r.merges.length,
    add: sum(r.commits, c => c.add), del: sum(r.commits, c => c.del),
    first: r.commits.at(-1).date, last: r.commits[0].date, months: monthsOf(r.commits),
    tags: r.tags,
    prsList: r.merges.map(m => ({ date: m.date, text: m.text })),
  })),
};
for (const r of shipped) for (const c of r.commits) (stats.days[c.date] ??= {})[r.name] = (stats.days[c.date][r.name] ?? 0) + 1;

// private dir with an unguessable name, so nothing else can pre-create or symlink the files
const work = mkdtempSync(join(tmpdir(), 'shipped-'));
const statsPath = join(work, 'stats.json');
writeFileSync(statsPath, JSON.stringify(stats), { mode: 0o600 });

const text = `${L.join('\n')}\n`;
let target = opt.out;
if (!target && text.length > 25000) target = join(work, 'digest.txt');
const footer = !all.length ? '' : `\nchart (paste into the answer as-is):\n${C.join('\n')}\n\nstats for the HTML report: ${statsPath}\n`;
if (target) {
  writeFileSync(target, text, { mode: 0o600 });
  process.stdout.write(`${L.slice(0, 2).join('\n')}\n\ndigest written to ${target} (${text.length} chars, ${L.length} lines) — read it in chunks\n${footer}`);
} else {
  process.stdout.write(text + footer);
}

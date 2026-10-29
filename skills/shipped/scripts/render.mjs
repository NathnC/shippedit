#!/usr/bin/env node
// shipped — build the interactive HTML report from collect.mjs's stats.json plus
// Claude's distilled summary (JSON on stdin or --summary FILE). Zero dependencies.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `usage: render.mjs --stats STATS.json [--summary SUMMARY.json] [--out FILE] [--open]

The summary comes from --summary or stdin:
{ "tldr": "...",
  "repos": [{ "name": "repo", "about": "what it is",
              "items": [{ "title": "Deliverable", "outcome": "what it does", "month": "YYYY-MM" }] }],
  "upstream": [{ "repo": "org/repo", "text": "contribution" }],
  "also": [{ "repo": "repo", "text": "thing" }] }
`;

const argv = process.argv.slice(2);
const opt = { stats: null, summary: null, out: null, open: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
  else if (a === '--stats') opt.stats = argv[++i];
  else if (a === '--summary') opt.summary = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--open') opt.open = true;
  else fail(`unknown argument ${a}\n\n${HELP}`);
}
if (!opt.stats) fail(`--stats is required\n\n${HELP}`);

function fail(msg) { process.stderr.write(`shipped: ${msg}\n`); process.exit(1); }

const stats = JSON.parse(readFileSync(opt.stats, 'utf8'));
let raw;
try { raw = opt.summary ? readFileSync(opt.summary, 'utf8') : readFileSync(0, 'utf8'); } catch { raw = ''; }
let input;
try { input = JSON.parse(raw); } catch (e) { fail(`summary is not valid JSON: ${e.message}`); }

// Keep only the expected shape, as plain strings of sane length.
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const arr = v => (Array.isArray(v) ? v : []);
const summary = {
  tldr: str(input.tldr, 600),
  repos: arr(input.repos).slice(0, 12).map(r => ({
    name: str(r.name, 80), about: str(r.about, 120),
    items: arr(r.items).slice(0, 10).map(it => ({ title: str(it.title, 80), outcome: str(it.outcome, 160), month: /^\d{4}-\d{2}$/.test(it.month) ? it.month : '' })),
  })),
  upstream: arr(input.upstream).slice(0, 10).map(x => ({ repo: str(x.repo, 80), text: str(x.text, 160) })),
  also: arr(input.also).slice(0, 30).map(x => ({ repo: str(x.repo, 80), text: str(x.text, 160) })),
};

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, '..', 'assets', 'report.html'), 'utf8');
// JSON inside <script>: escape "<" so no string can close the tag
const LS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g'); // these end lines inside JS
const data = JSON.stringify({ stats, summary }).replace(/</g, '\\u003c').replace(LS, c => `\\u${c.charCodeAt(0).toString(16)}`);
const html = template.replace('/*__SHIPPED_DATA__*/', () => data);

const out = resolve(opt.out ?? join(dirname(opt.stats), 'report.html'));
writeFileSync(out, html);
process.stdout.write(`report: ${out}\n`);

if (opt.open) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [out]]
    : process.platform === 'darwin' ? ['open', [out]] : ['xdg-open', [out]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { process.stdout.write('could not open a browser; open the file above\n'); }
}

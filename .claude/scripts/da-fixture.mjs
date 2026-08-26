#!/usr/bin/env node
/**
 * Generate a plan's test fixtures into Document Authoring.
 *
 *   node .claude/scripts/da-fixture.mjs <plan.json> [options]
 *
 *     --dry-run       show what would change; write nothing
 *     --only ID,ID    restrict to these fixture ids
 *     --force         rewrite documents that already match
 *
 * Why this exists: a test step should never ask a tester to author anything. It cites a fixture
 * URL that already exists, which is what makes six broad tests per block workable instead of
 * fifteen narrow ones fragmented around who has to build the content.
 *
 * Two invariants, both structural rather than advisory:
 *
 *   1. **It never publishes.** Only the preview endpoint is called. There is no flag to reach
 *      /live/ because there is no code path to it. A fixture appearing on the client's live site
 *      is the worst thing this tool could do, so it is made unreachable rather than discouraged.
 *   2. **Everything lands under /drafts/.** A plan whose fixture path escapes that is refused by
 *      planProblems before a single request is made.
 *
 * Like xray-push it reconciles rather than recreates: a document whose content already matches is
 * left alone, so re-running after editing one fixture rewrites one document.
 *
 * Nav and footer fixtures are DERIVED from the live documents, not authored. The real nav carries
 * five menus and seventy-five links, and the real footer three columns and five social accounts; a
 * hand-built replacement would differ from production in ways nobody intended, and each difference
 * is a false result waiting to happen. The fixture keeps the whole live document and varies only
 * the axis under test. Both are reached the same way — a metadata row on the fixture page that the
 * block reads (`nav` for header.js, `footer` for footer.js) — so both paths are derived from the
 * fixture's own spec rather than repeated.
 *
 * Auth: DA_TOKEN, an Adobe IMS token. Short-lived by nature, so its expiry is checked before the
 * first request rather than surfacing as a 401 six documents in.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate } from './lib/schema.mjs';
import { planProblems } from './lib/reconcile.mjs';
import { fixturePage, transformNav, transformFooter } from './lib/da-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', 'qa', 'plan.schema.json');
const DA_ADMIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const flag = (n) => args.includes(n);
const listArg = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1].split(',').map((s) => s.trim()) : null;
};
const dryRun = flag('--dry-run');
const force = flag('--force');
const only = listArg('--only');

const fail = (m) => { console.error(`da-fixture: ${m}`); process.exit(1); };
if (!planPath) fail('usage: da-fixture.mjs <plan.json> [--dry-run] [--only IDs] [--force]');
if (!existsSync(planPath)) fail(`no such plan: ${planPath}`);

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const problems = [...validate(plan, JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))), ...planProblems(plan)];
if (problems.length) fail(`plan is invalid:\n  - ${problems.join('\n  - ')}`);

const fixtures = (plan.fixtures || []).filter((f) => !only || only.includes(f.id));
if (!fixtures.length) fail(only ? 'no fixture matched --only' : 'the plan declares no fixtures');

/* ------------------------------------------------------------------- auth */

const token = process.env.DA_TOKEN;
if (!token) fail('DA_TOKEN is not set (see .claude/qa/README.md)');

// An IMS token is a JWT, so its expiry is readable locally with no secret and no request.
// Checking it up front turns "401 halfway through" into one clear sentence.
try {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const left = payload.exp * 1000 - Date.now();
  if (left <= 0) fail(`DA_TOKEN expired ${Math.round(-left / 3.6e6)}h ago — refresh it and re-run`);
  if (left < 5 * 60_000) console.error(`warn     DA_TOKEN expires in ${Math.round(left / 60_000)} minute(s)`);
} catch { /* not a JWT we can read; let the API be the judge */ }

/* -------------------------------------------------------------------- api */

const ORG_SITE = (() => {
  const m = /^https:\/\/[^-]+--([^-]+)--([^.]+)\.aem\.page/.exec(plan.previewBase || '');
  if (!m) fail('plan.previewBase must look like https://{branch}--{site}--{org}.aem.page');
  const branch = /^https:\/\/([^-]+)--/.exec(plan.previewBase)[1];
  return { site: m[1], org: m[2], branch };
})();

const auth = { Authorization: `Bearer ${token}` };

async function readSource(path) {
  const res = await fetch(`${DA_ADMIN}/source/${ORG_SITE.org}/${ORG_SITE.site}${path}.html`, { headers: auth });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${path}: HTTP ${res.status}`);
  return res.text();
}

async function writeSource(path, html) {
  const body = new FormData();
  // A Blob, not a string. Setting `data` to a bare string stores the document JSON-encoded — the
  // stored file begins with a quote and every attribute arrives as \" — which renders as broken
  // images rather than as an error, so the write "succeeds" with HTTP 201 and the damage only
  // shows up in the browser. Verified both ways against the live API on 2026-08-25.
  body.set('data', new Blob([html], { type: 'text/html' }));
  const res = await fetch(`${DA_ADMIN}/source/${ORG_SITE.org}/${ORG_SITE.site}${path}.html`, {
    method: 'POST',
    // Tags the version author as an agent, so generated documents are distinguishable from a
    // person's hand edits in DA's history rather than all appearing under the token's owner.
    headers: { ...auth, 'x-da-initiator': 'mcp' },
    body,
  });
  if (!res.ok) throw new Error(`write ${path}: HTTP ${res.status}${res.status === 403 ? ' — the token cannot write here' : ''}`);
  return res.status;
}

// Preview only. There is deliberately no publish counterpart in this file.
async function preview(path) {
  const res = await fetch(`${AEM_ADMIN}/preview/${ORG_SITE.org}/${ORG_SITE.site}/${ORG_SITE.branch}${path}`, {
    method: 'POST', headers: auth,
  });
  if (!res.ok) throw new Error(`preview ${path}: HTTP ${res.status}`);
  return res.status;
}

/* -------------------------------------------------------------- reconcile */

// Whitespace differences are not content differences, and DA may normalise on the way in.
const same = (a, b) => a != null && b != null && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

const sources = new Map();
async function sourceFor(from, kind) {
  if (!sources.has(from)) {
    const html = await readSource(from);
    if (!html) throw new Error(`source document ${from} not found — a ${kind} fixture is derived from it`);
    sources.set(from, html);
  }
  return sources.get(from);
}

const planned = [];
for (const f of fixtures) {
  if (f.nav) {
    const src = await sourceFor(f.nav.from, 'nav');
    planned.push({ fixture: f.id, kind: 'nav', path: f.nav.path, html: transformNav(src, f.nav) });
  }
  // The footer is reached by the same mechanism under a different key: footer.js reads
  // getMetadata('footer') and falls back to /footer, exactly as header.js does for the nav.
  if (f.footer) {
    const src = await sourceFor(f.footer.from, 'footer');
    planned.push({ fixture: f.id, kind: 'footer', path: f.footer.path, html: transformFooter(src, f.footer) });
  }
  // The page's nav and footer metadata rows are derived from the fixture's own documents when it
  // generates them, so each path is stated once and cannot drift between the two.
  const metadata = { ...(f.metadata || {}) };
  if (f.nav) metadata.nav = f.nav.path;
  if (f.footer) metadata.footer = f.footer.path;
  planned.push({
    fixture: f.id,
    kind: 'page',
    path: f.page,
    html: fixturePage({ ...f, metadata }, { source: f.nav?.from || f.footer?.from }),
  });
}

const actions = [];
for (const p of planned) {
  const current = await readSource(p.path);
  const state = current == null ? 'create' : (same(current, p.html) && !force ? 'unchanged' : 'update');
  actions.push({ ...p, state, bytes: p.html.length });
}

/* ----------------------------------------------------------------- report */

const w = Math.max(...actions.map((a) => a.path.length));
console.log(`plan ${planPath}`);
console.log(`  ${ORG_SITE.org}/${ORG_SITE.site} on ${ORG_SITE.branch}\n`);
for (const a of actions) {
  const mark = { create: 'CREATE   ', update: 'UPDATE   ', unchanged: 'unchanged' }[a.state];
  console.log(`  ${mark} ${a.path.padEnd(w)}  ${String(a.bytes).padStart(6)} bytes  ${a.kind}  ${a.fixture}`);
}
const todo = actions.filter((a) => a.state !== 'unchanged');
console.log(`\n  ${todo.length} to write, ${actions.length - todo.length} already correct`);

if (dryRun) { console.log('\nNothing was written. Re-run without --dry-run to apply.'); process.exit(0); }
if (!todo.length) { console.log('\nNothing to do.'); process.exit(0); }

/* ------------------------------------------------------------------ apply */

console.log('');
let written = 0;
try {
  for (const a of todo) {
    await writeSource(a.path, a.html);
    await preview(a.path);
    written += 1;
    console.log(`written  ${a.path}  (${a.state}, previewed)`);
  }
} catch (err) {
  console.error(`\nda-fixture: ${err.message}`);
  console.error(`${written}/${todo.length} document(s) were written before this. Re-run to continue —`);
  console.error('the run reconciles, so anything already correct is skipped.');
  process.exit(1);
}

console.log(`\n${written} document(s) written and previewed. Open one to check:`);
console.log(`  ${plan.previewBase}${fixtures[0].page}`);
console.log('\nNothing was published. This tool only ever calls the preview endpoint.');

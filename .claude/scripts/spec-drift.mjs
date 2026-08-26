#!/usr/bin/env node
/**
 * spec-drift.mjs — detect plans whose spec ticket no longer says what the tests assume.
 *
 *     node .claude/scripts/spec-drift.mjs                check every plan
 *     node .claude/scripts/spec-drift.mjs BRANDS         check one plan by feature/file name
 *     node .claude/scripts/spec-drift.mjs --digest       read a spec description on stdin,
 *                                                        print its acceptance-criteria digest
 *     node .claude/scripts/spec-drift.mjs BRANDS --record
 *                                                        record the current digest in the plan,
 *                                                        from Jira, or from stdin with --stdin
 *
 * Two kinds of drift, and they fail differently.
 *
 * A ticket can be **repurposed**: EC-18 went from "Products Brand Carousel" to "[Megamenu]:
 * Utility Bar" and stranded 13 tests pointing at a spec that no longer described them. The plan
 * records `source.summary`, so comparing summaries catches that. Because test summaries are
 * prefixed with the spec title, this also means every pushed test is now mis-titled.
 *
 * Far more often a ticket keeps its title and its **acceptance criteria are rewritten** underneath
 * the tests. A summary comparison cannot see that at all, which made the agent's own entry
 * criterion — "its ACs have not changed since its tests were written" — unenforceable. So the plan
 * also records a digest of the ticket's acceptance-criteria section, normalised hard enough that
 * reflowing a paragraph or changing a bullet glyph is not reported as a change.
 *
 * Auth: set JIRA_EMAIL and JIRA_API_TOKEN to check automatically. Without them the script prints
 * what to resolve over the Atlassian MCP server, including how to compute a digest from a
 * description the agent has already fetched.
 *
 * Exits 1 when drift is found, so it can gate a pre-sprint check.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { acDigest } from './lib/reconcile.mjs';

const SITE = 'https://unileverfoodsolutions.atlassian.net';
// Resolved from the script, not the process's working directory: this used to report "no plans"
// when run from anywhere but the repo root, which reads exactly like a clean result.
const PLANS = join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'plans');

const argv = process.argv.slice(2);
const wantDigest = argv.includes('--digest');
const record = argv.includes('--record');
const only = argv.find((a) => !a.startsWith('--'));

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`;
const digestOf = (description) => acDigest(description, sha);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

/* ---------------------------------------------------- digest from a pipe */

if (wantDigest && !record) {
  const text = await readStdin();
  const { digest, scoped, length } = digestOf(text);
  console.log(digest);
  if (!scoped) {
    console.error('note: no "Testable Acceptance Criteria" heading found — digested the whole description.');
  }
  if (length < 200) console.error(`note: only ${length} normalised characters — is this the full description?`);
  process.exit(0);
}

/* ------------------------------------------------------------ load plans */

const planFiles = existsSync(PLANS)
  ? readdirSync(PLANS)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.result.json') && !f.endsWith('.jira-actions.json'))
    .filter((f) => !only || basename(f, '.json').toLowerCase() === only.toLowerCase())
  : [];

if (!planFiles.length) {
  console.error(only ? `no plan matching "${only}" in ${PLANS}` : `no plans in ${PLANS}`);
  process.exit(2);
}

const plans = planFiles.map((f) => {
  const path = join(PLANS, f);
  const plan = read(path);
  const resultPath = join(PLANS, `${basename(f, '.json')}.result.json`);
  const pushed = existsSync(resultPath) ? Object.values(read(resultPath).tests || {}) : [];
  return {
    file: f,
    path,
    plan,
    key: plan.source?.key,
    recorded: plan.source?.summary,
    recordedDigest: plan.source?.acDigest,
    pushed,
  };
});

const auth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`
  : null;

const live = async (key) => {
  const res = await fetch(`${SITE}/rest/api/3/issue/${key}?fields=summary,description&expand=renderedFields`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { summary: json.fields.summary, description: json.fields.description ?? '' };
};

/* ------------------------------------------------------------ record mode */

if (record) {
  if (!only) {
    console.error('--record needs a plan: spec-drift.mjs BRANDS --record');
    process.exit(2);
  }
  const p = plans[0];
  // Where the description comes from has to be decided WITHOUT reading stdin first. An absent TTY
  // does not mean anything was piped — an agent or a CI job leaves stdin open and idle, so reading
  // it speculatively either blocks forever or, if it closes, records the digest of the empty
  // string, which matches no spec and quietly disarms the next drift check. So: Jira when we can
  // authenticate, stdin only when asked for it or when there is nothing else.
  const wantsStdin = argv.includes('--stdin') || !auth;
  let description;
  if (wantsStdin && !process.stdin.isTTY) description = await readStdin();
  else if (auth) description = (await live(p.key)).description;
  else {
    console.error('--record needs either JIRA_EMAIL / JIRA_API_TOKEN, or the spec description on stdin.');
    console.error(`Fetch ${p.key} over MCP and pipe its description in:`);
    console.error(`  ... | node .claude/scripts/spec-drift.mjs ${only} --record --stdin`);
    process.exit(2);
  }
  if (!String(description).trim()) {
    console.error(`${p.key} has an empty description — refusing to record a digest that would match nothing.`);
    process.exit(2);
  }
  const { digest, scoped } = digestOf(description);
  p.plan.source = {
    ...p.plan.source,
    acDigest: digest,
    acCheckedOn: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(p.path, `${JSON.stringify(p.plan, null, 2)}\n`);
  console.log(`recorded ${digest} in ${p.file}${scoped ? '' : '  (whole description — no AC heading found)'}`);
  process.exit(0);
}

/* ------------------------------------------------------------ check mode */

const checkable = plans.filter((p) => p.key && p.recorded);
for (const p of plans.filter((x) => !x.key || !x.recorded)) {
  console.log(`SKIP   ${p.file} — no source.key/source.summary recorded, nothing to compare`);
}
const undigested = checkable.filter((p) => !p.recordedDigest);
if (!checkable.length) process.exit(0);

if (!auth) {
  console.log('No JIRA_EMAIL / JIRA_API_TOKEN set — cannot fetch live specs.\n');
  console.log('Resolve these over the Atlassian MCP server and compare against "recorded":\n');
  console.log(`  jql: key in (${checkable.map((p) => p.key).join(', ')})\n`);
  for (const p of checkable) {
    console.log(`  ${p.key.padEnd(8)} summary: ${p.recorded}`);
    console.log(`  ${''.padEnd(8)} acDigest: ${p.recordedDigest || '(none recorded)'}`);
  }
  console.log('\nA changed summary means the ticket was repurposed. To check the criteria, pipe each');
  console.log('description through the digest and compare:\n');
  console.log('  node .claude/scripts/spec-drift.mjs --digest < description.md\n');
  process.exit(0);
}

let drifted = 0;
for (const p of checkable) {
  const now = await live(p.key);
  if (now.gone) {
    drifted += 1;
    console.log(`GONE   ${p.file}  ${p.key} no longer exists — re-point source.key`);
    continue;
  }
  const problems = [];
  if (now.summary !== p.recorded) {
    problems.push(`repurposed — recorded: ${p.recorded}\n                     live:     ${now.summary}`);
  }
  if (p.recordedDigest) {
    const { digest } = digestOf(now.description);
    if (digest !== p.recordedDigest) {
      problems.push(`criteria rewritten — recorded ${p.recordedDigest}, live ${digest}`);
    }
  }
  if (!problems.length) {
    const note = p.recordedDigest ? '' : '  (no acDigest recorded — criteria unchecked)';
    console.log(`ok     ${p.file}  ${p.key} — "${now.summary}"${note}`);
    continue;
  }
  drifted += 1;
  console.log(`DRIFT  ${p.file}  ${p.key}`);
  for (const problem of problems) console.log(`         ${problem}`);
  if (p.pushed.length && now.summary !== p.recorded) {
    console.log(`         ${p.pushed.length} pushed test(s) carry the stale title prefix — retitle or re-point`);
  }
}

if (undigested.length) {
  console.log(`\n${undigested.length} plan(s) have no acDigest, so only their titles were checked:`);
  console.log(`  ${undigested.map((p) => basename(p.file, '.json')).join(', ')}`);
  console.log('  Record one after reviewing the spec:  spec-drift.mjs <FEATURE> --record');
}

if (drifted) {
  console.log(`\n${drifted} plan(s) drifted. Re-read the spec before running anything: re-point source.key,`);
  console.log('update source.summary, retitle the pushed tests where the title moved, and re-check every');
  console.log('AC reference — AC numbering rarely survives a rewrite. Then re-record the digest.');
  console.log('Test ids stay as they are — they are feature-scoped and survive a ticket renumber.');
  process.exit(1);
}
console.log('\nNo drift.');

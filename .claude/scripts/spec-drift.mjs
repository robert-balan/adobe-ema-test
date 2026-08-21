#!/usr/bin/env node
/**
 * spec-drift.mjs — detect plans whose spec ticket has been repurposed.
 *
 *     node .claude/scripts/spec-drift.mjs            check every plan
 *     node .claude/scripts/spec-drift.mjs BRANDS     check one plan by feature/file name
 *
 * Each plan records the summary its spec ticket had when the plan was written
 * (`source.summary`). Tickets get renumbered and repurposed — EC-18 went from
 * "Products Brand Carousel" to "[Megamenu]: Utility Bar" and stranded 13 tests
 * pointing at a spec that no longer described them. This compares the recorded
 * summary against the live one and reports every mismatch.
 *
 * Because our test summaries are prefixed with the spec title, drift also means
 * every pushed test for that plan is now mis-titled; the report says how many.
 *
 * Auth: set JIRA_EMAIL and JIRA_API_TOKEN to check automatically. Without them
 * the script prints the JQL and the expected summaries so an agent can resolve
 * them over the Atlassian MCP server and compare by hand.
 *
 * Exits 1 when drift is found, so it can gate a pre-sprint check.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const SITE = 'https://unileverfoodsolutions.atlassian.net';
const PLANS = '.claude/qa/plans';
const only = process.argv[2];

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const planFiles = existsSync(PLANS)
  ? readdirSync(PLANS)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.result.json') && !f.endsWith('.jira-actions.json'))
      .filter((f) => !only || basename(f, '.json').toLowerCase() === only.toLowerCase())
  : [];

if (!planFiles.length) {
  console.error(only ? `no plan matching "${only}" in ${PLANS}` : `no plans in ${PLANS}`);
  process.exit(2);
}

// A plan without source.summary predates this check and cannot be compared.
const plans = planFiles.map((f) => {
  const plan = read(join(PLANS, f));
  const resultPath = join(PLANS, `${basename(f, '.json')}.result.json`);
  const pushed = existsSync(resultPath) ? Object.values(read(resultPath).tests || {}) : [];
  return { file: f, key: plan.source?.key, recorded: plan.source?.summary, tests: plan.tests || [], pushed };
});

const checkable = plans.filter((p) => p.key && p.recorded);
for (const p of plans.filter((p) => !p.key || !p.recorded)) {
  console.log(`SKIP   ${p.file} — no source.key/source.summary recorded, nothing to compare`);
}
if (!checkable.length) process.exit(0);

const auth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`
  : null;

if (!auth) {
  console.log('No JIRA_EMAIL / JIRA_API_TOKEN set — cannot fetch live summaries.\n');
  console.log('Resolve these over the Atlassian MCP server and compare against "recorded":\n');
  console.log(`  jql: key in (${checkable.map((p) => p.key).join(', ')})\n`);
  for (const p of checkable) console.log(`  ${p.key.padEnd(8)} recorded: ${p.recorded}`);
  console.log('\nAny mismatch means the spec ticket was repurposed — review the plan before running it.');
  process.exit(0);
}

const live = async (key) => {
  const res = await fetch(`${SITE}/rest/api/3/issue/${key}?fields=summary`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status} ${await res.text()}`);
  return { summary: (await res.json()).fields.summary };
};

let drifted = 0;
for (const p of checkable) {
  const now = await live(p.key);
  if (now.gone) {
    drifted += 1;
    console.log(`GONE   ${p.file}  ${p.key} no longer exists — re-point source.key`);
  } else if (now.summary !== p.recorded) {
    drifted += 1;
    console.log(`DRIFT  ${p.file}  ${p.key}`);
    console.log(`         recorded: ${p.recorded}`);
    console.log(`         live:     ${now.summary}`);
    if (p.pushed.length) {
      console.log(`         ${p.pushed.length} pushed test(s) carry the stale title prefix — retitle or re-point`);
    }
  } else {
    console.log(`ok     ${p.file}  ${p.key} — "${now.summary}"`);
  }
}

if (drifted) {
  console.log(`\n${drifted} plan(s) drifted. The spec was repurposed: re-point source.key, update`);
  console.log('source.summary, retitle the pushed tests, and re-check the ACs before running anything.');
  console.log('Test ids stay as they are — they are feature-scoped and survive a ticket renumber.');
  process.exit(1);
}
console.log('\nNo drift.');

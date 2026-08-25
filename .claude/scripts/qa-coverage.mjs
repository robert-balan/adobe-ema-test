#!/usr/bin/env node
/**
 * qa-coverage.mjs — ask Xray what it actually thinks is covered.
 *
 *     node .claude/scripts/qa-coverage.mjs EC-14 EC-18       coverage for these stories
 *     node .claude/scripts/qa-coverage.mjs --plan .claude/qa/plans/BRANDS.json
 *                                                            also check every test in the plan
 *                                                            is one of the tests Xray counts
 *
 * This exists because the check it automates was previously a shell snippet in a document, and the
 * failure it catches is silent. Xray computes requirement coverage from Test -> Story links, in one
 * direction only, and only for link types named in the project's Test Coverage settings. A link
 * made the other way round renders identically in the Jira UI and contributes nothing. Every test
 * in this project was once created that way; nothing surfaced it, because everything looked linked.
 *
 * Coverage is what Xray reports, not what the Jira UI draws, so this asks Xray.
 * Exits 1 if any named issue has no covering tests, or if a plan's tests are missing from one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './lib/gql.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const fail = (msg) => { console.error(`qa-coverage: ${msg}`); process.exit(2); };

const planArg = (() => {
  const i = argv.indexOf('--plan');
  return i >= 0 ? argv[i + 1] : null;
})();
const keys = argv.filter((a) => /^[A-Z][A-Z0-9]*-\d+$/.test(a));

let plan = null;
let ledger = null;
if (planArg) {
  if (!existsSync(planArg)) fail(`no such plan: ${planArg}`);
  plan = JSON.parse(readFileSync(planArg, 'utf8'));
  const resultPath = `${planArg.replace(/\.json$/, '')}.result.json`;
  ledger = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { tests: {} };
  if (plan.source?.key && !keys.includes(plan.source.key)) keys.push(plan.source.key);
}
if (!keys.length) {
  fail('usage: qa-coverage.mjs <ISSUE-KEY...> [--plan <plan.json>]');
}

const client = createClient({
  baseUrl: process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app',
  clientId: process.env.XRAY_CLIENT_ID,
  clientSecret: process.env.XRAY_CLIENT_SECRET,
  onRetry: ({ label, attempt, of, delay }) => console.error(`retry    ${label} (${attempt}/${of}) in ${delay}ms`),
});

const QUERY = `query Coverage($jql: String!, $limit: Int!) {
  getCoverableIssues(jql: $jql, limit: $limit) {
    total
    results {
      issueId
      status { name }
      jira(fields: ["key","summary","issuetype"])
      tests(limit: 100) { total results { issueId jira(fields: ["key","summary","labels"]) } }
    } } }`;

let data;
try {
  data = await client.gql(QUERY, { jql: `key in (${keys.join(', ')})`, limit: 100 }, { label: 'getCoverableIssues' });
} catch (err) {
  fail(err.message);
}

const found = new Map();
for (const r of data?.getCoverableIssues?.results || []) found.set(r.jira.key, r);

let bad = 0;
for (const key of keys) {
  const r = found.get(key);
  if (!r) {
    bad += 1;
    // Xray only treats configured issue types as coverable — in EC that is Story and nothing else.
    console.log(`${key.padEnd(8)} NOT COVERABLE — Xray does not track coverage for this issue type`);
    continue;
  }
  const total = r.tests?.total ?? 0;
  const flag = total === 0 ? '  ← no tests count toward this story' : '';
  console.log(`${key.padEnd(8)} ${String(r.status?.name || '?').padEnd(10)} ${String(total).padStart(3)} test(s)  ${r.jira.summary}${flag}`);
  if (total === 0) bad += 1;

  // A retired test that kept its requirement link still counts here, and will never be executed
  // again — so the story's coverage can never come out green and the figure stops meaning
  // anything. This is the safety net for a deprecation whose unlink step was skipped.
  const retired = (r.tests?.results || []).filter((t) => (t.jira.labels || []).includes('deprecated'));
  if (retired.length) {
    bad += 1;
    console.log(`         ${retired.length} of those are DEPRECATED and still counted: ${retired.map((t) => t.jira.key).join(', ')}`);
    console.log('         They will never run again, so this coverage can never complete.');
    console.log('         Remove their links:  node .claude/scripts/jira-unlink.mjs <plan.json>');
  }
}

/* --------------------------------------------- did the plan's tests land? */

if (plan) {
  const r = found.get(plan.source?.key);
  const counted = new Set((r?.tests?.results || []).map((t) => t.jira.key));
  const expected = [];
  for (const t of plan.tests) {
    const rec = ledger.tests?.[t.id];
    if (rec?.key) expected.push({ id: t.id, key: rec.key });
  }
  const missing = expected.filter((e) => !counted.has(e.key));

  console.log('');
  console.log(`plan ${planArg}`);
  console.log(`  ${expected.length} pushed test(s), ${expected.length - missing.length} counted by Xray toward ${plan.source?.key}`);
  if (!expected.length) {
    console.log('  nothing pushed yet — run xray-push.mjs first');
  } else if (missing.length) {
    bad += 1;
    console.log(`  ${missing.length} NOT COUNTED — the link is missing, or points story → test:`);
    for (const m of missing) console.log(`      ${m.key}  ${m.id}`);
    console.log('  Check the link direction: the Test goes in inwardIssue, the Story in outwardIssue.');
  } else {
    console.log('  every pushed test is counted.');
  }
}

process.exit(bad ? 1 : 0);

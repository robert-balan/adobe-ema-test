#!/usr/bin/env node
/**
 * jira-unlink.mjs — remove the requirement links that a deprecation left behind.
 *
 *     node .claude/scripts/jira-unlink.mjs <plan.json> [--dry-run]
 *
 * Retiring a test removes it from every suite and Test Plan, but the link to its spec ticket is
 * a Jira issue link, and that is the thing Xray actually counts coverage from. Leave it and the
 * story still reports a test that will never run again — so its coverage can never come out green,
 * and the number stops meaning anything. EC-14 sat at "16 tests" with only 7 live because of
 * exactly this.
 *
 * It exists as its own script because nothing else can do the job: Xray's API has no issue-link
 * mutations at all (links belong to Jira), and the Atlassian MCP server can create a link but not
 * delete one. Jira's REST API can, which needs a Jira API token — so this is the one task in the
 * toolchain that cannot be done over MCP.
 *
 * Reads the `unlink` list that xray-push writes into <plan>.jira-actions.json.
 *
 * Auth: JIRA_EMAIL and JIRA_API_TOKEN, stored like the Xray key (see .claude/qa/README.md).
 * Without them it prints exactly what to remove, so the job can still be finished by hand.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SITE = 'https://unileverfoodsolutions.atlassian.net';
const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const dryRun = args.includes('--dry-run');

const fail = (m) => { console.error(`jira-unlink: ${m}`); process.exit(1); };
if (!planPath) fail('usage: jira-unlink.mjs <plan.json> [--dry-run]');

const actionsPath = `${planPath.replace(/\.json$/, '')}.jira-actions.json`;
if (!existsSync(actionsPath)) fail(`no ${actionsPath} — run xray-push first`);
const actions = JSON.parse(readFileSync(actionsPath, 'utf8'));
const unlink = actions.unlink || [];

if (!unlink.length) {
  console.log('Nothing to unlink — no retired test is still linked to its spec ticket.');
  process.exit(0);
}

console.log(`${unlink.length} requirement link(s) to remove:\n`);
for (const u of unlink) console.log(`  ${u.test.padEnd(8)} → ${u.spec}   link ${u.linkId}   (${u.planId})`);

const auth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`
  : null;

if (dryRun) { console.log('\nNothing was removed. Re-run without --dry-run to apply.'); process.exit(0); }

if (!auth) {
  console.log('\nJIRA_EMAIL / JIRA_API_TOKEN are not set, so nothing was removed.');
  console.log('Neither Xray nor the MCP server can delete an issue link — only Jira REST can.\n');
  console.log('Either set a token and re-run, or remove them by hand: open each Test above, find');
  console.log(`the "tests ${unlink[0].spec}" link, and click the ✕ beside it.\n`);
  console.log('With a token, each one is:');
  console.log(`  curl -X DELETE -u "$JIRA_EMAIL:$JIRA_API_TOKEN" ${SITE}/rest/api/3/issueLink/${unlink[0].linkId}`);
  process.exit(2);
}

console.log('');
const done = [];
for (const u of unlink) {
  const res = await fetch(`${SITE}/rest/api/3/issueLink/${u.linkId}`, { method: 'DELETE', headers: { Authorization: auth } });
  // 204 removed it; 404 means it was already gone, which is the same end state.
  if (res.ok || res.status === 404) {
    done.push(u);
    console.log(`removed  ${u.test} → ${u.spec}${res.status === 404 ? '  (already gone)' : ''}`);
  } else {
    console.error(`FAILED   ${u.test} → ${u.spec}: HTTP ${res.status}`);
  }
}

// Only the ones that actually went are dropped from the list, so a re-run retries the rest.
actions.unlink = unlink.filter((u) => !done.includes(u));
writeFileSync(actionsPath, `${JSON.stringify(actions, null, 2)}\n`);

console.log(`\n${done.length}/${unlink.length} removed.`);
console.log('Confirm the coverage figure dropped to the live tests only:');
console.log(`  node .claude/scripts/qa-coverage.mjs --plan ${planPath}`);
process.exit(actions.unlink.length ? 1 : 0);

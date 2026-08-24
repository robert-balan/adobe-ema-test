#!/usr/bin/env node
/**
 * verify-environment.mjs — re-check the instance facts the tooling relies on.
 *
 *     node .claude/scripts/verify-environment.mjs          check and report
 *     node .claude/scripts/verify-environment.mjs --update rewrite environment.json from live
 *
 * Issue-type ids, the coverage configuration, the link type and its direction, and the three test
 * environments were recorded as prose with a verification date. Dating them was the right instinct
 * and it still leaves the same hole: an admin changing any of it produces no signal, the file
 * simply becomes wrong, and it is trusted precisely because it looks verified. A wrong coverage
 * setting is the worst case — every link the agent makes would be correct and count for nothing.
 *
 * Run it with the pre-sprint drift check. Exits 1 on any mismatch.
 *
 * Xray exposes the project settings and link types directly. Jira issue-type ids need Jira
 * credentials; without them those rows are reported as unchecked rather than assumed good.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './lib/gql.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, '..', 'qa', 'environment.json');
const update = process.argv.includes('--update');

const env = JSON.parse(readFileSync(ENV_PATH, 'utf8'));
const client = createClient({
  baseUrl: process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app',
  clientId: process.env.XRAY_CLIENT_ID,
  clientSecret: process.env.XRAY_CLIENT_SECRET,
});

const rows = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (what, recorded, live) => {
  const state = live === undefined ? 'UNCHECKED' : same(recorded, live) ? 'ok' : 'CHANGED';
  rows.push({ what, recorded, live, state });
  return state === 'ok';
};

/* ------------------------------------------------------------------- xray */

const SETTINGS = `query Settings($project: String!) {
  getProjectSettings(projectIdOrKey: $project) {
    projectId
    testEnvironments
    testCoverageSettings { coverableIssueTypeIds issueLinkTypeId issueLinkTypeDirection }
  } }`;
const LINK_TYPES = '{ getIssueLinkTypes { id name } }';

let settings; let linkTypes;
try {
  settings = (await client.gql(SETTINGS, { project: env.project.key }, { label: 'getProjectSettings' }))?.getProjectSettings;
  linkTypes = (await client.gql(LINK_TYPES, {}, { label: 'getIssueLinkTypes' }))?.getIssueLinkTypes;
} catch (err) {
  console.error(`verify-environment: ${err.message}`);
  process.exit(2);
}

const cov = settings?.testCoverageSettings || {};
check('project id', env.project.id, settings?.projectId);
check('coverable issue types', env.coverage.coverableIssueTypeIds, cov.coverableIssueTypeIds);
check('coverage link type id', env.coverage.issueLinkTypeId, cov.issueLinkTypeId);
check('coverage link direction', env.coverage.issueLinkTypeDirection, cov.issueLinkTypeDirection);
check('test environments', env.testEnvironments, settings?.testEnvironments);
check('link type name', env.coverage.issueLinkTypeName,
  linkTypes?.find((l) => l.id === env.coverage.issueLinkTypeId)?.name);

/* ------------------------------------------------------------------- jira */

const auth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`
  : null;

let liveTypes;
if (auth) {
  const res = await fetch(`${env.site}/rest/api/3/project/${env.project.key}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (res.ok) {
    const json = await res.json();
    liveTypes = Object.fromEntries((json.issueTypes || []).map((t) => [t.name, t.id]));
  } else {
    console.error(`note: could not read Jira issue types (HTTP ${res.status})`);
  }
}
for (const [name, id] of Object.entries(env.issueTypes)) {
  check(`issue type "${name}"`, id, liveTypes ? (liveTypes[name] ?? null) : undefined);
}

/* ----------------------------------------------------------------- report */

const width = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) {
  const mark = r.state === 'ok' ? 'ok       ' : r.state === 'CHANGED' ? 'CHANGED  ' : 'unchecked';
  const detail = r.state === 'CHANGED'
    ? `recorded ${JSON.stringify(r.recorded)} → live ${JSON.stringify(r.live)}`
    : JSON.stringify(r.recorded);
  console.log(`${mark} ${r.what.padEnd(width)}  ${detail}`);
}

const changed = rows.filter((r) => r.state === 'CHANGED');
const unchecked = rows.filter((r) => r.state === 'UNCHECKED');

if (unchecked.length) {
  console.log(`\n${unchecked.length} row(s) unchecked — set JIRA_EMAIL and JIRA_API_TOKEN, or read the`);
  console.log(`issue types for ${env.project.key} over MCP and compare by hand.`);
}

if (update) {
  if (!changed.length) console.log('\nNothing to update.');
  else {
    for (const r of changed) {
      if (r.what === 'project id') env.project.id = r.live;
      if (r.what === 'coverable issue types') env.coverage.coverableIssueTypeIds = r.live;
      if (r.what === 'coverage link type id') env.coverage.issueLinkTypeId = r.live;
      if (r.what === 'coverage link direction') env.coverage.issueLinkTypeDirection = r.live;
      if (r.what === 'link type name') env.coverage.issueLinkTypeName = r.live;
      if (r.what === 'test environments') env.testEnvironments = r.live;
      const m = r.what.match(/^issue type "(.+)"$/);
      if (m && r.live) env.issueTypes[m[1]] = r.live;
    }
    env.verifiedOn = new Date().toISOString().slice(0, 10);
    writeFileSync(ENV_PATH, `${JSON.stringify(env, null, 2)}\n`);
    console.log(`\nUpdated ${changed.length} value(s) in ${ENV_PATH}.`);
    console.log('Read the diff before committing — a changed coverage setting can silently zero every');
    console.log('coverage figure in the project, and recording it is not the same as agreeing with it.');
  }
  process.exit(0);
}

if (changed.length) {
  console.log(`\n${changed.length} fact(s) changed since ${env.verifiedOn}. Find out who changed them and why`);
  console.log('before running anything that writes. Then re-run with --update.');
  process.exit(1);
}
console.log(`\nAll checked facts match (recorded ${env.verifiedOn}).`);

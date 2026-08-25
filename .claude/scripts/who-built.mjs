#!/usr/bin/env node
/**
 * who-built.mjs — who should answer for the code behind a ticket?
 *
 *     node .claude/scripts/who-built.mjs EC-22 EC-18
 *
 * When a spec describes something the implementation does not do, the question needs a developer
 * as well as the requirements engineers — otherwise the two sides answer past each other. The
 * ticket's current assignee is usually no help: by the time QA reads it, it has often been handed
 * on or unassigned entirely.
 *
 * So this reads the changelog instead and asks a narrower question: which front-end developer held
 * the ticket while it was being built? It reports the assignee at the moment the ticket entered
 * an in-progress status, and anyone from the front-end roster who held it afterwards.
 *
 * If nobody from the roster ever held it, it says so and falls back to the lead — and that gap is
 * worth noticing in itself. EC-22 went straight from To Do to Ready for Testing with no developer
 * ever assigned, which turned out to match the fact that part of its spec was never implemented.
 *
 * The roster lives in .claude/qa/environment.json under `people`, so it is data rather than code.
 * Auth: JIRA_EMAIL and JIRA_API_TOKEN — the changelog is Jira REST only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = JSON.parse(readFileSync(join(HERE, '..', 'qa', 'environment.json'), 'utf8'));
const SITE = env.site;
const frontend = env.people?.frontend || [];
const lead = frontend.find((p) => p.lead) || frontend[0];

const keys = process.argv.slice(2).filter((a) => /^[A-Z][A-Z0-9]*-\d+$/.test(a));
const fail = (m) => { console.error(`who-built: ${m}`); process.exit(2); };
if (!keys.length) fail('usage: who-built.mjs <ISSUE-KEY...>');

const auth = process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`
  : fail('JIRA_EMAIL / JIRA_API_TOKEN are not set — the changelog is only readable over Jira REST');

// "Being built" is any status that is neither the backlog nor a testing/done state. Matching on
// intent rather than on one exact name, because workflow names drift.
const IN_PROGRESS = /in progress|development|implementation|building/i;

for (const key of keys) {
  const res = await fetch(`${SITE}/rest/api/3/issue/${key}?expand=changelog&fields=summary,assignee,status`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok) { console.log(`${key}  could not be read (HTTP ${res.status})`); continue; }
  const issue = await res.json();

  const events = [];
  for (const h of issue.changelog?.histories || []) {
    for (const it of h.items) {
      if (it.field === 'status' || it.field === 'assignee') {
        events.push({ at: h.created, field: it.field, to: it.toString, from: it.fromString });
      }
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  // Replay the timeline, tracking who held it and whether it had reached an in-progress state.
  let holder = null;
  let everInProgress = false;
  const heldWhileBuilding = new Set();
  for (const e of events) {
    if (e.field === 'assignee') holder = e.to || null;
    if (e.field === 'status' && IN_PROGRESS.test(e.to || '')) {
      everInProgress = true;
      if (holder) heldWhileBuilding.add(holder);
    }
    if (everInProgress && e.field === 'assignee' && e.to) heldWhileBuilding.add(e.to);
  }

  const devs = [...heldWhileBuilding].filter((n) => frontend.some((p) => p.name === n));
  const current = issue.fields.assignee?.displayName || '(unassigned)';

  console.log(`\n${key}  ${issue.fields.summary}`);
  console.log(`  status now: ${issue.fields.status.name}   assignee now: ${current}`);
  if (!everInProgress) {
    console.log('  ⚠ never entered an in-progress status — it went straight to testing.');
  }
  if (devs.length) {
    console.log(`  developer(s) who held it while building: ${devs.join(', ')}`);
    for (const d of devs) console.log(`      ${frontend.find((p) => p.name === d).accountId}`);
  } else {
    console.log(`  no front-end developer ever held it — tag the lead, ${lead.name}`);
    console.log(`      ${lead.accountId}`);
  }
}
console.log('');

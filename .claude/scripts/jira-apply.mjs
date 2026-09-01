#!/usr/bin/env node
/**
 * Apply a plan's Jira-side field actions.
 *
 *   node .claude/scripts/jira-apply.mjs <plan.json> [<plan.json> …]     preview, writes nothing
 *   JIRA_APPLY_APPROVED=1 node .claude/scripts/jira-apply.mjs <plan.json> --apply
 *
 * Why this exists: Xray owns test steps, test type and suite membership, and `xray-push` writes
 * those itself. Jira owns summary, description and labels, which the Xray API cannot touch — so the
 * push leaves them in `<plan>.jira-actions.json` for someone to apply.
 *
 * The documented route for that is the Atlassian MCP server, one call per test, and it is still the
 * right route for one or two. It stops being reasonable in bulk: a change to how `describeTest`
 * builds a description touches every test in the project at once, and forty-five hand-made edits is
 * how a typo reaches a live ticket. That happened on 2026-09-01 — forty-five descriptions in one
 * go — and the script written to do it was a throwaway that had to be rebuilt from memory halfway
 * through when /tmp was cleared. This is that script, kept, guarded and tested.
 *
 * Fields only. Issue links are deliberately out of scope: creating one is an MCP call, and deleting
 * one already has `jira-unlink.mjs`, which exists because MCP cannot delete a link at all.
 *
 * The risk here is not the request, it is the document-tree conversion — Jira stores a tree, not
 * text, and mangling it renders badly rather than failing. That lives in `lib/adf.mjs` with its own
 * tests, because the reconciliation check cannot see formatting: `sameText` strips emphasis markers
 * before comparing, so a mangled description still reports as unchanged on the next push.
 */
import { readFileSync, existsSync } from 'node:fs';
import { toAdf, fromAdf } from './lib/adf.mjs';

const SITE = process.env.JIRA_BASE_URL || 'https://unileverfoodsolutions.atlassian.net';
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const plans = argv.filter((a) => !a.startsWith('--'));

const fail = (msg) => { console.error(`jira-apply: ${msg}`); process.exit(1); };
if (!plans.length) fail('usage: jira-apply.mjs <plan.json> [more …] [--apply]');

const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
if (!email || !token) fail('JIRA_EMAIL and JIRA_API_TOKEN are both needed — see .claude/qa/README.md');
const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

// The same approval the other write scripts take, and for the same reason: this one can rewrite
// every description in the project in a single command.
if (apply && process.env.JIRA_APPLY_APPROVED !== '1') {
  fail('--apply needs JIRA_APPLY_APPROVED=1 in the command. Show the preview first, and repeat the\n'
    + '           approval in the invocation so it is recorded in the transcript:\n'
    + '             JIRA_APPLY_APPROVED=1 node .claude/scripts/jira-apply.mjs <plan.json> --apply');
}

const api = (path, init) => fetch(`${SITE}/rest/api/3${path}`, {
  ...init,
  headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init?.headers || {}) },
});

let edits = 0; let labels = 0; let failed = 0;

for (const planPath of plans) {
  const actionsPath = `${planPath.replace(/\.json$/, '')}.jira-actions.json`;
  if (!existsSync(actionsPath)) { console.log(`\n${planPath}\n  no ${actionsPath} — run xray-push first`); continue; }
  const a = JSON.parse(readFileSync(actionsPath, 'utf8'));
  console.log(`\n${planPath}`);

  // A deprecation adds a label rather than replacing the set, so read what is there first: the
  // issue may carry labels nobody in this repo put on it.
  for (const dep of a.deprecate || []) {
    const cur = await api(`/issue/${dep.key}?fields=labels`);
    if (!cur.ok) { console.log(`  FAIL ${dep.key}  reading labels: ${cur.status}`); failed += 1; continue; }
    const next = [...new Set([...(await cur.json()).fields.labels, dep.addLabel])];
    if (!apply) { console.log(`  would label  ${dep.key}  ${dep.planId}  +${dep.addLabel}`); labels += 1; continue; }
    const res = await api(`/issue/${dep.key}`, { method: 'PUT', body: JSON.stringify({ fields: { labels: next } }) });
    console.log(`  ${res.ok ? 'labelled' : 'FAIL    '} ${dep.key}  ${dep.planId}  +${dep.addLabel}`);
    res.ok ? (labels += 1) : (failed += 1);
  }

  for (const e of a.edits || []) {
    const fields = {};
    // Only what actually changed. Restating a field that already matches is a needless write and
    // shows up in the ticket's history as noise.
    if (e.changed.includes('description')) fields.description = toAdf(e.fields.description);
    if (e.changed.includes('summary')) fields.summary = e.fields.summary;
    if (e.changed.includes('labels')) fields.labels = e.fields.labels;
    const what = Object.keys(fields).join(', ');
    if (!what) { console.log(`  skip     ${e.key}  ${e.planId}  nothing Jira owns changed`); continue; }
    if (!apply) { console.log(`  would edit   ${e.key}  ${e.planId}  (${what})`); edits += 1; continue; }

    const res = await api(`/issue/${e.key}`, { method: 'PUT', body: JSON.stringify({ fields }) });
    if (!res.ok) {
      console.log(`  FAIL     ${e.key}  ${e.planId}  ${(await res.text()).slice(0, 160)}`);
      failed += 1;
      continue;
    }
    // Read it back. A write can succeed and still store the wrong shape, and this is the one class
    // of mistake the next push will not report — so it is checked here or never.
    let note = '';
    if (fields.description) {
      const back = await api(`/issue/${e.key}?fields=description`);
      const stored = back.ok ? fromAdf((await back.json()).fields.description) : null;
      const norm = (s) => String(s || '').replace(/[*_]/g, '').replace(/[ \t]+$/gm, '').trim();
      if (stored === null) note = '  (could not read back)';
      else if (norm(stored) !== norm(e.fields.description)) { note = '  MISMATCH after write'; failed += 1; }
    }
    console.log(`  edited   ${e.key}  ${e.planId}  (${what})${note}`);
    edits += 1;
  }
}

const verb = apply ? 'applied' : 'pending';
console.log(`\n${edits} field edit(s) and ${labels} label change(s) ${verb}.`);
if (failed) { console.error(`${failed} problem(s) above.`); process.exit(1); }
if (!apply) {
  console.log('Nothing was written. Re-run with --apply, and the approval in the command, to write:');
  console.log(`  JIRA_APPLY_APPROVED=1 node .claude/scripts/jira-apply.mjs ${plans.join(' ')} --apply`);
}

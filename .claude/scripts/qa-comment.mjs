#!/usr/bin/env node
/**
 * qa-comment.mjs — post the QA discrepancy comment on a spec ticket.
 *
 *     node .claude/scripts/qa-comment.mjs .claude/qa/comments/EC-7.json              # preview
 *     QA_COMMENT_APPROVED=1 node .claude/scripts/qa-comment.mjs .claude/qa/comments/EC-7.json --post
 *
 * After a plan is pushed, one comment goes on the spec ticket carrying the discrepancies the test
 * design turned up — the spec against the design, or the spec against what was built. Its shape is
 * fixed in `.claude/agents/qa-xray.md`; this script builds it so the fixed parts stay fixed.
 *
 * **It updates in place by default.** `commentId` in the spec file names the comment to rewrite, so
 * re-running after a correction edits the one comment rather than stacking a second copy under it.
 * `--new` creates the first one and writes the id it gets back into the spec file.
 *
 * Auth: JIRA_EMAIL and JIRA_API_TOKEN, stored like the Xray key (see .claude/qa/README.md). The
 * Atlassian MCP server can add a comment but not edit one, and it is the edit that matters here.
 *
 * Writing is gated the same way as a push: the PreToolUse guard denies `--post` unless the user's
 * approval is repeated in the command itself as QA_COMMENT_APPROVED=1. Show them the preview first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { approvalProblem } from './lib/approval.mjs';
import { buildComment, renderPreview, roster, countMentions } from './lib/qa-comment.mjs';

const SITE = 'https://unileverfoodsolutions.atlassian.net';
const ENVIRONMENT = new URL('../qa/environment.json', import.meta.url);

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const post = args.includes('--post');
const isNew = args.includes('--new');

const fail = (m) => { console.error(`qa-comment: ${m}`); process.exit(1); };
if (!specPath) fail('usage: qa-comment.mjs <comment.json> [--post] [--new]');

// Same check the PreToolUse hook makes, in the script, so it holds under any tool. Without --post
// this only prints the comment, which is the preview and needs no approval.
{
  const problem = approvalProblem({
    writes: post,
    variable: 'QA_COMMENT_APPROVED',
    script: 'qa-comment.mjs',
    args: '<comment.json> --post',
    target: 'write a comment on a real Jira ticket',
  });
  if (problem) fail(problem);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const people = roster(JSON.parse(readFileSync(ENVIRONMENT, 'utf8')));

let body;
try {
  body = buildComment(spec, people);
} catch (e) {
  fail(`${specPath}: ${e.message}`);
}

console.log(renderPreview(body));

const target = spec.commentId ? `comment ${spec.commentId}` : 'a new comment';
if (!post) {
  console.log(`[preview only — ${spec.issue} ${target} not touched]`);
  console.log(`To post it: QA_COMMENT_APPROVED=1 node .claude/scripts/qa-comment.mjs ${specPath} --post${spec.commentId ? '' : ' --new'}`);
  process.exit(0);
}

// Refusing rather than guessing: a spec with no id and no --new almost always means the id was
// lost, and posting would leave two QA comments on the ticket saying different things.
if (!spec.commentId && !isNew) fail(`${spec.issue} has no commentId — pass --new to create the first comment, or add the id of the one to rewrite`);
if (spec.commentId && isNew) fail(`${spec.issue} already has commentId ${spec.commentId} — drop --new to rewrite it`);

const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_EMAIL || !JIRA_API_TOKEN) fail('JIRA_EMAIL / JIRA_API_TOKEN are not set — see .claude/qa/README.md');
const auth = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;

const base = `${SITE}/rest/api/3/issue/${spec.issue}/comment`;
const res = await fetch(isNew ? base : `${base}/${spec.commentId}`, {
  method: isNew ? 'POST' : 'PUT',
  headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ body }),
});
if (!res.ok) fail(`HTTP ${res.status} on ${spec.issue}: ${await res.text()}`);

const saved = await res.json();
if (isNew) {
  spec.commentId = saved.id;
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
}

// Read the count off what Jira stored, not off what was sent. A mention that arrived as plain text
// looks correct in the ticket and notifies nobody, which is the failure this whole file guards.
const mentions = countMentions(saved.body);
console.log(`${isNew ? 'CREATED' : 'UPDATED'} ${spec.issue} comment ${saved.id} — ${mentions}/${spec.mentions.length} mention nodes stored, ${saved.updated || saved.created}`);
if (mentions !== spec.mentions.length) fail('a mention came back as plain text — nobody was notified for it; check the accountIds in environment.json');
console.log(`  ${SITE}/browse/${spec.issue}?focusedCommentId=${saved.id}`);

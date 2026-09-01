/**
 * The in-script approval gate.
 *
 *   node --test .claude/scripts/test/
 *
 * These are unit tests rather than end-to-end ones on purpose: the PreToolUse hook denies an
 * unapproved run before the script starts, so the script's own check cannot be reached from a
 * Claude Code shell at all. That layering is the point — but it means the only honest way to test
 * the backstop is to call it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalProblem } from '../lib/approval.mjs';

const gate = (over = {}) => approvalProblem({
  writes: true,
  variable: 'XRAY_PUSH_APPROVED',
  script: 'xray-push.mjs',
  args: '<plan.json>',
  target: 'create or modify real Jira issues',
  env: {},
  ...over,
});

test('approvalProblem: a read-only run needs no approval', () => {
  assert.equal(gate({ writes: false }), null);
  assert.equal(gate({ writes: false, env: { XRAY_PUSH_APPROVED: '1' } }), null);
});

test('approvalProblem: a write with the approval present proceeds', () => {
  assert.equal(gate({ env: { XRAY_PUSH_APPROVED: '1' } }), null);
});

test('approvalProblem: a write without it is refused, and says what to do', () => {
  const msg = gate();
  assert.match(msg, /not approved/);
  assert.match(msg, /create or modify real Jira issues/, 'names what would be written');
  assert.match(msg, /XRAY_PUSH_APPROVED=1 node \.claude\/scripts\/xray-push\.mjs <plan\.json>/);
});

// Only "1" counts. A variable that is merely present — set empty by a shell profile, or left at
// "0" or "false" by someone half-remembering the rule — is not a person's decision.
test('approvalProblem: only the exact value "1" approves', () => {
  for (const v of ['', '0', 'false', 'true', 'yes', ' 1', '1 ']) {
    assert.notEqual(gate({ env: { XRAY_PUSH_APPROVED: v } }), null, `"${v}" must not approve`);
  }
});

test('approvalProblem: each script gets its own variable in the message', () => {
  assert.match(
    gate({ variable: 'DA_FIXTURE_APPROVED', script: 'da-fixture.mjs', target: "write to the client's authoring environment" }),
    /DA_FIXTURE_APPROVED=1 node \.claude\/scripts\/da-fixture\.mjs/,
  );
  assert.match(
    gate({ variable: 'QA_COMMENT_APPROVED', script: 'qa-comment.mjs', args: '<comment.json> --post' }),
    /QA_COMMENT_APPROVED=1 node \.claude\/scripts\/qa-comment\.mjs <comment\.json> --post/,
  );
});

// The gate reads the environment it is handed, so a test can never be affected by the real one.
test('approvalProblem: defaults to process.env but takes an override', () => {
  const withEnv = approvalProblem({
    writes: true, variable: 'NEVER_SET_ANYWHERE', script: 's.mjs', args: 'x', target: 'do a thing',
  });
  assert.match(withEnv, /NEVER_SET_ANYWHERE/);
});

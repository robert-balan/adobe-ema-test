/**
 * The approval gate on anything that writes to production, enforced by the scripts themselves.
 *
 * There is a `PreToolUse` hook in `.claude/settings.json` that denies these runs unless the
 * approval is written into the command, and it is the better place for the check: it fires before
 * the command runs at all, and it can explain itself. But it is Claude Code's hook, and Claude Code
 * is not the only thing that will ever drive this repo — a colleague using Copilot, a person in a
 * terminal, a CI job. For those the hook does not exist, and until this file existed
 * `xray-push.mjs`, `da-fixture.mjs` and `qa-comment.mjs` would write straight to a client's Jira and
 * authoring environment with nothing asking first.
 *
 * So the hook stays as the first line of defence and this is the backstop. Same variable, same
 * meaning, so approving a run satisfies both at once and nobody has to learn two mechanisms.
 *
 * The variable is deliberately not something a script can set for itself. It stands for a person's
 * decision, it is repeated in the invocation, and that is what makes it visible in a transcript or
 * a shell history afterwards.
 */

/**
 * @param {object} o
 * @param {boolean} o.writes    whether this invocation would write to production at all
 * @param {string}  o.variable  the environment variable that carries the approval
 * @param {string}  o.script    script filename, for the message
 * @param {string}  o.args      the arguments the writing form takes, for the message
 * @param {string}  o.target    what gets written, in the user's terms
 * @param {object} [o.env]      defaults to process.env
 * @returns {string|null} a message to fail with, or null when the run may proceed
 */
export function approvalProblem({ writes, variable, script, args, target, env = process.env }) {
  if (!writes) return null;
  if (env[variable] === '1') return null;
  return `this would ${target}, and the run is not approved.\n`
    + `           Show the dry run first, then repeat the approval in the command so it is\n`
    + `           recorded rather than remembered:\n`
    + `             ${variable}=1 node .claude/scripts/${script} ${args}`;
}

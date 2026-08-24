#!/usr/bin/env bash
# PreToolUse guard: no unapproved writes to Jira and Xray.
#
# The qa-xray agent's first hard rule is that nothing reaches Jira until the user has seen the
# proposed set and approved it. Until this hook existed that rule was prose, and the command that
# writes to production differed from the safe one by an absent flag — so the rule held only for as
# long as the agent kept reading it.
#
# Reads the PreToolUse payload on stdin and denies a Bash call that runs xray-push.mjs unless it
# is a read-only mode, or the approval is written into the command itself. Approving by prefixing
# the variable rather than exporting it is deliberate: the approval is then visible in the
# transcript, scoped to one invocation, and cannot linger in a shell.
set -euo pipefail

allow() { exit 0; }

deny() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || allow

# Only an actual invocation counts. Reading, grepping or naming the script in a message is not a
# write, and a guard that blocks those gets switched off — which costs more than it saves.
invokes() {
  printf '%s' "$command" | grep -Eq \
    -e '(^|[;&|]|[[:space:]])(node|nodejs)[[:space:]]+[^;&|]*xray-push\.mjs' \
    -e '(^|[;&|][[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(\.{0,2}/)[^[:space:];&|]*xray-push\.mjs'
}
invokes || allow

# Read-only modes write nothing to Xray and need no approval.
case "$command" in
  *--dry-run*|*--adopt*) allow ;;
esac

case "$command" in
  *XRAY_PUSH_APPROVED=1*) allow ;;
esac

deny "Blocked: this would create or modify real Jira issues, and the run is not marked as approved.

Show the user the dry run first:
    node .claude/scripts/xray-push.mjs <plan.json> --dry-run

Once they have seen it and said go, repeat their approval in the command itself:
    XRAY_PUSH_APPROVED=1 node .claude/scripts/xray-push.mjs <plan.json>

Do not set that variable on your own initiative — it stands for a person's decision, and it is
recorded in the transcript as one."

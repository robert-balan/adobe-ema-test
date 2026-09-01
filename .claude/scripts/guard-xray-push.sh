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
  local script="$1"
  printf '%s' "$command" | grep -Eq \
    -e "(^|[;&|]|[[:space:]])(node|nodejs)[[:space:]]+[^;&|]*${script}" \
    -e "(^|[;&|][[:space:]]*)([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(\.{0,2}/)[^[:space:];&|]*${script}"
}

if invokes 'xray-push\.mjs'; then
  tool=xray; approval=XRAY_PUSH_APPROVED; target="real Jira issues"
  script=xray-push.mjs; preview='<plan.json> --dry-run'; args='<plan.json>'
elif invokes 'da-fixture\.mjs'; then
  tool=fixture; approval=DA_FIXTURE_APPROVED; target="content in the client's authoring environment"
  script=da-fixture.mjs; preview='<plan.json> --dry-run'; args='<plan.json>'
elif invokes 'qa-comment\.mjs'; then
  tool=comment; approval=QA_COMMENT_APPROVED; target="a comment on a real Jira ticket"
  script=qa-comment.mjs; preview='<comment.json>'; args='<comment.json> --post'
elif invokes 'jira-apply\.mjs'; then
  tool=apply; approval=JIRA_APPLY_APPROVED; target="summaries, descriptions and labels on real Jira issues"
  script=jira-apply.mjs; preview='<plan.json>'; args='<plan.json> --apply'
else
  allow
fi

# Read-only modes write nothing and need no approval. qa-comment only writes with --post: without
# it the script prints the comment and stops, which is the preview the user is meant to see.
case "$command" in
  *--dry-run*|*--adopt*) allow ;;
esac
if [ "$tool" = comment ]; then
  case "$command" in
    *--post*) ;;
    *) allow ;;
  esac
fi
# jira-apply previews unless asked to write, so an invocation without --apply needs no approval.
if [ "$tool" = apply ]; then
  case "$command" in
    *--apply*) ;;
    *) allow ;;
  esac
fi

case "$command" in
  *"${approval}=1"*) allow ;;
esac

deny "Blocked: this would create or modify ${target}, and the run is not marked as approved.

Show the user the dry run first:
    node .claude/scripts/${script} ${preview}

Once they have seen it and said go, repeat their approval in the command itself:
    ${approval}=1 node .claude/scripts/${script} ${args}

Do not set that variable on your own initiative — it stands for a person's decision, and it is
recorded in the transcript as one."

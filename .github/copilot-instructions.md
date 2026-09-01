# Copilot instructions

**Read [`AGENTS.md`](../AGENTS.md) first.** It is the project's own description of what this
repository is and how to work in it, and it applies to every tool, not just one. This file exists
because Copilot looks here; it deliberately does not restate what is there, because two copies of a
rule drift apart and the reader has no way to tell which one is current.

The short version: this is a **QA workspace**, not a website. It holds the tooling that turns Jira
specifications into Xray test cases for a separate Edge Delivery site. There is nothing here to
build, serve, preview or lint. If a task looks like it needs a block, a stylesheet or a dev server,
it belongs in a different repository.

## The one rule to read before running anything

**Four scripts write to production** — a client's Jira project and a client's authoring
environment. Nothing in this repository writes to either without an approval repeated in the
command itself:

```sh
node .claude/scripts/xray-push.mjs <plan.json> --dry-run          # safe, shows what would change
XRAY_PUSH_APPROVED=1 node .claude/scripts/xray-push.mjs <plan.json>
```

| Script | Approval | Writes to |
|---|---|---|
| `xray-push.mjs` | `XRAY_PUSH_APPROVED=1` | Xray test steps, suites, Test Plans |
| `da-fixture.mjs` | `DA_FIXTURE_APPROVED=1` | the client's authoring environment |
| `jira-apply.mjs` | `JIRA_APPLY_APPROVED=1` + `--apply` | Jira summaries, descriptions, labels |
| `qa-comment.mjs` | `QA_COMMENT_APPROVED=1` + `--post` | a comment on a Jira ticket |

Every one of them has a read-only mode, and the read-only mode is where you start. **Do not set
those variables on your own initiative.** They stand for a person's decision, and repeating one in
the command is what records that decision where someone can see it afterwards.

Each script also checks its own variable, so the rule holds whatever is driving it — Copilot, a
terminal, or CI. There is a `PreToolUse` hook that enforces the same thing a step earlier, but that
hook is Claude Code's and does not run here, which is exactly why the checks are in the scripts too.

## Working here

- Node ES modules, no build step, no transpiling, no framework.
- **Deliberately dependency-free.** Adding a dependency to run a script is a trade that needs
  justifying in the pull request, not a default.
- Run `npm test` before proposing any change under `.claude/scripts/`. It takes about a second and
  needs nothing installed.
- Test steps, plan files and commit messages are read by the client. Keep them accurate and keep
  confidential detail out of them.

## What lives where

```
.claude/agents/qa-xray.md   the doctrine: how a test case is designed, and the hard rules
.claude/qa/                 the plan schema, the plans, and README.md — start there
.claude/scripts/            the tooling, and its tests
```

`.claude/` is Claude Code's directory, and some of it — `settings.json`, the agent's tool list — only
means something to that tool. The parts that matter to everyone are the scripts, which are plain
Node, and the doctrine in `.claude/qa/` and `.claude/agents/qa-xray.md`, which is prose. Read it
before changing how a test is written; most of it exists because something went wrong once.

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

## Start here, in this order

```sh
node .claude/scripts/qa-status.mjs
```

No credentials, no network. It prints every plan, every test with its live Jira key, and every open
finding — which is the fastest way to understand where the project actually is. Then:

1. [`AGENTS.md`](../AGENTS.md) — what this repository is, and the parts of Edge Delivery that change
   what a test should assert.
2. [`.claude/qa/README.md`](../.claude/qa/README.md) — setup, how a push reconciles rather than
   recreates, and the conventions the tooling enforces.
3. [`.claude/agents/qa-xray.md`](../.claude/agents/qa-xray.md) — the doctrine: how a test case is
   designed, and the hard rules. Written for Claude Code, but the body is prose and applies to
   anyone. Most of it exists because something went wrong once.
4. `.claude/qa/how-the-agent-works.html` and `onboarding.html` — the same ground for a reader who
   prefers a walkthrough.

Two things that will otherwise cost you an hour:

- **"Cannot update this protected ref"** on a push to `main` is not a failure. Look for the
  `abc123..def456  main -> main` line under it. It is an admin bypass reporting the rule it ignored.
- **A 401 from a script whose token you just set** is almost always the shell, not the token. Read
  the keychain in the same command that uses it rather than relying on an inherited variable.

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

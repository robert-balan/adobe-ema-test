# qa-xray

Turns Jira specifications into Xray test cases, and keeps them honest afterwards.

This repository holds a Claude Code agent and the tooling it drives. Point it at a spec ticket and
it reads the acceptance criteria, grounds each assertion in the real implementation and the design
handover, writes a reviewable plan file, and — only once a human has approved it — creates the Xray
Tests in Jira, adds them to the right suites, and links them to the ticket so Xray actually counts
the coverage.

The site under test lives elsewhere. Nothing is built or served from here.

```sh
npm test        # the tooling's own tests — no dependencies, about a second
```

## Start here

**[`.claude/qa/README.md`](.claude/qa/README.md)** — setup, the Xray API key, how a push
reconciles rather than recreates, and how two people share the work without creating duplicate
tests.

**[`.claude/qa/onboarding.html`](.claude/qa/onboarding.html)** — a walkthrough for QA collaborators
who have not used the agent before.

**[`.claude/agents/qa-xray.md`](.claude/agents/qa-xray.md)** — the doctrine: how test cases are
designed, how they are grouped, what every block must be covered against, and why. Every rule
carries the reason it exists, so it can be argued with.

## The shape of it

```
> use the qa-xray agent to write test cases for EC-18

.claude/qa/plans/UTILITY.json          the plan — the master copy, reviewed in a PR
                    ↓  xray-push.mjs
EC-140 … EC-152                        Xray Tests, labelled with their plan id
                    ↓  qa-coverage.mjs
EC-18  COVERED  13 tests               what Xray actually counts
```

The plan file is the master copy and Jira is the published copy. Re-running a revised plan edits
the existing tickets in place rather than creating a second set, because each test carries its plan
id as a Jira label — so a colleague pushing from a fresh clone adopts your tests instead of
duplicating them. Nothing is ever deleted; retiring a test removes it from the suites and keeps its
execution history.

Three things are checked in both directions before anything is written, because each can drift
without leaving a trace anywhere a person would look: the test's own fields, its suite membership,
and the requirement link — which renders identically in Jira whether it is right or backwards, and
counts for nothing when it is backwards.

## A note on this repository being public

Plan files are tracked so they can be reviewed and shared, which means every word of a test step is
world-readable and permanent once pushed. Keep client-confidential detail out of them — or move
`.claude/qa/plans/` into a private repository checked out at that path, which the tooling supports
unchanged.

## History

This started as a copy of [aem-boilerplate](https://github.com/adobe/aem-boilerplate/) and carried
a full Edge Delivery site for a while. None of it was ever used, and all of it has been removed.
The `LICENSE`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` still date from that inheritance and
describe Adobe's contribution process rather than this project's.

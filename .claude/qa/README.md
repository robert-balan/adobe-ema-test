# QA / Xray setup

The `qa-xray` agent (`.claude/agents/qa-xray.md`) reads a Jira ticket, derives test cases from
its acceptance criteria, and creates real Xray Tests and Test Sets in project **EC**.

## Design sources

The Jira spec is the contract; the handover prototype is where its values come from. URLs and the
extraction recipe live in [`design-sources.md`](design-sources.md) — read it before writing any
test step that asserts a colour, size, spacing or timing.

Note this repo is an aem-boilerplate **sandbox** for building the QA tooling, not the site under
test, and it is public. Keep proprietary spec and design detail out of tracked files.

## Prerequisites

### 1. Xray API key

Xray Cloud keeps test steps and test type in its own store, reachable only through the Xray
GraphQL API — the Atlassian MCP server cannot write them. So the agent needs an Xray API key.

1. In Jira, open the **settings gear → Apps → Marketplace Apps**, find the **Xray** section in
   the left sidebar and pick **API Keys**. Requires Jira/Xray admin permission.
2. Click **Create API Key**, type your own name in the **User** field and select it from the
   suggestions. Copy both the **Client ID** and the **Client Secret** — the secret is shown once
   and cannot be retrieved later.

   The key is bound to that Jira user and inherits their permissions, so tests get created as
   them. For shared CI use, generate the key against a dedicated automation account instead.
3. Store them outside the repo. `robert-balan/adobe-ema-test` is a **public** GitHub repo, so a
   committed secret is world-readable and picked up by credential scanners within minutes. Never
   put them in `.mcp.json`, `.claude/settings.local.json`, any tracked file, or a chat transcript.

   **Preferred — macOS Keychain.** Encrypted at rest, and `-w` with no value prompts so the
   secret never enters shell history:

   ```sh
   security add-generic-password -a "$USER" -s xray-client-id -w
   security add-generic-password -a "$USER" -s xray-client-secret -w
   ```

   then in `~/.zshrc`:

   ```sh
   export XRAY_CLIENT_ID="$(security find-generic-password -a "$USER" -s xray-client-id -w 2>/dev/null)"
   export XRAY_CLIENT_SECRET="$(security find-generic-password -a "$USER" -s xray-client-secret -w 2>/dev/null)"
   # only if your site is pinned to a region:
   # export XRAY_BASE_URL='https://us.xray.cloud.getxray.app'
   ```

   **Alternative — a mode-600 env file** at `~/.config/xray/env`, sourced from `~/.zshrc`. Paste
   the values in with an editor rather than typing them on a command line, or they land in
   `~/.zsh_history`.

   Have the admin deliver the key through a password manager share, not Slack or email.

4. Verify:

   ```sh
   .claude/scripts/xray-api.sh check
   ```

The bearer token is cached in `$TMPDIR` for 20h (Xray tokens last 24h); the API key itself does
not expire. If a key leaks, an admin deletes it in Xray's API Keys page and
issues a new one — the secret can never be re-displayed, so regeneration is the only path either
way, which at least makes containment cheap.

**A Jira API token is not a substitute.** This comes up often because it is true on Xray
Server/Data Center, where test steps are a Jira custom field ("Manual Test Steps") and Jira REST
can write them. Xray *Cloud* moved them out of Jira: the Xray REST/GraphQL API at
`xray.cloud.getxray.app` rejects Jira Basic Auth and only accepts a bearer token minted from an
Xray Client ID + Secret. Verified against this instance — `EC-58` is a real Xray Test issue and
a `*all` field expansion returns no step, test-type, or Test Set field of any kind. The clinching
detail is that Xray exposes `addTestStep` as a GraphQL mutation at all; if steps were a Jira
field, that mutation would not need to exist.

### 2. Test Set issue type enabled in EC — done

Enabled on 2026-08-18. EC now exposes `Xray Test` (12531), `Test Set` (12669), `Test Plan`
(12597), `Test execution` (12598) and `XRay Precondition` (12668), all reachable over the Jira
API, so `xray-push.mjs` can create Test Sets.

One caveat: those names are inconsistently spelled (`Xray Test` vs `XRay Precondition` vs
`Test execution`), which suggests they were added by hand. Xray identifies its issue types by
internal mapping rather than by name, and that mapping cannot be read through the Jira API — so
whether Xray itself treats them as real Test Sets is only provable by calling the Xray GraphQL
API. The first push doubles as that proof; run it on a single case first:

```sh
node .claude/scripts/xray-push.mjs .claude/qa/example-plan.json --only EC-18-TC-01
```

If Xray rejects the mapping, the error surfaces there rather than after 40 issues exist.

## Usage

```
> use the qa-xray agent to write test cases for EC-18
```

The agent writes a reviewable plan to `.claude/qa/plans/EC-18.json`, shows you an AC coverage
matrix, and waits. Nothing reaches Jira until you say go.

```sh
node .claude/scripts/xray-push.mjs .claude/qa/plans/EC-18.json --dry-run   # validate + preview
node .claude/scripts/xray-push.mjs .claude/qa/plans/EC-18.json             # apply
```

Created keys are recorded in `.claude/qa/plans/EC-18.result.json`. Re-running skips tests that
already exist, so the push is safe to repeat after a partial failure.

### Before each sprint — check for spec drift

```sh
node .claude/scripts/spec-drift.mjs
```

Each plan records the summary its spec ticket had when it was written. This compares that against
the live summary and exits non-zero on a mismatch — meaning the ticket was repurposed and its
tests may no longer describe it. Set `JIRA_EMAIL` and `JIRA_API_TOKEN` (store them like the Xray
key above) to check automatically; without them the script prints the JQL and expected summaries
for an agent to resolve over MCP.

Plans and test ids are keyed on a **feature slug**, not a ticket key — `BRANDS-TC-01` in
`plans/BRANDS.json` — precisely so a renumbered ticket costs nothing but re-pointing `source.key`.

### Revising tests when a spec changes

The plan file is the master copy; Jira is the published copy. Re-run the same plan after editing
it and the script updates the existing tickets in place rather than creating duplicates — tests
are matched on their plan id, so **never renumber one**.

```sh
node .claude/scripts/xray-push.mjs .claude/qa/plans/EC-18.json --dry-run   # shows a step-level diff
```

Tests dropped from a plan are reported for review, never deleted — deleting a test destroys its
execution history. To retire one properly:

```sh
node .claude/scripts/xray-push.mjs .claude/qa/plans/EC-18.json --deprecate EC-18-TC-09
```

That removes it from every suite so it stops being run, and flags it for a `deprecated` label.
The ticket and its history survive.

Because the Xray API cannot write Jira fields or links, each run also emits
`<plan>.jira-actions.json` listing the links, field edits and labels for the agent to apply over
MCP.

### Test Sets are project-wide

There is one `Sanity testing`, one `Regression testing` and one `E2E testing` Test Set for the
whole EC project, and each ticket's tests are added into them. Their issue ids are recorded in
`.claude/qa/testsets.json` — commit that file, since it is what stops a second ticket from
creating duplicate suites. The first push creates the three sets; every push after that adds to
them.

To get ticket-scoped sets instead, name them in the plan's `testSets` block — the registry is
keyed by summary, so a different name simply means a different set.

## Files

| Path | Purpose |
|---|---|
| `.claude/agents/qa-xray.md` | The QA agent: role, test-design heuristics, suite rules, conventions |
| `.claude/qa/design-sources.md` | Handover + token URLs and how to extract exact design values |
| `.claude/qa/plan.schema.json` | Schema for a test plan |
| `.claude/scripts/spec-drift.mjs` | Flags plans whose spec ticket was repurposed — run before each sprint |
| `.claude/qa/plans/` | Generated plans and their push results |
| `.claude/qa/testsets.json` | Shared registry of the three project-wide Test Sets (created on first push) |
| `.claude/scripts/xray-api.sh` | Auth + raw GraphQL against Xray Cloud |
| `.claude/scripts/xray-push.mjs` | Validates a plan, creates Tests and Test Sets, idempotently |

Everything lives under `.claude/`, which `.hlxignore` excludes from the published site.

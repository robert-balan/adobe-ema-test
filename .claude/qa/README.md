# QA / Xray setup

The `qa-xray` agent (`.claude/agents/qa-xray.md`) reads a Jira ticket, derives test cases from
its acceptance criteria, and creates real Xray Tests and Test Sets in project **EC**.

## Two different things are called a "plan"

Say **plan file** for `plans/<FEATURE>.json` — the master copy of the test content, which lives in
git. Say **Xray Test Plan** for the Jira issue type (12597), which holds a sprint's execution scope
and tracks results across Test Executions. They are unrelated, and bare "test plan" is ambiguous,
so avoid it.

## Design sources

The Jira spec is the contract; the handover prototype is where its values come from. URLs and the
extraction recipe live in [`design-sources.md`](design-sources.md) — read it before writing any
test step that asserts a colour, size, spacing or timing.

Note this repo holds the QA tooling, **not the site under test**, and it is **public**. Plans
under `plans/` are tracked so they can be reviewed and shared,
which means every word of a test step is world-readable and permanent once pushed. Keep
client-confidential detail out of plan text — or move `plans/` into a private repo checked out
at that path, which the tooling supports unchanged.

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

### 2. Jira API token — for the jobs MCP cannot do well

Most Jira work goes through the MCP server. Three things do not: deleting an issue link
(`jira-unlink.mjs` — the server cannot delete one at all), fetching a spec ticket to compare against
a recorded digest (`spec-drift.mjs`), and applying a plan's field edits in bulk
(`jira-apply.mjs` — the server can do these one at a time, which is the problem). All three need a
Jira API token. (`qa-comment.mjs` needs one too, if you ever reach for it — see the file table.)

Unlike the Xray key, you can create this one yourself — no admin needed. Go to
[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
**Create API token** (the plain one, not "with scopes" — scoped tokens do not work with the basic
email-plus-token auth these scripts use), name it, and copy it. It is shown once. Atlassian now
requires an expiry date, so put a reminder in your calendar or it will stop working one morning
with no warning.

```sh
security add-generic-password -a "$USER" -s jira-api-token -w "$(pbpaste | tr -d '[:space:]')"
```

```sh
export JIRA_EMAIL="you@unilever.com"
export JIRA_API_TOKEN="$(security find-generic-password -a "$USER" -s jira-api-token -w 2>/dev/null)"
```

Both are needed — Jira's basic auth is the email and the token together. Check it:

```sh
curl -s -o /dev/null -w "%{http_code}\n" -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  https://unileverfoodsolutions.atlassian.net/rest/api/3/myself
```

`200` is good. **`401` usually means whitespace, not a bad token** — a copied token often carries a
leading space, which makes the auth string malformed while the token itself is perfectly valid.
That is why the `pbpaste` line above pipes through `tr -d '[:space:]'`.

### 3. Test Set issue type enabled in EC — done

Enabled on 2026-08-18. EC now exposes `Test` (12531), `Test Set` (12669), `Test Plan`
(12597), `Test execution` (12598) and `XRay Precondition` (12668), all reachable over the Jira
API, so `xray-push.mjs` can create Test Sets.

The Test type reads as plain `Test` in the API, not `Xray Test` — verified against the live
instance on 2026-08-24. Look the type up rather than matching on a name you remember.

One caveat: those names are inconsistently spelled (`Test` vs `XRay Precondition` vs
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

Created keys are recorded in `.claude/qa/plans/EC-18.result.json`, and each Test is labelled
with its plan id in Jira. Re-running reconciles against both, so the push is safe to repeat after
a partial failure — and safe to run from a clone that has never seen the result file.

### Before each sprint — check for drift

```sh
node .claude/scripts/verify-environment.mjs    # has the Jira/Xray instance moved?
node .claude/scripts/spec-drift.mjs            # have the specs?
```

**The instance.** Issue-type ids, the coverage settings, the link type and the test environments
are recorded in `environment.json` and re-read from the live API. The coverage settings are the
ones that matter: change them and every link the tooling makes stays correct and counts for
nothing. Re-record with `--update` once you know who changed what and why — recording a change is
not the same as agreeing with it.

**The specs.** Each plan records both the summary its ticket had and a digest of its acceptance
criteria. Two different failures:

- the **summary** changed — the ticket was repurposed, and every pushed test now carries a stale
  title prefix
- the **digest** changed — the title held still while the criteria were rewritten underneath the
  tests. This is the common one, and a summary comparison cannot see it

Set `JIRA_EMAIL` and `JIRA_API_TOKEN` (store them like the Xray key above) to check automatically.
Without them the script prints what to resolve over MCP; pipe a description through
`spec-drift.mjs --digest` to compare a digest by hand, and record one with
`spec-drift.mjs <FEATURE> --record`.

### After each push — check the coverage registered

```sh
node .claude/scripts/qa-coverage.mjs --plan .claude/qa/plans/BRANDS.json
```

Xray computes requirement coverage from Test → Story links, in one direction only. A link made the
other way round renders identically in the Jira UI and contributes nothing, which is how this
project once ended up with a full suite of tests covering nothing at all. This asks Xray what it
counts, names any pushed test that is not counted, and exits non-zero — so it can gate.

The push emits missing links on every run now, not only when a test changes, and reports a
backwards link separately: those have to be deleted in the Jira UI, since the MCP tools cannot
remove a link and adding a second one does not help.

### After each push — apply the Jira-side field edits

`xray-push` writes test steps and suite membership itself. Summary, description and labels belong to
Jira, which the Xray API cannot touch, so they land in `<plan>.jira-actions.json`. Apply them:

```sh
node .claude/scripts/jira-apply.mjs .claude/qa/plans/NAV.json                 # preview, writes nothing
JIRA_APPLY_APPROVED=1 node .claude/scripts/jira-apply.mjs .claude/qa/plans/NAV.json --apply
```

It takes several plans at once, sends only the fields that actually changed, and reads every
description back to confirm what Jira stored.

That last part is the reason this is a script and not a handful of MCP calls. Jira stores a document
tree rather than text, so a write can succeed and still store the wrong shape — a fixture list
flattened onto one line, a label that lost its emphasis. And nothing downstream will tell you:
`sameText` strips emphasis markers before comparing, so a mangled description reconciles as
unchanged on the next push forever. The conversion lives in `lib/adf.mjs` with its own tests, and one
of those tests exists because the first version italicised everything between `2*3` and a stray
asterisk at the end of the line.

`editJiraIssue` over MCP is still the right tool for one or two edits. The script is for the case
where a change to `describeTest` touches all forty-eight tests at once.

### Nothing reaches Jira unapproved

`.claude/settings.json` registers a `PreToolUse` hook that blocks `xray-push.mjs`, `da-fixture.mjs`,
`jira-apply.mjs --apply` and `qa-comment.mjs --post` unless the run is read-only (`--dry-run`,
`--adopt`, or a preview) or carries an explicit approval. The comment script is no longer part of the workflow, but
the guard still covers it — a script that can write to a live ticket keeps its safety whether or not
anything calls it:

```sh
XRAY_PUSH_APPROVED=1 node .claude/scripts/xray-push.mjs .claude/qa/plans/BRANDS.json
```

The agent's first hard rule always said this; until the hook existed it was prose, and the
command that writes to production differed from the safe one by an absent flag. Prefixing the
variable rather than exporting it keeps the approval scoped to one invocation and visible in the
transcript. Review `/hooks` if you want to see or disable it.

### Changing the tooling

```sh
node --test .claude/scripts/test/*.test.mjs
```

Every reconcile outcome the tables in this file promise — created, adopted, mismatch, duplicate,
gone, orphan, unchanged — is pinned by a test, along with link direction, suite drift, schema
validation and the client's retry behaviour. The decision-making code has no I/O in it
(`scripts/lib/reconcile.mjs`), so none of that needs a Jira instance to exercise. Run the tests
before pushing a change to the tooling; they take under a second.

Plans and test ids are keyed on a **feature slug**, not a ticket key — `BRANDS-TC-01` in
`plans/BRANDS.json` — precisely so a renumbered ticket costs nothing but re-pointing `source.key`.

### Working with someone else on the same project

Three things are shared, and each is shared differently:

| What | Lives in | Why |
|---|---|---|
| The tooling and the doctrine | git | reviewed like code; disagreements are PRs against `qa-xray.md` |
| Plans and their result ledgers | git (`plans/`) | the plan is the master copy; the ledger maps plan ids to issues |
| Test identity | **Jira labels** | every Test carries its plan id, so identity survives a lost file |

Each pushed Test is labelled with its plan id (`BRANDS-TC-01`). That makes `result.json` a cache
rather than the only copy of the mapping, which is what makes collaboration safe: a push from a
fresh clone, or from a checkout that predates a colleague's last push, **adopts** the existing
issues instead of creating a second set of them.

On a fresh clone, or after losing a ledger:

```sh
node .claude/scripts/xray-push.mjs .claude/qa/plans/BRANDS.json --adopt
```

That rebuilds `BRANDS.result.json` from the labels and writes nothing to Xray. A normal push
adopts automatically, so `--adopt` is only needed when you want the ledger repaired without
pushing.

If the ledger and the labels disagree — they name different issues for one plan id, or two
issues claim the same one — the push refuses and reports it rather than guessing. Guessing here
edits the steps of a Test that somebody's execution history hangs off. Fix the labels in Jira,
or re-run with `--adopt`.

If the report says a test is **unclaimed** — it sits in a suite the plan no longer claims — nothing
is removed for you. Review it, then act on it through the tooling rather than by hand:

```sh
XRAY_PUSH_APPROVED=1 node .claude/scripts/xray-push.mjs .claude/qa/plans/BRANDS.json --unclaim BRANDS-TC-07:e2e
```

It refuses if the plan still claims that suite, because the next push would simply put it back.

### Retiring a test also means unlinking it

Removing a test from the suites is only half of retiring it. The link to its spec ticket is what
Xray counts coverage from, so a deprecated test keeps counting against the story — and because it
will never run again, that story can never reach full coverage. EC-14 read "16 tests" with only 7
live for exactly this reason.

`--deprecate` now records the link to remove, and:

```sh
node .claude/scripts/jira-unlink.mjs .claude/qa/plans/BRANDS.json
```

removes them. This is the one job that cannot go through MCP: Xray has no issue-link mutations,
and the MCP server can create a link but not delete one. Only Jira REST can, so it needs
`JIRA_EMAIL` and `JIRA_API_TOKEN`. Without them the script prints every link and its id so you can
remove them by hand.

`qa-coverage.mjs` is the safety net — it fails when a story still counts a deprecated test, so a
skipped unlink is caught on the next check rather than quietly rotting the coverage figure.

Still commit `result.json` after a push. Adoption is the safety net, not the plan.

### Moving a test to another plan

A retired test does not have to be thrown away. When EC-8's megamenu turned out to need nine of
the tests EC-14 had already retired, they were re-used rather than rewritten: the same nine Jira
issues were relabelled `MEGAMENU-TC-01`…`09`, picked up by the megamenu plan's next push through
the usual label adoption, and moved into `/Header/Megamenu` in the Test Repository. Execution
history came with them, which is the whole reason to move an issue rather than create a new one.

The Jira side takes care of itself — identity lives in the label, so relabelling *is* the move.
The old plan's ledger is the part that does not, and the push will not fix it for you:

```
9   no longer in the plan — review manually, never auto-deleted
REVIEW    EC-127  BRANDS-TC-08 — dropped from the plan; deprecate it or restore the entry
```

That is the push refusing to guess, and it is the right default — an entry with no test in the
plan is usually a test somebody deleted by accident, and losing the mapping would mean losing the
issue. Reuse is the one case where the mapping is genuinely not lost: it now lives in the new
plan's ledger and in the labels on the issues themselves. `--adopt` will not clear it either — it
merges into the existing ledger rather than replacing it, on purpose.

So delete those entries from the old `<plan>.result.json` by hand, and check the move actually
landed before you do:

```sh
# the issues answer to the new plan's ids, not the old ones
node .claude/scripts/xray-push.mjs .claude/qa/plans/MEGAMENU.json --adopt

# and neither story is counting the other's tests
node .claude/scripts/qa-coverage.mjs EC-14      # 7 test(s)
node .claude/scripts/qa-coverage.mjs EC-8       # 9 test(s)
```

Left in place the entries are not harmful, but they are not free: every push reports nine tests
for review and three test sets in drift, so the one report that is supposed to tell you something
is wrong tells you that every time. A clean run is what makes a dirty one worth reading.

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
node .claude/scripts/xray-push.mjs .claude/qa/plans/EC-18.json --deprecate BRANDS-TC-09
```

That removes it from every Test Set **and every Xray Test Plan**, and flags it for a `deprecated`
label. The ticket and its history survive. Both have to be cleared: a test dropped only from the
suites still sits in each open sprint's Test Plan, unexecuted, dragging that sprint's completion
figure down.

Because the Xray API cannot write Jira fields or links, each run also emits
`<plan>.jira-actions.json` listing the links, field edits and labels for the agent to apply over
MCP.

### Fixtures — generated test content

A test step should never ask a tester to author anything. Fixtures are declared in the plan's
`fixtures` block, generated into Document Authoring under `/drafts/qa/{feature}/`, and their URLs
published into each test's Jira description.

A step that sends the tester to a page names that fixture in its own `fixtures`, and the push
renders the id as a full preview URL at the top of that step's Test Data:

```json
{ "action": "Open the Arabic fixture and inspect the page's root element.",
  "fixtures": ["FOOTER-FX-06"],
  "result": "The <html> element carries dir=\"rtl\" and lang=\"ar-MA\"." }
```

```
Action  Open the Arabic fixture and inspect the page's root element.
Data    https://develop--ufs--foodsolutions-04.aem.page/drafts/qa/footer/rtl
```

Set it on the first step of a test, on a step that moves to a second fixture, and on a step that
compares one against another. Leave it off a step that stays on the page already open — resizing,
hovering, running axe. Ids only: a written-out URL in a step is a second copy of a path that
already exists in `fixtures`, and the second copy is the one nobody updates when a page moves.

Four rules are enforced by the tooling rather than trusted to a reviewer:

- **A fixture path outside `/drafts/` is refused.** That is the mistake that publishes test
  content to the client's live site.
- **The fixture tooling calls the preview endpoint and never `/live/`.** Not a flag, not an
  override — the folder convention is the second line of defence, not the first.
- **A step naming an unknown fixture is refused**, since the id is what becomes the URL.
- **A step may only name a fixture its own test lists.** Reaching past that list would send a
  tester to a page the test's description never mentions.

The origin comes from the plan's `previewBase`, so it is named once and a plan re-pointed at
another branch produces steps for that branch without one of them being edited.

Header-family blocks (header, megamenu, utility bar, brand carousel) live in one site-wide `nav`
document, so a fixture page carries a `nav` metadata row pointing at its own nav document;
`header.js` reads `getMetadata('nav')` and loads that instead. RTL is reached the same way, with a
`Language` row that `decorateLocale()` turns into `lang` and `dir` on `<html>`.

Accessibility and hostile-content fixtures get a page to themselves. Tab order runs through
everything on a page, axe reports per page, stacked instances manufacture duplicate-name
violations that do not exist in production, and a block that throws during decoration can take out
every block after it. Sections give separation, not isolation.

### The block library is the authoring contract — read the folder, not the index

A block's variants and the content structure each expects are documented in DA under
`/docs/library/blocks/`, on **`foodsolutions-04/ufs`** (an older `foodsolutions-04/ufs-global-blocks`
also exists and is out of date — 16 blocks against 24, none touched since mid-August). Each document
holds one section per variant: the block as an author would place it, plus a `library-metadata`
table naming and describing it.

**`blocks.json` is not the list of blocks.** It is the index the library UI reads, and entries get
removed from it — to keep a block out of authors' hands while it is being worked on, say — while the
document stays exactly where it was. Today 13 of the 24 documents are unlisted. Build a fixture off
the index and you are blind to whatever is not in it, so enumerate the folder:

```sh
curl -s -H "Authorization: Bearer $DA_TOKEN" \
  https://admin.da.live/list/foodsolutions-04/ufs/docs/library/blocks
curl -s -H "Authorization: Bearer $DA_TOKEN" \
  https://admin.da.live/source/foodsolutions-04/ufs/docs/library/blocks/<block>.html
```

`da-probe.mjs` checks both and names the gap, so the difference is visible rather than assumed.

The library covers blocks an author **places** on a page. The header family (nav, megamenu, utility
bar, brand carousel, promo tile) and the footer are not there: they are site-wide fragments authored
once in `/nav` and `/footer`, which is why their fixtures are derived from those documents instead.

Check what the environment will allow before building against it:

```sh
node .claude/scripts/da-probe.mjs                # read-only
node .claude/scripts/da-probe.mjs --write-test   # opt-in, cleans up after itself
```

### Test Sets are project-wide

There is one `Sanity testing`, one `Regression testing` and one `E2E testing` Test Set for the
whole EC project, and each ticket's tests are added into them. Their issue ids are recorded in
`.claude/qa/testsets.json` — commit that file, since it is what stops a second ticket from
creating duplicate suites. The first push creates the three sets; every push after that adds to
them.

To get ticket-scoped sets instead, name them in the plan's `testSets` block — the registry is
keyed by summary, so a different name simply means a different set.

### Xray Test Plans — sprint scope

Test Sets and Xray Test Plans answer opposite questions, and conflating them is the usual way this
gets messy:

| | Answers | Lifetime |
|---|---|---|
| **Test Set** | what kind of run is this — sanity, regression, e2e | permanent, cumulative |
| **Xray Test Plan** | is this slice of work tested yet | finite; opens, fills, closes |

So never create a Test Plan called "Regression" — that duplicates the Test Set and never closes.
A Test Plan carries the axis a Test Set cannot: **time and scope**. One per sprint, named to match
the Jira sprint so they cross-reference, holding the tests for that sprint's stories plus the
sanity suite plus regression for whatever it touched. Test Executions then sit inside it, one per
branch per cycle, each tagged with a test environment:

```
EC Sprint 14                                  ← Xray Test Plan
 ├─ Sprint 14 — develop — round 1    env: develop-eds-ufs
 ├─ Sprint 14 — develop — round 2    env: develop-eds-ufs
 └─ Sprint 14 — stage — sign-off     env: stage-eds-ufs
```

A push can add its tests to an existing Test Plan:

```sh
node .claude/scripts/xray-push.mjs .claude/qa/plans/BRANDS.json --test-plan EC-59
```

Opt-in rather than automatic, deliberately. What a sprint intends to run includes regression for
blocks the ticket never touched, which a plan file has no way of knowing — pushing tests and
scoping a sprint are separate decisions. Adding is idempotent, so re-running to pick up new cases
is safe, and a key that is not a Test Plan is rejected before anything is written.

## Files

| Path | Purpose |
|---|---|
| `.claude/agents/qa-xray.md` | The QA agent: role, test-design heuristics, suite rules, conventions |
| `.claude/qa/design-sources.md` | Handover + token URLs and how to extract exact design values |
| `.claude/qa/plan.schema.json` | Schema for a plan file — enforced on every push, not just documented |
| `.claude/qa/environment.json` | Instance facts (issue types, coverage settings, environments), machine-checked |
| `.claude/qa/plans/` | Plan files and their result ledgers — tracked; `*.jira-actions.json` is not |
| `.claude/qa/comments/` | Historical. The discrepancy comments posted on spec tickets before that step was dropped — kept as the record of what was reported |
| `.claude/qa/testsets.json` | Shared registry of the three project-wide Test Sets (created on first push) |
| `.claude/scripts/xray-push.mjs` | Validates a plan, creates Tests and Test Sets, idempotently |
| `.claude/scripts/qa-coverage.mjs` | Asks Xray what it actually counts as covered — run after every push |
| `.claude/scripts/spec-drift.mjs` | Flags a repurposed ticket or rewritten criteria — run before each sprint |
| `.claude/scripts/jira-apply.mjs` | Applies a plan's `jira-actions.json` field edits — summary, description, labels — and reads each description back to check what Jira stored |
| `.claude/scripts/lib/adf.mjs` | Description text into Jira's document tree. Tested on its own, because a mangled tree renders badly rather than failing, and the push cannot see it |
| `.claude/scripts/qa-comment.mjs` | Builds and posts a comment on a spec ticket, editable in place. **Not part of the workflow** — posting a comment after writing test cases is no longer a step. Retained for the occasions someone wants it deliberately |
| `.claude/scripts/verify-environment.mjs` | Re-checks `environment.json` against the live instance |
| `.claude/scripts/guard-xray-push.sh` | PreToolUse hook: blocks an unapproved push, fixture write or comment |
| `.claude/scripts/xray-api.sh` | Auth + raw GraphQL against Xray Cloud |
| `.claude/scripts/lib/` | The parts with no I/O in them: reconcile logic, schema validation, the API client |
| `.claude/scripts/test/` | Tests for all of the above — `node --test .claude/scripts/test/*.test.mjs` |

Everything lives under `.claude/`. There is nothing else in this repository — the aem-boilerplate
site it was created from was removed on 2026-08-25, unused.

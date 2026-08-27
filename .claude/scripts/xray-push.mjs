#!/usr/bin/env node
/**
 * Reconcile a QA plan file with Xray Cloud.
 *
 *   node .claude/scripts/xray-push.mjs <plan.json> [options]
 *
 *     --dry-run            show what would change, including suite and link drift; write nothing
 *     --only ID,ID         restrict to these plan test ids
 *     --force              rewrite matching tests even when nothing differs
 *     --deprecate ID,ID    retire tests: drop from every suite and Test Plan, flag for a label
 *     --adopt              rebuild <plan>.result.json from the Jira labels and exit; writes
 *                          nothing to Xray. Use on a fresh clone, or to repair a lost cache.
 *     --test-plan KEY      also add this plan's tests to an existing Xray Test Plan (e.g. EC-59)
 *     --unclaim ID:suite   remove a test from a suite the plan no longer claims. Reported as
 *                          drift on every run; this is how a person acts on that report.
 *
 * Suites (Test Sets) and sprint scope (Xray Test Plans) are separate axes, so adding to a Test
 * Plan is opt-in rather than automatic: which tests a sprint intends to run includes regression
 * for blocks this ticket never touched, which a plan file cannot know.
 *
 * The plan is the master copy and Jira is the published copy; this brings the published copy
 * into line. Tests are matched on their plan id, which is written to Jira as a label and cached
 * in <plan>.result.json, so a revised plan edits the existing tickets rather than creating
 * duplicates. Because the id also lives in Jira, a missing or stale cache is recovered rather
 * than obeyed: the run adopts the labelled issue instead of creating a second one, and refuses
 * to act on a contradiction. Nothing is ever deleted.
 *
 * Three kinds of state are checked in both directions before anything is written, because each
 * can drift without leaving a trace anywhere a person would look:
 *
 *   steps, summary, labels, description   compared against the live Test
 *   suite membership                      lives in Xray, so a removal in its UI is invisible
 *   the requirement link                  correct and backwards render identically in Jira, and
 *                                         backwards yields no coverage at all
 *
 * Xray owns test steps, test type and suite membership — this script writes those directly.
 * Jira owns summary, description, labels and issue links, which the Xray API cannot write (it
 * can read them, which is why they can be reconciled), so those are emitted to
 * <plan>.jira-actions.json for the qa-xray agent to apply over MCP.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './lib/gql.mjs';
import { validate } from './lib/schema.mjs';
import {
  SUITES, LINK_TYPE, stepsOf, labelsFor, describeTest, folderFor,
  resolveIdentity, diffTest, linkState, driftFor, planProblems, parseUnclaim, requirementLinkId,
} from './lib/reconcile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app';

// Suites are project-wide and accumulate across tickets, so Test Set ids live in one shared
// registry rather than per-plan. A plan that names its own Test Sets gets ticket-scoped ones
// instead — the registry is keyed by summary, so a new name simply means a new set.
const DEFAULT_SET_NAMES = { sanity: 'Sanity testing', regression: 'Regression testing', e2e: 'E2E testing' };
const REGISTRY_PATH = join(HERE, '..', 'qa', 'testsets.json');
const SCHEMA_PATH = join(HERE, '..', 'qa', 'plan.schema.json');

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const flag = (name) => args.includes(name);
const listArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')
    ? args[i + 1].split(',').map((s) => s.trim()) : null;
};
const dryRun = flag('--dry-run');
const force = flag('--force');
const only = listArg('--only');
const deprecate = listArg('--deprecate') || [];
const adopt = flag('--adopt');
const oneArg = (name) => listArg(name)?.[0] || null;
const testPlanKey = oneArg('--test-plan');
const unclaimSpecs = listArg('--unclaim') || [];

const fail = (msg) => { console.error(`xray-push: ${msg}`); process.exit(1); };
if (!planPath) fail('usage: xray-push.mjs <plan.json> [--dry-run] [--only IDs] [--force] [--deprecate IDs] [--adopt] [--test-plan KEY] [--unclaim ID:suite]');
if (testPlanKey && !/^[A-Z][A-Z0-9]*-\d+$/.test(testPlanKey)) fail(`--test-plan expects an issue key like EC-59, got "${testPlanKey}"`);
if (!existsSync(planPath)) fail(`no such plan: ${planPath}`);

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const resultPath = `${planPath.replace(/\.json$/, '')}.result.json`;
const actionsPath = `${planPath.replace(/\.json$/, '')}.jira-actions.json`;
const prior = existsSync(resultPath)
  ? JSON.parse(readFileSync(resultPath, 'utf8')) : { tests: {}, testSets: {} };
const registry = existsSync(REGISTRY_PATH) ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) : {};
const setNameFor = (suite) => plan.testSets?.[suite] || DEFAULT_SET_NAMES[suite];

/* ---------------------------------------------------------------- validation */

// The schema is the contract, so it is enforced rather than described. Semantic rules the schema
// cannot express are checked after it.
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const problems = validate(plan, schema);

problems.push(...planProblems(plan));
const { pairs: unclaims, problems: unclaimProblems } = parseUnclaim(unclaimSpecs, plan);
problems.push(...unclaimProblems);

if (problems.length) fail(`plan is invalid (checked against ${SCHEMA_PATH}):\n  - ${problems.join('\n  - ')}`);

/* ------------------------------------------------------------------ graphql */

const client = createClient({
  baseUrl: BASE,
  clientId: process.env.XRAY_CLIENT_ID,
  clientSecret: process.env.XRAY_CLIENT_SECRET,
  onRetry: ({ label, attempt, of, delay, reason }) => {
    console.error(`retry    ${label} (${attempt}/${of}) in ${delay}ms — ${reason.slice(0, 120)}`);
  },
});
const gql = async (...a) => {
  try {
    return await client.gql(...a);
  } catch (err) {
    return fail(err.message);
  }
};
// Used where a throw must be caught rather than exit the process (the step rewrite).
const gqlOrThrow = client.gql;

const Q = {
  getTests: `query GetTests($issueIds: [String]) {
    getTests(issueIds: $issueIds, limit: 100) {
      total
      results { issueId testType { name } steps { id action data result }
                folder { path }
                jira(fields: ["key","summary","labels","description","issuelinks"]) }
    } }`,
  findByLabel: `query FindByLabel($jql: String!, $start: Int, $limit: Int!) {
    getTests(jql: $jql, start: $start, limit: $limit) {
      total results { issueId jira(fields: ["key","labels"]) } } }`,
  linksOf: `query LinksOf($issueIds: [String]) {
    getTests(issueIds: $issueIds, limit: 100) {
      results { issueId jira(fields: ["key","issuelinks"]) } } }`,
  testPlansOf: `query TestPlansOf($issueIds: [String]) {
    getTests(issueIds: $issueIds, limit: 100) {
      results { issueId testPlans(limit: 100) { total results { issueId jira(fields: ["key"]) } } } } }`,
  createFolder: `mutation CreateFolder($projectId: String, $path: String!) {
    createFolder(projectId: $projectId, path: $path) { folder { path } warnings } }`,
  createTest: `mutation CreateTest($steps: [CreateStepInput], $folder: String, $jira: JSON!) {
    createTest(testType: { name: "Manual" }, steps: $steps, folderPath: $folder, jira: $jira) {
      test { issueId jira(fields: ["key"]) } warnings } }`,
  removeAllSteps: `mutation RemoveAll($issueId: String!) { removeAllTestSteps(issueId: $issueId) }`,
  // Xray only accepts a folder at creation time via createTest, so moving an existing test needs
  // its own mutation. Returns the resulting path as a bare String, not an object.
  updateTestFolder: `mutation UpdateTestFolder($issueId: String!, $folderPath: String!) {
    updateTestFolder(issueId: $issueId, folderPath: $folderPath) }`,
  addStep: `mutation AddStep($issueId: String!, $step: CreateStepInput!) {
    addTestStep(issueId: $issueId, step: $step) { id } }`,
  createTestSet: `mutation CreateTestSet($testIssueIds: [String], $jira: JSON!) {
    createTestSet(testIssueIds: $testIssueIds, jira: $jira) {
      testSet { issueId jira(fields: ["key"]) } warnings } }`,
  addToSet: `mutation AddTests($issueId: String!, $testIssueIds: [String]!) {
    addTestsToTestSet(issueId: $issueId, testIssueIds: $testIssueIds) { addedTests warning } }`,
  removeFromSet: `mutation RemoveTests($issueId: String!, $testIssueIds: [String]!) {
    removeTestsFromTestSet(issueId: $issueId, testIssueIds: $testIssueIds) }`,
  getTestSet: `query GetTestSet($issueId: String!, $start: Int, $limit: Int!) {
    getTestSet(issueId: $issueId) {
      issueId tests(start: $start, limit: $limit) { total results { issueId } } } }`,
  findTestPlan: `query FindTestPlan($jql: String!) {
    getTestPlans(jql: $jql, limit: 1) {
      results { issueId jira(fields: ["key","summary"]) } } }`,
  addToPlan: `mutation AddToPlan($issueId: String!, $testIssueIds: [String]!) {
    addTestsToTestPlan(issueId: $issueId, testIssueIds: $testIssueIds) { addedTests warning } }`,
  removeFromPlan: `mutation RemoveFromPlan($issueId: String!, $testIssueIds: [String]!) {
    removeTestsFromTestPlan(issueId: $issueId, testIssueIds: $testIssueIds) }`,
};

const stepInput = (s) => ({ action: s.action, data: s.data || undefined, result: s.result });
const scoped = plan.tests.filter((t) => !only || only.includes(t.id));

/* -------------------------------------------------------- identity by label */

async function findByPlanIds(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {   // keep the JQL in list well clear of any length cap
    const batch = ids.slice(i, i + 50);
    const jql = `project = ${plan.project} AND labels in (${batch.map((id) => `'${id}'`).join(', ')})`;
    let start = 0;
    for (;;) {
      const d = await gql(Q.findByLabel, { jql, start, limit: 100 }, { label: 'findByLabel' });
      const results = d?.getTests?.results || [];
      for (const r of results) {
        // An issue carries many labels; only the plan ids we asked about are identities.
        for (const label of r.jira.labels || []) {
          if (!batch.includes(label)) continue;
          if (!found.has(label)) found.set(label, []);
          found.get(label).push({ issueId: r.issueId, key: r.jira.key });
        }
      }
      if (results.length < 100) break;
      start += results.length;
    }
  }
  return found;
}

const labelled = await findByPlanIds(scoped.map((t) => t.id));
const {
  record, adopted: ADOPTED, mismatch: MISMATCH, duplicate: DUPLICATE,
} = resolveIdentity({ scoped, prior, labelled });
const conflicted = new Set([...MISMATCH, ...DUPLICATE].map((c) => c.id));
const recordFor = (id) => record.get(id) || prior.tests[id];

function reportIdentityProblems() {
  for (const { id, cached, live: liveKey } of MISMATCH) {
    console.error(`MISMATCH  ${id}: ${resultPath} says ${cached}, the Jira label says ${liveKey}`);
  }
  for (const { id, keys } of DUPLICATE) {
    console.error(`DUPLICATE ${id}: claimed by ${keys.join(', ')} — one of them should lose the label`);
  }
}

/* ----------------------------------------------------------- adopt and exit */

if (adopt) {
  for (const { id, key } of ADOPTED) console.log(`adopted  ${id} → ${key}`);
  for (const t of scoped) {
    if (!record.has(t.id) && !conflicted.has(t.id)) console.log(`absent   ${t.id} — not in Jira; a push will create it`);
  }
  reportIdentityProblems();
  const tests = { ...prior.tests };
  for (const [id, rec] of record) tests[id] = { ...tests[id], ...rec };
  const sets = {};
  for (const suite of SUITES) {
    const set = registry[setNameFor(suite)];
    if (set && plan.tests.some((t) => (t.suites || []).includes(suite))) sets[suite] = set;
  }
  if (dryRun) console.log(`\n${resultPath} not written (--dry-run).`);
  else {
    writeFileSync(resultPath, `${JSON.stringify({ ...prior, tests, testSets: sets }, null, 2)}\n`);
    console.log(`\nRecovered ${record.size}/${scoped.length} plan id(s) into ${resultPath}. Nothing was written to Xray.`);
  }
  process.exit(conflicted.size ? 1 : 0);
}

/* ---------------------------------------------------------------- reconcile */

// Batched at the query's own limit. Unbatched, the 101st test came back absent, was classified as
// deleted, and was recreated as a second issue carrying the same plan id — which the next run then
// refused to touch. A short read now stops the run instead of being read as an absence.
async function fetchLive(issueIds) {
  const live = new Map();
  for (let i = 0; i < issueIds.length; i += 100) {
    const batch = issueIds.slice(i, i + 100);
    const d = await gql(Q.getTests, { issueIds: batch }, { label: 'getTests' });
    const page = d?.getTests;
    const results = page?.results || [];
    if ((page?.total ?? results.length) > results.length) {
      fail(`getTests returned ${results.length} of ${page.total} for a batch of ${batch.length}`
         + ' — refusing to treat the remainder as deleted. This is a paging bug; do not re-run with --force.');
    }
    for (const r of results) live.set(r.issueId, r);
  }
  return live;
}

const known = [...record.values()].filter((v) => v.issueId);
const live = known.length ? await fetchLive(known.map((v) => v.issueId)) : new Map();

const CREATE = []; const UPDATE = []; const UNCHANGED = []; const GONE = [];
for (const t of scoped) {
  if (conflicted.has(t.id)) continue;          // identity is unresolved; touch nothing
  const rec = record.get(t.id);
  if (!rec) { CREATE.push(t); continue; }
  const cur = live.get(rec.issueId);
  if (!cur) { GONE.push({ t, rec }); CREATE.push(t); continue; }   // deleted outside this tool
  const diffs = diffTest({ plan, t, cur });
  if (diffs.length || force) UPDATE.push({ t, rec, cur, diffs: diffs.length ? diffs : ['forced'] });
  else UNCHANGED.push({ t, rec, cur });
}
// Tests recorded from an earlier run whose plan entry has since been removed.
const ORPHANS = Object.entries(prior.tests)
  .filter(([id]) => !plan.tests.some((t) => t.id === id))
  .map(([id, rec]) => ({ id, rec }));

/* ---------------------------------------------------------------- link state */

// The requirement link is the only thing that produces Xray coverage, and it used to be emitted
// only when a test was created or updated — so a run that was interrupted before the agent applied
// the actions file left tests that existed, were never linked, and were reported "unchanged"
// forever after. Read it back like everything else, on every run.
//
// A backwards link is called out rather than counted or replaced: it looks correct in the Jira UI,
// contributes no coverage, and the fix is to delete it, which the MCP tools cannot do.
const LINKS = { missing: [], reversed: [], unknown: [], present: 0 };
if (plan.source?.key) {
  for (const t of scoped) {
    if (conflicted.has(t.id)) continue;
    const rec = record.get(t.id);
    const cur = rec && live.get(rec.issueId);
    if (!cur) { LINKS.missing.push({ id: t.id, key: rec?.key || null, reason: 'new' }); continue; }
    const state = linkState({ issuelinks: cur.jira?.issuelinks, specKey: plan.source.key });
    if (state === 'present') LINKS.present += 1;
    else if (state === 'reversed') LINKS.reversed.push({ id: t.id, key: rec.key });
    else if (state === 'unknown') LINKS.unknown.push({ id: t.id, key: rec.key });
    else LINKS.missing.push({ id: t.id, key: rec.key, reason: 'absent in Jira' });
  }
}

/* -------------------------------------------------------------- suite drift */

async function setMembers(issueId) {
  const members = new Set();
  let dangling = 0;
  let start = 0;
  let seen2 = 0;
  let total = Infinity;
  while (seen2 < total) {
    const d = await gql(Q.getTestSet, { issueId, start, limit: 100 }, { label: 'getTestSet' });
    const page = d?.getTestSet?.tests;
    const results = page?.results || [];
    if (!page || !results.length) break;
    total = page.total ?? 0;
    // A membership row whose Test issue has been deleted comes back as null.
    // Count it rather than dereferencing it, and page on `seen` not on
    // `members.size` — otherwise a dangling row stalls the loop.
    for (const r of results) {
      if (r?.issueId) members.add(r.issueId);
      else dangling += 1;
    }
    seen2 += results.length;
    start += results.length;
  }
  return { members, dangling };
}

const ownedByPlan = new Map();  // issueId -> plan test id, for everything this plan has created
for (const [id, rec] of Object.entries(prior.tests)) if (rec.issueId) ownedByPlan.set(rec.issueId, id);
for (const [id, rec] of record) if (rec.issueId) ownedByPlan.set(rec.issueId, id);
const creating = new Set(CREATE.map((t) => t.id));

const DRIFT = {};
for (const suite of SUITES) {
  const desired = plan.tests.filter((t) => (t.suites || []).includes(suite));
  if (!desired.length) continue;
  const name = setNameFor(suite);
  const set = registry[name];
  const d = {
    name,
    key: set?.key,
    desired: desired.length,
    missing: [],
    unclaimed: [],
    foreign: 0,
    // Tests being created this run have no membership yet by definition — not drift.
    pending: desired.filter((t) => creating.has(t.id)).map((t) => t.id),
  };
  if (set?.issueId) {
    const { members, dangling } = await setMembers(set.issueId);
    d.dangling = dangling;
    Object.assign(d, driftFor({ desired, members, creating, recordFor, ownedByPlan }));
  }
  DRIFT[suite] = d;
}

/* ----------------------------------------------------------- xray test plan */

// Resolved during reconcile rather than at apply time: a mistyped key should stop the run
// before it writes, not after it has created 16 issues.
let testPlan = null;
if (testPlanKey) {
  const d = await gql(Q.findTestPlan, { jql: `key = ${testPlanKey}` }, { label: 'findTestPlan' });
  const hit = d?.getTestPlans?.results?.[0];
  if (!hit) fail(`--test-plan ${testPlanKey} is not an Xray Test Plan in this instance`);
  testPlan = { issueId: hit.issueId, key: hit.jira.key, summary: hit.jira.summary };
}

/* ------------------------------------------------------------------- report */

function report() {
  const w = (n) => String(n).padEnd(3);
  console.log(`plan ${planPath}`);
  console.log(`  ${w(CREATE.length)} to create`);
  console.log(`  ${w(UPDATE.length)} to update`);
  console.log(`  ${w(UNCHANGED.length)} unchanged`);
  if (ADOPTED.length) console.log(`  ${w(ADOPTED.length)} adopted from Jira by label — absent from ${resultPath}`);
  if (ORPHANS.length) console.log(`  ${w(ORPHANS.length)} no longer in the plan — review manually, never auto-deleted`);
  if (deprecate.length) console.log(`  ${w(deprecate.length)} to deprecate`);
  if (unclaims.length) console.log(`  ${w(unclaims.length)} to remove from a suite`);
  if (conflicted.size) console.log(`  ${w(conflicted.size)} with a contested identity — nothing will be written`);
  if (testPlan) {
    const n = scoped.filter((t) => !conflicted.has(t.id)).length;
    console.log(`  ${w(n)} to add to Xray Test Plan ${testPlan.key} "${testPlan.summary}"`);
  }
  console.log('');
  for (const { id, key } of ADOPTED) console.log(`  ADOPT     ${key}  ${id} — already in Jira, reusing it instead of creating a duplicate`);
  reportIdentityProblems();
  for (const t of CREATE) console.log(`  NEW       ${t.id}  ${t.summary}`);
  for (const {
    t, rec, cur, diffs,
  } of UPDATE) {
    console.log(`  UPDATE    ${rec.key}  ${t.id}  (${diffs.join(', ')})`);
    if (diffs.includes('summary')) {
      console.log(`      summary:  - ${cur.jira.summary}`);
      console.log(`                + ${t.summary}`);
    }
    if (diffs.includes('folder')) {
      console.log(`      folder:   - ${cur.folder?.path || '(none)'}`);
      console.log(`                + ${folderFor(plan, t)}`);
    }
    if (diffs.includes('description')) {
      const a = (cur.jira.description || '').split('\n\n').filter(Boolean);
      const b = describeTest(plan, t).split('\n\n').filter(Boolean);
      for (const line of a.filter((x) => !b.includes(x))) console.log(`      desc:     - ${line}`);
      for (const line of b.filter((x) => !a.includes(x))) console.log(`      desc:     + ${line}`);
    }
    if (diffs.includes('steps')) {
      const a = cur.steps; const b = stepsOf(plan, t);
      // Data is compared, so it has to be shown. It was not, and a change that touched only the
      // data — which is where the fixture URLs live — printed two identical-looking lines.
      const render = (s) => `${s.action} → ${s.result}${s.data ? `  [data: ${s.data.replace(/\n/g, ' | ')}]` : ''}`;
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i]; const y = b[i];
        if (x && y && x.action === y.action && (x.data || '') === (y.data || '') && x.result === y.result) continue;
        if (!x) { console.log(`      step ${i + 1}: + ${render(y)}`); continue; }
        if (!y) { console.log(`      step ${i + 1}: - ${render(x)}`); continue; }
        console.log(`      step ${i + 1}: - ${render(x)}`);
        console.log(`              + ${render(y)}`);
      }
    }
  }
  for (const { id, rec } of ORPHANS) console.log(`  REVIEW    ${rec.key}  ${id} — dropped from the plan; deprecate it or restore the entry`);
  for (const id of deprecate) {
    const rec = recordFor(id);
    console.log(rec ? `  DEPRECATE ${rec.key}  ${id} — removed from all suites and Test Plans, flagged for a 'deprecated' label`
      : `  DEPRECATE ${id} — no record; nothing to do`);
  }

  for (const { id, suite } of unclaims) {
    const rec = recordFor(id);
    console.log(rec ? `  UNCLAIM   ${rec.key}  ${id} — remove from the ${suite} suite`
      : `  UNCLAIM   ${id} — no record; nothing to remove`);
  }
  console.log('');
  console.log('  Test Sets:');
  for (const s of SUITES) {
    const d = DRIFT[s];
    if (!d) continue;
    if (!d.key) {
      console.log(`      ${s}: ${d.desired} test(s) → create "${d.name}"`);
      continue;
    }
    const state = [];
    if (d.pending.length) state.push(`${d.pending.length} new`);
    if (d.missing.length) state.push(`${d.missing.length} missing`);
    if (d.unclaimed.length) state.push(`${d.unclaimed.length} unclaimed`);
    if (!state.length) state.push('in sync');
    console.log(`      ${s}: ${d.desired} test(s) → ${d.key} "${d.name}" — ${state.join(', ')}`);
    if (d.missing.length) {
      console.log(`          DRIFT  missing from the set, will be re-added: ${d.missing.join(', ')}`);
    }
    if (d.unclaimed.length) {
      console.log('          DRIFT  in the set but the plan no longer claims this suite — review, never auto-removed:');
      console.log(`                 ${d.unclaimed.join(', ')}`);
    }
    if (d.foreign) console.log(`          ${d.foreign} test(s) from other plans — left alone`);
    if (d.dangling) console.log(`          ⚠ ${d.dangling} membership row(s) point at a deleted Test — clean up in the Xray UI`);
  }

  if (plan.source?.key) {
    console.log('');
    console.log(`  Requirement links → ${plan.source.key}:`);
    const bits = [`${LINKS.present} present`];
    if (LINKS.missing.length) bits.push(`${LINKS.missing.length} to create`);
    if (LINKS.reversed.length) bits.push(`${LINKS.reversed.length} BACKWARDS`);
    if (LINKS.unknown.length) bits.push(`${LINKS.unknown.length} unreadable`);
    console.log(`      ${bits.join(', ')}`);
    if (LINKS.missing.length) {
      console.log(`          ${LINKS.missing.map((l) => l.key || l.id).join(', ')}`);
    }
    if (LINKS.reversed.length) {
      console.log('          ⚠ BACKWARDS — these link the story to the test, which renders correctly in Jira');
      console.log('            and yields no Xray coverage. Delete each in the Jira UI, then re-run:');
      console.log(`            ${LINKS.reversed.map((l) => l.key).join(', ')}`);
    }
  }
}

report();
if (dryRun) { console.log('\nNothing was written. Re-run without --dry-run to apply.'); process.exit(0); }
if (conflicted.size) {
  fail(`${conflicted.size} plan id(s) above have a contested identity — resolve the labels in Jira, or\n`
     + `            run --adopt to rebuild ${resultPath} from them. Nothing was written.`);
}
if (GONE.length) console.log(`\nnote: ${GONE.map(({ rec }) => rec.key).join(', ')} no longer exist in Xray — recreating.\n`);

/* -------------------------------------------------------------------- apply */

const created = { ...prior.tests };
for (const [id, rec] of record) created[id] = { ...created[id], ...rec };
const jiraActions = {
  source: plan.source?.key || null, project: plan.project, links: [], relink: [], unlink: [], edits: [], deprecate: [], review: [],
};
const testSets = {};

// The ledger is written even when the run dies part-way. Adoption by label would recover the
// mapping anyway, but a half-finished run should not also cost the record of what it managed.
let applyError = null;
function persist() {
  writeFileSync(resultPath, `${JSON.stringify({ ...prior, tests: created, testSets }, null, 2)}\n`);
  writeFileSync(actionsPath, `${JSON.stringify(jiraActions, null, 2)}\n`);
}

async function restoreSteps(issueId, previous) {
  if (await client.gql(Q.removeAllSteps, { issueId }, { tolerant: true }) === null) return false;
  for (const s of previous) {
    if (await client.gql(Q.addStep, { issueId, step: stepInput(s) }, { tolerant: true }) === null) return false;
  }
  return true;
}

// Xray has no "replace steps" mutation, so a rewrite is destructive by construction: remove all,
// then add back one at a time. If an add fails after the remove has landed, the Test is left empty
// or half-written — so put the previous steps back before surfacing the error.
async function rewriteSteps({ issueId, key, next, previous }) {
  await gqlOrThrow(Q.removeAllSteps, { issueId }, { label: `removeAllSteps ${key}` });
  try {
    for (const s of next) {
      await gqlOrThrow(Q.addStep, { issueId, step: stepInput(s) }, { label: `addStep ${key}` });
    }
  } catch (err) {
    const restored = await restoreSteps(issueId, previous);
    throw new Error(`${key}: step rewrite failed — ${err.message}\n`
      + (restored
        ? '            The previous steps were restored; the test is intact. Re-run to retry.'
        : `            RESTORE ALSO FAILED. ${key} may now have no steps or partial steps.`
          + ' Fix it in Xray before running again.'));
  }
}

try {
  if (plan.folder && (CREATE.length || UPDATE.length)) {
    const d = await gqlOrThrow(Q.createFolder,
      { projectId: String(plan.projectId || ''), path: plan.folder }, { tolerant: true, label: 'createFolder' });
    console.log(d?.createFolder?.folder ? `folder   created ${plan.folder}` : `folder   ${plan.folder} already exists`);
  }

  for (const t of CREATE) {
    const d = await gqlOrThrow(Q.createTest, {
      steps: stepsOf(plan, t).map(stepInput),
      folder: t.folder || plan.folder || undefined,
      jira: {
        fields: {
          summary: t.summary,
          project: { key: plan.project },
          labels: labelsFor(plan, t),
          ...(plan.assignee ? { assignee: { id: plan.assignee } } : {}),
          ...(describeTest(plan, t) ? { description: describeTest(plan, t) } : {}),
        },
      },
    }, { label: `createTest ${t.id}` });
    const { issueId, jira } = d.createTest.test;
    created[t.id] = { issueId, key: jira.key, suites: t.suites, ac: t.ac };
    const warn = d.createTest.warnings?.length ? `  ⚠ ${d.createTest.warnings.join('; ')}` : '';
    console.log(`created  ${t.id} → ${jira.key}${warn}`);
  }

  for (const { t, rec, cur, diffs } of UPDATE) {
    if (diffs.includes('steps') || diffs.includes('forced')) {
      await rewriteSteps({ issueId: rec.issueId, key: rec.key, next: stepsOf(plan, t), previous: cur.steps || [] });
    }
    if (diffs.includes('folder')) {
      const want = folderFor(plan, t);
      await gqlOrThrow(Q.updateTestFolder,
        { issueId: String(rec.issueId), folderPath: want }, { label: `updateTestFolder ${t.id}` });
      console.log(`moved    ${t.id} → ${rec.key}  ${cur.folder?.path || '(none)'} → ${want}`);
    }
    // Jira-owned fields are always restated; the agent applies them over MCP.
    jiraActions.edits.push({
      key: rec.key,
      planId: t.id,
      changed: diffs,
      fields: { summary: t.summary, labels: labelsFor(plan, t), description: describeTest(plan, t) },
    });
    created[t.id] = { ...rec, suites: t.suites, ac: t.ac };
    console.log(`updated  ${t.id} → ${rec.key}  (${diffs.join(', ')})`);
  }

  // Keep the ledger's view of suites and criteria current even for tests nothing else touched,
  // so result.json does not quietly describe an older plan.
  for (const { t, rec } of UNCHANGED) created[t.id] = { ...rec, suites: t.suites, ac: t.ac };

  for (const { id, rec } of ORPHANS) {
    created[id] = rec;                                   // keep the record; never lose the mapping
    jiraActions.review.push({ key: rec.key, planId: id, reason: 'no longer present in the plan' });
  }

  /* ------------------------------------------------------------------ links */

  // Emitted from the reconciled state rather than from what this run happened to touch, so an
  // unlinked test is picked up on every subsequent run until the link actually exists.
  for (const l of LINKS.missing) {
    const key = l.key || created[l.id]?.key;
    if (key) jiraActions.links.push({ test: key, spec: plan.source.key, type: LINK_TYPE, reason: l.reason });
  }
  for (const l of LINKS.reversed) {
    jiraActions.relink.push({
      test: l.key,
      spec: plan.source.key,
      problem: 'link points story → test; Xray counts no coverage',
      action: 'delete the existing link in the Jira UI, then re-run this push to emit the correct one',
    });
  }
  for (const l of LINKS.unknown) {
    jiraActions.links.push({
      test: l.key, spec: plan.source.key, type: LINK_TYPE, reason: 'could not read existing links — verify before creating',
    });
  }

  /* -------------------------------------------------------------- test sets */

  for (const suite of SUITES) {
    const ids = plan.tests
      .filter((t) => (t.suites || []).includes(suite) && created[t.id])
      .map((t) => created[t.id].issueId);
    if (!ids.length) continue;
    const summary = setNameFor(suite);
    if (registry[summary]?.issueId) {
      const d = await gqlOrThrow(Q.addToSet, { issueId: registry[summary].issueId, testIssueIds: ids }, { label: `addToSet ${suite}` });
      const { addedTests, warning } = d.addTestsToTestSet;
      const n = Array.isArray(addedTests) ? addedTests.length : addedTests;
      console.log(`testset  ${suite}: +${n} → ${registry[summary].key} "${summary}"${warning ? `  ⚠ ${warning}` : ''}`);
    } else {
      const d = await gqlOrThrow(Q.createTestSet, {
        testIssueIds: ids,
        jira: { fields: { summary, project: { key: plan.project }, labels: [suite] } },
      }, { label: `createTestSet ${suite}` });
      const { issueId, jira } = d.createTestSet.testSet;
      registry[summary] = { issueId, key: jira.key, suite };
      console.log(`testset  ${suite}: created ${jira.key} "${summary}" with ${ids.length} test(s)`);
    }
    testSets[suite] = registry[summary];
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  }

  /* --------------------------------------------------------- xray test plan */

  // Membership is additive and idempotent — Xray ignores tests the plan already holds — so a
  // re-run to pick up newly added cases is safe.
  if (testPlan) {
    const ids = scoped
      .filter((t) => !conflicted.has(t.id) && created[t.id]?.issueId)
      .map((t) => created[t.id].issueId);
    if (ids.length) {
      const d = await gqlOrThrow(Q.addToPlan, { issueId: testPlan.issueId, testIssueIds: ids }, { label: 'addToPlan' });
      const { addedTests, warning } = d.addTestsToTestPlan;
      const n = Array.isArray(addedTests) ? addedTests.length : addedTests;
      console.log(`testplan +${n} → ${testPlan.key} "${testPlan.summary}"${warning ? `  ⚠ ${warning}` : ''}`);
    }
  }

  /* -------------------------------------------------------------- unclaim */

  // Acting on drift a person has reviewed. Only the named suite is touched, and the test itself
  // is left completely alone — this is not deprecation.
  for (const { id, suite } of unclaims) {
    const rec = recordFor(id);
    if (!rec?.issueId) { console.log(`skip     ${id} — no record to unclaim`); continue; }
    const set = registry[setNameFor(suite)];
    if (!set?.issueId) { console.log(`skip     ${id} — no ${suite} Test Set exists`); continue; }
    await gqlOrThrow(Q.removeFromSet, { issueId: set.issueId, testIssueIds: [rec.issueId] });
    console.log(`unclaimed ${id} → ${rec.key}  (removed from ${suite}, test itself untouched)`);
  }

  /* ----------------------------------------------------------- deprecation */

  // Suites answer "what kind of run is this" and Test Plans answer "is this slice tested yet", so
  // retiring a test means leaving both. Dropping it from the suites alone left it sitting in every
  // open sprint's Test Plan, unexecuted, holding that sprint's completion figure down.
  for (const id of deprecate) {
    const rec = recordFor(id);
    if (!rec) { console.log(`skip     ${id} — no record to deprecate`); continue; }
    for (const suite of SUITES) {
      const set = registry[setNameFor(suite)];
      if (!set?.issueId) continue;
      await gqlOrThrow(Q.removeFromSet, { issueId: set.issueId, testIssueIds: [rec.issueId] }, { tolerant: true });
    }
    const d = await gqlOrThrow(Q.testPlansOf, { issueIds: [rec.issueId] }, { tolerant: true, label: 'testPlansOf' });
    const plans = d?.getTests?.results?.[0]?.testPlans?.results || [];
    for (const tp of plans) {
      await gqlOrThrow(Q.removeFromPlan, { issueId: tp.issueId, testIssueIds: [rec.issueId] }, { tolerant: true });
    }
    const from = plans.length ? ` and ${plans.map((p) => p.jira.key).join(', ')}` : '';

    // The requirement link has to go too. Xray counts coverage from it, so a retired test that
    // keeps its link is still counted against the story — and since it will never run again, that
    // story's coverage can never come out green. The link is Jira's, and neither Xray's API nor
    // the MCP tools can delete one, so it is emitted with its link id for the agent to remove.
    let unlinked = '';
    if (plan.source?.key) {
      const d2 = await gqlOrThrow(Q.linksOf, { issueIds: [rec.issueId] }, { tolerant: true, label: 'linksOf' });
      const links = d2?.getTests?.results?.[0]?.jira?.issuelinks;
      const linkId = requirementLinkId(links, plan.source.key);
      if (linkId) {
        jiraActions.unlink.push({ test: rec.key, spec: plan.source.key, linkId, planId: id });
        unlinked = `, link ${linkId} to ${plan.source.key} flagged for removal`;
      }
    }

    jiraActions.deprecate.push({ key: rec.key, planId: id, addLabel: 'deprecated', removedFromTestPlans: plans.map((p) => p.jira.key) });
    console.log(`deprecated ${id} → ${rec.key}  (removed from all suites${from}${unlinked})`);
  }
} catch (err) {
  applyError = err;
} finally {
  persist();
}

const pending = jiraActions.links.length + jiraActions.edits.length + jiraActions.deprecate.length;
console.log(`\nRecorded in ${resultPath}`);
if (pending || jiraActions.review.length || jiraActions.relink.length) {
  console.log(`Jira-side actions written to ${actionsPath}:`);
  if (jiraActions.links.length) console.log(`  ${jiraActions.links.length} link(s) to create`);
  if (jiraActions.relink.length) console.log(`  ${jiraActions.relink.length} backwards link(s) to delete by hand — they produce no coverage`);
  if (jiraActions.edits.length) console.log(`  ${jiraActions.edits.length} field edit(s) — summary / labels / description`);
  if (jiraActions.deprecate.length) console.log(`  ${jiraActions.deprecate.length} 'deprecated' label(s) to add`);
  if (jiraActions.unlink.length) console.log(`  ${jiraActions.unlink.length} requirement link(s) to REMOVE — a retired test still counts as coverage until its link goes`);
  if (jiraActions.review.length) console.log(`  ${jiraActions.review.length} test(s) needing a human decision`);
  console.log('The Xray API cannot write Jira fields or links — the qa-xray agent applies these over MCP.');
}
if (plan.source?.key) {
  console.log(`\nVerify coverage actually registered:  node .claude/scripts/qa-coverage.mjs ${plan.source.key}`);
}

if (applyError) fail(`${applyError.message}\n            Everything completed before this point is recorded above.`);

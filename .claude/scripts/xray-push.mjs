#!/usr/bin/env node
/**
 * Reconcile a QA test plan with Xray Cloud.
 *
 *   node .claude/scripts/xray-push.mjs <plan.json> [options]
 *
 *     --dry-run            show what would change, including suite drift; write nothing
 *     --only ID,ID         restrict to these plan test ids
 *     --force              rewrite matching tests even when nothing differs
 *     --deprecate ID,ID    retire tests: drop from every suite, flag for a `deprecated` label
 *     --adopt              rebuild <plan>.result.json from the Jira labels and exit; writes
 *                          nothing to Xray. Use on a fresh clone, or to repair a lost cache.
 *
 * The plan is the master copy and Jira is the published copy; this brings the published copy
 * into line. Tests are matched on their plan id, which is written to Jira as a label and cached
 * in <plan>.result.json, so a revised plan edits the existing tickets rather than creating
 * duplicates. Because the id also lives in Jira, a missing or stale cache is recovered rather
 * than obeyed: the run adopts the labelled issue instead of creating a second one, and refuses
 * to act on a contradiction. Nothing is ever deleted.
 *
 * Suite membership is checked in both directions before anything is written: tests the plan claims
 * but the Test Set has lost (a stray removal in the Xray UI leaves no trace, since membership is
 * not a Jira link) and tests sitting in a set the plan no longer claims. Missing ones are restored
 * by the run itself; unclaimed ones are only reported, never removed.
 *
 * Xray owns test steps, test type and suite membership — this script writes those directly.
 * Jira owns summary, description, labels and issue links, which the Xray API cannot touch, so
 * those are emitted to <plan>.jira-actions.json for the qa-xray agent to apply over MCP.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app';
const SUITES = ['sanity', 'regression', 'e2e'];

// Suites are project-wide and accumulate across tickets, so Test Set ids live in one shared
// registry rather than per-plan. A plan that names its own Test Sets gets ticket-scoped ones
// instead — the registry is keyed by summary, so a new name simply means a new set.
const DEFAULT_SET_NAMES = { sanity: 'Sanity testing', regression: 'Regression testing', e2e: 'E2E testing' };
const REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'testsets.json');

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

const fail = (msg) => { console.error(`xray-push: ${msg}`); process.exit(1); };
if (!planPath) fail('usage: xray-push.mjs <plan.json> [--dry-run] [--only IDs] [--force] [--deprecate IDs] [--adopt]');
if (!existsSync(planPath)) fail(`no such plan: ${planPath}`);

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const resultPath = planPath.replace(/\.json$/, '') + '.result.json';
const actionsPath = planPath.replace(/\.json$/, '') + '.jira-actions.json';
const prior = existsSync(resultPath)
  ? JSON.parse(readFileSync(resultPath, 'utf8')) : { tests: {}, testSets: {} };
const registry = existsSync(REGISTRY_PATH) ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) : {};
const setNameFor = (suite) => plan.testSets?.[suite] || DEFAULT_SET_NAMES[suite];

/* ---------------------------------------------------------------- validation */

const problems = [];
if (!plan.project) problems.push('plan.project is required');
if (!Array.isArray(plan.tests) || plan.tests.length === 0) problems.push('plan.tests must be a non-empty array');
const seen = new Set();
(plan.tests || []).forEach((t, i) => {
  const at = `tests[${i}]${t.id ? ` (${t.id})` : ''}`;
  if (!t.id) problems.push(`${at}: id is required`);
  if (t.id && seen.has(t.id)) problems.push(`${at}: duplicate id`);
  if (t.id) seen.add(t.id);
  if (!t.summary) problems.push(`${at}: summary is required`);
  if (!Array.isArray(t.steps) || t.steps.length === 0) problems.push(`${at}: at least one step is required`);
  (t.steps || []).forEach((s, j) => {
    if (!s.action) problems.push(`${at}: steps[${j}].action is required`);
    if (!s.result) problems.push(`${at}: steps[${j}].result is required`);
  });
  const bad = (t.suites || []).filter((s) => !SUITES.includes(s));
  if (bad.length) problems.push(`${at}: unknown suite(s) ${bad.join(', ')} — expected ${SUITES.join(' | ')}`);
  if (!(t.suites || []).length) problems.push(`${at}: must belong to at least one suite`);
  if (!(t.ac || []).length) problems.push(`${at}: must cite at least one acceptance criterion in "ac"`);
});
if (problems.length) fail(`plan is invalid:\n  - ${problems.join('\n  - ')}`);

/* ------------------------------------------------------------------ graphql */

let token;
async function auth() {
  if (token) return token;
  const { XRAY_CLIENT_ID: client_id, XRAY_CLIENT_SECRET: client_secret } = process.env;
  if (!client_id || !client_secret) fail('XRAY_CLIENT_ID / XRAY_CLIENT_SECRET are not set (see .claude/qa/README.md)');
  const res = await fetch(`${BASE}/api/v2/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id, client_secret }),
  });
  const body = await res.text();
  if (!res.ok) fail(`authenticate failed (HTTP ${res.status}): ${body}`);
  token = JSON.parse(body); // a bare JSON string holding the JWT
  return token;
}

// tolerant: return null on a GraphQL error instead of aborting. Used where failure is benign
// (e.g. the Test Repository folder already exists from an earlier push).
async function gql(query, variables, { tolerant = false } = {}) {
  const res = await fetch(`${BASE}/api/v2/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  if (!res.ok) { if (tolerant) return null; fail(`graphql HTTP ${res.status}: ${body}`); }
  const json = JSON.parse(body);
  if (json.errors?.length) { if (tolerant) return null; fail(`graphql errors: ${JSON.stringify(json.errors)}`); }
  return json.data;
}

const Q = {
  getTests: `query GetTests($issueIds: [String]) {
    getTests(issueIds: $issueIds, limit: 100) {
      results { issueId testType { name } steps { id action data result } jira(fields: ["key","summary","labels","description"]) }
    } }`,
  findByLabel: `query FindByLabel($jql: String!, $start: Int, $limit: Int!) {
    getTests(jql: $jql, start: $start, limit: $limit) {
      total results { issueId jira(fields: ["key","labels"]) } } }`,
  createFolder: `mutation CreateFolder($projectId: String, $path: String!) {
    createFolder(projectId: $projectId, path: $path) { folder { path } warnings } }`,
  createTest: `mutation CreateTest($steps: [CreateStepInput], $folder: String, $jira: JSON!) {
    createTest(testType: { name: "Manual" }, steps: $steps, folderPath: $folder, jira: $jira) {
      test { issueId jira(fields: ["key"]) } warnings } }`,
  removeAllSteps: `mutation RemoveAll($issueId: String!) { removeAllTestSteps(issueId: $issueId) }`,
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
};

/* ------------------------------------------------------------------ payloads */

// Preconditions have no structured home on a Manual test, so they lead the description.
function description(t) {
  const parts = [];
  if (t.precondition) parts.push(`*Preconditions:* ${t.precondition}`);
  if (t.ac?.length) parts.push(`*Covers:* ${t.ac.join(', ')}`);
  if (plan.source?.key) parts.push(`*Source:* ${plan.source.key}${plan.source.summary ? ` — ${plan.source.summary}` : ''}`);
  if (t.notes) parts.push(t.notes);
  return parts.join('\n\n');
}

// Jira rejects labels containing whitespace.
// The plan id leads. It is the test's identity, so publishing it to Jira means Xray carries the
// id -> issue mapping too, and result.json becomes a cache rather than the only copy of it.
const labelsFor = (t) => [...new Set([t.id, ...(t.suites || []), ...(t.labels || []), plan.source?.key].filter(Boolean))]
  .map((l) => String(l).replace(/\s+/g, '-')).sort();

const stepsOf = (t) => t.steps.map((s) => ({ action: s.action, data: s.data || '', result: s.result }));
const sameSteps = (a, b) => JSON.stringify(a.map((s) => [s.action, s.data || '', s.result]))
                         === JSON.stringify(b.map((s) => [s.action, s.data || '', s.result]));

const scoped = plan.tests.filter((t) => !only || only.includes(t.id));

/* -------------------------------------------------------- identity by label */

// Every pushed Test carries its plan id as a Jira label, so Xray holds the id -> issue mapping
// independently of result.json. Resolve identity from Jira first and treat the file as a cache:
//
//   adopted   — nothing cached, but Jira has the label. Reuse that issue rather than creating a
//               second one. This is what makes a fresh clone, or a colleague's checkout that
//               predates your last push, safe to push from.
//   mismatch  — cache and Jira name different issues for one plan id.
//   duplicate — two issues claim one plan id.
//
// The last two are refused rather than guessed at: either way, picking wrong edits the steps of
// a Test somebody else's execution history hangs off.

async function findByPlanIds(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {   // keep the JQL in list well clear of any length cap
    const batch = ids.slice(i, i + 50);
    const jql = `project = ${plan.project} AND labels in (${batch.map((id) => `'${id}'`).join(', ')})`;
    let start = 0;
    for (;;) {
      const d = await gql(Q.findByLabel, { jql, start, limit: 100 });
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
const record = new Map();                      // plan id -> the issue this run will act on
const ADOPTED = [], MISMATCH = [], DUPLICATE = [];
for (const t of scoped) {
  const rec = prior.tests[t.id];
  const hits = labelled.get(t.id) || [];
  if (hits.length > 1) { DUPLICATE.push({ id: t.id, keys: hits.map((h) => h.key) }); continue; }
  const hit = hits[0];
  if (rec?.issueId && hit && hit.issueId !== rec.issueId) {
    MISMATCH.push({ id: t.id, cached: rec.key, live: hit.key });
  } else if (rec?.issueId) {
    record.set(t.id, rec);
  } else if (hit) {
    ADOPTED.push({ id: t.id, key: hit.key });
    record.set(t.id, { issueId: hit.issueId, key: hit.key, suites: t.suites, ac: t.ac });
  }
}
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
    writeFileSync(resultPath, JSON.stringify({ ...prior, tests, testSets: sets }, null, 2) + '\n');
    console.log(`\nRecovered ${record.size}/${scoped.length} plan id(s) into ${resultPath}. Nothing was written to Xray.`);
  }
  process.exit(conflicted.size ? 1 : 0);
}

/* ---------------------------------------------------------------- reconcile */

const known = [...record.values()].filter((v) => v.issueId);
const live = new Map();
if (known.length) {
  const data = await gql(Q.getTests, { issueIds: known.map((v) => v.issueId) });
  for (const r of data.getTests.results || []) live.set(r.issueId, r);
}

const CREATE = [], UPDATE = [], UNCHANGED = [], GONE = [];
for (const t of scoped) {
  if (conflicted.has(t.id)) continue;          // identity is unresolved; touch nothing
  const rec = record.get(t.id);
  if (!rec) { CREATE.push(t); continue; }
  const cur = live.get(rec.issueId);
  if (!cur) { GONE.push({ t, rec }); CREATE.push(t); continue; }   // deleted outside this tool
  const diffs = [];
  if (!sameSteps(stepsOf(t), cur.steps)) diffs.push('steps');
  if (cur.jira.summary !== t.summary) diffs.push('summary');
  if (JSON.stringify([...(cur.jira.labels || [])].sort()) !== JSON.stringify(labelsFor(t))) diffs.push('labels');
  if (diffs.length || force) UPDATE.push({ t, rec, cur, diffs: diffs.length ? diffs : ['forced'] });
  else UNCHANGED.push({ t, rec });
}
// Tests recorded from an earlier run whose plan entry has since been removed.
const ORPHANS = Object.entries(prior.tests)
  .filter(([id]) => !plan.tests.some((t) => t.id === id))
  .map(([id, rec]) => ({ id, rec }));

/* -------------------------------------------------------------- suite drift */

// Suite membership lives in Xray, not in a Jira link, so a stray removal in the Xray UI leaves no
// trace. Compare each set's real membership against the plan before touching anything, in both
// directions. Suites are project-wide and accumulate across tickets, so a set legitimately holds
// tests from other plans — drift is only meaningful for the tests THIS plan owns:
//   missing   — the plan claims the suite, the set doesn't have the test (a re-run restores it)
//   unclaimed — the set has a test this plan owns, but the plan no longer claims that suite
// Anything the plan has never heard of belongs to another ticket and is counted, never touched.

async function setMembers(issueId) {
  const members = new Set();
  let dangling = 0;
  let start = 0;
  let seen = 0;
  let total = Infinity;
  while (seen < total) {
    const d = await gql(Q.getTestSet, { issueId, start, limit: 100 });
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
    seen += results.length;
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
    name, key: set?.key, desired: desired.length, missing: [], unclaimed: [], foreign: 0,
    // Tests being created this run have no membership yet by definition — not drift.
    pending: desired.filter((t) => creating.has(t.id)).map((t) => t.id),
  };
  if (set?.issueId) {
    const { members, dangling } = await setMembers(set.issueId);
    d.dangling = dangling;
    const want = new Set();
    for (const t of desired) {
      if (creating.has(t.id)) continue;
      const rec = recordFor(t.id);
      if (!rec?.issueId) continue;
      want.add(rec.issueId);
      if (!members.has(rec.issueId)) d.missing.push(`${rec.key} (${t.id})`);
    }
    for (const issueId of members) {
      if (want.has(issueId)) continue;
      const id = ownedByPlan.get(issueId);
      if (id) d.unclaimed.push(`${recordFor(id).key} (${id})`);
      else d.foreign += 1;
    }
  }
  DRIFT[suite] = d;
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
  if (conflicted.size) console.log(`  ${w(conflicted.size)} with a contested identity — nothing will be written`);
  console.log('');
  for (const { id, key } of ADOPTED) console.log(`  ADOPT     ${key}  ${id} — already in Jira, reusing it instead of creating a duplicate`);
  reportIdentityProblems();
  for (const t of CREATE) console.log(`  NEW       ${t.id}  ${t.summary}`);
  for (const { t, rec, cur, diffs } of UPDATE) {
    console.log(`  UPDATE    ${rec.key}  ${t.id}  (${diffs.join(', ')})`);
    if (diffs.includes('summary')) {
      console.log(`      summary:  - ${cur.jira.summary}`);
      console.log(`                + ${t.summary}`);
    }
    if (diffs.includes('steps')) {
      const a = cur.steps, b = stepsOf(t);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i], y = b[i];
        if (x && y && x.action === y.action && (x.data || '') === (y.data || '') && x.result === y.result) continue;
        if (!x) { console.log(`      step ${i + 1}: + ${y.action} → ${y.result}`); continue; }
        if (!y) { console.log(`      step ${i + 1}: - ${x.action} → ${x.result}`); continue; }
        console.log(`      step ${i + 1}: - ${x.action} → ${x.result}`);
        console.log(`              + ${y.action} → ${y.result}`);
      }
    }
  }
  for (const { id, rec } of ORPHANS) console.log(`  REVIEW    ${rec.key}  ${id} — dropped from the plan; deprecate it or restore the entry`);
  for (const id of deprecate) {
    const rec = recordFor(id);
    console.log(rec ? `  DEPRECATE ${rec.key}  ${id} — removed from all suites, flagged for a 'deprecated' label`
                    : `  DEPRECATE ${id} — no record; nothing to do`);
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
      console.log(`          DRIFT  in the set but the plan no longer claims this suite — review, never auto-removed:`);
      console.log(`                 ${d.unclaimed.join(', ')}`);
    }
    if (d.foreign) console.log(`          ${d.foreign} test(s) from other plans — left alone`);
    if (d.dangling) console.log(`          ⚠ ${d.dangling} membership row(s) point at a deleted Test — clean up in the Xray UI`);
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
const jiraActions = { source: plan.source?.key || null, project: plan.project, links: [], edits: [], deprecate: [], review: [] };

if (plan.folder && (CREATE.length || UPDATE.length)) {
  const d = await gql(Q.createFolder,
    { projectId: String(plan.projectId || ''), path: plan.folder }, { tolerant: true });
  console.log(d?.createFolder?.folder ? `folder   created ${plan.folder}` : `folder   ${plan.folder} already exists`);
}

for (const t of CREATE) {
  const d = await gql(Q.createTest, {
    steps: stepsOf(t).map((s) => ({ action: s.action, data: s.data || undefined, result: s.result })),
    folder: t.folder || plan.folder || undefined,
    jira: { fields: { summary: t.summary, project: { key: plan.project }, labels: labelsFor(t),
                      ...(plan.assignee ? { assignee: { id: plan.assignee } } : {}),
                      ...(description(t) ? { description: description(t) } : {}) } },
  });
  const { issueId, jira } = d.createTest.test;
  created[t.id] = { issueId, key: jira.key, suites: t.suites, ac: t.ac };
  const warn = d.createTest.warnings?.length ? `  ⚠ ${d.createTest.warnings.join('; ')}` : '';
  console.log(`created  ${t.id} → ${jira.key}${warn}`);
  if (plan.source?.key) jiraActions.links.push({ test: jira.key, spec: plan.source.key, type: 'Test', reason: 'new' });
}

for (const { t, rec, diffs } of UPDATE) {
  if (diffs.includes('steps') || diffs.includes('forced')) {
    await gql(Q.removeAllSteps, { issueId: rec.issueId });
    for (const s of stepsOf(t)) {
      await gql(Q.addStep, { issueId: rec.issueId, step: { action: s.action, data: s.data || undefined, result: s.result } });
    }
  }
  // Jira-owned fields are always restated; the agent applies them over MCP.
  jiraActions.edits.push({ key: rec.key, planId: t.id, changed: diffs,
    fields: { summary: t.summary, labels: labelsFor(t), description: description(t) } });
  if (plan.source?.key) jiraActions.links.push({ test: rec.key, spec: plan.source.key, type: 'Test', reason: 'updated by this ticket' });
  created[t.id] = { ...rec, suites: t.suites, ac: t.ac };
  console.log(`updated  ${t.id} → ${rec.key}  (${diffs.join(', ')})`);
}

for (const { id, rec } of ORPHANS) {
  created[id] = rec;                                   // keep the record; never lose the mapping
  jiraActions.review.push({ key: rec.key, planId: id, reason: 'no longer present in the plan' });
}

/* --------------------------------------------------------------- test sets */

const testSets = {};
for (const suite of SUITES) {
  const ids = plan.tests
    .filter((t) => (t.suites || []).includes(suite) && created[t.id])
    .map((t) => created[t.id].issueId);
  if (!ids.length) continue;
  const summary = setNameFor(suite);
  if (registry[summary]?.issueId) {
    const d = await gql(Q.addToSet, { issueId: registry[summary].issueId, testIssueIds: ids });
    const { addedTests, warning } = d.addTestsToTestSet;
    const n = Array.isArray(addedTests) ? addedTests.length : addedTests;
    console.log(`testset  ${suite}: +${n} → ${registry[summary].key} "${summary}"${warning ? `  ⚠ ${warning}` : ''}`);
  } else {
    const d = await gql(Q.createTestSet, { testIssueIds: ids,
      jira: { fields: { summary, project: { key: plan.project }, labels: [suite] } } });
    const { issueId, jira } = d.createTestSet.testSet;
    registry[summary] = { issueId, key: jira.key, suite };
    console.log(`testset  ${suite}: created ${jira.key} "${summary}" with ${ids.length} test(s)`);
  }
  testSets[suite] = registry[summary];
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

/* ------------------------------------------------------------- deprecation */

for (const id of deprecate) {
  const rec = recordFor(id);
  if (!rec) { console.log(`skip     ${id} — no record to deprecate`); continue; }
  for (const suite of SUITES) {
    const set = registry[setNameFor(suite)];
    if (!set?.issueId) continue;
    await gql(Q.removeFromSet, { issueId: set.issueId, testIssueIds: [rec.issueId] }, { tolerant: true });
  }
  jiraActions.deprecate.push({ key: rec.key, planId: id, addLabel: 'deprecated' });
  console.log(`deprecated ${id} → ${rec.key}  (removed from all suites)`);
}

writeFileSync(resultPath, JSON.stringify({ ...prior, tests: created, testSets }, null, 2) + '\n');
writeFileSync(actionsPath, JSON.stringify(jiraActions, null, 2) + '\n');

const pending = jiraActions.links.length + jiraActions.edits.length + jiraActions.deprecate.length;
console.log(`\nRecorded in ${resultPath}`);
if (pending || jiraActions.review.length) {
  console.log(`Jira-side actions written to ${actionsPath}:`);
  if (jiraActions.links.length)     console.log(`  ${jiraActions.links.length} link(s) to create`);
  if (jiraActions.edits.length)     console.log(`  ${jiraActions.edits.length} field edit(s) — summary / labels / description`);
  if (jiraActions.deprecate.length) console.log(`  ${jiraActions.deprecate.length} 'deprecated' label(s) to add`);
  if (jiraActions.review.length)    console.log(`  ${jiraActions.review.length} test(s) needing a human decision`);
  console.log('The Xray API cannot write Jira fields or links — the qa-xray agent applies these over MCP.');
}

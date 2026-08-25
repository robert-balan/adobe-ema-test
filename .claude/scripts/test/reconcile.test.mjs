/**
 * The reconcile logic, exercised against a table of states instead of against production Jira.
 *
 *   node --test .claude/scripts/test/
 *
 * Every outcome the README promises — created, adopted, mismatch, duplicate, gone, orphan,
 * unchanged — used to be asserted only by prose, and verified only by running the real thing
 * against the real instance. These are the cases that must not regress, so they are the cases
 * that are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  stepsOf, sameSteps, labelsFor, describeTest,
  resolveIdentity, diffTest, linkState, driftFor, acDigest, plainText, planProblems,
} from '../lib/reconcile.mjs';

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`;

const PLAN = {
  project: 'EC',
  feature: 'BRANDS',
  source: { key: 'EC-14', summary: 'Header: Products Brand Carousel' },
};

const aTest = (over = {}) => ({
  id: 'BRANDS-TC-01',
  summary: 'Header: Products Brand Carousel - Arrow scrolling',
  ac: ['AC-8'],
  suites: ['regression'],
  labels: ['brand-carousel'],
  steps: [{ action: 'Click next', result: 'The strip scrolls' }],
  ...over,
});

const liveOf = (plan, t, over = {}) => ({
  issueId: '900',
  steps: stepsOf(t),
  jira: {
    key: 'EC-120',
    summary: t.summary,
    labels: labelsFor(plan, t),
    description: describeTest(plan, t),
    issuelinks: [{ type: { name: 'Test' }, outwardIssue: { key: 'EC-14' } }],
  },
  ...over,
});

/* -------------------------------------------------------------- payloads */

test('labelsFor: dedupes, hyphenates whitespace, sorts, carries the source key', () => {
  const t = aTest({ suites: ['sanity', 'regression'], labels: ['brand carousel', 'a11y', 'a11y'] });
  assert.deepEqual(labelsFor(PLAN, t), ['BRANDS-TC-01', 'EC-14', 'a11y', 'brand-carousel', 'regression', 'sanity']);
});

test('describeTest: preconditions lead, then Covers, then Source', () => {
  const t = aTest({ precondition: 'Products megamenu is open', ac: ['AC-8', 'AC-9'], notes: 'Known risk.' });
  assert.equal(describeTest(PLAN, t), [
    '*Preconditions:* Products megamenu is open',
    '*Covers:* AC-8, AC-9',
    '*Source:* EC-14 — Header: Products Brand Carousel',
    'Known risk.',
  ].join('\n\n'));
});

test('sameSteps: treats a missing data field and an empty one as equal', () => {
  assert.ok(sameSteps(
    [{ action: 'a', result: 'r' }],
    [{ action: 'a', data: '', result: 'r' }],
  ));
});

/* -------------------------------------------------------------- identity */

test('resolveIdentity: uses the cached record when it agrees with Jira', () => {
  const t = aTest();
  const { record, adopted, mismatch, duplicate } = resolveIdentity({
    scoped: [t],
    prior: { tests: { 'BRANDS-TC-01': { issueId: '900', key: 'EC-120' } } },
    labelled: new Map([['BRANDS-TC-01', [{ issueId: '900', key: 'EC-120' }]]]),
  });
  assert.equal(record.get('BRANDS-TC-01').key, 'EC-120');
  assert.deepEqual([adopted, mismatch, duplicate], [[], [], []]);
});

test('resolveIdentity: adopts a labelled issue when the ledger is missing it', () => {
  const t = aTest();
  const { record, adopted } = resolveIdentity({
    scoped: [t],
    prior: { tests: {} },
    labelled: new Map([['BRANDS-TC-01', [{ issueId: '900', key: 'EC-120' }]]]),
  });
  assert.deepEqual(adopted, [{ id: 'BRANDS-TC-01', key: 'EC-120' }]);
  assert.equal(record.get('BRANDS-TC-01').issueId, '900');
});

test('resolveIdentity: reports a mismatch and records nothing for it', () => {
  const { record, mismatch } = resolveIdentity({
    scoped: [aTest()],
    prior: { tests: { 'BRANDS-TC-01': { issueId: '900', key: 'EC-120' } } },
    labelled: new Map([['BRANDS-TC-01', [{ issueId: '901', key: 'EC-121' }]]]),
  });
  assert.deepEqual(mismatch, [{ id: 'BRANDS-TC-01', cached: 'EC-120', live: 'EC-121' }]);
  assert.equal(record.has('BRANDS-TC-01'), false, 'a contested id must not be acted on');
});

test('resolveIdentity: reports two issues claiming one plan id', () => {
  const { record, duplicate } = resolveIdentity({
    scoped: [aTest()],
    prior: { tests: {} },
    labelled: new Map([['BRANDS-TC-01', [{ issueId: '900', key: 'EC-120' }, { issueId: '901', key: 'EC-121' }]]]),
  });
  assert.deepEqual(duplicate, [{ id: 'BRANDS-TC-01', keys: ['EC-120', 'EC-121'] }]);
  assert.equal(record.has('BRANDS-TC-01'), false);
});

test('resolveIdentity: an unknown id is left for creation', () => {
  const { record, adopted } = resolveIdentity({ scoped: [aTest()], prior: { tests: {} }, labelled: new Map() });
  assert.equal(record.size, 0);
  assert.equal(adopted.length, 0);
});

/* ------------------------------------------------------------------ diff */

test('diffTest: an untouched test reports no diff', () => {
  const t = aTest();
  assert.deepEqual(diffTest({ plan: PLAN, t, cur: liveOf(PLAN, t) }), []);
});

test('diffTest: detects a changed step', () => {
  const t = aTest();
  const cur = liveOf(PLAN, t);
  cur.steps = [{ action: 'Click next', result: 'Nothing happens' }];
  assert.deepEqual(diffTest({ plan: PLAN, t, cur }), ['steps']);
});

test('diffTest: detects a changed summary and changed labels', () => {
  const t = aTest();
  const cur = liveOf(PLAN, t);
  cur.jira.summary = 'Something else';
  cur.jira.labels = ['stale'];
  assert.deepEqual(diffTest({ plan: PLAN, t, cur }).sort(), ['labels', 'summary']);
});

// The regression this whole diff exists for: re-pointing a test at different acceptance criteria
// changes only the description, and used to be reported as "unchanged" while Jira kept the old
// Covers line — traceability rotting silently.
test('diffTest: detects an AC change that touches nothing but the description', () => {
  const before = aTest({ ac: ['AC-8'] });
  const after = aTest({ ac: ['AC-8', 'AC-9'] });
  const cur = liveOf(PLAN, before);
  assert.deepEqual(diffTest({ plan: PLAN, t: after, cur }), ['description']);
});

test('diffTest: tolerates a live test with no description at all', () => {
  const t = aTest();
  const cur = liveOf(PLAN, t);
  delete cur.jira.description;
  assert.deepEqual(diffTest({ plan: PLAN, t, cur }), ['description']);
});

/* ----------------------------------------------------------------- links */

test('linkState: a correctly directed link reads as present', () => {
  assert.equal(linkState({
    issuelinks: [{ type: { name: 'Test' }, outwardIssue: { key: 'EC-14' } }],
    specKey: 'EC-14',
  }), 'present');
});

// Backwards renders identically in the Jira UI and yields no coverage, so it must not be
// mistaken for present, and must not be quietly "fixed" by adding a second link.
test('linkState: a backwards link is called out, not counted', () => {
  assert.equal(linkState({
    issuelinks: [{ type: { name: 'Test' }, inwardIssue: { key: 'EC-14' } }],
    specKey: 'EC-14',
  }), 'reversed');
});

test('linkState: links of other types and to other issues do not count', () => {
  assert.equal(linkState({
    issuelinks: [
      { type: { name: 'Defect' }, outwardIssue: { key: 'EC-14' } },
      { type: { name: 'Test' }, outwardIssue: { key: 'EC-99' } },
    ],
    specKey: 'EC-14',
  }), 'missing');
});

test('linkState: an unreadable links field is unknown, not missing', () => {
  assert.equal(linkState({ issuelinks: undefined, specKey: 'EC-14' }), 'unknown');
});

/* ----------------------------------------------------------- suite drift */

test('driftFor: separates missing, unclaimed and foreign membership', () => {
  const desired = [{ id: 'A' }, { id: 'B' }, { id: 'NEW' }];
  const recs = { A: { issueId: '1', key: 'EC-1' }, B: { issueId: '2', key: 'EC-2' }, C: { issueId: '3', key: 'EC-3' } };
  const d = driftFor({
    desired,
    members: new Set(['1', '3', '99']),        // B absent, C present but unclaimed, 99 foreign
    creating: new Set(['NEW']),
    recordFor: (id) => recs[id],
    ownedByPlan: new Map([['1', 'A'], ['2', 'B'], ['3', 'C']]),
  });
  assert.deepEqual(d.missing, ['EC-2 (B)']);
  assert.deepEqual(d.unclaimed, ['EC-3 (C)']);
  assert.equal(d.foreign, 1);
});

test('driftFor: a test being created this run is not counted as missing', () => {
  const d = driftFor({
    desired: [{ id: 'NEW' }],
    members: new Set(),
    creating: new Set(['NEW']),
    recordFor: () => undefined,
    ownedByPlan: new Map(),
  });
  assert.deepEqual(d.missing, []);
});

/* ------------------------------------------------------------- ac digest */

const SPEC = `# Brand Carousel

## 7. Variation Summary Matrix
irrelevant preamble

## 8. Testable Acceptance Criteria

* **AC-1:** The carousel renders every authored logo.
* **AC-2:** The prev arrow is hidden at the start.
`;

test('acDigest: scopes to the acceptance-criteria section', () => {
  const { scoped } = acDigest(SPEC, sha);
  assert.equal(scoped, true);
  // Editing text above the AC heading must not register as an AC change.
  const edited = SPEC.replace('irrelevant preamble', 'completely rewritten preamble');
  assert.equal(acDigest(edited, sha).digest, acDigest(SPEC, sha).digest);
});

test('acDigest: reflowing and re-bulleting is not a criteria change', () => {
  const reflowed = SPEC
    .replace(/^\* /gm, '- ')
    .replace('renders every authored logo.', 'renders every\n  authored logo.')
    .replace(/\*\*/g, '');
  assert.equal(acDigest(reflowed, sha).digest, acDigest(SPEC, sha).digest);
});

test('acDigest: an edited criterion changes the digest', () => {
  const changed = SPEC.replace('hidden at the start', 'hidden at the end');
  assert.notEqual(acDigest(changed, sha).digest, acDigest(SPEC, sha).digest);
});

test('acDigest: falls back to the whole description when there is no AC heading', () => {
  const { scoped, digest } = acDigest('Just a paragraph.', sha);
  assert.equal(scoped, false);
  assert.match(digest, /^sha256:[0-9a-f]{16}$/);
});

// The REST API returns ADF and the MCP server returns Markdown. If those digest differently, the
// check reports drift every time the source changes rather than when the criteria do.
test('acDigest: ADF and Markdown for the same criteria agree', () => {
  const markdown = '## 8. Testable Acceptance Criteria\n\n* **AC-1:** The carousel renders every authored logo.\n';
  const adf = {
    type: 'doc',
    content: [
      { type: 'heading', content: [{ type: 'text', text: '8. Testable Acceptance Criteria' }] },
      {
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: 'AC-1:', marks: [{ type: 'strong' }] },
              { type: 'text', text: ' The carousel renders every authored logo.' },
            ],
          }],
        }],
      },
    ],
  };
  assert.equal(acDigest(adf, sha).digest, acDigest(markdown, sha).digest);
});

test('plainText: a JSON-encoded ADF string is flattened, not digested as JSON', () => {
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };
  assert.equal(plainText(JSON.stringify(adf)).trim(), 'hello');
  assert.equal(plainText(null), '');
});

// The description is the tester's whole briefing: what it covers, and where to open it.
test('describeTest: publishes scope and resolved fixture URLs', () => {
  const plan = {
    ...PLAN,
    previewBase: 'https://develop--ufs--foodsolutions-04.aem.page',
    fixtures: [
      { id: 'BRANDS-FX-01', title: 'happy', page: '/drafts/qa/brands/happy', purpose: '8 logos, label present' },
      { id: 'BRANDS-FX-09', title: 'unused', page: '/drafts/qa/brands/unused' },
    ],
  };
  const t = aTest({ scope: 'Whether the authored model produces a carousel.', fixtures: ['BRANDS-FX-01'] });
  const out = describeTest(plan, t);
  assert.match(out, /\*Scope:\* Whether the authored model produces a carousel\./);
  assert.match(out, /BRANDS-FX-01 {2}https:\/\/develop--ufs--foodsolutions-04\.aem\.page\/drafts\/qa\/brands\/happy {2}— 8 logos, label present/);
  assert.doesNotMatch(out, /BRANDS-FX-09/, 'only cited fixtures are published');
});

test('describeTest: a test citing no fixtures gets no Fixtures section', () => {
  const out = describeTest({ ...PLAN, fixtures: [{ id: 'BRANDS-FX-01', title: 'x', page: '/p' }] }, aTest());
  assert.doesNotMatch(out, /\*Fixtures:\*/);
});

/* ------------------------------------------------------------- plan rules */

const planOf = (over = {}) => ({
  feature: 'BRANDS',
  fixtures: [{ id: 'BRANDS-FX-01', title: 'happy', page: '/drafts/qa/brands/happy' }],
  tests: [aTest({ fixtures: ['BRANDS-FX-01'] })],
  ...over,
});

test('planProblems: a coherent plan has no problems', () => {
  assert.deepEqual(planProblems(planOf()), []);
});

test('planProblems: duplicate test ids are rejected', () => {
  const p = planOf({ tests: [aTest(), aTest()] });
  assert.match(planProblems(p).join(), /duplicate id "BRANDS-TC-01"/);
});

test('planProblems: a test id not matching the feature slug is rejected', () => {
  const p = planOf({ tests: [aTest({ id: 'OTHER-TC-01' })] });
  assert.match(planProblems(p).join(), /does not start with the plan's feature slug/);
});

// The rule that only surfaced when a standing-requirement test met a schema demanding an AC.
test('planProblems: no AC is allowed only when notes explain why', () => {
  const bare = planOf({ tests: [aTest({ ac: [] })] });
  assert.match(planProblems(bare).join(), /cites no acceptance criterion/);

  const explained = planOf({ tests: [aTest({ ac: [], notes: 'Standing RTL requirement; EC-14 states none.' })] });
  assert.deepEqual(planProblems(explained), []);
});

test('planProblems: a test citing an unknown fixture is rejected', () => {
  const p = planOf({ tests: [aTest({ fixtures: ['BRANDS-FX-99'] })] });
  assert.match(planProblems(p).join(), /cites unknown fixture "BRANDS-FX-99"/);
});

// The mistake that would publish test content to a client's live site.
test('planProblems: a fixture outside /drafts/ is refused', () => {
  const page = planOf({ fixtures: [{ id: 'BRANDS-FX-01', title: 'x', page: '/products/happy' }] });
  assert.match(planProblems(page).join(), /page "\/products\/happy" is outside \/drafts\//);

  const nav = planOf({
    fixtures: [{ id: 'BRANDS-FX-01', title: 'x', page: '/drafts/qa/ok', nav: '/nav' }],
  });
  assert.match(planProblems(nav).join(), /nav "\/nav" is outside \/drafts\//);
});

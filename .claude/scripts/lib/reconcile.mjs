/**
 * The decision-making half of xray-push, with no I/O in it.
 *
 * Everything here is a pure function of (plan, live state) -> what should change. It lives apart
 * from the script so it can be tested against a table of states rather than against production
 * Jira, which was the only way to exercise it before. The script keeps the network, the ordering
 * and the reporting; this file keeps the judgement.
 */

export const SUITES = ['sanity', 'regression', 'e2e'];
export const LINK_TYPE = 'Test';

/* ------------------------------------------------------------------- payloads */

/**
 * A step's Test Data, with the page a tester has to open resolved to a full preview URL.
 *
 * A step that says "open FX-06" is only useful to somebody who already knows where FX-06 lives.
 * The description carries the URLs, but a tester works down the step table and should not have to
 * go back up to it — so any step that sends them to a page names that page in its own data, in
 * full, ready to paste into the address bar.
 *
 * The URL is derived rather than authored, because a fixture's path is already written down once
 * in `plan.fixtures` and a second copy is a second thing to get wrong. That is not hypothetical:
 * a comment on EC-6 pointed at /drafts/qa/footer/arabic for days after the fixture moved to
 * /drafts/qa/footer/rtl, and it went unnoticed precisely because the dead page still rendered.
 *
 * The origin comes from `plan.previewBase`, so a plan pointed at another branch produces steps for
 * that branch without any of them being edited.
 */
export const stepsOf = (plan, t) => {
  const byId = new Map((plan?.fixtures || []).map((f) => [f.id, f]));
  const base = plan?.previewBase || '';
  return t.steps.map((s) => {
    const urls = (s.fixtures || [])
      .map((id) => byId.get(id))
      .filter((f) => f && f.page)
      .map((f) => `${base}${f.page}`);
    return { action: s.action, data: [...urls, s.data].filter(Boolean).join('\n'), result: s.result };
  });
};

export const sameSteps = (a, b) => JSON.stringify(a.map((s) => [s.action, s.data || '', s.result]))
                                === JSON.stringify(b.map((s) => [s.action, s.data || '', s.result]));

// Jira rejects labels containing whitespace.
// The plan id leads. It is the test's identity, so publishing it to Jira means Xray carries the
// id -> issue mapping too, and result.json becomes a cache rather than the only copy of it.
export const labelsFor = (plan, t) => [...new Set([t.id, ...(t.suites || []), ...(t.labels || []), plan.source?.key].filter(Boolean))]
  .map((l) => String(l).replace(/\s+/g, '-')).sort();

/**
 * Where a test belongs in the Xray Test Repository. A test may name its own folder; otherwise it
 * takes the plan's. Null means the plan expresses no opinion, and an existing test is then left
 * wherever it already sits rather than being dragged to the root.
 *
 * Trailing slashes are trimmed so "/Header/Megamenu/" and "/Header/Megamenu" are the same folder,
 * which they are to Xray but were not to a string comparison.
 */
export const folderFor = (plan, t) => {
  const raw = t?.folder || plan?.folder || null;
  if (!raw) return null;
  const trimmed = String(raw).replace(/\/+$/, '');
  return trimmed || '/';
};

/**
 * The Jira description. A tester opens this and should need nothing else — what the test covers,
 * which criteria it traces to, and the fixture URLs to open. Preconditions lead because a Manual
 * test has no structured home for them.
 *
 * Fixture links are the reason a handful of broad tests works at all: the step says "open this
 * URL" rather than describing authoring work, so breadth costs the tester nothing.
 */
export function describeTest(plan, t, { previewBase } = {}) {
  const parts = [];
  if (t.precondition) parts.push(`*Preconditions:* ${t.precondition}`);
  if (t.ac?.length) parts.push(`*Covers:* ${t.ac.join(', ')}`);
  if (t.scope) parts.push(`*Scope:* ${t.scope}`);

  const byId = new Map((plan.fixtures || []).map((f) => [f.id, f]));
  const cited = (t.fixtures || []).map((id) => byId.get(id)).filter(Boolean);
  if (cited.length) {
    const base = previewBase || plan.previewBase || '';
    const lines = cited.map((f) => `  ${f.id}  ${base}${f.page}${f.purpose ? `  — ${f.purpose}` : ''}`);
    parts.push(`*Fixtures:*\n${lines.join('\n')}`);
  }

  if (plan.source?.key) parts.push(`*Source:* ${plan.source.key}${plan.source.summary ? ` — ${plan.source.summary}` : ''}`);
  if (t.notes) parts.push(t.notes);
  return parts.join('\n\n');
}

/* ----------------------------------------------------------------- plan rules */

/**
 * Rules the JSON Schema cannot express: uniqueness, cross-references between tests and fixtures,
 * and the two places where being permissive would be dangerous rather than convenient.
 *
 * @returns {string[]} problems, empty when the plan is coherent.
 */
export function planProblems(plan) {
  const problems = [];
  const seenTests = new Set();
  const fixtureIds = new Set((plan.fixtures || []).map((f) => f.id));

  for (const t of plan.tests || []) {
    if (!t.id) continue;
    if (seenTests.has(t.id)) problems.push(`tests: duplicate id "${t.id}" — ids are the idempotency key and must be unique`);
    seenTests.add(t.id);
    if (plan.feature && !t.id.startsWith(`${plan.feature}-TC-`)) {
      problems.push(`tests (${t.id}): does not start with the plan's feature slug "${plan.feature}-TC-"`);
    }
    // A test may trace to no acceptance criterion only when it covers a standing requirement the
    // doctrine mandates regardless of the ticket — WCAG 2.1 AA, RTL. It then has to say so, or
    // "traces to nothing" becomes indistinguishable from "nobody checked".
    if (!(t.ac || []).length && !t.notes) {
      problems.push(`tests (${t.id}): cites no acceptance criterion, so it must explain in "notes" `
        + 'which standing requirement it covers and why the ticket states none');
    }
    for (const fx of t.fixtures || []) {
      if (!fixtureIds.has(fx)) problems.push(`tests (${t.id}): cites unknown fixture "${fx}"`);
    }
    // A test must not predict its own result. `notes` is published into the Test's description, so
    // a prediction there reaches the tester and stops the bug being raised — the failure reads as
    // expected, and a step that later fails for a NEW reason is waved through as the old one.
    // Analysis belongs in `findings`, which never leaves the plan file.
    const predicts = /expected to fail|will fail|known (defect|issue|bug)|fails on (current )?code|not implemented/i;
    if (t.notes && predicts.test(t.notes)) {
      problems.push(`tests (${t.id}): "notes" predicts the result, and notes are published to the tester. `
        + 'Move the analysis to "findings", which stays in the plan');
    }
    // A step that opens a page must name the fixture, and the test must own that fixture. Both
    // halves matter: the id is what resolves to a URL in the step's data, and the test's own list
    // is what puts that URL in the description. A step reaching past its test's fixtures would
    // send a tester to a page the test never says it uses.
    const owned = new Set(t.fixtures || []);
    (t.steps || []).forEach((s, i) => {
      for (const fx of s.fixtures || []) {
        if (!fixtureIds.has(fx)) {
          problems.push(`tests (${t.id}) step ${i + 1}: opens unknown fixture "${fx}"`);
        } else if (!owned.has(fx)) {
          problems.push(`tests (${t.id}) step ${i + 1}: opens fixture "${fx}", which the test does not list `
            + 'in its own "fixtures" — add it there so the description carries the page too');
        }
      }
    });
  }

  const seenFixtures = new Set();
  for (const f of plan.fixtures || []) {
    if (seenFixtures.has(f.id)) problems.push(`fixtures: duplicate id "${f.id}"`);
    seenFixtures.add(f.id);
    // Fixtures are written into a client's authoring environment. A path outside the drafts area
    // is the mistake that publishes test content to a live site, so it is refused rather than warned.
    for (const [field, value] of [["page", f.page], ["nav", f.nav?.path], ["footer", f.footer?.path]]) {
      if (value && !value.startsWith('/drafts/')) {
        problems.push(`fixtures (${f.id}): ${field} "${value}" is outside /drafts/ — `
          + 'fixtures must never sit on a publishable path');
      }
    }
  }
  return problems;
}

/**
 * Parse `--unclaim ID:suite` requests: remove a test from a suite it is still sitting in but the
 * plan no longer claims.
 *
 * Drift in that direction is reported and never acted on automatically, because silently dropping
 * a test from a suite is how a test quietly stops being run. But once a person has decided, they
 * need a way to carry it out that goes through the same dry run and approval as everything else —
 * otherwise the only route is a hand-written API call, which is the one path with no safety on it.
 *
 * A request is refused when the plan still claims that suite: removing it would be undone by the
 * next push, so the honest fix is to edit the plan.
 */
export function parseUnclaim(specs, plan) {
  const pairs = []; const problems = [];
  for (const spec of specs || []) {
    const [id, suite] = String(spec).split(':');
    if (!id || !suite) {
      problems.push(`--unclaim "${spec}": expected the form TESTID:suite, e.g. BRANDS-TC-07:e2e`);
      continue;
    }
    if (!SUITES.includes(suite)) {
      problems.push(`--unclaim "${spec}": unknown suite "${suite}" — expected ${SUITES.join(' | ')}`);
      continue;
    }
    const test = (plan.tests || []).find((t) => t.id === id);
    if (test && (test.suites || []).includes(suite)) {
      problems.push(`--unclaim "${spec}": the plan still claims ${suite} for ${id}, so the next push `
        + `would put it straight back. Remove "${suite}" from that test in the plan instead.`);
      continue;
    }
    pairs.push({ id, suite });
  }
  return { pairs, problems };
}

/* ------------------------------------------------------------------- identity */

/**
 * Resolve each plan id to the issue this run should act on, preferring Jira over the local cache.
 *
 *   adopted   — nothing cached, but Jira has the label. Reuse that issue rather than creating a
 *               second one. This is what makes a fresh clone, or a colleague's checkout that
 *               predates your last push, safe to push from.
 *   mismatch  — cache and Jira name different issues for one plan id.
 *   duplicate — two issues claim one plan id.
 *
 * The last two are refused rather than guessed at: either way, picking wrong edits the steps of
 * a Test somebody else's execution history hangs off.
 */
export function resolveIdentity({ scoped, prior, labelled }) {
  const record = new Map();
  const adopted = []; const mismatch = []; const duplicate = [];
  for (const t of scoped) {
    const rec = prior.tests?.[t.id];
    const hits = labelled.get(t.id) || [];
    if (hits.length > 1) { duplicate.push({ id: t.id, keys: hits.map((h) => h.key) }); continue; }
    const hit = hits[0];
    if (rec?.issueId && hit && hit.issueId !== rec.issueId) {
      mismatch.push({ id: t.id, cached: rec.key, live: hit.key });
    } else if (rec?.issueId) {
      record.set(t.id, rec);
    } else if (hit) {
      adopted.push({ id: t.id, key: hit.key });
      record.set(t.id, { issueId: hit.issueId, key: hit.key, suites: t.suites, ac: t.ac });
    }
  }
  return { record, adopted, mismatch, duplicate };
}

/* ----------------------------------------------------------------------- diff */

/**
 * Which Jira/Xray-visible aspects of a live Test no longer match the plan.
 *
 * `description` is in here deliberately. It carries the `*Covers:*` line, which is the only place
 * a reader sees which acceptance criteria a test traces to. Leaving it out of the diff meant
 * re-pointing a test at different ACs changed nothing anywhere and the run reported "unchanged",
 * so traceability rotted in place while every report looked clean.
 *
 * `folder` is here for the same reason. It is only ever set when a test is created, so a test that
 * moves between plans — or is reused from a retired one — keeps filing itself under the old
 * feature forever. Nothing surfaced that, because every other field reconciled cleanly and the run
 * reported "unchanged" while the Test Repository slowly stopped matching the plans.
 */
export function diffTest({ plan, t, cur }) {
  const diffs = [];
  if (!sameSteps(stepsOf(plan, t), cur.steps || [])) diffs.push('steps');
  if (cur.jira?.summary !== t.summary) diffs.push('summary');
  if (JSON.stringify([...(cur.jira?.labels || [])].sort()) !== JSON.stringify(labelsFor(plan, t))) diffs.push('labels');
  if (sameText(cur.jira?.description, describeTest(plan, t)) === false) diffs.push('description');
  // A plan with no folder has no opinion, so an existing test is left where it is. Only a stated
  // folder that disagrees with the live one is drift.
  const want = folderFor(plan, t);
  if (want && cur.folder?.path && cur.folder.path.replace(/\/+$/, '') !== want) diffs.push('folder');
  return diffs;
}

/**
 * Compare two descriptions for meaning rather than for characters.
 *
 * Jira does not store text — it stores a document tree — so what comes back is a re-rendering of
 * what went in, not a copy of it. `*Covers:*` is written, stored as an emphasis node, and read
 * back as `_Covers:_`. Identical to a reader, different to `===`. Comparing literally meant every
 * run reported the same seven descriptions as changed forever, which is worse than useless: a real
 * change would have been indistinguishable from the permanent noise.
 *
 * Only the round-tripping differences are normalised — emphasis markers and trailing whitespace.
 * Anything a person would notice still registers as a change.
 */
export function sameText(a, b) {
  const norm = (s) => String(s || '')
    .replace(/[*_]/g, '')          // * and _ are the same emphasis node once stored
    .replace(/[ \t]+$/gm, '')      // Jira appends trailing spaces as soft line breaks
    .replace(/\r\n/g, '\n')
    .trim();
  return norm(a) === norm(b);
}

/* ---------------------------------------------------------------------- links */

/**
 * Whether a Test already carries a correctly directed requirement link to its spec ticket.
 *
 * Seen from the Test, a correct link puts the spec in `outwardIssue` — it reads "this Test *tests*
 * that Story". The reverse renders identically in the Jira UI and produces no Xray coverage at
 * all, which is how every test in this project once ended up covering nothing, so a backwards
 * link is reported as its own state rather than being counted as present or quietly re-created.
 */
/**
 * The id of the requirement link from a Test to its spec ticket, or null.
 *
 * Needed to remove one. A retired test must lose this link, because Xray counts coverage from it:
 * leave it and the story reports tests that will never run again, so its coverage can never come
 * out green and the figure stops meaning anything. This is the one case where the "keep links for
 * lineage" rule does not apply — a test that verifies nothing should not claim to verify this.
 */
export function requirementLinkId(issuelinks, specKey, linkType = LINK_TYPE) {
  if (!Array.isArray(issuelinks)) return null;
  const hit = issuelinks.find((l) => l?.type?.name === linkType
    && (l.outwardIssue?.key === specKey || l.inwardIssue?.key === specKey));
  return hit?.id || null;
}

export function linkState({ issuelinks, specKey, linkType = LINK_TYPE }) {
  if (!Array.isArray(issuelinks)) return 'unknown';
  let reversed = false;
  for (const l of issuelinks) {
    if (l?.type?.name !== linkType) continue;
    if (l.outwardIssue?.key === specKey) return 'present';
    if (l.inwardIssue?.key === specKey) reversed = true;
  }
  return reversed ? 'reversed' : 'missing';
}

/* ---------------------------------------------------------------- suite drift */

/**
 * Compare one Test Set's real membership against what the plan claims, in both directions.
 *
 * Suite membership lives in Xray rather than in a Jira link, so a stray removal in the Xray UI
 * leaves no trace. Suites are project-wide and accumulate across tickets, so a set legitimately
 * holds tests from other plans — drift is only meaningful for the tests this plan owns.
 *
 *   missing   — the plan claims the suite, the set doesn't have the test (a re-run restores it)
 *   unclaimed — the set has a test this plan owns, but the plan no longer claims that suite
 *   foreign   — belongs to another plan: counted, never touched
 */
export function driftFor({ desired, members, creating, recordFor, ownedByPlan }) {
  const missing = []; const unclaimed = []; const want = new Set();
  for (const t of desired) {
    if (creating.has(t.id)) continue;               // no membership yet by definition
    const rec = recordFor(t.id);
    if (!rec?.issueId) continue;
    want.add(rec.issueId);
    if (!members.has(rec.issueId)) missing.push(`${rec.key} (${t.id})`);
  }
  let foreign = 0;
  for (const issueId of members) {
    if (want.has(issueId)) continue;
    const id = ownedByPlan.get(issueId);
    if (id) unclaimed.push(`${recordFor(id).key} (${id})`);
    else foreign += 1;
  }
  return { missing, unclaimed, foreign };
}

/* ------------------------------------------------------------------ ac digest */

/**
 * A stable digest of a spec ticket's acceptance criteria, used to detect that a ticket kept its
 * title while its criteria were rewritten underneath the tests — the common case, and the one a
 * summary comparison cannot see.
 *
 * Normalised hard on purpose: reflowed paragraphs, changed bullet glyphs and edited whitespace are
 * not AC changes, and a digest that trips on them would be ignored within a sprint.
 */
export function acDigest(description, hash) {
  const text = plainText(description);
  const start = text.search(/^#{0,6}\s*\d*\.?\s*Testable Acceptance Criteria/im);
  const body = start === -1 ? text : text.slice(start);
  const normalised = body
    .replace(/\r/g, '')
    .replace(/^[\s>*\-+#]*/gm, '')      // list glyphs, headings and quote markers carry no meaning
    .replace(/[*_`\\|]/g, '')           // emphasis and table rules likewise
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { digest: hash(normalised), scoped: start !== -1, length: normalised.length };
}

/**
 * Reduce a description to plain text, whichever shape it arrives in.
 *
 * The Jira REST API returns Atlassian Document Format; the MCP server returns Markdown. Both have
 * to digest to the same value or the check reports drift every time the source changes rather than
 * when the criteria do. Flattening to text removes most of the difference — what survives is
 * cosmetic (a dropped link target), and the failure mode is a prompt to re-read the spec, which is
 * the safe direction to fail in.
 */
export function plainText(description) {
  if (description == null) return '';
  if (typeof description === 'string') {
    // A REST response handed straight through arrives as a JSON-encoded ADF document.
    const trimmed = description.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('"{')) {
      try {
        return plainText(JSON.parse(trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed));
      } catch { /* not ADF after all — treat it as the Markdown it looks like */ }
    }
    return description;
  }
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.text === 'string') out.push(node.text);
    if (node.content) walk(node.content);
    // Block-level nodes end a line; inline ones must not, or words run together.
    if (['paragraph', 'heading', 'listItem', 'tableRow', 'codeBlock'].includes(node.type)) out.push('\n');
  };
  walk(description);
  return out.join('');
}

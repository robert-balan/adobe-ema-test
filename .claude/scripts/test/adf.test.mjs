/**
 * The description -> ADF conversion, pinned.
 *
 *   node --test .claude/scripts/test/
 *
 * These exist because the reconciliation check cannot see this class of bug. `sameText` strips
 * emphasis markers before comparing, so a description whose formatting was mangled still reports as
 * unchanged on the next push. Every case below was written from a real description that went to a
 * live ticket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAdf, fromAdf } from '../lib/adf.mjs';

const paras = (doc) => doc.content.length;
const textOf = (p) => (p.content || []).filter((n) => n.type === 'text').map((n) => n.text).join('');

test('toAdf: a blank line starts a new paragraph', () => {
  const doc = toAdf('First one.\n\nSecond one.');
  assert.equal(paras(doc), 2);
  assert.equal(textOf(doc.content[0]), 'First one.');
  assert.equal(textOf(doc.content[1]), 'Second one.');
});

test('toAdf: a single newline is a line break inside one paragraph', () => {
  const doc = toAdf('Fixtures:\n  FX-01  https://example.test/a\n  FX-02  https://example.test/b');
  assert.equal(paras(doc), 1, 'one paragraph, not three');
  assert.equal(doc.content[0].content.filter((n) => n.type === 'hardBreak').length, 2);
});

// The fixture lines are indented, and that indentation is what lines the URLs up in the ticket.
test('toAdf: leading whitespace on a wrapped line is kept', () => {
  const doc = toAdf('Fixtures:\n  FX-01  https://example.test/a');
  assert.ok(textOf(doc.content[0]).includes('  FX-01'), 'the two-space indent survives');
});

test('toAdf: *runs* become emphasis, and the asterisks go', () => {
  const doc = toAdf('*Covers:* AC-1, AC-2');
  const [first, rest] = doc.content[0].content;
  assert.deepEqual(first, { type: 'text', text: 'Covers:', marks: [{ type: 'em' }] });
  assert.equal(rest.text, ' AC-1, AC-2');
  assert.equal(rest.marks, undefined, 'the rest of the line is not emphasised');
});

test('toAdf: emphasis is em, not strong — it is what the MCP route produced', () => {
  const doc = toAdf('*Scope:* what it does');
  assert.deepEqual(doc.content[0].content[0].marks, [{ type: 'em' }]);
});

test('toAdf: a lone asterisk stays literal rather than eating the line', () => {
  const doc = toAdf('Widths 2*3 and a trailing *');
  assert.equal(textOf(doc.content[0]), 'Widths 2*3 and a trailing *');
  assert.ok(!(doc.content[0].content || []).some((n) => n.marks), 'nothing marked');
});

// A real description: every label emphasised, the fixture block on one paragraph with breaks.
test('toAdf: a whole description keeps its shape', () => {
  const src = [
    '*Covers:* AC-12, AC-13',
    '*Scope:* That the bar works right to left.',
    '*Fixtures:*\n  UTILITY-FX-05  https://example.test/rtl  — the Arabic bar',
    '*Source:* EC-18 — Utility Bar',
  ].join('\n\n');
  const doc = toAdf(src);
  assert.equal(paras(doc), 4);
  const em = JSON.stringify(doc).match(/"type":"em"/g) || [];
  assert.equal(em.length, 4, 'one emphasised label per paragraph');
  assert.equal(JSON.stringify(doc).match(/hardBreak/g).length, 1, 'only the fixture block breaks');
});

// Clearing a description is not what this is for, and an empty one means a bug upstream.
test('toAdf: refuses to build an empty document', () => {
  assert.throws(() => toAdf(''), /empty description/);
  assert.throws(() => toAdf('\n\n  \n\n'), /empty description/);
  assert.throws(() => toAdf(undefined), /empty description/);
});

test('fromAdf: round-trips the text, so a write can be read back and checked', () => {
  const src = '*Covers:* AC-1\n\n*Fixtures:*\n  FX-01  https://example.test/a';
  assert.equal(fromAdf(toAdf(src)), 'Covers: AC-1\n\nFixtures:\n  FX-01  https://example.test/a');
});

/**
 * The QA discrepancy comment builder.
 *
 * Two failures are worth pinning here because neither shows up when you look at the ticket. A
 * mention that renders as plain text looks exactly like one that notifies, and a preview built
 * separately from the payload can show text that was never sent — so the mention nodes and the
 * preview-from-ADF are both asserted directly. The rest is the fixed shape: the closing line is
 * the builder's, not the caller's, and a typo'd key fails loudly instead of dropping an item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildComment, renderPreview, roster, validateSpec, countMentions, CLOSING } from '../lib/qa-comment.mjs';

const PEOPLE = roster(JSON.parse(readFileSync(new URL('../../qa/environment.json', import.meta.url), 'utf8')));

const spec = (over = {}) => ({
  issue: 'EC-7',
  commentId: '875166',
  mentions: ['Lubbe, Sybrand', 'Volpe, Gianluca'],
  intro: ' — please see below the discrepancies we found while creating the test cases for this ticket.',
  items: [{ text: 'The switch is at 1200px, not 1024px.' }],
  ...over,
});

/* ------------------------------------------------------------------ roster */

test('roster: reads the people who get tagged, and only them', () => {
  assert.equal(PEOPLE.get('Volpe, Gianluca'), '712020:8b7e0918-ec81-484d-827f-f54e6a0920eb');
  assert.equal(PEOPLE.get('Lubbe, Sybrand'), '712020:54484866-f4d8-477e-981f-ddb6f49a7a46');
  // `team` is in environment.json so a changelog reads clearly; those roles carry no accountId and
  // are never tagged.
  assert.equal(PEOPLE.get('Kalusinski, Valerie'), undefined);
});

/* ---------------------------------------------------------------- mentions */

test('the greeting carries real mention nodes, not text', () => {
  const doc = buildComment(spec(), PEOPLE);
  const nodes = doc.content[0].content;
  assert.equal(nodes[0].text, 'Hi ');
  assert.equal(nodes[1].type, 'mention');
  assert.equal(nodes[1].attrs.id, PEOPLE.get('Lubbe, Sybrand'));
  assert.equal(nodes[1].attrs.text, '@Lubbe, Sybrand');
  assert.equal(countMentions(doc), 2);
});

test('a single space separates two mentions, or the names run together', () => {
  const nodes = buildComment(spec(), PEOPLE).content[0].content;
  assert.deepEqual(nodes.map((n) => n.type), ['text', 'mention', 'text', 'mention', 'text']);
  assert.equal(nodes[2].text, ' ');
  // and no trailing separator before the framing sentence
  assert.match(nodes[4].text, /^ — please see below/);
});

test('an unknown name is an error, not a silently un-notified person', () => {
  assert.throws(() => buildComment(spec({ mentions: ['Lubbe, Sybrandt'] }), PEOPLE), /no accountId for "Lubbe, Sybrandt"/);
});

/* ------------------------------------------------------------------- shape */

test('items become an ordered list; bullets and the trailing note nest inside their item', () => {
  const doc = buildComment(spec({
    items: [
      { text: 'one' },
      { text: 'two', bullets: ['a', 'b'], after: 'Separately, …' },
    ],
  }), PEOPLE);

  const list = doc.content[1];
  assert.equal(list.type, 'orderedList');
  assert.equal(list.content.length, 2);

  const second = list.content[1].content;
  assert.deepEqual(second.map((n) => n.type), ['paragraph', 'bulletList', 'paragraph']);
  assert.equal(second[1].content.length, 2);
  assert.equal(second[1].content[0].content[0].content[0].text, 'a');
  assert.equal(second[2].content[0].text, 'Separately, …');
});

test('the closing line is the builder\'s and is always the last node', () => {
  const doc = buildComment(spec(), PEOPLE);
  const last = doc.content.at(-1);
  assert.equal(last.type, 'paragraph');
  assert.equal(last.content[0].text, CLOSING);
  assert.equal(CLOSING, 'Please review and advise.');
});

test('a doc is a doc: version 1, and no empty paragraph anywhere', () => {
  const doc = buildComment(spec({ items: [{ text: 'one', bullets: ['a'], after: 'b' }] }), PEOPLE);
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'paragraph') assert.ok(n.content?.length, 'paragraph with no content');
    if (n.type === 'text') assert.ok(n.text.length, 'empty text node');
    walk(n.content);
  };
  walk(doc);
});

/* ----------------------------------------------------------------- preview */

test('the preview renders the document that gets posted', () => {
  const doc = buildComment(spec({
    mentions: ['Lubbe, Sybrand'],
    items: [{ text: 'one' }, { text: 'two', bullets: ['a'], after: 'note' }],
  }), PEOPLE);

  assert.equal(renderPreview(doc), [
    'Hi @Lubbe, Sybrand — please see below the discrepancies we found while creating the test cases for this ticket.',
    '',
    '1. one',
    '',
    '2. two',
    '   - a',
    '   note',
    '',
    'Please review and advise.',
    '',
  ].join('\n'));
});

test('the preview spells a mention out the way the ticket will show it', () => {
  assert.match(renderPreview(buildComment(spec(), PEOPLE)), /^Hi @Lubbe, Sybrand @Volpe, Gianluca — /);
});

/* -------------------------------------------------------------- validation */

test('a typo\'d key fails loudly rather than dropping what it holds', () => {
  assert.throws(() => validateSpec(spec({ item: [{ text: 'lost' }] })), /unknown key\(s\): item/);
  assert.throws(() => validateSpec({ ...spec(), items: [{ txt: 'lost' }] }), /item 1: unknown key\(s\): txt/);
  // including an attempt to override the fixed closing line
  assert.throws(() => validateSpec(spec({ closing: 'Thanks!' })), /unknown key\(s\): closing/);
});

test('the comment must have someone to send it to and something to say', () => {
  assert.throws(() => validateSpec(spec({ mentions: [] })), /mentions must be a non-empty array/);
  assert.throws(() => validateSpec(spec({ items: [] })), /items must be a non-empty array/);
  assert.throws(() => validateSpec(spec({ items: [{ text: '  ' }] })), /item 1: text is required/);
  assert.throws(() => validateSpec(spec({ items: [{ text: 'x', bullets: [] }] })), /bullets must be a non-empty array/);
  assert.throws(() => validateSpec(spec({ items: [{ text: 'x', bullets: ['a', ''] }] })), /bullet 2 is empty/);
});

test('the intro joins onto the names, and says when the work was done', () => {
  assert.throws(() => validateSpec(spec({ intro: 'please see below while creating the test cases' })), /must open with the separator/);
  // "while testing" reads as a failed test run — the comment goes up before anything is executed
  assert.throws(() => validateSpec(spec({ intro: ' — the discrepancies we found while testing this ticket.' })), /while creating the test cases/);
});

test('the target is a ticket key and, when rewriting, a numeric comment id', () => {
  assert.throws(() => validateSpec(spec({ issue: 'ec-7' })), /must be a ticket key/);
  assert.throws(() => validateSpec(spec({ commentId: 'latest' })), /commentId must be numeric/);
  // no id at all is fine — that is the first post, before the id exists
  assert.doesNotThrow(() => validateSpec({ ...spec(), commentId: undefined }));
});

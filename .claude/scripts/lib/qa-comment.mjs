/**
 * qa-comment — the QA discrepancy comment, as Atlassian Document Format.
 *
 * One comment goes on a spec ticket after its tests are written, and it holds the discrepancies
 * and nothing else: no list of the tests (they are linked to the ticket already), no fixture URLs
 * (they are in each test's description), no JQL. The shape is fixed by the agent file — greeting
 * with mentions, one framing sentence, numbered items, then `Please review and advise.` — so it is
 * built here rather than hand-written, and the closing line is not the caller's to change.
 *
 * Two things make this worth a module of its own rather than a hand-built body:
 *
 *   1. **A mention only notifies when it is a real ADF mention node.** Writing `@Name` as text, or
 *      Jira's `[~accountid:...]` syntax, renders as literal text: it looks right in the ticket and
 *      nobody is told. The spec file therefore names people, and the accountId is looked up in
 *      environment.json — an unknown name is an error rather than a silently un-notified person.
 *   2. **The preview and the posted body come from the same source.** A preview built separately
 *      from the payload is a preview of something else, which is exactly how wrong text gets
 *      approved.
 */

const CLOSING = 'Please review and advise.';
const SPEC_KEYS = new Set(['issue', 'commentId', 'mentions', 'intro', 'items']);
const ITEM_KEYS = new Set(['text', 'bullets', 'after']);

const text = (t) => ({ type: 'text', text: t });
const para = (content) => ({ type: 'paragraph', content });

/**
 * Flatten environment.json's people into name → accountId.
 *
 * Only the two groups that are ever tagged: the requirements engineers, and the front-end
 * developers. `team` deliberately carries no accountId — those roles are there so a changelog
 * reads clearly, not so they can be pulled into a QA thread.
 */
export function roster(environment) {
  const out = new Map();
  for (const group of ['requirements', 'frontend']) {
    for (const p of environment?.people?.[group] || []) {
      if (p.name && p.accountId) out.set(p.name, p.accountId);
    }
  }
  return out;
}

/** Throw on anything that would produce a malformed or off-format comment. */
export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be an object');

  const unknown = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k));
  // A typo'd key would otherwise be dropped in silence — losing an item, or posting the default
  // closing line while the caller believed they had replaced it.
  if (unknown.length) throw new Error(`unknown key(s): ${unknown.join(', ')} — allowed: ${[...SPEC_KEYS].join(', ')}`);

  if (!/^[A-Z]+-\d+$/.test(spec.issue || '')) throw new Error('issue must be a ticket key, e.g. EC-7');
  if (spec.commentId != null && !/^\d+$/.test(String(spec.commentId))) throw new Error('commentId must be numeric');

  if (!Array.isArray(spec.mentions) || !spec.mentions.length) throw new Error('mentions must be a non-empty array of names');
  for (const m of spec.mentions) {
    if (typeof m !== 'string' || !m.trim()) throw new Error('each mention must be a name from environment.json');
  }

  if (typeof spec.intro !== 'string' || !spec.intro.trim()) throw new Error('intro is required');
  // The greeting is "Hi <mentions><intro>", so the intro carries the punctuation that joins them.
  if (!/^[\s—–-]/.test(spec.intro)) throw new Error('intro must open with the separator that follows the names, e.g. " — please see below…"');
  if (!/while creating the test cases/.test(spec.intro)) {
    throw new Error('intro must say "while creating the test cases" — the comment goes up before anything has been executed');
  }

  if (!Array.isArray(spec.items) || !spec.items.length) throw new Error('items must be a non-empty array');
  spec.items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`item ${n} must be an object`);
    const bad = Object.keys(it).filter((k) => !ITEM_KEYS.has(k));
    if (bad.length) throw new Error(`item ${n}: unknown key(s): ${bad.join(', ')} — allowed: ${[...ITEM_KEYS].join(', ')}`);
    if (typeof it.text !== 'string' || !it.text.trim()) throw new Error(`item ${n}: text is required`);
    if (it.bullets != null) {
      if (!Array.isArray(it.bullets) || !it.bullets.length) throw new Error(`item ${n}: bullets must be a non-empty array when present`);
      it.bullets.forEach((b, j) => {
        if (typeof b !== 'string' || !b.trim()) throw new Error(`item ${n}: bullet ${j + 1} is empty`);
      });
    }
    if (it.after != null && (typeof it.after !== 'string' || !it.after.trim())) throw new Error(`item ${n}: after must be non-empty text when present`);
  });

  return spec;
}

/** The mention nodes and the framing sentence, as one paragraph's worth of content. */
function greeting(spec, people) {
  const content = [text('Hi ')];
  spec.mentions.forEach((name, i) => {
    const id = people.get(name);
    if (!id) {
      throw new Error(`no accountId for "${name}" — add them to environment.json under people, or fix the spelling (names are "Surname, Firstname")`);
    }
    content.push({ type: 'mention', attrs: { id, text: `@${name}` } });
    // Two mention nodes with nothing between them render as one run-together name.
    if (i < spec.mentions.length - 1) content.push(text(' '));
  });
  content.push(text(spec.intro));
  return content;
}

function listItem(item) {
  const content = [para([text(item.text)])];
  if (item.bullets?.length) {
    content.push({ type: 'bulletList', content: item.bullets.map((b) => ({ type: 'listItem', content: [para([text(b)])] })) });
  }
  if (item.after) content.push(para([text(item.after)]));
  return { type: 'listItem', content };
}

/** The ADF document to post. */
export function buildComment(spec, people) {
  validateSpec(spec);
  return {
    type: 'doc',
    version: 1,
    content: [
      para(greeting(spec, people)),
      { type: 'orderedList', content: spec.items.map(listItem) },
      para([text(CLOSING)]),
    ],
  };
}

/**
 * The same comment as plain text, for the approval preview.
 *
 * Rendered from the ADF rather than from the spec, so what is shown cannot drift from what is sent.
 */
export function renderPreview(doc) {
  const inline = (nodes) => (nodes || []).map((n) => (n.type === 'mention' ? n.attrs.text : n.text || '')).join('');
  const out = [];
  for (const node of doc.content) {
    if (node.type === 'paragraph') out.push(inline(node.content), '');
    if (node.type === 'orderedList') {
      node.content.forEach((li, i) => {
        li.content.forEach((child, j) => {
          if (child.type === 'paragraph') out.push(j === 0 ? `${i + 1}. ${inline(child.content)}` : `   ${inline(child.content)}`);
          if (child.type === 'bulletList') child.content.forEach((b) => out.push(`   - ${inline(b.content[0].content)}`));
        });
        out.push('');
      });
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** How many real mention nodes a stored body came back with — the check that it will notify anyone. */
export function countMentions(doc) {
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'mention') n += 1;
    walk(node.content);
  };
  walk(doc);
  return n;
}

export { CLOSING };

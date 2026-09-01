/**
 * Jira description text -> Atlassian Document Format.
 *
 * Jira does not store description text, it stores a document tree. Every field write therefore has
 * to build that tree, and getting it subtly wrong does not error — it renders badly. A fixture list
 * collapses onto one line, or the labels lose their emphasis, and nobody notices until a tester
 * opens the ticket.
 *
 * That failure mode is invisible to the reconciliation check as well, by design: Jira round-trips
 * `*bold*` as `_italic_`, so `sameText` in reconcile.mjs strips emphasis markers before comparing.
 * A description whose formatting this file mangled still reports as "unchanged" on the next push.
 * Which is exactly why the conversion lives here, on its own, with tests — the safety net that
 * catches everything else is blind to this one thing.
 *
 * The shape is fixed by what `describeTest` produces:
 *
 *   a blank line starts a new paragraph
 *   a single newline inside a paragraph is a line break, and the indentation after it is content
 *   *asterisks* around a run make it emphasis
 *
 * Emphasis rather than strong is deliberate: it is what the Atlassian MCP server produced from the
 * same markdown, so descriptions written by either route look identical and neither shows as drift.
 */

// The delimiters must sit at a word boundary. Without that, "2*3 and a trailing *" pairs the
// asterisk after the 2 with the stray one at the end and italicises everything between them —
// which is not a hypothetical, it is what the first version of this did.
const EMPHASIS = /((?<![\w*])\*[^*\n]+\*(?![\w*]))/g;
const IS_EMPHASIS = /^\*[^*\n]+\*$/;

/** One line of text into text nodes, with *runs* marked as emphasis. */
function inline(line) {
  const nodes = [];
  for (const part of line.split(EMPHASIS)) {
    if (!part) continue;
    if (IS_EMPHASIS.test(part)) nodes.push({ type: 'text', text: part.slice(1, -1), marks: [{ type: 'em' }] });
    else nodes.push({ type: 'text', text: part });
  }
  return nodes;
}

/**
 * @param {string} description  plain text, as `describeTest` builds it
 * @returns {object} an ADF doc, safe to send as the `description` field
 */
export function toAdf(description) {
  const blocks = String(description ?? '').split('\n\n').filter((b) => b.trim().length);
  const content = blocks.map((block) => {
    const nodes = [];
    block.split('\n').forEach((line, i) => {
      if (i) nodes.push({ type: 'hardBreak' });
      // An empty line inside a block contributes only the break; ADF rejects an empty text node.
      nodes.push(...inline(line));
    });
    return { type: 'paragraph', content: nodes };
  });
  // A document with no paragraphs is rejected, and clearing a description is not something this
  // is for — an empty input is a bug upstream, so it fails here rather than silently blanking a field.
  if (!content.length) throw new Error('refusing to build an empty description');
  return { type: 'doc', version: 1, content };
}

/** The reverse, for verifying what came back out of Jira. Emphasis is not re-marked. */
export function fromAdf(doc) {
  const walk = (node) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'hardBreak') return '\n';
    const inner = (node.content || []).map(walk).join('');
    return node.type === 'paragraph' ? `${inner}\n\n` : inner;
  };
  return (doc?.content || []).map(walk).join('').replace(/\n\n$/, '');
}

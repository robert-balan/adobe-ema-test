# AGENTS.md

This repository holds the **qa-xray agent** and the tooling it uses to turn Jira specifications
into Xray test cases. It is a QA workspace, not a website.

That distinction matters more than it sounds. This repo was created from
[aem-boilerplate](https://github.com/adobe/aem-boilerplate/) and carried a full Edge Delivery site
for a while — stock blocks, styles, fonts, a demo homepage — none of which anyone ever edited. All
of it is gone. **There is no site here to build, serve, preview or lint.** If a task seems to call
for writing a block, changing CSS or running a dev server, the task belongs in a different
repository.

## What is here

```
.claude/
├── agents/qa-xray.md     The agent: role, test-design heuristics, suite rules, conventions
├── qa/                   Doctrine, the plan schema, instance facts, and the plan files
└── scripts/              The tooling that reconciles a plan file with Xray Cloud
```

Start with [`.claude/qa/README.md`](.claude/qa/README.md). It covers setup, the Xray API key, how a
push reconciles rather than recreates, and how two people share the work without creating duplicate
tests.

```sh
npm test        # the tooling's own tests — no dependencies, runs in about a second
```

## The site under test

The site these tests are written against is **`FoodSolutions-04/ufs`**, built with Edge Delivery
Services in Adobe Experience Manager. It is a separate, restricted repository — but a public
preview per branch serves both the code and the authored content, which is how the agent grounds a
test in what actually ships:

```
https://{branch}--ufs--foodsolutions-04.aem.page/blocks/{block}/{block}.js
https://{branch}--ufs--foodsolutions-04.aem.page/styles/styles.css
https://{branch}--ufs--foodsolutions-04.aem.page/nav.plain.html
```

Fetch with `curl --compressed` or the response comes back as binary. Testing runs against
`develop` and `stage`, never `main`, and those branches genuinely diverge — see the environment
rules in the agent file before assuming a value holds everywhere.

## Edge Delivery concepts that shape a test case

Not build instructions — the parts of the EDS model that change what a test should assert. The
agent's test-design heuristics depend on these.

**Content is authored, so the authoring contract is a test surface.** A page is built from
sections; sections hold default content (text, headings, links) and blocks. A block's expected
content structure is the contract between the author and the developer, which means an author can
break a block by omitting an optional field, adding an extra column, or pasting something strange
into a cell. Those are real test cases, not edge cases — they are what the `authoring` category
exists for. Background: [markup, sections and blocks](https://www.aem.live/developer/markup-sections-blocks).

**Blocks transform their own DOM.** Each block ships a `decorate(block)` function that rewrites the
authored markup into its final structure. So the DOM a test inspects is not the DOM the author
wrote, and a block must survive being handed content it did not expect. Re-decoration should be
idempotent.

**Auto-blocking builds blocks nobody authored**, from patterns in the content. A block can
therefore appear on a page with no corresponding row in the document — worth knowing when a test
says "author the block".

**Pages load in three phases**: eager (everything needed for LCP, including the first section),
lazy (the rest, plus header and footer), delayed (anything that can wait). Content that arrives in
a later phase must not shift layout when it lands, and a block with nothing to render must suppress
itself rather than leave an empty container behind.

**Responsive breakpoints are 600px, 900px and 1200px**, mobile-first, plus whatever breakpoint a
spec names for itself. Test at the boundaries — this is where the brand carousel's real defect was
found, `develop` switching at 1200px where the spec says 900px.

**Author-uploaded images are optimised automatically** and served as a `picture` with generated
sources. So test the alt text, the loading attribute and the rendered sources; file size is not
yours to assert.

## Working here

- Node ES modules, no build step, no transpiling, no framework.
- The tooling is deliberately **dependency-free**. Adding a dependency to run a script is a trade
  that needs justifying in the PR, not a default.
- Run `npm test` before proposing a change to anything under `.claude/scripts/`.
- **This repository is public.** Test steps, plan files and commit messages are world-readable and
  permanent. Keep client-confidential detail out of them.
- Never write to Jira or Xray without explicit approval. A `PreToolUse` hook enforces this; the
  rule and the reasoning are in `.claude/agents/qa-xray.md`.

# Design and implementation sources

The Jira spec is the contract, but it states values (`#d14900`, `40×40px`, "round white tiles")
without saying where they come from. These three files are where they come from. Use them to turn
a vague AC into a testable number — never guess a value the handover already pins down.

| URL | What it is |
|---|---|
| `https://felipecastro92.github.io/ufs-design-system/handover/index.html` | Component documentation |
| `https://felipecastro92.github.io/ufs-design-system/handover/full-page-preview-v0.2.html` | Working prototype of the whole site — real markup, CSS and JS for every block |
| `https://felipecastro92.github.io/ufs-design-system/handover/tokens.css` | The token definitions every value in the prototype resolves through |

The design-system root (`.../ufs-design-system/`) is a separate, higher-level site. It does **not**
link to `handover/` and does not contain the blocks — don't go looking for a block there.

## The implementation — via the preview, not the repo

The real project is `FoodSolutions-04/ufs` on GitHub and its content is authored in DA at
`https://da.live/#/foodsolutions-04`. Both are **restricted** — the GitHub org is not visible to
this machine's `gh` token, and DA's API returns 401 without an Adobe IMS token.

Neither is needed. Edge Delivery serves the repo's code and the authored content from a public
preview **per branch**, so the implementation is fully readable there:

```
https://{branch}--ufs--foodsolutions-04.aem.page/
```

**Sprint testing runs against `develop` and `stage`, not `main`.** Always ground a plan in the
branch that ticket will be tested on, and say which branch you read in the plan — the branches
diverge, sometimes in ways that change the ACs. Project rule: **≥900px is desktop, <900px is
mobile**. Verified 2026-08-21:

| Branch | State of `blocks/header` |
|---|---|
| `develop` | Furthest ahead (34.6 KB `header.js`). `header.css` switches at **1200px** while its own global `styles.css` still switches at 900px — looks like a regression, not a redefinition |
| `main` | Behind develop (31.6 KB). `header.css` and `styles.css` both switch at **900px** |
| `stage` | Stock boilerplate — 6.5 KB, **no megamenu and no brand carousel at all** |

| Path | What you get |
|---|---|
| `/blocks/{block}/{block}.js` · `.css` | The real block implementation |
| `/styles/styles.css` | The real token values (`--color-*`, `--space-*`, `--text-*`) |
| `/nav.plain.html` | The real authored nav content, exactly as DA produces it |
| `/{path}.plain.html` | Authored markup for any page |

`main--ufs--foodsolutions-04.aem.live` currently 404s — nothing is published to production yet, so
the branch previews are the only environments.

**Always pass `curl --compressed`.** The CDN returns these compressed regardless, and without it
you get binary and every `grep` silently finds nothing.

```sh
cd "$(mktemp -d)"
branch=develop   # the branch this ticket will be tested on
base=https://$branch--ufs--foodsolutions-04.aem.page
curl -sS --compressed -O "$base/blocks/header/header.js" -O "$base/styles/styles.css"
```

Diff the branches before trusting any value. A quick `shasum` across `main`, `develop` and `stage`
tells you immediately whether the block you are testing is even the same code.

Read the implementation *and* the authored content: `nav.plain.html` shows the real content model
including authoring noise (stray empty paragraphs, apostrophes in alt text) that no spec mentions
and that makes excellent `authoring` fixtures.

## Extracting values

`WebFetch` summarises and drops exact numbers, which is the opposite of what you need. Download and
parse instead:

```sh
cd "$(mktemp -d)"
base=https://felipecastro92.github.io/ufs-design-system/handover
curl -sO "$base/full-page-preview-v0.2.html" -O "$base/tokens.css"
```

Find the block by its rendered text, not by the spec's class name — the prototype uses its own
naming (see the warning below):

```sh
grep -o 'class="[^"]*brand[^"]*"' full-page-preview-v0.2.html | sort | uniq -c | sort -rn
```

Then pull the rules and resolve the tokens. The prototype's CSS is inline in `<style>` blocks and
its JS in inline `<script>` blocks, so a small Python pass beats grep:

```python
import re
src = open('full-page-preview-v0.2.html', encoding='utf-8', errors='replace').read()
css = "\n".join(re.findall(r'<style[^>]*>(.*?)</style>', src, re.S))
for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
    if re.search(r'YOUR-CLASS', m.group(1), re.I):
        print(re.sub(r'\s+', ' ', m.group(0)))
```

Read the inline JS too. Interaction ACs ("scrolls toward the end smoothly") are usually vague in the
ticket and exact in the prototype.

## Two warnings

**The prototype's class names are not the EDS class names.** The prototype uses its own prefixes
(`mm-*` for the megamenu, `drawer-*` for the mobile drawer); the specs use EDS `nav-*` conventions.
Take *values and behaviour* from the prototype, never selectors. Test steps must reference what the
user sees, not either set of class names.

**The prototype is a design reference, not an implementation.** Where it disagrees with the spec,
that is a question for the REs — not a licence to test the prototype's behaviour. Record the
disagreement in the plan's clarifications section.

## Worked example — Products Brand Carousel (EC-14), extracted 2026-08-21

Prototype classes: `.mm-brands*` (desktop), `.drawer-brands*` (mobile).

| Spec says | Handover resolves to |
|---|---|
| tinted band `#f5f3f4` | `--color-mushroom-100` = `#F5F3F4`, plus a `1px` `--color-mushroom-300` (`#E2DFE0`) border |
| orange `#d14900` | `--color-accessible-orange` = `#D14900` — cite the token, not the hex |
| arrows "40×40px … rounded-square" | `--space-10` = `40px`, `--radius-sm` = `8px`, `1px` accessible-orange border, `18×18` chevron |
| "round white tiles" | `--radius-full` (circle); **80×80px** desktop, **64×64px** (`--space-16`) mobile |
| (unspecified) tile gap | `--space-8` = `32px` desktop, `--space-4` = `16px` mobile |
| label "uppercase overline style" | `.text-overline` = **12px / 600 / 0.96px tracking**, uppercase |
| "hover lift" | `transform: scale(1.06)` + deeper shadow — a scale, not a translate |
| "scrolls toward the end smoothly" | jumps **all the way** to the end or start in one `scrollTo({behavior:'smooth'})` |
| arrows "hidden" at the edges | `.is-hidden` = `opacity:0; pointer-events:none` — still focusable |

Whatever you extract, re-extract it per ticket: the prototype is versioned in its filename
(`v0.2`) and will move.

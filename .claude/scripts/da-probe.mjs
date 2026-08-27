#!/usr/bin/env node
/**
 * da-probe.mjs — can we build test fixtures in Document Authoring? Find out without building any.
 *
 *     node .claude/scripts/da-probe.mjs
 *     node .claude/scripts/da-probe.mjs --ref stage --sample /docs/library/blocks/flex-carousel
 *
 * **This script writes nothing, anywhere.** Every request is a GET. It exists so the decision to
 * start creating content in a client's authoring environment can be made on evidence rather than
 * on optimism, and so the permission gaps show up before a renderer is written against them.
 *
 * One thing it cannot answer: whether the token may WRITE to /drafts/qa. Write access is not
 * readable — the only proof is a write. The report says so rather than implying otherwise.
 *
 * Credentials, both optional, both keychain material and never in this repo:
 *   DA_TOKEN         IMS bearer token for admin.da.live
 *   AEM_ADMIN_TOKEN  admin.hlx.page API key (falls back to DA_TOKEN, which often works)
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
};

const ORG = arg('org', 'foodsolutions-04');
const SITE = arg('site', 'ufs');
const REF = arg('ref', 'develop');
const FIXTURE_ROOT = arg('fixtures', '/drafts/qa');
const SAMPLE = arg('sample', '/docs/library/blocks/flex-carousel');

const PREVIEW = `https://${REF}--${SITE}--${ORG}.aem.page`;
const DA_ADMIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';

const daToken = process.env.DA_TOKEN;
const aemToken = process.env.AEM_ADMIN_TOKEN || process.env.DA_TOKEN;

/* ------------------------------------------------------------------ report */

const rows = [];
const record = (state, what, detail) => { rows.push({ state, what, detail }); };
const ok = (what, detail) => record('ok', what, detail);
const no = (what, detail) => record('NO', what, detail);
const skip = (what, detail) => record('--', what, detail);

async function get(url, token) {
  try {
    const res = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Accept-Encoding': 'gzip',
      },
    });
    return { status: res.status, ok: res.ok, text: res.ok ? await res.text() : '' };
  } catch (err) {
    return { status: 0, ok: false, text: '', error: err.message };
  }
}

/* -------------------------------------------------- 1. no credentials needed */

const nav = await get(`${PREVIEW}/nav.plain.html`);
if (nav.ok) {
  const imgs = (nav.text.match(/<(img|picture)\b/g) || []).length;
  ok(`preview ${REF} reachable`, `nav.plain.html, ${imgs} image element(s)`);
} else {
  no(`preview ${REF} reachable`, `nav.plain.html returned ${nav.status}`);
}

// `blocks.json` is the index the DA library UI reads, and it is NOT the list of blocks. Entries
// get taken out of it — to hide a block from authors while it is being worked on, say — while the
// document stays right where it was. So the folder is the source of truth for what exists, and the
// index only says what an author can currently insert. Reading blocks.json alone means building
// fixtures blind to whatever is not listed.
const lib = await get(`${PREVIEW}/docs/library/blocks.json`);
let indexed = null;
if (lib.ok) {
  try {
    const json = JSON.parse(lib.text);
    const entries = json.data || json;
    indexed = entries.map((e) => String(e.path || '').split('/').pop()).filter(Boolean);
    ok('block library index', `blocks.json lists ${entries.length} block(s) — what authors can insert`);
    const external = entries.filter((e) => /^https?:/.test(e.path || '')).length;
    if (external) {
      skip('library paths', `${external}/${entries.length} point at content.da.live — reading them needs DA_TOKEN`);
    }
  } catch {
    no('block library index', 'blocks.json was not JSON');
  }
} else {
  no('block library index', `blocks.json returned ${lib.status}`);
}

if (daToken) {
  const folder = await get(`${DA_ADMIN}/list/${ORG}/${SITE}/docs/library/blocks`, daToken);
  if (folder.ok) {
    try {
      const docs = JSON.parse(folder.text).filter((e) => e.ext === 'html').map((e) => e.name);
      ok('block library documents', `${docs.length} block document(s) — the fixture template source`);
      if (indexed) {
        const unlisted = docs.filter((n) => !indexed.includes(n));
        const orphaned = indexed.filter((n) => !docs.includes(n));
        if (unlisted.length) {
          skip('blocks not in the index', `${unlisted.length} document(s) absent from blocks.json — real blocks, `
            + `just not offered in the library UI: ${unlisted.join(', ')}`);
        }
        if (orphaned.length) {
          no('index entries with no document', `blocks.json names ${orphaned.join(', ')}, which do not exist`);
        }
      }
    } catch {
      no('block library documents', 'the folder listing was not JSON');
    }
  } else {
    no('block library documents', `listing /docs/library/blocks returned ${folder.status}`);
  }
} else {
  skip('block library documents', 'DA_TOKEN is not set — cannot list the folder, and blocks.json alone under-reports');
}

// The single most important capability for header fixtures: can a page point the header at a
// different nav document? Without it, header/megamenu variants cannot be isolated per page,
// because the nav is one site-wide document.
const headerJs = await get(`${PREVIEW}/blocks/header/header.js`);
if (headerJs.ok) {
  const supportsOverride = /getMetadata\(\s*['"]nav['"]\s*\)/.test(headerJs.text);
  (supportsOverride ? ok : no)(
    'per-page nav override',
    supportsOverride
      ? "header.js reads getMetadata('nav') — a fixture page can supply its own nav document"
      : "header.js does not read getMetadata('nav') — header variants cannot be isolated per page",
  );
} else {
  no('per-page nav override', `header.js returned ${headerJs.status}`);
}

/* ------------------------------------------------------ 2. DA, needs a token */

if (!daToken) {
  skip('DA token', 'DA_TOKEN is not set — every DA check below was skipped');
} else {
  const root = await get(`${DA_ADMIN}/list/${ORG}/${SITE}`, daToken);
  if (root.ok) {
    ok('DA read access', `list /${ORG}/${SITE} succeeded — token is valid`);
  } else {
    no('DA read access', `list returned ${root.status}${root.status === 401 ? ' — token invalid or expired' : ''}`);
  }

  if (root.ok) {
    // Existence is decided by the PARENT listing, never by the folder's own.
    // Listing a prefix that has never existed returns 200 with an empty array, identical to a
    // folder that exists and is empty — an earlier version read that as proof of existence and
    // reported a /drafts/qa that wasn't there. A folder created in da.live does show up as an
    // entry in its parent, so that is what to ask.
    const listing = async (path) => {
      const r = await get(`${DA_ADMIN}/list/${ORG}/${SITE}${path}`, daToken);
      if (!r.ok) return null;
      try { return JSON.parse(r.text) || []; } catch { return []; }
    };

    const drafts = await listing('/drafts');
    if (drafts) ok('DA /drafts listing', `${drafts.length} entr(ies), ${drafts.filter((i) => !i.ext).length} folder(s)`);
    else no('DA /drafts listing', 'could not be read');

    const parent = FIXTURE_ROOT.replace(/\/[^/]+$/, '') || '/';
    const leaf = FIXTURE_ROOT.split('/').filter(Boolean).pop();
    const siblings = parent === '/drafts' ? drafts : await listing(parent);
    if (!siblings) {
      no(`DA ${FIXTURE_ROOT} exists`, `could not list ${parent}`);
    } else if (siblings.some((i) => i.name === leaf && !i.ext)) {
      const contents = await listing(FIXTURE_ROOT);
      ok(`DA ${FIXTURE_ROOT} exists`, `present in ${parent}, holding ${contents ? contents.length : '?'} item(s)`);
    } else {
      skip(`DA ${FIXTURE_ROOT} exists`, `not listed in ${parent} — create it in da.live, or let the first `
        + 'document write bring the path into being');
    }

    // Reading one real document is how the renderer learns DA's exact shape. Report the
    // structure, never the content — this is the client's copy.
    const src = await get(`${DA_ADMIN}/source/${ORG}/${SITE}${SAMPLE}.html`, daToken);
    if (src.ok) {
      const tags = ['main', 'div', 'table', 'tr', 'td', 'p', 'picture'];
      const shape = tags
        .map((t) => [t, (src.text.match(new RegExp(`<${t}\\b`, 'g')) || []).length])
        .filter(([, n]) => n)
        .map(([t, n]) => `${t}×${n}`)
        .join(' ');
      ok('DA document format legible', `${SAMPLE}: ${shape || 'no recognisable structure'}`);
    } else {
      no('DA document format legible', `source ${SAMPLE} returned ${src.status}`);
    }
  }
}

/* -------------------------------------------- 3. preview API, needs a token */

if (!aemToken) {
  skip('preview API', 'no AEM_ADMIN_TOKEN or DA_TOKEN — preview checks skipped');
} else {
  const status = await get(`${AEM_ADMIN}/status/${ORG}/${SITE}/${REF}/`, aemToken);
  if (status.ok) {
    ok('preview API authorised', `status for ${ORG}/${SITE}/${REF} succeeded`);
  } else if (status.status === 401 || status.status === 403) {
    no('preview API authorised', `status returned ${status.status} — the token lacks admin rights on this site`);
  } else {
    no('preview API authorised', `status returned ${status.status}`);
  }
}

/* ----------------------------------------------------------------- verdict */

const width = Math.max(...rows.map((r) => r.what.length));
console.log(`probe  ${ORG}/${SITE}  ref=${REF}  fixtures=${FIXTURE_ROOT}\n`);
for (const r of rows) console.log(`  ${r.state.padEnd(3)} ${r.what.padEnd(width)}  ${r.detail}`);

const blocked = rows.filter((r) => r.state === 'NO');
const skipped = rows.filter((r) => r.state === '--');

console.log('');
if (blocked.length) {
  console.log(`${blocked.length} check(s) failed. Those are the gaps to close before building anything:`);
  for (const r of blocked) console.log(`  - ${r.what}: ${r.detail}`);
} else {
  console.log('Nothing failed.');
}
if (skipped.length) console.log(`${skipped.length} check(s) skipped — see above for what each needs.`);

/* ------------------------------------------------- 4. write test, opt-in only */

// Write access cannot be read. The only proof is a write, so this is behind an explicit flag:
// one document created at a fixed probe path, read back, then deleted. It never touches a real
// fixture path, and the delete runs in a finally so an assertion failure still cleans up.
//
// Verified against adobe/da-admin: POST multipart/form-data with a `data` field creates or
// updates, DELETE removes, and a token without write permission is refused with a clean 403.
const WRITE_PATH = `${FIXTURE_ROOT}/_probe-write-test`;

if (process.argv.includes('--write-test')) {
  console.log(`\n--- write test: ${WRITE_PATH} ---`);
  if (!daToken) {
    console.log('  skipped — DA_TOKEN is not set');
  } else {
    const url = `${DA_ADMIN}/source/${ORG}/${SITE}${WRITE_PATH}.html`;
    const body = new FormData();
    body.set('data', '<body><header></header><main><div><p>'
      + 'Temporary write-permission probe created by da-probe.mjs. Safe to delete.'
      + '</p></div></main><footer></footer></body>');

    let created = false;
    try {
      const put = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${daToken}` }, body });
      if (put.status === 403) {
        console.log('  NO   create — 403: the token may read this path but not write it');
      } else if (!put.ok) {
        console.log(`  NO   create — HTTP ${put.status}`);
      } else {
        created = true;
        console.log(`  ok   create — HTTP ${put.status}`);
        const back = await get(url, daToken);
        console.log(back.ok && back.text.includes('write-permission probe')
          ? '  ok   read back — content matches what was written'
          : `  NO   read back — HTTP ${back.status}`);
      }
    } catch (err) {
      console.log(`  NO   create — ${err.message}`);
    } finally {
      if (created) {
        const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${daToken}` } });
        if (del.ok || del.status === 204) {
          const gone = await get(url, daToken);
          console.log(gone.status === 404
            ? '  ok   delete — the probe document is gone, nothing left behind'
            : `  NO   delete — the document still reads back as HTTP ${gone.status}`);
        } else {
          console.log(`\n  ⚠ DELETE FAILED (HTTP ${del.status}). A document was left at:`);
          console.log(`      ${WRITE_PATH}`);
          console.log('      Remove it in da.live, or re-run to retry the cleanup.');
        }
      }
    }
  }
} else {
  console.log(`
NOT PROVEN, and not provable by reading: whether the token may WRITE to
${FIXTURE_ROOT}. The only test of write access is a write. Run with --write-test
to create one throwaway document at ${WRITE_PATH},
read it back and delete it again.

This probe created nothing.`);
}

process.exit(blocked.length ? 1 : 0);

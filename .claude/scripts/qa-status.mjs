#!/usr/bin/env node
/**
 * Where this project stands, read from the plans themselves.
 *
 *   node .claude/scripts/qa-status.mjs              everything
 *   node .claude/scripts/qa-status.mjs --findings    just the open findings
 *   node .claude/scripts/qa-status.mjs BRANDS NAV    named plans only
 *
 * Needs no credentials and no network, so it works from a cold clone. That is the point: someone
 * arriving on this repository — a colleague, another tool, you in three months — should be able to
 * see the whole picture in one command instead of reconstructing it from seventy commits.
 *
 * It is generated rather than written for the same reason. A STATE.md would be accurate on the day
 * it was committed and quietly wrong a week later, and a document that might be wrong is worse than
 * no document, because you cannot tell which kind you are reading.
 *
 * The findings section is the part that earns this. `findings` is deliberately never published to
 * Jira — a tester must meet each case cold, or a known failure stops being raised and a new one
 * hiding behind it gets waved through. But unpublished turned into invisible: nineteen thousand
 * characters of real analysis, reachable only by opening seven JSON files and reading past the
 * steps. These are the things somebody still has to decide.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLANS = join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'plans');
const argv = process.argv.slice(2);
const only = argv.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
const findingsOnly = argv.includes('--findings');

const plans = readdirSync(PLANS)
  .filter((f) => /^[A-Z]+\.json$/.test(f))
  .filter((f) => !only.length || only.includes(f.replace('.json', '')))
  .map((f) => {
    const plan = JSON.parse(readFileSync(join(PLANS, f), 'utf8'));
    const resultPath = join(PLANS, f.replace('.json', '.result.json'));
    const ledger = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).tests || {} : {};
    return { slug: f.replace('.json', ''), plan, ledger };
  });

if (!plans.length) { console.error('qa-status: no plans matched'); process.exit(1); }

const pad = (s, n) => String(s).padEnd(n);

if (!findingsOnly) {
  let tests = 0; let steps = 0; let live = 0;
  console.log('\nPLANS\n');
  for (const { slug, plan, ledger } of plans) {
    const bp = plan.breakpoint ? `${plan.breakpoint.value}px (set ${plan.breakpoint.setOn})` : 'not set';
    console.log(`${slug}  →  ${plan.source?.key || '?'}  ${plan.source?.summary || ''}`);
    console.log(`  breakpoint ${bp}`);
    if (plan.designRef) console.log(`  design     ${plan.designRef.name}`);
    console.log(`  criteria last checked ${plan.source?.acCheckedOn || 'never'}`);
    for (const t of plan.tests || []) {
      tests += 1; steps += t.steps.length;
      const key = ledger[t.id]?.key;
      if (key) live += 1;
      const category = (t.summary.split(' - ')[1] || '?').trim();
      console.log(`    ${pad(key || '(not pushed)', 11)} ${pad(t.id, 17)} ${pad(`${t.steps.length}st`, 5)} ${pad((t.suites || []).join(','), 22)} ${category}`);
    }
    // A ledger entry with no plan test behind it is a retired or moved test still being tracked.
    const orphans = Object.keys(ledger).filter((id) => !(plan.tests || []).some((t) => t.id === id));
    if (orphans.length) console.log(`    ledger has ${orphans.length} id(s) with no test in the plan: ${orphans.join(', ')}`);
    console.log('');
  }
  console.log(`${plans.length} plan(s)   ${tests} test(s), ${live} pushed to Jira   ${steps} step(s)\n`);
}

/* ------------------------------------------------------------------- findings */

const found = [];
for (const { slug, plan, ledger } of plans) {
  for (const t of plan.tests || []) {
    if (!t.findings) continue;
    found.push({ slug, id: t.id, key: ledger[t.id]?.key, source: plan.source?.key, text: t.findings });
  }
}

console.log('OPEN FINDINGS');
console.log('Never published to Jira. These are the things somebody still has to decide.\n');
if (!found.length) console.log('  none recorded\n');
for (const f of found) {
  console.log(`── ${f.id}${f.key ? `  ${f.key}` : ''}  (${f.source})`);
  for (const line of f.text.split('\n')) console.log(line.trim() ? `   ${line}` : '');
  console.log('');
}
console.log(`${found.length} test(s) carry findings.`);
if (!findingsOnly) console.log('Run with --findings to see only these.');

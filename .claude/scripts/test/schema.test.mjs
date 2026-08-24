/**
 * The plan schema is now the contract xray-push enforces, so it needs to hold up as one — and the
 * validator needs to keep understanding all of it. The last test here is the important one: it
 * fails the moment the schema grows a keyword the validator would silently ignore, which is how a
 * "validated" plan would quietly stop being validated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, unsupportedKeywords } from '../lib/schema.mjs';

const QA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qa');
const schema = JSON.parse(readFileSync(join(QA, 'plan.schema.json'), 'utf8'));

const valid = () => ({
  project: 'EC',
  feature: 'BRANDS',
  source: { key: 'EC-14', summary: 'Header: Products Brand Carousel' },
  tests: [{
    id: 'BRANDS-TC-01',
    summary: 'Header: Products Brand Carousel - Arrow scrolling',
    ac: ['AC-8'],
    suites: ['regression', 'sanity'],
    steps: [{ action: 'Click next', data: '', result: 'The strip scrolls' }],
  }],
});

test('a well-formed plan validates', () => {
  assert.deepEqual(validate(valid(), schema), []);
});

test('an unknown top-level property is rejected', () => {
  const p = valid();
  p.testSet = 'Regression testing';        // the real field is testSets
  assert.match(validate(p, schema).join(), /unknown property "testSet"/);
});

test('an unknown property inside a test is rejected', () => {
  const p = valid();
  p.tests[0].label = 'a11y';               // the real field is labels
  assert.match(validate(p, schema).join(), /unknown property "label"/);
});

test('a test id that is not <SLUG>-TC-nn is rejected', () => {
  const p = valid();
  p.tests[0].id = 'brands-tc-1';
  assert.match(validate(p, schema).join(), /does not match/);
});

test('an unknown suite is rejected', () => {
  const p = valid();
  p.tests[0].suites = ['smoke'];
  assert.match(validate(p, schema).join(), /"smoke" is not one of/);
});

test('a test with no acceptance criteria is rejected', () => {
  const p = valid();
  p.tests[0].ac = [];
  assert.match(validate(p, schema).join(), /at least 1 item/);
});

test('a step missing its expected result is rejected', () => {
  const p = valid();
  delete p.tests[0].steps[0].result;
  assert.match(validate(p, schema).join(), /"result" is required/);
});

test('a missing required top-level field is reported', () => {
  const p = valid();
  delete p.tests;
  assert.match(validate(p, schema).join(), /"tests" is required/);
});

test('the wrong type is reported against the field, not swallowed', () => {
  const p = valid();
  p.tests[0].steps = 'Click next';
  assert.match(validate(p, schema).join(), /expected array, got string/);
});

test('an acDigest in the wrong shape is rejected', () => {
  const p = valid();
  p.source.acDigest = 'deadbeef';
  assert.match(validate(p, schema).join(), /does not match/);
});

// If the schema grows a keyword the validator does not implement, that keyword is silently
// ignored and the plan is "valid" for the wrong reason. Fail loudly instead.
test('the validator understands every keyword the schema uses', () => {
  assert.deepEqual(unsupportedKeywords(schema), []);
});

test('the real plans in this repo validate against the schema', () => {
  const plans = join(QA, 'plans');
  if (!existsSync(plans)) return;
  for (const f of readdirSync(plans)) {
    if (!f.endsWith('.json') || f.endsWith('.result.json') || f.endsWith('.jira-actions.json')) continue;
    const problems = validate(JSON.parse(readFileSync(join(plans, f), 'utf8')), schema);
    assert.deepEqual(problems, [], `${f} does not validate:\n  ${problems.join('\n  ')}`);
  }
});

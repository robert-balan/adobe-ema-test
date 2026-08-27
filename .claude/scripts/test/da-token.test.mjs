/**
 * The DA token expiry check.
 *
 * This exists because the check it replaces was wrong in the one way that mattered: it did
 * arithmetic on `payload.exp` without asking whether there was one. A missing claim made every
 * comparison NaN, NaN fails every test rather than failing the check, and so the guard written to
 * turn a mid-run 401 into one clear sentence waved through the exact token that produced one.
 *
 * So the case that regressed gets a test of its own, and `now` is injected rather than read from
 * the clock — a check about time that cannot be tested at a chosen time is not much of a check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenExpiry } from '../lib/da-token.mjs';

const HOUR = 3.6e6;
const NOW = 1_800_000_000_000; // a fixed instant; nothing here should depend on the real clock

/** A JWT-shaped string with the given payload. The signature is never checked locally. */
const jwt = (payload) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  'not-a-real-signature',
].join('.');

test('a token with plenty of life left is ok', () => {
  assert.deepEqual(tokenExpiry(jwt({ exp: (NOW + 8 * HOUR) / 1000 }), NOW), { kind: 'ok' });
});

test('an expired token is refused, and says how long ago', () => {
  assert.deepEqual(
    tokenExpiry(jwt({ exp: (NOW - 3 * HOUR) / 1000 }), NOW),
    { kind: 'expired', hours: 3 },
  );
});

test('a token expiring inside the warning window warns, in minutes', () => {
  assert.deepEqual(
    tokenExpiry(jwt({ exp: (NOW + 2 * 60_000) / 1000 }), NOW),
    { kind: 'expiring', minutes: 2 },
  );
});

test('the boundary belongs to expired, not to ok', () => {
  assert.equal(tokenExpiry(jwt({ exp: NOW / 1000 }), NOW).kind, 'expired');
});

// The regression. A real DA_TOKEN in this project carried client_id and scope but no exp, so the
// old check computed NaN, passed it, and died later on a raw HTTP 401 in a stack trace.
test('a readable token with no exp claim is reported, never silently passed', () => {
  const noExp = jwt({ client_id: 'darkalley', scope: 'AdobeID,openid,session' });
  assert.deepEqual(tokenExpiry(noExp, NOW), { kind: 'no-expiry' });
  assert.notEqual(tokenExpiry(noExp, NOW).kind, 'ok', 'the bug: NaN comparisons made this look fine');
});

test('an exp that is not a number is no-expiry rather than an accidental pass', () => {
  for (const exp of ['soon', null, {}, [], true, '']) {
    assert.equal(tokenExpiry(jwt({ exp }), NOW).kind, 'no-expiry', `exp: ${JSON.stringify(exp)}`);
  }
});

test('an exp given as a numeric string is still read', () => {
  assert.equal(tokenExpiry(jwt({ exp: String((NOW + 8 * HOUR) / 1000) }), NOW).kind, 'ok');
});

test('something that is not a JWT is unreadable, and left for the API to judge', () => {
  for (const t of ['', 'not-a-jwt', 'a.b', 'a.!!!not-base64!!!.c', undefined, null]) {
    assert.equal(tokenExpiry(t, NOW).kind, 'unreadable', `token: ${JSON.stringify(t)}`);
  }
});

test('a payload that decodes to something other than an object is unreadable', () => {
  const scalar = ['x', Buffer.from('5').toString('base64url'), 'y'].join('.');
  assert.equal(tokenExpiry(scalar, NOW).kind, 'unreadable');
});

test('the warning window is adjustable, and expiry is judged against the given instant', () => {
  const t = jwt({ exp: (NOW + 30 * 60_000) / 1000 });
  assert.equal(tokenExpiry(t, NOW).kind, 'ok', 'half an hour is outside the default window');
  assert.equal(tokenExpiry(t, NOW, 60 * 60_000).kind, 'expiring', 'but inside an hour-wide one');
  assert.equal(tokenExpiry(t, NOW + HOUR).kind, 'expired', 'and gone an hour later');
});

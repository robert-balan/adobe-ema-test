/**
 * The client's job is to make a transient failure transient. It matters most during a step
 * rewrite, which removes every step before adding them back: a 429 halfway through used to exit
 * the process and leave the Test empty. So what is pinned here is which failures retry, which do
 * not, and that a GraphQL application error never does — retrying a rejected mutation just writes
 * the same rejection four more times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../lib/gql.mjs';

const AUTH = { ok: true, status: 200, text: async () => JSON.stringify('a-jwt'), headers: { get: () => null } };
const json = (body, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null },
});

/** Replays a queued list of responses, recording every call. */
function fakeFetch(queue) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body });
      const next = queue.shift();
      if (!next) throw new Error('fake fetch ran out of responses');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const clientWith = (queue, over = {}) => {
  const { fetchImpl, calls } = fakeFetch(queue);
  const client = createClient({
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
    sleep: async () => {},          // no real waiting in tests
    ...over,
  });
  return { client, calls };
};

test('a successful query returns data', async () => {
  const { client } = clientWith([AUTH, json({ data: { getTests: { total: 1 } } })]);
  assert.deepEqual(await client.gql('{ getTests { total } }'), { getTests: { total: 1 } });
});

test('authenticates once and reuses the token', async () => {
  const { client, calls } = clientWith([AUTH, json({ data: 1 }), json({ data: 2 })]);
  await client.gql('a');
  await client.gql('b');
  assert.equal(calls.filter((c) => c.url.endsWith('/authenticate')).length, 1);
});

test('retries a 429 and then succeeds', async () => {
  const retries = [];
  const { client, calls } = clientWith(
    [AUTH, json({}, 429), json({ data: { ok: true } })],
    { onRetry: (r) => retries.push(r) },
  );
  assert.deepEqual(await client.gql('q'), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(retries.length, 1);
});

test('retries a 503 and a network fault', async () => {
  const { client } = clientWith([AUTH, json({}, 503), new Error('ECONNRESET'), json({ data: { ok: true } })]);
  assert.deepEqual(await client.gql('q'), { ok: true });
});

test('gives up after the retry budget and reports the last failure', async () => {
  const { client, calls } = clientWith(
    [AUTH, json({}, 500), json({}, 500), json({}, 500)],
    { retries: 2 },
  );
  await assert.rejects(() => client.gql('q'), /graphql HTTP 500/);
  assert.equal(calls.length, 4, 'one auth plus the initial attempt plus two retries');
});

test('does not retry a 400 — a malformed query is not transient', async () => {
  const { client, calls } = clientWith([AUTH, json({ errors: [{ message: 'bad field' }] }, 400)]);
  await assert.rejects(() => client.gql('q'), /graphql HTTP 400/);
  assert.equal(calls.length, 2);
});

// Xray answers a rejected mutation with HTTP 200 and an errors array. Retrying that just makes
// the same rejection four more times, and on a mutation it could apply the write repeatedly.
test('does not retry a GraphQL application error returned with HTTP 200', async () => {
  const { client, calls } = clientWith([AUTH, json({ errors: [{ message: 'issue does not exist' }] })]);
  await assert.rejects(() => client.gql('q'), /issue does not exist/);
  assert.equal(calls.length, 2);
});

test('tolerant calls return null instead of throwing', async () => {
  const { client } = clientWith([AUTH, json({ errors: [{ message: 'folder exists' }] })]);
  assert.equal(await client.gql('q', {}, { tolerant: true }), null);
});

test('a tolerant call still exhausts its retries first', async () => {
  const { client, calls } = clientWith([AUTH, json({}, 503), json({ data: { ok: true } })]);
  assert.deepEqual(await client.gql('q', {}, { tolerant: true }), { ok: true });
  assert.equal(calls.length, 3);
});

test('missing credentials fail before any request is made', async () => {
  const { client, calls } = clientWith([], { clientId: undefined, clientSecret: undefined });
  await assert.rejects(() => client.gql('q'), /XRAY_CLIENT_ID/);
  assert.equal(calls.length, 0);
});

test('honours Retry-After when the server sends one', async () => {
  const delays = [];
  const { fetchImpl } = fakeFetch([
    AUTH,
    { ok: false, status: 429, text: async () => '{}', headers: { get: (h) => (h === 'retry-after' ? '7' : null) } },
    json({ data: { ok: true } }),
  ]);
  const client = createClient({
    clientId: 'id', clientSecret: 'secret', fetchImpl, sleep: async (ms) => { delays.push(ms); },
  });
  await client.gql('q');
  assert.deepEqual(delays, [7000]);
});

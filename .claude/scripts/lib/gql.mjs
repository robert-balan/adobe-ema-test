/**
 * Xray Cloud GraphQL client: auth, retry, and nothing else.
 *
 * Split out so the reconciler can be tested against a fake, and so transient failures stop being
 * fatal. They used to be: every error exited the process immediately, which mattered most in the
 * one place the script is destructive — a step rewrite removes all steps and then adds them back
 * one mutation at a time, so a 429 in the middle left a Test with no steps and no record of it.
 *
 * `fetch` and `sleep` are injectable for the same reason.
 */

export class XrayError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = 'XrayError';
    this.retryable = retryable;
    this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_SLEEP = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function createClient({
  baseUrl = 'https://xray.cloud.getxray.app',
  clientId,
  clientSecret,
  fetchImpl = fetch,
  sleep = DEFAULT_SLEEP,
  retries = 4,
  baseDelay = 500,
  onRetry = () => {},
} = {}) {
  let token = null;

  const backoff = (attempt, retryAfter) => (retryAfter != null
    ? Number(retryAfter) * 1000
    // Jittered exponential. The jitter matters because every step of a rewrite retries in
    // lockstep otherwise, and they all collide again on the next attempt.
    : Math.round(baseDelay * (2 ** attempt) * (0.75 + Math.random() * 0.5)));

  async function withRetry(label, attempt, fn) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof XrayError ? err.retryable : true;  // network faults retry
      if (!retryable || attempt >= retries) throw err;
      const delay = backoff(attempt, err.retryAfter);
      onRetry({ label, attempt: attempt + 1, of: retries, delay, reason: err.message });
      await sleep(delay);
      return withRetry(label, attempt + 1, fn);
    }
  }

  async function auth() {
    if (token) return token;
    if (!clientId || !clientSecret) {
      throw new XrayError('XRAY_CLIENT_ID / XRAY_CLIENT_SECRET are not set (see .claude/qa/README.md)');
    }
    token = await withRetry('authenticate', 0, async () => {
      const res = await fetchImpl(`${baseUrl}/api/v2/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      });
      const body = await res.text();
      if (!res.ok) {
        const err = new XrayError(`authenticate failed (HTTP ${res.status}): ${body}`,
          { retryable: RETRYABLE_STATUS.has(res.status), status: res.status });
        err.retryAfter = res.headers?.get?.('retry-after');
        throw err;
      }
      return JSON.parse(body);   // a bare JSON string holding the JWT
    });
    return token;
  }

  /**
   * @param {object} opts.tolerant  return null on failure instead of throwing. For calls whose
   *                                failure is benign — a Test Repository folder that already
   *                                exists, a removal from a set the test was never in.
   */
  async function gql(query, variables, { tolerant = false, label = 'graphql' } = {}) {
    try {
      return await withRetry(label, 0, async () => {
        const res = await fetchImpl(`${baseUrl}/api/v2/graphql`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        const body = await res.text();
        if (!res.ok) {
          const err = new XrayError(`graphql HTTP ${res.status}: ${body}`,
            { retryable: RETRYABLE_STATUS.has(res.status), status: res.status });
          err.retryAfter = res.headers?.get?.('retry-after');
          throw err;
        }
        const json = JSON.parse(body);
        // GraphQL reports application errors with a 200 status, and they are not transient.
        if (json.errors?.length) throw new XrayError(`graphql errors: ${JSON.stringify(json.errors)}`);
        return json.data;
      });
    } catch (err) {
      if (tolerant) return null;
      throw err;
    }
  }

  return { auth, gql };
}

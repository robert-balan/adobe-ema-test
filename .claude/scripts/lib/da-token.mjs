/**
 * What a DA token says about its own expiry, read locally.
 *
 * An IMS token is a JWT, so its expiry is readable with no secret and no request. Checking it
 * before the first call turns "401 halfway through a run" into one sentence up front — which is
 * the entire reason this exists, and the reason it has to be right about the cases where it
 * cannot tell.
 *
 * It was not. The check computed `payload.exp * 1000 - Date.now()` and compared the result against
 * zero. A token with no `exp` makes that NaN, every comparison against NaN is false, and so an
 * unusable token passed the guard silently and died later as a raw HTTP 401 in a stack trace —
 * exactly the failure the guard was written to prevent. Hence the explicit finite check, and hence
 * a caller-visible difference between "no expiry claim" and "not a JWT at all": the first is a
 * token this cannot vouch for and should say so about, the second is a credential shape it was
 * never meant to judge.
 *
 * No I/O, so every branch is exercisable without a token or a network.
 *
 * @param {string} token          the raw token
 * @param {number} now            milliseconds since the epoch, injectable so tests are not clocked
 * @param {number} warnWithinMs   how close to expiry is worth a warning
 * @returns {{kind:'expired',hours:number}|{kind:'expiring',minutes:number}
 *          |{kind:'no-expiry'}|{kind:'unreadable'}|{kind:'ok'}}
 */
export function tokenExpiry(token, now = Date.now(), warnWithinMs = 5 * 60_000) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
  } catch {
    return { kind: 'unreadable' };
  }
  if (!payload || typeof payload !== 'object') return { kind: 'unreadable' };

  // Two traps here, and a bare Number() falls into both. Number(undefined) and Number('soon') are
  // NaN, and NaN fails every comparison rather than failing the check — so the finite test has to
  // come before any arithmetic. But Number(null), Number('') and Number([]) are all 0, which is
  // finite, so a claim of `null` would sail past that test and be reported as a token that expired
  // in 1970. Neither is an expiry; both have to land on no-expiry.
  const { exp } = payload;
  const seconds = typeof exp === 'number' ? exp
    : (typeof exp === 'string' && exp.trim() !== '' ? Number(exp) : NaN);
  if (!Number.isFinite(seconds)) return { kind: 'no-expiry' };
  const expMs = seconds * 1000;

  const left = expMs - now;
  if (left <= 0) return { kind: 'expired', hours: Math.round(-left / 3.6e6) };
  if (left < warnWithinMs) return { kind: 'expiring', minutes: Math.round(left / 60_000) };
  return { kind: 'ok' };
}

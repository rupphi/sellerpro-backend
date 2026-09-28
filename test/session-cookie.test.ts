import { test } from "node:test";
import assert from "node:assert/strict";
import { COOKIE_LIFETIME_MS, needsSessionRenewal, sessionCookieOptions } from "../src/modules/auth/session-cookie";

test("persistent cookies retain security flags and renew daily or on legacy session upgrade", () => {
  assert.deepEqual(sessionCookieOptions(true), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 400 * 86400000,
  });
  assert.equal(COOKIE_LIFETIME_MS, 34560000000);
  assert.equal(sessionCookieOptions(false).secure, false);
  const now = Date.now();
  assert.equal(needsSessionRenewal(null, new Date(now), now), false);
  assert.equal(needsSessionRenewal(null, new Date(now - 86400000), now), true);
  assert.equal(needsSessionRenewal(new Date(now + 86400000), new Date(now), now), true);
});

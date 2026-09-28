import type { CookieOptions } from "express";
export const SESSION_COOKIE = "ml_session";
// Browsers cap persistent cookies; refresh on visits instead of promising infinite storage.
export const COOKIE_LIFETIME_MS = 400 * 86400000;
export function sessionCookieOptions(production: boolean): CookieOptions {
    return {
        httpOnly: true,
        secure: production,
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_LIFETIME_MS,
    };
}
export function needsSessionRenewal(expiresAt: Date | null, renewedAt: Date, now = Date.now()) {
    return expiresAt !== null || now - renewedAt.getTime() >= 86400000;
}

import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE_NAME = "tkos_demo_access";
export const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 12;

function configuredPassword(): string | null {
  const password = process.env.TKOS_ACCESS_PASSWORD?.trim();
  return password ? password.toLocaleLowerCase("en-US") : null;
}

function configuredSecret(): string | null {
  return process.env.TKOS_ACCESS_SECRET?.trim() || null;
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isAccessConfigured(): boolean {
  return Boolean(configuredPassword() && configuredSecret());
}

export function isPasswordAccepted(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;

  const expected = configuredPassword();
  if (!expected) return false;

  return sameText(candidate.trim().toLocaleLowerCase("en-US"), expected);
}

export function accessCookieValue(): string | null {
  const password = configuredPassword();
  const secret = configuredSecret();
  if (!password || !secret) return null;

  return createHmac("sha256", secret)
    .update(`tkos-demo-access-v1:${password}`)
    .digest("base64url");
}

export function isAccessCookieValid(candidate: string | undefined): boolean {
  if (!candidate) return false;

  const expected = accessCookieValue();
  return expected ? sameText(candidate, expected) : false;
}

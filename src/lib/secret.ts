import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server's secret for signing cookies and sealing tokens at rest.
 * AUTH_SECRET when set; otherwise derived from the OAuth client secret, which
 * every deployment has and which never reaches the browser.
 */
function serverSecret(): string {
  const s = process.env.AUTH_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!s) throw new Error("AUTH_SECRET or GOOGLE_CLIENT_SECRET must be set");
  return s;
}

function keyFor(purpose: string): Buffer {
  return createHmac("sha256", serverSecret()).update(purpose).digest();
}

/** `value.signature`: tamper-evident but readable */
export function sign(value: string, purpose = "cookie"): string {
  const mac = createHmac("sha256", keyFor(purpose)).update(value).digest("base64url");
  return `${value}.${mac}`;
}

/** The value if the signature checks out, else null */
export function verifySigned(signed: string | undefined, purpose = "cookie"): string | null {
  if (!signed) return null;
  const at = signed.lastIndexOf(".");
  if (at <= 0) return null;
  const value = signed.slice(0, at);
  const expected = sign(value, purpose);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

/** Constant-time equality for secrets from headers */
export function secretEquals(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A random token for OAuth state and the like */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** The shared secret the server uses to call its own worker endpoint without a queue */
export function internalToken(): string {
  return createHmac("sha256", keyFor("internal")).update("process").digest("base64url");
}

const SEAL_PREFIX = "v1.";

/** AES-256-GCM: for Google tokens kept in job records */
export function seal(plain: string): string {
  if (!plain) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor("seal"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The plain value; a value that was never sealed comes back as is */
export function unseal(stored: string): string {
  if (!stored || !stored.startsWith(SEAL_PREFIX)) return stored;
  try {
    const buf = Buffer.from(stored.slice(SEAL_PREFIX.length), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyFor("seal"), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

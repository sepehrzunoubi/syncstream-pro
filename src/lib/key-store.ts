import { Redis } from "@upstash/redis";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LicenseKey {
  key: string;
  boundToGoogleId: string | null;
  boundToEmail: string | null;
  boundAt: number | null;
  resetUsed: boolean;
}

export interface UserKeyBinding {
  key: string;
  googleId: string;
  email: string;
  boundAt: number;
  resetUsed: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const KEY_PREFIX = "licensekey:";
const BINDING_PREFIX = "keybinding:";
const RATE_LIMIT_PREFIX = "keyrl:";

// Rate limit: max 5 attempts per 10 minutes per Google account
const RATE_LIMIT_WINDOW = 600;
const RATE_LIMIT_MAX = 5;

// ── 10 Pre-generated License Keys ──────────────────────────────────────────

export const VALID_KEYS = [
  "SYNCLIFETIME-8X4K2-NV7PQ-R3M9W",
  "SYNCLIFETIME-F6J1D-HT5YA-B8C3E",
  "SYNCLIFETIME-Q9W2Z-LP4MX-K7G6N",
  "SYNCLIFETIME-A5R8V-DC1UF-Y2S7J",
  "SYNCLIFETIME-M3E6T-WB9HK-P4L1X",
  "SYNCLIFETIME-V7N4G-JS2QC-F8D5A",
  "SYNCLIFETIME-H1Y9M-XK6RW-T3P7B",
  "SYNCLIFETIME-C4L2E-NF8VA-D6J9Q",
  "SYNCLIFETIME-W5T7K-QG3BN-M1X4H",
  "SYNCLIFETIME-Z8P6J-AY9DC-R2F5L",
];

// ── Redis helpers ──────────────────────────────────────────────────────────

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// Fallback in-memory store for local dev without Redis
const localKeys = new Map<string, LicenseKey>();
const localBindings = new Map<string, UserKeyBinding>();
const localRateLimits = new Map<string, { count: number; resetAt: number }>();

// ── Key operations ─────────────────────────────────────────────────────────

export async function getLicenseKey(key: string): Promise<LicenseKey | null> {
  const normalized = key.trim().toUpperCase();
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<LicenseKey>(`${KEY_PREFIX}${normalized}`);
    return data ?? null;
  }
  return localKeys.get(normalized) ?? null;
}

export async function setLicenseKey(licenseKey: LicenseKey): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_PREFIX}${licenseKey.key}`, licenseKey);
  } else {
    localKeys.set(licenseKey.key, licenseKey);
  }
}

export async function getUserBinding(googleId: string): Promise<UserKeyBinding | null> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<UserKeyBinding>(`${BINDING_PREFIX}${googleId}`);
    return data ?? null;
  }
  return localBindings.get(googleId) ?? null;
}

export async function setUserBinding(binding: UserKeyBinding): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${BINDING_PREFIX}${binding.googleId}`, binding);
  } else {
    localBindings.set(binding.googleId, binding);
  }
}

export async function deleteUserBinding(googleId: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.del(`${BINDING_PREFIX}${googleId}`);
  } else {
    localBindings.delete(googleId);
  }
}

// ── Rate limiting ──────────────────────────────────────────────────────────

export async function checkRateLimit(googleId: string): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  const rlKey = `${RATE_LIMIT_PREFIX}${googleId}`;

  if (redis) {
    const current = await redis.incr(rlKey);
    if (current === 1) {
      await redis.expire(rlKey, RATE_LIMIT_WINDOW);
    }
    const remaining = Math.max(0, RATE_LIMIT_MAX - current);
    return { allowed: current <= RATE_LIMIT_MAX, remaining };
  }

  // Local fallback
  const now = Date.now();
  const entry = localRateLimits.get(googleId);
  if (!entry || now > entry.resetAt) {
    localRateLimits.set(googleId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW * 1000 });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  return { allowed: entry.count <= RATE_LIMIT_MAX, remaining };
}

// ── Seed keys ──────────────────────────────────────────────────────────────
// Called on first API access to ensure all keys exist in storage

let seeded = false;

export async function seedKeysIfNeeded(): Promise<void> {
  if (seeded) return;

  const redis = getRedis();
  for (const key of VALID_KEYS) {
    if (redis) {
      const exists = await redis.exists(`${KEY_PREFIX}${key}`);
      if (!exists) {
        await redis.set(`${KEY_PREFIX}${key}`, {
          key,
          boundToGoogleId: null,
          boundToEmail: null,
          boundAt: null,
          resetUsed: false,
        } satisfies LicenseKey);
      }
    } else {
      if (!localKeys.has(key)) {
        localKeys.set(key, {
          key,
          boundToGoogleId: null,
          boundToEmail: null,
          boundAt: null,
          resetUsed: false,
        });
      }
    }
  }
  seeded = true;
}

// ── Core business logic ────────────────────────────────────────────────────

export async function redeemKey(
  inputKey: string,
  googleId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  await seedKeysIfNeeded();

  const normalized = inputKey.trim().toUpperCase();

  // Validate key format
  if (!VALID_KEYS.includes(normalized)) {
    return { success: false, error: "Invalid license key." };
  }

  // Check if user already has a binding
  const existingBinding = await getUserBinding(googleId);
  if (existingBinding) {
    return { success: false, error: "This Google account already has a key bound to it." };
  }

  // Check if key is already bound to someone else
  const licenseKey = await getLicenseKey(normalized);
  if (!licenseKey) {
    return { success: false, error: "Invalid license key." };
  }

  if (licenseKey.boundToGoogleId && licenseKey.boundToGoogleId !== googleId) {
    return { success: false, error: "This key is already bound to another account." };
  }

  // Bind the key
  const now = Date.now();
  const updatedKey: LicenseKey = {
    ...licenseKey,
    boundToGoogleId: googleId,
    boundToEmail: email,
    boundAt: now,
  };

  const binding: UserKeyBinding = {
    key: normalized,
    googleId,
    email,
    boundAt: now,
    resetUsed: false,
  };

  await setLicenseKey(updatedKey);
  await setUserBinding(binding);

  return { success: true };
}

export async function resetKey(
  googleId: string
): Promise<{ success: boolean; key?: string; error?: string }> {
  await seedKeysIfNeeded();

  const binding = await getUserBinding(googleId);
  if (!binding) {
    return { success: false, error: "No key bound to this account." };
  }

  // Check both the binding AND the license key itself for reset history
  // This prevents a new owner from resetting a key that was already reset by a previous owner
  const licenseKey = await getLicenseKey(binding.key);

  if (binding.resetUsed || licenseKey?.resetUsed) {
    return { success: false, error: "Key reset has already been used. This is a one-time feature." };
  }

  // Unbind the key from the user
  if (licenseKey) {
    const updatedKey: LicenseKey = {
      ...licenseKey,
      boundToGoogleId: null,
      boundToEmail: null,
      boundAt: null,
      resetUsed: true,
    };
    await setLicenseKey(updatedKey);
  }

  // We delete the user binding so they're no longer authorized
  await deleteUserBinding(googleId);

  // But we need to track that this KEY has been reset once
  // We already updated the LicenseKey.resetUsed = true above
  // Also store a reset marker so the key remembers its reset history
  if (licenseKey) {
    const redis = getRedis();
    if (redis) {
      await redis.set(`keyresetmarker:${binding.key}`, { resetUsed: true, previousGoogleId: googleId });
    }
  }

  return { success: true, key: binding.key };
}

export async function hasKeyResetBeenUsed(key: string): Promise<boolean> {
  const normalized = key.trim().toUpperCase();
  const licenseKey = await getLicenseKey(normalized);
  return licenseKey?.resetUsed ?? false;
}

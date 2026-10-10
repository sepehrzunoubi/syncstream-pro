/**
 * A tiny .env loader (no dependency): KEY=VALUE lines, # comments, optional
 * quotes. Values already in the environment win, as with dotenv.
 */

import fs from "node:fs";
import path from "node:path";

export function parseEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2].replace(/\\n/g, "\n");
    else {
      // An unquoted value ends at a comment
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Load `.env.local` (then `.env`) from `dir` into process.env without overriding what is set. Returns the files read. */
export function loadLocalEnv(dir = process.cwd()): string[] {
  const read: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) {
      if (process.env[k] == null) process.env[k] = v;
    }
    read.push(file);
  }
  return read;
}

/** The named variables, or the list of missing ones */
export function requireEnv(names: string[]): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) values[n] = v;
    else missing.push(n);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values };
}

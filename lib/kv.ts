import "server-only";

import { createClient, type VercelKV } from "@vercel/kv";
import { randomBytes } from "node:crypto";

import { CANDIDATES_CACHE_TTL_SEC } from "./constants";
import { env } from "./env";
import type { AssignmentRecord, Candidate } from "./types";

// ---------- client (lazy) ----------

let _client: VercelKV | null = null;

function getClient(): VercelKV {
  if (_client) return _client;
  _client = createClient({
    url: env.KV_REST_API_URL,
    token: env.KV_REST_API_TOKEN,
  });
  return _client;
}

/**
 * Bare client accessor. Prefer the helpers below.
 * Wrapped in a Proxy so module load never instantiates the client.
 */
export const kv: VercelKV = new Proxy({} as VercelKV, {
  get(_target, prop) {
    const client = getClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    return client[prop];
  },
}) as VercelKV;

// ---------- key builders ----------

const assignmentKey = (shortcode: string) => `assignment:${shortcode}`;
const idempotencyKey = (a: number, b: number) => `idempotency:${a}:${b}`;
const candidatesCacheKey = (fid: number) => `candidates:cache:${fid}`;

// ---------- assignments ----------

export async function getAssignment(
  shortcode: string,
): Promise<AssignmentRecord | null> {
  const raw = await getClient().get<string | AssignmentRecord>(
    assignmentKey(shortcode),
  );
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as AssignmentRecord;
  } catch (err) {
    console.warn(
      `[kv] failed to parse assignment ${shortcode}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function setAssignment(record: AssignmentRecord): Promise<void> {
  await getClient().set(
    assignmentKey(record.shortcode),
    JSON.stringify(record),
  );
}

export async function updateAssignment(
  shortcode: string,
  patch: Partial<AssignmentRecord>,
): Promise<void> {
  const existing = await getAssignment(shortcode);
  if (!existing) return;
  await setAssignment({ ...existing, ...patch });
}

// ---------- idempotency ----------

export async function getIdempotentShortcode(
  inviterFid: number,
  inviteeFid: number,
): Promise<string | null> {
  return getClient().get<string>(idempotencyKey(inviterFid, inviteeFid));
}

export async function setIdempotentShortcode(
  inviterFid: number,
  inviteeFid: number,
  shortcode: string,
): Promise<void> {
  await getClient().set(idempotencyKey(inviterFid, inviteeFid), shortcode);
}

// ---------- candidate cache ----------

export async function getCachedCandidates(
  fid: number,
): Promise<Candidate[] | null> {
  const raw = await getClient().get<string | Candidate[]>(
    candidatesCacheKey(fid),
  );
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw) as Candidate[];
  } catch (err) {
    console.warn(
      `[kv] failed to parse cached candidates for ${fid}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function setCachedCandidates(
  fid: number,
  c: Candidate[],
): Promise<void> {
  await getClient().set(candidatesCacheKey(fid), JSON.stringify(c), {
    ex: CANDIDATES_CACHE_TTL_SEC,
  });
}

// ---------- shortcode generation ----------

/**
 * 8-char urlsafe shortcode (6 random bytes base64url-encoded → 8 chars).
 * Prefers `node:crypto.randomBytes` and falls back to Web Crypto for edge
 * runtimes that don't expose Node's crypto module.
 */
export function newShortcode(): string {
  try {
    return randomBytes(6).toString("base64url");
  } catch {
    const arr = new Uint8Array(6);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).crypto.getRandomValues(arr);
    let bin = "";
    for (const b of arr) bin += String.fromCharCode(b);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b64 = (globalThis as any).btoa(bin) as string;
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

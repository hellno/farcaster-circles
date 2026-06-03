// NOTE: do NOT add `import "server-only"` here.
// This module is PURE CHAIN (it imports only safe.ts + invite.ts, neither of
// which is server-only) so the tsx scripts that already pull invite.ts in plain
// Node can reuse it. `server-only` would throw there.

import type { Address } from "viem";

import { predictUserSafe } from "@/lib/circles/safe";
import { getHubStatus } from "@/lib/circles/invite";

/**
 * Positive-only memo of "this Safe is a registered Circles human" (D7).
 * Keyed on the lowercased `safeAddress` — NEVER on fid (the same Safe is reached
 * from many candidate owner sets). Negatives are never stored, so a not-yet-human
 * Safe is re-read each time and a later registration is picked up. Monotonic
 * (a registered human can't un-register), so no TTL.
 */
export interface HumanCache {
  get(safe: Address): boolean;
  set(safe: Address): void;
}

const _humans = new Set<string>();

/** Process-lifetime positive-only cache backing `findRegisteredSafe`. */
export const defaultHumanCache: HumanCache = {
  get: (safe) => _humans.has(safe.toLowerCase()),
  set: (safe) => {
    _humans.add(safe.toLowerCase());
  },
};

/**
 * Given realistic owner-set shapes for one user (D2 bounded enumeration), find
 * the first that predicts to an already-registered Circles human Safe.
 *
 * Walks `candidates` SEQUENTIALLY and early-exits at the first hit so the common
 * case (candidate[0] is the user's real Safe) costs exactly one `predictUserSafe`
 * + one `getHubStatus`. A cached safe skips the `getHubStatus` read entirely.
 * Errors from the chain layer PROPAGATE — the caller decides whether to fail-open.
 *
 * Returns the matched `safeAddress` AND the `owners` set that produced it (a
 * deterministic CREATE2 prediction, so these are the registered Safe's actual
 * owners) — callers report the matched set, not the one they happened to try.
 */
export async function findRegisteredSafe(
  candidates: Address[][],
  cache: HumanCache = defaultHumanCache,
): Promise<{ safeAddress: Address; owners: Address[] } | null> {
  for (const cand of candidates) {
    const { safeAddress } = await predictUserSafe(cand);

    // Cached entries are always confirmed humans — skip the read.
    if (cache.get(safeAddress)) {
      return { safeAddress, owners: cand };
    }

    const { isHuman } = await getHubStatus(safeAddress);
    if (isHuman) {
      cache.set(safeAddress); // write-on-true ONLY; never cache a negative
      return { safeAddress, owners: cand };
    }
  }

  return null;
}

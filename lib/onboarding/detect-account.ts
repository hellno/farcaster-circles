// [server · fid layer] Returning-user detection (issue #6). Lives in the FID
// layer so it MAY import Farcaster identity helpers + name resolution; the pure
// chain probe (`findRegisteredSafe`) stays in `lib/circles/*`. `server-only`
// because it pulls server-only modules (neynar, names, profile).
import "server-only";

import Safe from "@safe-global/protocol-kit";
import type { Address } from "viem";

import { env } from "@/lib/env";
import { normalizeOwners } from "@/lib/circles/safe";
import { findRegisteredSafe } from "@/lib/circles/account-status";
import { readMetadataDigest, isDigestSet } from "@/lib/circles/profile";
import { fetchVerifiedEthAddresses } from "@/lib/farcaster/neynar";
import { resolveNames, recommendedSigners } from "@/lib/names";
import type { AccountStatus } from "@/lib/types";

/**
 * Cap the verified-address fan-out (Codex #10): an fid with a huge verified set
 * would blow up the C3 "all verified" candidate (one `predictUserSafe` over a
 * large owner set). Above this we skip C3 ONLY — C1 (connected + recommended)
 * and C2 (connected only) still cover the realistic cases. Name resolution is
 * deliberately NOT capped (see `detectAccount`): it must mirror the uncapped
 * onboard signer picker so detection reconstructs the same C1 the user's Safe
 * was actually created with.
 */
export const MAX_VERIFIED_FANOUT = 10;

/**
 * PURE — no I/O. Build the bounded candidate owner sets the chain layer will
 * probe (D2). Each set is `normalizeOwners`-shaped (sorted, lowercase-deduped),
 * so two sets are element-equal iff their `join(",")` matches.
 *
 * - C1 = connected + recommended  ← default / common case (probe first)
 * - C2 = connected only           ← drift: names dropped
 * - C3 = connected + all verified  ← drift: extra verified added (SKIPPED past
 *                                    MAX_VERIFIED_FANOUT, the overflow guard)
 *
 * Always returns at least C2 (the connected wallet alone is always valid).
 * Element-equal candidates collapse, preserving order C1, C2, C3.
 */
export function buildCandidateOwnerSets(
  connectedAddress: string,
  verified: string[],
  recommended: string[],
): Address[][] {
  const c1 = normalizeOwners([connectedAddress, ...recommended]);
  const c2 = normalizeOwners([connectedAddress]);

  const candidates: Address[][] = [c1, c2];
  // Skip the all-verified candidate when the verified set is too large.
  if (verified.length <= MAX_VERIFIED_FANOUT) {
    candidates.push(normalizeOwners([connectedAddress, ...verified]));
  }

  // Collapse element-equal candidates (preserve first-seen order).
  const seen = new Set<string>();
  const deduped: Address[][] = [];
  for (const cand of candidates) {
    const key = cand.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cand);
  }
  return deduped;
}

/**
 * Detect whether `fid` already has a registered Circles Safe reachable from the
 * connected wallet (issue #6). Resilient by design: the route (T4) wraps this
 * and fail-opens, but each best-effort read (verified set, names, digest, owners)
 * is independently guarded here so a single read failure degrades gracefully
 * rather than killing detection. `findRegisteredSafe` errors PROPAGATE — the
 * route decides whether to fail-open.
 */
export async function detectAccount(
  fid: number,
  connectedAddress: string,
): Promise<AccountStatus> {
  // 1. Verified set — fail-soft to [] (fetchVerifiedEthAddresses CAN throw).
  let verified: string[] = [];
  try {
    verified = await fetchVerifiedEthAddresses(fid);
  } catch {
    verified = [];
  }

  // 2. Recommended signers. Resolve names over the FULL verified set, exactly
  // like the onboard signer picker (`/api/verified-addresses`, uncapped): the
  // Safe a returning user actually created has C1 = connected + recommended built
  // from that same uncapped set, so detection MUST reconstruct it the same way or
  // an over-cap user (>10 verified, one named) is never matched and wrongly lands
  // on Create. The fan-out cap (Codex #10) applies only to the C3 all-verified
  // *candidate* (handled in buildCandidateOwnerSets), not to name resolution
  // (which fans out concurrently; the route bounds total latency with a timeout).
  let recommended: string[] = [];
  try {
    const names = await resolveNames(verified);
    recommended = recommendedSigners(verified, names);
  } catch {
    recommended = [];
  }

  // 3. + 4. Build bounded candidates and let the chain pick the first hit.
  const candidates = buildCandidateOwnerSets(
    connectedAddress,
    verified,
    recommended,
  );
  const hit = await findRegisteredSafe(candidates);
  if (!hit) return { found: false };

  // 5. profileSet — null-safe (Codex #6): digest read failure keeps found:true.
  let profileSet: boolean | null;
  try {
    profileSet = isDigestSet(await readMetadataDigest(hit.safeAddress));
  } catch {
    profileSet = null;
  }

  // 6. ownerMatch (Codex #7): is the connected wallet still an on-chain owner?
  let ownerMatch = false;
  try {
    const kit = await Safe.init({
      provider: env.GNOSIS_RPC_URL,
      safeAddress: hit.safeAddress,
    });
    const owners = (await kit.getOwners()).map((o) => o.toLowerCase());
    ownerMatch = owners.includes(connectedAddress.toLowerCase());
  } catch {
    ownerMatch = false;
  }

  return { found: true, safeAddress: hit.safeAddress, profileSet, ownerMatch };
}

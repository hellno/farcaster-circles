import "server-only";

import { FARCASTER_HUB_URL } from "./constants";
import { fetchVerifiedEthAddresses } from "./neynar";
import type { SpamSignals } from "./types";

// ---------- power badge (Warpcast's free, keyless anti-spam allowlist) ----------

const POWER_BADGE_URL = "https://api.warpcast.com/v2/power-badge-users";
const POWER_BADGE_TTL_MS = 30 * 60 * 1000; // 30 min

interface PowerBadgeCache {
  fids: Set<number>;
  at: number;
}
let powerBadgeCache: PowerBadgeCache | null = null;

/**
 * Whether the fid holds a Warpcast "power badge" — Warpcast's own curated
 * spam-resistance signal. Free + keyless; the full fid list is fetched once and
 * cached in-process for 30 min. Returns null if the list can't be fetched.
 */
export async function hasPowerBadge(fid: number): Promise<boolean | null> {
  try {
    const fresh =
      powerBadgeCache && Date.now() - powerBadgeCache.at < POWER_BADGE_TTL_MS;
    if (!fresh) {
      const res = await fetch(POWER_BADGE_URL, {
        headers: { accept: "application/json" },
        cache: "no-store",
        next: { revalidate: 0 },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: { fids?: number[] } };
      const fids = json.result?.fids ?? [];
      powerBadgeCache = { fids: new Set(fids), at: Date.now() };
    }
    return powerBadgeCache!.fids.has(fid);
  } catch {
    return null;
  }
}

// ---------- follow graph (free, keyless hub) ----------

/**
 * Whether `fid` currently follows `targetFid`, via the hub's linkById. A present
 * MESSAGE_TYPE_LINK_ADD = following; 404 = not following; null = lookup failed.
 */
export async function isFollowing(
  fid: number,
  targetFid: number,
): Promise<boolean | null> {
  try {
    const res = await fetch(
      `${FARCASTER_HUB_URL}/v1/linkById?fid=${fid}&target_fid=${targetFid}&link_type=follow`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
        next: { revalidate: 0 },
      },
    );
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { type?: string } };
    return json.data?.type === "MESSAGE_TYPE_LINK_ADD";
  } catch {
    return null;
  }
}

/**
 * The follow relationship between a viewer (e.g. the app operator) and a user,
 * both directions, plus the mutual flag. Fields are null when a lookup fails.
 */
export async function getFollowRelation(
  viewerFid: number,
  userFid: number,
): Promise<{
  viewerFollowsUser: boolean | null;
  userFollowsViewer: boolean | null;
  mutual: boolean | null;
}> {
  const [viewerFollowsUser, userFollowsViewer] = await Promise.all([
    isFollowing(viewerFid, userFid),
    isFollowing(userFid, viewerFid),
  ]);
  const mutual =
    viewerFollowsUser != null && userFollowsViewer != null
      ? viewerFollowsUser && userFollowsViewer
      : null;
  return { viewerFollowsUser, userFollowsViewer, mutual };
}

// ---------- combined signals ----------

/**
 * Collect all free/keyless anti-spam signals for an onboarding user. No Neynar,
 * no quota, no chain writes. `viewerFid` (the operator's fid) enables the
 * mutual-follow signals; omit it and those stay null. `allowlist` is a set of
 * fids that always pass the gate.
 *
 * Special-cases: the operator themselves (fid === viewerFid) and any allowlisted
 * fid are treated as mutual (you can't follow yourself, so without this the
 * operator would be gated out of their own app).
 */
export async function getSpamSignals(
  fid: number,
  viewerFid?: number,
  allowlist?: number[],
): Promise<SpamSignals> {
  const isOperator = viewerFid != null && fid === viewerFid;
  const allowlisted = (allowlist ?? []).includes(fid);
  const bypass = isOperator || allowlisted;

  const [powerBadge, relation, verified] = await Promise.all([
    hasPowerBadge(fid),
    viewerFid && !bypass
      ? getFollowRelation(viewerFid, fid)
      : Promise.resolve({
          viewerFollowsUser: null,
          userFollowsViewer: null,
          mutual: null,
        }),
    fetchVerifiedEthAddresses(fid).catch(() => []),
  ]);

  return {
    fid,
    isOperator,
    allowlisted,
    powerBadge,
    operatorFollowsUser: relation.viewerFollowsUser,
    userFollowsOperator: relation.userFollowsViewer,
    // Operator / allowlisted are trivially trusted -> count as mutual.
    mutualWithOperator: bypass ? true : relation.mutual,
    verifiedAddressCount: verified.length,
  };
}

// ---------- gate policy ----------

export type GatePolicy =
  | "off"
  | "powerBadge"
  | "mutual"
  | "powerBadgeOrMutual"
  | "powerBadgeAndMutual";

/**
 * Evaluate a gate policy against a user's signals. Returns whether onboarding is
 * allowed plus a human reason. `null` signals are treated as "not satisfied" for
 * that condition (fail-closed on the specific check), EXCEPT policy "off" which
 * always allows.
 */
export function evaluateGate(
  policy: GatePolicy,
  signals: SpamSignals,
): { allowed: boolean; reason: string } {
  // Operator + allowlisted fids always pass, whatever the policy.
  if (signals.isOperator) return { allowed: true, reason: "operator" };
  if (signals.allowlisted) return { allowed: true, reason: "allowlisted fid" };

  const pb = signals.powerBadge === true;
  const mut = signals.mutualWithOperator === true;

  switch (policy) {
    case "off":
      return { allowed: true, reason: "gate off" };
    case "powerBadge":
      return pb
        ? { allowed: true, reason: "has power badge" }
        : { allowed: false, reason: "no power badge" };
    case "mutual":
      return mut
        ? { allowed: true, reason: "mutual follow with operator" }
        : { allowed: false, reason: "not a mutual follow with operator" };
    case "powerBadgeOrMutual":
      return pb || mut
        ? {
            allowed: true,
            reason: pb ? "has power badge" : "mutual follow with operator",
          }
        : { allowed: false, reason: "no power badge and not a mutual follow" };
    case "powerBadgeAndMutual":
      return pb && mut
        ? { allowed: true, reason: "power badge AND mutual follow" }
        : {
            allowed: false,
            reason: `requires power badge (${pb}) AND mutual follow (${mut})`,
          };
    default:
      return { allowed: true, reason: "unknown policy — allowing" };
  }
}

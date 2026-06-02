import "server-only";

import { getAddress, type Address } from "viem";

import { FARCASTER_HUB_URL, NEYNAR_BASE_URL } from "./constants";
import { env } from "../env";
import type { NeynarProfile, UserSummary } from "../types";

// ---------- shape definitions ----------

interface NeynarViewerContext {
  following?: boolean; // viewer follows this user
  followed_by?: boolean; // this user follows the viewer
}

interface NeynarExperimental {
  neynar_user_score?: number;
}

interface NeynarUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  custody_address?: string;
  score?: number;
  user_score?: number;
  experimental?: NeynarExperimental;
  viewer_context?: NeynarViewerContext;
  verified_addresses?: { eth_addresses?: string[] };
}

interface NeynarBulkUsersResponse {
  users?: NeynarUser[];
}

// ---------- fetch helper ----------

async function neynarFetch(path: string): Promise<unknown> {
  const url = `${NEYNAR_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": env.NEYNAR_API_KEY,
      "x-neynar-experimental": "true",
    },
    cache: "no-store",
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Neynar ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------- free Farcaster hub (keyless) ----------

interface HubVerificationMessage {
  data?: {
    verificationAddAddressBody?: {
      address?: string;
      protocol?: string | number;
    };
  };
}

interface HubVerificationsResponse {
  messages?: HubVerificationMessage[];
}

/**
 * Verified ETH addresses for an fid from the free, keyless Farcaster hub.
 * Throws on HTTP error so the caller can fall back to Neynar. Skips Solana
 * verifications; `PROTOCOL_ETHEREUM` (or legacy numeric 0 / missing) = ETH.
 */
async function fetchVerifiedEthAddressesFromHub(
  fid: number,
): Promise<Address[]> {
  const res = await fetch(
    `${FARCASTER_HUB_URL}/v1/verificationsByFid?fid=${fid}`,
    {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      next: { revalidate: 0 },
    },
  );
  if (!res.ok) throw new Error(`Hub ${res.status}`);
  const json = (await res.json()) as HubVerificationsResponse;
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const m of json.messages ?? []) {
    const body = m.data?.verificationAddAddressBody;
    const addr = body?.address;
    const proto = body?.protocol;
    const isEth =
      proto === "PROTOCOL_ETHEREUM" || proto === 0 || proto == null;
    if (!isEth || !addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    const checksummed = getAddress(addr);
    const key = checksummed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checksummed);
  }
  return out;
}

// ---------- public API ----------

/**
 * Rich profile for debugging/context: Neynar score, verified + custody
 * addresses, and (when `viewerFid` is given) the follow relationship between
 * that viewer (e.g. the app operator) and this user.
 */
export async function fetchUserProfile(
  fid: number,
  viewerFid?: number,
): Promise<NeynarProfile | null> {
  const viewerQuery = viewerFid ? `&viewer_fid=${viewerFid}` : "";
  let json: NeynarBulkUsersResponse;
  try {
    json = (await neynarFetch(
      `/v2/farcaster/user/bulk?fids=${fid}${viewerQuery}`,
    )) as NeynarBulkUsersResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Neynar 404")) return null;
    throw err;
  }
  const u = json.users?.[0];
  if (!u || typeof u.fid !== "number") return null;

  const rawScore =
    u.experimental?.neynar_user_score ?? u.score ?? u.user_score ?? null;
  const neynarScore =
    typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;

  const verifiedEthAddresses: string[] = [];
  for (const addr of u.verified_addresses?.eth_addresses ?? []) {
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      verifiedEthAddresses.push(getAddress(addr));
    }
  }

  let viewer: NeynarProfile["viewer"] = null;
  if (viewerFid) {
    const viewerFollowsUser = u.viewer_context?.following ?? null;
    const userFollowsViewer = u.viewer_context?.followed_by ?? null;
    viewer = {
      viewerFid,
      viewerFollowsUser,
      userFollowsViewer,
      mutual:
        viewerFollowsUser != null && userFollowsViewer != null
          ? viewerFollowsUser && userFollowsViewer
          : null,
    };
  }

  return {
    fid: u.fid,
    username: u.username ?? "",
    displayName: u.display_name ?? u.username ?? "",
    pfpUrl: u.pfp_url ?? "",
    neynarScore,
    custodyAddress: u.custody_address
      ? getAddress(u.custody_address)
      : null,
    verifiedEthAddresses,
    viewer,
    raw: u as unknown as Record<string, unknown>,
  };
}

// ---------- display card (pfp + name), hub-first ----------

/** Minimal profile fields the OG share cards render. */
export interface FarcasterCard {
  username: string;
  displayName: string;
  pfpUrl: string;
}

interface HubUserDataMessage {
  data?: {
    userDataBody?: {
      type?: string;
      value?: string;
    };
  };
}

interface HubUserDataResponse {
  messages?: HubUserDataMessage[];
}

/**
 * An fid's display card (pfp / display name / username) from the free, keyless
 * hub via userDataByFid. Throws on HTTP error so the caller can fall back to
 * Neynar. Returns null only when the hub responds but carries no usable fields.
 */
async function fetchFarcasterCardFromHub(
  fid: number,
): Promise<FarcasterCard | null> {
  const res = await fetch(`${FARCASTER_HUB_URL}/v1/userDataByFid?fid=${fid}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`Hub ${res.status}`);
  const json = (await res.json()) as HubUserDataResponse;
  let username = "";
  let displayName = "";
  let pfpUrl = "";
  for (const m of json.messages ?? []) {
    const body = m.data?.userDataBody;
    const value = body?.value ?? "";
    switch (body?.type) {
      case "USER_DATA_TYPE_USERNAME":
        username = value;
        break;
      case "USER_DATA_TYPE_DISPLAY":
        displayName = value;
        break;
      case "USER_DATA_TYPE_PFP":
        pfpUrl = value;
        break;
    }
  }
  if (!username && !displayName && !pfpUrl) return null;
  return { username, displayName: displayName || username, pfpUrl };
}

/**
 * An fid's display card for the share OG image. Tries the free keyless hub
 * first (no Neynar plan needed — same hub-first pattern as
 * `fetchVerifiedEthAddresses`), then falls back to Neynar. Returns null if both
 * fail, so the caller can render a name/pfp-less fallback.
 */
export async function fetchFarcasterCard(
  fid: number,
): Promise<FarcasterCard | null> {
  try {
    const fromHub = await fetchFarcasterCardFromHub(fid);
    if (fromHub) return fromHub;
  } catch (hubErr) {
    console.warn(
      `[neynar] hub userData failed for fid=${fid}, falling back to Neynar:`,
      hubErr instanceof Error ? hubErr.message : hubErr,
    );
  }
  const summary = await fetchUserByFid(fid).catch(() => null);
  if (!summary) return null;
  return {
    username: summary.username,
    displayName: summary.displayName,
    pfpUrl: summary.pfpUrl,
  };
}

export async function fetchUserByFid(
  fid: number,
): Promise<UserSummary | null> {
  let json: NeynarBulkUsersResponse;
  try {
    json = (await neynarFetch(
      `/v2/farcaster/user/bulk?fids=${fid}`,
    )) as NeynarBulkUsersResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Neynar 404")) return null;
    throw err;
  }
  const u = json.users?.[0];
  if (!u || typeof u.fid !== "number") return null;
  return {
    fid: u.fid,
    username: u.username ?? "",
    displayName: u.display_name ?? u.username ?? "",
    pfpUrl: u.pfp_url ?? "",
  };
}

/**
 * An fid's verified ETH addresses, used as additional owners of the user's
 * Safe. Tries the free keyless Farcaster hub first (no Neynar plan needed),
 * then falls back to Neynar if the hub is unavailable. Returns [] if both fail
 * or the fid has no ETH verifications — onboarding then uses only the connected
 * wallet address, which is acceptable.
 */
export async function fetchVerifiedEthAddresses(
  fid: number,
): Promise<Address[]> {
  // Primary: free hub.
  try {
    const fromHub = await fetchVerifiedEthAddressesFromHub(fid);
    return fromHub;
  } catch (hubErr) {
    console.warn(
      `[neynar] hub verifications failed for fid=${fid}, falling back to Neynar:`,
      hubErr instanceof Error ? hubErr.message : hubErr,
    );
  }

  // Fallback: Neynar (may 402 if over plan limit — caller treats [] as "none").
  const json = (await neynarFetch(
    `/v2/farcaster/user/bulk?fids=${fid}`,
  )) as NeynarBulkUsersResponse;
  const ethAddresses = json.users?.[0]?.verified_addresses?.eth_addresses;
  if (!ethAddresses || ethAddresses.length === 0) {
    return [];
  }
  return ethAddresses.map((addr) => getAddress(addr));
}

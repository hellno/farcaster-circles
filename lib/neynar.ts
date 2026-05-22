import "server-only";

import { MIN_SCORE, NEYNAR_BASE_URL } from "./constants";
import { env } from "./env";
import type { Candidate, UserSummary } from "./types";

// ---------- shape definitions ----------

interface NeynarViewerContext {
  followed_by?: boolean;
  following?: boolean;
}

interface NeynarExperimental {
  neynar_user_score?: number;
}

interface NeynarUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  viewer_context?: NeynarViewerContext;
  experimental?: NeynarExperimental;
  score?: number;
  user_score?: number;
}

interface NeynarFollowingEntry {
  object?: string;
  user?: NeynarUser;
}

interface NeynarFollowingResponse {
  users?: NeynarFollowingEntry[];
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

// ---------- score extraction (defensive) ----------

function extractScore(u: NeynarUser): number {
  const s =
    u.experimental?.neynar_user_score ?? u.score ?? u.user_score ?? 0;
  return typeof s === "number" && Number.isFinite(s) ? s : 0;
}

function toCandidate(u: NeynarUser): Candidate | null {
  if (typeof u.fid !== "number") return null;
  const followedBy = u.viewer_context?.followed_by === true;
  if (!followedBy) return null;
  const score = extractScore(u);
  if (!(score > MIN_SCORE)) return null;
  return {
    fid: u.fid,
    username: u.username ?? "",
    displayName: u.display_name ?? u.username ?? "",
    pfpUrl: u.pfp_url ?? "",
    score,
    followedBy: true,
  };
}

// ---------- public API ----------

export async function fetchMutuals(fid: number): Promise<Candidate[]> {
  const json = (await neynarFetch(
    `/v2/farcaster/following?fid=${fid}&viewer_fid=${fid}&limit=150`,
  )) as NeynarFollowingResponse;

  const users = json.users ?? [];
  const candidates: Candidate[] = [];
  for (const entry of users) {
    const user = entry.user;
    if (!user) continue;
    const c = toCandidate(user);
    if (c) candidates.push(c);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 50);
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

import { NextResponse } from "next/server";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { env } from "@/lib/env";
import { getSpamSignals } from "@/lib/farcaster/gating-signals";
import { evaluateGate, type GatePolicy } from "@/lib/farcaster/gating-policy";
import { fetchUserProfile } from "@/lib/farcaster/neynar";
import type {
  DebugMeErrorResponse,
  DebugMeResponse,
  SpamSignals,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True if NEYNAR_API_KEY is set, without throwing or exposing the value. */
function neynarKeyConfigured(): boolean {
  try {
    return env.NEYNAR_API_KEY.length > 0;
  } catch {
    return false;
  }
}

/**
 * Quick Auth probe. Proves the bearer token resolves to a verified fid and
 * returns the Neynar profile (score + follow relationship) we have for them.
 * Spends no quota, touches no chain — safe to call freely while debugging.
 */
export async function GET(request: Request) {
  try {
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      return NextResponse.json<DebugMeErrorResponse>(
        { error: "unauthorized", message: "missing or invalid Quick Auth token" },
        { status: 401 },
      );
    }

    const viewerFid = env.DEBUG_VIEWER_FID;
    const keyConfigured = neynarKeyConfigured();

    let profile = null;
    let profileError: string | null = null;
    if (!keyConfigured) {
      profileError = "NEYNAR_API_KEY is not set — cannot fetch score/profile";
    } else {
      try {
        profile = await fetchUserProfile(auth.fid, viewerFid);
        if (!profile) profileError = `Neynar returned no user for fid ${auth.fid}`;
      } catch (err) {
        profileError = errorMessage(err);
        console.error(
          `[debug/me] fetchUserProfile failed for fid=${auth.fid}:`,
          profileError,
        );
      }
    }

    // Free/keyless anti-spam signals + how the current gate policy would judge.
    let signals: SpamSignals | null = null;
    let gate: DebugMeResponse["gate"] = null;
    try {
      signals = await getSpamSignals(
        auth.fid,
        viewerFid,
        env.ONBOARD_ALLOWLIST_FIDS,
      );
      const policy = env.ONBOARD_GATE;
      gate = { policy, ...evaluateGate(policy as GatePolicy, signals) };
    } catch (err) {
      console.error(
        `[debug/me] signals failed for fid=${auth.fid}:`,
        errorMessage(err),
      );
    }

    return NextResponse.json<DebugMeResponse>(
      {
        verifiedFid: auth.fid,
        domain: env.FARCASTER_DOMAIN,
        profile,
        profileError,
        neynarKeyConfigured: keyConfigured,
        viewerFidConfigured: viewerFid ?? null,
        signals,
        gate,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json<DebugMeErrorResponse>(
      { error: "server_error", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

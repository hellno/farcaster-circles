import { NextResponse } from "next/server";

import { verifyQuickAuth } from "@/lib/auth";
import { fetchVerifiedEthAddresses } from "@/lib/neynar";
import type {
  VerifiedAddressesErrorResponse,
  VerifiedAddressesResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The caller's verified ETH addresses, for the onboarding signer picker.
 * Quick Auth'd so the fid is the verified caller. Uses the free Farcaster hub
 * (Neynar fallback inside fetchVerifiedEthAddresses). Returns [] (source:"none")
 * rather than erroring if lookups fail — the connected wallet alone is enough.
 * Spends no quota, touches no chain.
 */
export async function GET(request: Request) {
  try {
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      return NextResponse.json<VerifiedAddressesErrorResponse>(
        { error: "unauthorized", message: "missing or invalid Quick Auth token" },
        { status: 401 },
      );
    }

    let verifiedAddresses: string[] = [];
    try {
      verifiedAddresses = await fetchVerifiedEthAddresses(auth.fid);
    } catch (err) {
      console.error(
        `[verified-addresses] lookup failed for fid=${auth.fid}:`,
        errorMessage(err),
      );
    }
    // fetchVerifiedEthAddresses tries the free hub first, then Neynar. We can't
    // tell which succeeded from the return value, so report "hub" optimistically
    // when we got results; empty stays "none".
    const source: VerifiedAddressesResponse["source"] =
      verifiedAddresses.length > 0 ? "hub" : "none";

    return NextResponse.json<VerifiedAddressesResponse>(
      { verifiedAddresses, source },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json<VerifiedAddressesErrorResponse>(
      { error: "server_error", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

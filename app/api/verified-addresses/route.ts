import { NextResponse } from "next/server";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { fetchVerifiedEthAddresses } from "@/lib/farcaster/neynar";
import { recommendedSigners, resolveNames } from "@/lib/names";
import type {
  NameInfo,
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
 *
 * Also reverse-resolves each address to its ENS / basename and reports which
 * ones to recommend as default co-signers (those with a distinct name). Doing
 * this server-side keeps the default — and therefore the predicted Safe address
 * — independent of client-side name-resolution timing. Spends no quota, touches
 * no chain.
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

    // Reverse-resolve names (best-effort). On failure we return no names, so
    // nothing is recommended and the user opts addresses in manually — the safe
    // default (never silently add unnamed addresses as signers).
    let names: Record<string, NameInfo> = {};
    if (verifiedAddresses.length > 0) {
      try {
        names = await resolveNames(verifiedAddresses);
      } catch (err) {
        console.error(
          `[verified-addresses] name resolution failed for fid=${auth.fid}:`,
          errorMessage(err),
        );
      }
    }
    const recommended = recommendedSigners(verifiedAddresses, names);

    // fetchVerifiedEthAddresses tries the free hub first, then Neynar. We can't
    // tell which succeeded from the return value, so report "hub" optimistically
    // when we got results; empty stays "none".
    const source: VerifiedAddressesResponse["source"] =
      verifiedAddresses.length > 0 ? "hub" : "none";

    return NextResponse.json<VerifiedAddressesResponse>(
      { verifiedAddresses, names, recommended, source },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json<VerifiedAddressesErrorResponse>(
      { error: "server_error", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

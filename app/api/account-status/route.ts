import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { detectAccount } from "@/lib/onboarding/detect-account";
import type { AccountStatus, AccountStatusErrorResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  connectedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Bound total detection latency (Codex #10) so a slow/throttled Gnosis RPC can't
// hang the request up against maxDuration. On timeout the promise rejects and is
// caught below → fail-open 200 { found:false }, exactly like any other detection
// failure. Kept under maxDuration (30s) with headroom.
const DETECT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Read-only returning-user detector (issue #6, D3). Quick Auth'd; given the
 * connected wallet, reports whether the fid already has a registered Circles
 * Safe so the client can land on Manage instead of Create.
 *
 * OUT of the money path — it must NEVER gate onboarding (D4). Auth-null is a
 * clean 401 and a malformed body a clean 400, but ANY detection failure (or any
 * other unexpected throw) fails open SILENTLY to 200 { found:false }: the client
 * simply shows the Create flow, which self-heals. Detection spends no gas/quota.
 */
export async function POST(request: Request): Promise<Response> {
  const reqId = shortId();

  try {
    // 1. Quick Auth. A clean 401 (not a fail-open) — the early return lives
    // inside the try so a re-thrown non-token auth error still fails open below.
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      return NextResponse.json<AccountStatusErrorResponse>(
        { error: "unauthorized", message: "missing or invalid Quick Auth token" },
        { status: 401 },
      );
    }

    // 2. Parse body (same regex as onboard). Bad body is a clean 400.
    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json<AccountStatusErrorResponse>(
        {
          error: "invalid_request",
          message: "connectedAddress must be a 0x-prefixed 20-byte address",
        },
        { status: 400 },
      );
    }
    const { connectedAddress } = parsed.data;

    // 3. Detect (fail-open, the core requirement — D4). detectAccount lets
    // findRegisteredSafe errors propagate, so any throw here degrades to
    // found:false rather than a 5xx.
    try {
      const status = await withTimeout(
        detectAccount(auth.fid, connectedAddress),
        DETECT_TIMEOUT_MS,
        "account-status detect",
      );
      return NextResponse.json<AccountStatus>(status, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (err) {
      console.log(
        `[account-status][${reqId}] detect failed (fail-open): ${errorMessage(err)}`,
      );
      return NextResponse.json<AccountStatus>(
        { found: false },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch (err) {
    // Outer fail-open: any unexpected throw (incl. a re-thrown auth error) still
    // returns 200 { found:false } so detection never blocks onboarding (D4).
    console.log(
      `[account-status][${reqId}] detect failed (fail-open): ${errorMessage(err)}`,
    );
    return NextResponse.json<AccountStatus>(
      { found: false },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

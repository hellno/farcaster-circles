import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { isDebugEnabled } from "@/lib/env";
import { onboardAccount, buildDebug } from "@/lib/onboarding/onboard-account";
import type {
  OnboardErrorCode,
  OnboardErrorResponse,
  OnboardResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const STATUS: Record<OnboardErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  gated: 403,
  no_quota: 503,
  deploy_failed: 500,
  safe_not_ready: 500,
  invite_failed: 500,
  not_registered: 502,
  server_error: 500,
};

const bodySchema = z.object({
  connectedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  additionalOwners: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional(),
});

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function POST(request: Request) {
  const reqId = shortId();
  const debug = isDebugEnabled();
  // Tracked so an auth-stage throw still produces the original structured
  // server_error contract (verifyQuickAuth re-throws non-token errors).
  let verifiedFid = -1;

  try {
    // 1. Quick Auth.
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      console.log(`[onboard][${reqId}] auth: FAILED (no/invalid Quick Auth token)`);
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "unauthorized",
          message: "missing or invalid auth token",
          debug: buildDebug(debug, {
            reqId,
            verifiedFid: -1,
            connectedAddress: "",
            connectedAddressIsVerified: null,
            requestedAdditionalOwners: [],
            acceptedAdditionalOwners: [],
            rejectedAdditionalOwners: [],
            owners: [],
            safeAddress: null,
            quota: null,
            steps: ["auth: FAILED (no/invalid Quick Auth token)"],
            profile: null,
            profileError: null,
            signals: null,
            gate: null,
          }),
        },
        { status: STATUS.unauthorized },
      );
    }
    verifiedFid = auth.fid;

    // 2. Parse body.
    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      console.log(`[onboard][${reqId}] body: INVALID`);
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "invalid_request",
          message: "connectedAddress must be a 0x-prefixed 20-byte address",
          debug: buildDebug(debug, {
            reqId,
            verifiedFid: auth.fid,
            connectedAddress: "",
            connectedAddressIsVerified: null,
            requestedAdditionalOwners: [],
            acceptedAdditionalOwners: [],
            rejectedAdditionalOwners: [],
            owners: [],
            safeAddress: null,
            quota: null,
            steps: [`auth: OK verifiedFid=${auth.fid}`, "body: INVALID"],
            profile: null,
            profileError: null,
            signals: null,
            gate: null,
          }),
        },
        { status: STATUS.invalid_request },
      );
    }

    // 3. Run the flow.
    const outcome = await onboardAccount({
      fid: auth.fid,
      connectedAddress: parsed.data.connectedAddress,
      additionalOwners: parsed.data.additionalOwners,
      debug,
      reqId,
    });

    if (outcome.ok) {
      return NextResponse.json<OnboardResponse>(outcome.response, { status: 200 });
    }
    return NextResponse.json<OnboardErrorResponse>(
      {
        error: outcome.code,
        message: outcome.message,
        ...(outcome.txHashes ? { txHashes: outcome.txHashes } : {}),
        debug: outcome.debug,
      },
      { status: STATUS[outcome.code] },
    );
  } catch (err) {
    // Mirrors the original handler's outer catch: a throw from the auth/parse
    // stage (e.g. verifyQuickAuth re-throwing a non-token error) returns a
    // structured server_error JSON, not Next's plain-text 500 fallback.
    console.log(`[onboard][${reqId}] server_error: ${errorMessage(err)}`);
    return NextResponse.json<OnboardErrorResponse>(
      {
        error: "server_error",
        message: errorMessage(err),
        debug: buildDebug(debug, {
          reqId,
          verifiedFid,
          connectedAddress: "",
          connectedAddressIsVerified: null,
          requestedAdditionalOwners: [],
          acceptedAdditionalOwners: [],
          rejectedAdditionalOwners: [],
          owners: [],
          safeAddress: null,
          quota: null,
          steps: [`server_error: ${errorMessage(err)}`],
          profile: null,
          profileError: null,
          signals: null,
          gate: null,
        }),
      },
      { status: STATUS.server_error },
    );
  }
}

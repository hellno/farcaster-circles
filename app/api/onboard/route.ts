import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyQuickAuth } from "@/lib/auth";
import { env, isDebugEnabled } from "@/lib/env";
import { fetchUserProfile, fetchVerifiedEthAddresses } from "@/lib/neynar";
import {
  assertSafeReady,
  deployUserSafe,
  normalizeOwners,
  predictUserSafe,
} from "@/lib/safe";
import { getHubStatus, getQuota, inviteSafe } from "@/lib/circles";
import { evaluateGate, getSpamSignals, type GatePolicy } from "@/lib/gating";
import type {
  NeynarProfile,
  OnboardDebug,
  OnboardErrorResponse,
  OnboardResponse,
  SpamSignals,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  connectedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  additionalOwners: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional(),
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export async function POST(request: Request) {
  const reqId = shortId();
  const steps: string[] = [];
  const debug = isDebugEnabled();
  const log = (msg: string) => {
    steps.push(msg);
    console.log(`[onboard][${reqId}] ${msg}`);
  };

  // Filled in as we go so error responses can carry partial debug info.
  let verifiedFid = -1;
  let connectedAddress = "";
  let owners: string[] = [];
  let safeAddress: string | null = null;
  let quota: string | null = null;
  let connectedAddressIsVerified: boolean | null = null;
  let requestedAdditionalOwners: string[] = [];
  const acceptedAdditionalOwners: string[] = [];
  const rejectedAdditionalOwners: string[] = [];
  let profile: NeynarProfile | null = null;
  let profileError: string | null = null;
  let signals: SpamSignals | null = null;
  let gate: { policy: string; allowed: boolean; reason: string } | null = null;

  const buildDebug = (): OnboardDebug | undefined =>
    debug
      ? {
          reqId,
          verifiedFid,
          connectedAddress,
          connectedAddressIsVerified,
          requestedAdditionalOwners,
          acceptedAdditionalOwners,
          rejectedAdditionalOwners,
          owners,
          safeAddress,
          quota,
          steps,
          profile,
          profileError,
          signals,
          gate,
        }
      : undefined;

  try {
    // 1. Quick Auth — cryptographically verifies the caller's fid.
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      log("auth: FAILED (no/invalid Quick Auth token)");
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "unauthorized",
          message: "missing or invalid auth token",
          debug: buildDebug(),
        },
        { status: 401 },
      );
    }
    verifiedFid = auth.fid;
    log(`auth: OK verifiedFid=${auth.fid}`);

    // 2. Parse body.
    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      log("body: INVALID");
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "invalid_request",
          message: "connectedAddress must be a 0x-prefixed 20-byte address",
          debug: buildDebug(),
        },
        { status: 400 },
      );
    }
    connectedAddress = parsed.data.connectedAddress;
    requestedAdditionalOwners = parsed.data.additionalOwners ?? [];
    log(
      `body: OK connectedAddress=${connectedAddress} additionalOwners(requested)=${requestedAdditionalOwners.length}`,
    );

    // 3. Resolve owners.
    // The connected wallet is ALWAYS an owner. The user may additionally choose
    // any of their fid's verified addresses as co-signers; we re-validate each
    // chosen address against the fid's real verified set (defense-in-depth: a
    // deselect is honored by omission, and arbitrary addresses can't be added).
    let verified: string[] = [];
    try {
      verified = await fetchVerifiedEthAddresses(auth.fid);
      log(`verified set: ${verified.length} eth address(es)`);
    } catch (err) {
      log(
        `verified-address fetch FAILED (${errorMessage(err)}) — connected wallet only`,
      );
    }
    const verifiedLower = new Set(verified.map((a) => a.toLowerCase()));

    connectedAddressIsVerified = verifiedLower.has(
      connectedAddress.toLowerCase(),
    );
    log(`connectedAddress is a verified address of the fid: ${connectedAddressIsVerified}`);

    for (const a of requestedAdditionalOwners) {
      if (verifiedLower.has(a.toLowerCase())) acceptedAdditionalOwners.push(a);
      else rejectedAdditionalOwners.push(a);
    }
    if (rejectedAdditionalOwners.length > 0) {
      log(
        `rejected ${rejectedAdditionalOwners.length} requested owner(s) not in the fid's verified set: ${rejectedAdditionalOwners.join(", ")}`,
      );
    }

    owners = normalizeOwners([connectedAddress, ...acceptedAdditionalOwners]);
    log(`owners (sorted, deduped): ${owners.join(", ")}`);

    // 3.5 Anti-spam gate (free/keyless). Runs BEFORE any deploy/quota spend so a
    // blocked user costs nothing. Default policy "off" always allows.
    const policy = env.ONBOARD_GATE;
    try {
      signals = await getSpamSignals(
        auth.fid,
        env.DEBUG_VIEWER_FID,
        env.ONBOARD_ALLOWLIST_FIDS,
      );
      gate = { policy, ...evaluateGate(policy as GatePolicy, signals) };
      log(
        `gate[${policy}]: ${gate.allowed ? "ALLOW" : "BLOCK"} — ${gate.reason} ` +
          `(powerBadge=${signals.powerBadge}, mutual=${signals.mutualWithOperator})`,
      );
    } catch (err) {
      log(`gate: signals failed (${errorMessage(err)})`);
      if (policy !== "off") {
        gate = { policy, allowed: false, reason: "could not evaluate signals" };
      }
    }
    if (gate && !gate.allowed) {
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "gated",
          message:
            "This account doesn't meet the current eligibility requirements.",
          debug: buildDebug(),
        },
        { status: 403 },
      );
    }

    // Debug-only: enrich with score + follow relationship (no chain cost).
    if (debug) {
      try {
        profile = await fetchUserProfile(auth.fid, env.DEBUG_VIEWER_FID);
        if (profile) {
          log(
            `profile: @${profile.username} score=${profile.neynarScore ?? "n/a"}` +
              (profile.viewer
                ? ` mutual=${profile.viewer.mutual} (viewerFollowsUser=${profile.viewer.viewerFollowsUser}, userFollowsViewer=${profile.viewer.userFollowsViewer})`
                : " (no viewer fid set)"),
          );
        }
      } catch (err) {
        profileError = errorMessage(err);
        log(`profile: fetch FAILED (${profileError})`);
      }
    }

    // 4. Predict the user's Safe address.
    ({ safeAddress } = await predictUserSafe(owners as `0x${string}`[]));
    log(`predicted safe: ${safeAddress}`);

    // 5. Idempotent: already a registered human?
    const pre = await getHubStatus(safeAddress as `0x${string}`);
    if (pre.isHuman) {
      log("already registered — returning existing");
      return NextResponse.json<OnboardResponse>(
        {
          safeAddress,
          isHuman: true,
          avatar: pre.avatar,
          modules: { invitation: true, erc4337: true },
          txHashes: [],
          alreadyRegistered: true,
          debug: buildDebug(),
        },
        { status: 200 },
      );
    }

    // 6. Quota preflight.
    const q = await getQuota();
    quota = q.toString();
    log(`house inviter quota: ${quota}`);
    if (q === 0n) {
      log("no quota — aborting");
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "no_quota",
          message: "house inviter exhausted, request a new quota grant",
          debug: buildDebug(),
        },
        { status: 503 },
      );
    }

    // 7. Deploy + verify the Safe.
    try {
      const dep = await deployUserSafe(owners as `0x${string}`[]);
      log(
        dep.alreadyDeployed
          ? "safe already deployed"
          : `safe deployed tx=${dep.txHash}`,
      );
      await assertSafeReady(
        safeAddress as `0x${string}`,
        owners as `0x${string}`[],
      );
      log("assertSafeReady: OK (modules + fallback + version + threshold + owners)");
    } catch (err) {
      log(`deploy/assert FAILED: ${errorMessage(err)}`);
      return NextResponse.json<OnboardErrorResponse>(
        { error: "deploy_failed", message: errorMessage(err), debug: buildDebug() },
        { status: 500 },
      );
    }

    // 8. Invite (ensureInviterSetup + claim/transfer via pathfinder).
    let txHashes: string[] = [];
    try {
      ({ txHashes } = await inviteSafe(safeAddress as `0x${string}`));
      log(`invite txs: ${txHashes.join(", ")}`);
    } catch (err) {
      log(`invite FAILED: ${errorMessage(err)}`);
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "invite_failed",
          message: errorMessage(err),
          txHashes,
          debug: buildDebug(),
        },
        { status: 500 },
      );
    }

    // 9. Poll for registration.
    let registered = false;
    for (let i = 0; i < 12; i++) {
      const status = await getHubStatus(safeAddress as `0x${string}`);
      if (status.isHuman) {
        registered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!registered) {
      log("poll: not registered after timeout");
      return NextResponse.json<OnboardErrorResponse>(
        {
          error: "not_registered",
          message:
            "invite transactions sent but the Safe is not registered as human yet",
          txHashes,
          debug: buildDebug(),
        },
        { status: 502 },
      );
    }

    // 10. Success.
    const final = await getHubStatus(safeAddress as `0x${string}`);
    log(`SUCCESS isHuman=true avatar=${final.avatar}`);
    return NextResponse.json<OnboardResponse>(
      {
        safeAddress,
        isHuman: true,
        avatar: final.avatar,
        modules: { invitation: true, erc4337: true },
        txHashes,
        alreadyRegistered: false,
        debug: buildDebug(),
      },
      { status: 200 },
    );
  } catch (err) {
    log(`server_error: ${errorMessage(err)}`);
    return NextResponse.json<OnboardErrorResponse>(
      { error: "server_error", message: errorMessage(err), debug: buildDebug() },
      { status: 500 },
    );
  }
}

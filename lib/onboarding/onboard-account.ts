import "server-only";

import { env } from "@/lib/env";
import {
  fetchUserProfile,
  fetchVerifiedEthAddresses,
} from "@/lib/farcaster/neynar";
import { getSpamSignals } from "@/lib/farcaster/gating-signals";
import { evaluateGate, type GatePolicy } from "@/lib/farcaster/gating-policy";
import {
  assertSafeReady,
  deployUserSafe,
  normalizeOwners,
  predictUserSafe,
} from "@/lib/circles/safe";
import { getHubStatus, getQuota, inviteSafe } from "@/lib/circles/invite";
import type {
  NeynarProfile,
  OnboardDebug,
  OnboardOutcome,
  SpamSignals,
} from "@/lib/types";

export interface OnboardArgs {
  fid: number;
  connectedAddress: string;
  additionalOwners?: string[];
  /** When true, response carries the verbose debug payload. */
  debug: boolean;
  /** Request id for log correlation. */
  reqId: string;
}

export interface DebugState {
  reqId: string;
  verifiedFid: number;
  connectedAddress: string;
  connectedAddressIsVerified: boolean | null;
  requestedAdditionalOwners: string[];
  acceptedAdditionalOwners: string[];
  rejectedAdditionalOwners: string[];
  owners: string[];
  safeAddress: string | null;
  quota: string | null;
  steps: string[];
  profile: NeynarProfile | null;
  profileError: string | null;
  signals: SpamSignals | null;
  gate: { policy: string; allowed: boolean; reason: string } | null;
}

export function buildDebug(
  enabled: boolean,
  s: DebugState,
): OnboardDebug | undefined {
  return enabled
    ? {
        reqId: s.reqId,
        verifiedFid: s.verifiedFid,
        connectedAddress: s.connectedAddress,
        connectedAddressIsVerified: s.connectedAddressIsVerified,
        requestedAdditionalOwners: s.requestedAdditionalOwners,
        acceptedAdditionalOwners: s.acceptedAdditionalOwners,
        rejectedAdditionalOwners: s.rejectedAdditionalOwners,
        owners: s.owners,
        safeAddress: s.safeAddress,
        quota: s.quota,
        steps: s.steps,
        profile: s.profile,
        profileError: s.profileError,
        signals: s.signals,
        gate: s.gate,
      }
    : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function onboardAccount(
  args: OnboardArgs,
): Promise<OnboardOutcome> {
  const { fid, connectedAddress, debug, reqId } = args;
  const steps: string[] = [];
  const log = (msg: string) => {
    steps.push(msg);
    console.log(`[onboard][${reqId}] ${msg}`);
  };

  // Filled in as we go so error responses can carry partial debug info.
  const verifiedFid = fid;
  let owners: string[] = [];
  let safeAddress: string | null = null;
  let quota: string | null = null;
  let connectedAddressIsVerified: boolean | null = null;
  const requestedAdditionalOwners: string[] = args.additionalOwners ?? [];
  const acceptedAdditionalOwners: string[] = [];
  const rejectedAdditionalOwners: string[] = [];
  let profile: NeynarProfile | null = null;
  let profileError: string | null = null;
  let signals: SpamSignals | null = null;
  let gate: { policy: string; allowed: boolean; reason: string } | null = null;

  const localBuildDebug = (): OnboardDebug | undefined =>
    buildDebug(debug, {
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
    });

  try {
    log(`auth: OK verifiedFid=${fid}`);
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
      verified = await fetchVerifiedEthAddresses(fid);
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
        fid,
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
      return {
        ok: false,
        code: "gated",
        message:
          "This account doesn't meet the current eligibility requirements.",
        debug: localBuildDebug(),
      };
    }

    // Debug-only: enrich with score + follow relationship (no chain cost).
    if (debug) {
      try {
        profile = await fetchUserProfile(fid, env.DEBUG_VIEWER_FID);
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
      return {
        ok: true,
        response: {
          safeAddress,
          isHuman: true,
          avatar: pre.avatar,
          modules: { invitation: true, erc4337: true },
          txHashes: [],
          alreadyRegistered: true,
          debug: localBuildDebug(),
        },
      };
    }

    // 6. Quota preflight.
    const q = await getQuota();
    quota = q.toString();
    log(`house inviter quota: ${quota}`);
    if (q === 0n) {
      log("no quota — aborting");
      return {
        ok: false,
        code: "no_quota",
        message: "house inviter exhausted, request a new quota grant",
        debug: localBuildDebug(),
      };
    }

    // 7. Deploy + verify the Safe.
    try {
      const dep = await deployUserSafe(owners as `0x${string}`[]);
      log(
        dep.alreadyDeployed
          ? "safe already deployed"
          : `safe deployed tx=${dep.txHash}`,
      );
    } catch (err) {
      log(`deploy FAILED: ${errorMessage(err)}`);
      return {
        ok: false,
        code: "deploy_failed",
        message: errorMessage(err),
        debug: localBuildDebug(),
      };
    }
    try {
      await assertSafeReady(
        safeAddress as `0x${string}`,
        owners as `0x${string}`[],
      );
      log("assertSafeReady: OK (modules + fallback + version + threshold + owners)");
    } catch (err) {
      log(`assertSafeReady FAILED: ${errorMessage(err)}`);
      return {
        ok: false,
        code: "safe_not_ready",
        message: errorMessage(err),
        debug: localBuildDebug(),
      };
    }

    // 8. Invite (ensureInviterSetup + claim/transfer via pathfinder).
    let txHashes: string[] = [];
    try {
      ({ txHashes } = await inviteSafe(safeAddress as `0x${string}`));
      log(`invite txs: ${txHashes.join(", ")}`);
    } catch (err) {
      log(`invite FAILED: ${errorMessage(err)}`);
      return {
        ok: false,
        code: "invite_failed",
        message: errorMessage(err),
        txHashes,
        debug: localBuildDebug(),
      };
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
      return {
        ok: false,
        code: "not_registered",
        message:
          "invite transactions sent but the Safe is not registered as human yet",
        txHashes,
        debug: localBuildDebug(),
      };
    }

    // 10. Success.
    const final = await getHubStatus(safeAddress as `0x${string}`);
    log(`SUCCESS isHuman=true avatar=${final.avatar}`);
    return {
      ok: true,
      response: {
        safeAddress,
        isHuman: true,
        avatar: final.avatar,
        modules: { invitation: true, erc4337: true },
        txHashes,
        alreadyRegistered: false,
        debug: localBuildDebug(),
      },
    };
  } catch (err) {
    log(`server_error: ${errorMessage(err)}`);
    return {
      ok: false,
      code: "server_error",
      message: errorMessage(err),
      debug: localBuildDebug(),
    };
  }
}

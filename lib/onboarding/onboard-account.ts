import "server-only";

import type { Address } from "viem";

import { env } from "@/lib/env";
import {
  fetchUserProfile,
  fetchVerifiedEthAddresses,
} from "@/lib/farcaster/neynar";
import { getSpamSignals } from "@/lib/farcaster/gating-signals";
import { evaluateGate, type GatePolicy } from "@/lib/farcaster/gating-policy";
import { normalizeOwners } from "@/lib/circles/safe";
import { onboardSafeToCircles } from "@/lib/circles/onboard-safe";
import { MAX_VERIFIED_FANOUT } from "@/lib/onboarding/detect-account";
import type {
  NeynarProfile,
  OnboardDebug,
  OnboardOutcome,
  OnboardProgress,
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
  /** Progress sink (the route's SSE channel). Forwarded the core's events. */
  onProgress?: (event: OnboardProgress) => void;
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

/** Dedupe candidate owner sets by their normalized (sorted) membership. */
function dedupeOwnerSets(sets: Address[][]): Address[][] {
  const seen = new Set<string>();
  const out: Address[][] = [];
  for (const s of sets) {
    const key = s.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
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

    // D8: realistic candidate owner sets the user MIGHT already be registered
    // under (name-resolution drift or a different prior signer selection). The
    // chain core short-circuits on any already-registered candidate before
    // spending. C1 = the set we'd deploy; C2 = connected-only; C3 = connected +
    // all verified. Deduped (collapses when verified is empty).
    // C3 (connected + all verified) is the heavy candidate; skip it past the
    // shared fan-out cap so this pre-spend check stays bounded (Codex #10, the
    // SAME bound detection uses). C1 (the set we'd deploy) + C2 (connected-only)
    // still cover the realistic drift cases.
    const candidateOwnerSets: Address[][] = [
      normalizeOwners(owners),
      normalizeOwners([connectedAddress]),
    ];
    if (verified.length <= MAX_VERIFIED_FANOUT) {
      candidateOwnerSets.push(normalizeOwners([connectedAddress, ...verified]));
    }
    const candidateSets = dedupeOwnerSets(candidateOwnerSets);
    log(`d8: ${candidateSets.length} candidate owner-set(s) for short-circuit`);

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

    // 4. Hand off to the transport-agnostic chain core (predict -> preflight ->
    // deploy -> verify -> invite -> poll). The Farcaster layer above is done.
    //
    // FAN-OUT the core's progress: one event source, two sinks. We derive the
    // debug trail from the SAME event the client receives, so the two can never
    // drift. `log` is cheap and non-throwing; the core also try/catch-guards each
    // onProgress call, so nothing here can break the money-spending sequence.
    const onChainProgress = (e: OnboardProgress) => {
      log(`chain: ${e.stage}${e.attempt ? ` (attempt ${e.attempt})` : ""}`);
      args.onProgress?.(e); // forward to the route's SSE sink
    };

    const chain = await onboardSafeToCircles(
      { owners, candidateSets },
      onChainProgress,
    );

    // Carry the core's resolved address into our debug payload (owners is already
    // known). Quota is only observed on a failure outcome. Append one summary line.
    safeAddress = chain.safeAddress;
    if (chain.ok) {
      log(
        `chain: registered safe=${chain.safeAddress} alreadyRegistered=${chain.alreadyRegistered}`,
      );
      return {
        ok: true,
        response: {
          safeAddress: chain.safeAddress,
          isHuman: chain.isHuman,
          avatar: chain.avatar,
          modules: { invitation: true, erc4337: true },
          txHashes: chain.txHashes,
          alreadyRegistered: chain.alreadyRegistered,
          debug: localBuildDebug(),
        },
      };
    }
    quota = chain.quota;
    log(`chain: FAILED ${chain.code} — ${chain.message}`);
    return {
      ok: false,
      code: chain.code,
      message: chain.message,
      ...(chain.txHashes.length ? { txHashes: chain.txHashes } : {}),
      debug: localBuildDebug(),
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

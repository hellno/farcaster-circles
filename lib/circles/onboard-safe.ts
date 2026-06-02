import "server-only";

import {
  assertSafeReady,
  deployUserSafe,
  normalizeOwners,
  predictUserSafe,
} from "@/lib/circles/safe";
import { getHubStatus, inviteSafe, preflightInvite } from "@/lib/circles/invite";
import type {
  ChainOnboardOutcome,
  ChainOnboardFailure,
  OnboardProgress,
} from "@/lib/types";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Transport-agnostic Circles/Safe onboarding core. Sequences the on-chain steps
 * (predict -> preflight -> deploy -> verify -> invite -> poll) and emits a
 * progress event at the START of each stage. It knows NOTHING about Farcaster,
 * fids, gating, Quick Auth, SSE, HTTP, or UI copy — that lives in the callers
 * (`lib/onboarding/*`, `app/api/onboard/route.ts`). A CLI or script can consume
 * the returned `ChainOnboardOutcome` directly.
 *
 * Idempotent: the Safe address is deterministic for a given owner set, so a
 * re-run on an already-registered Safe short-circuits with `alreadyRegistered`.
 * Read-only checks (preflight) run BEFORE any deploy/quota spend, so a doomed
 * onboard costs zero gas.
 */
export async function onboardSafeToCircles(
  args: { owners: string[] },
  onProgress?: (event: OnboardProgress) => void,
): Promise<ChainOnboardOutcome> {
  // Normalize FIRST for determinism: the predicted Safe address depends on the
  // exact (sorted, deduped) owner set, so the core canonicalizes up front and
  // uses this list everywhere (including the outcome's `owners` field).
  const owners = normalizeOwners(args.owners);

  // A faulty progress sink must NEVER abort a money-spending sequence; swallow
  // anything it throws.
  const emit = (event: OnboardProgress) => {
    try {
      onProgress?.(event);
    } catch {
      /* a faulty sink must never abort a money-spending sequence */
    }
  };

  // Filled in as we go so failure outcomes can carry partial context.
  let safeAddress: string | null = null;
  let quota: string | null = null;
  let txHashes: string[] = [];

  const fail = (
    code: ChainOnboardFailure["code"],
    message: string,
  ): ChainOnboardFailure => ({
    ok: false,
    code,
    message,
    owners,
    safeAddress,
    txHashes,
    quota,
  });

  try {
    // 1. Predict the user's Safe address.
    emit({ type: "progress", stage: "predicting" });
    ({ safeAddress } = await predictUserSafe(owners as `0x${string}`[]));

    // 2. Idempotent: already a registered human? Short-circuit before any
    // preflight / deploy / quota spend.
    const pre = await getHubStatus(safeAddress as `0x${string}`);
    if (pre.isHuman) {
      return {
        ok: true,
        owners,
        safeAddress,
        isHuman: true,
        avatar: pre.avatar,
        txHashes: [],
        alreadyRegistered: true,
      };
    }

    // 3. Invite preflight (read-only) — runs BEFORE deploy so a doomed onboard
    // costs no gas. Checks quota and that the inviter is a registered human.
    emit({ type: "progress", stage: "preflight", safeAddress });
    const pf = await preflightInvite();
    quota = pf.quota.toString();
    if (!pf.ok) {
      const failed = pf.failed!;
      if (failed.name === "quota") {
        return fail("no_quota", "house inviter exhausted, request a new quota grant");
      }
      return fail(
        "inviter_unavailable",
        "onboarding is temporarily unavailable — the inviter can't issue invites right now",
      );
    }

    // 4. Deploy the Safe (operator pays gas).
    emit({ type: "progress", stage: "deploying", safeAddress });
    try {
      await deployUserSafe(owners as `0x${string}`[]);
    } catch (err) {
      return fail("deploy_failed", errorMessage(err));
    }

    // 5. Verify the deployed Safe (modules + fallback + version + threshold + owners).
    emit({ type: "progress", stage: "verifying", safeAddress });
    try {
      await assertSafeReady(
        safeAddress as `0x${string}`,
        owners as `0x${string}`[],
      );
    } catch (err) {
      return fail("safe_not_ready", errorMessage(err));
    }

    // 6. Invite (ensureInviterSetup + claim/transfer via pathfinder).
    emit({ type: "progress", stage: "inviting", safeAddress });
    try {
      ({ txHashes } = await inviteSafe(safeAddress as `0x${string}`));
    } catch (err) {
      return fail("invite_failed", errorMessage(err));
    }

    // 7. Poll for registration. `ExecutionSuccess` lies (a Safe execTransaction
    // succeeds even when the inner call reverts), so assert the on-chain effect.
    let registered = false;
    for (let attempt = 1; attempt <= 12; attempt++) {
      emit({ type: "progress", stage: "registering", safeAddress, attempt });
      const status = await getHubStatus(safeAddress as `0x${string}`);
      if (status.isHuman) {
        registered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!registered) {
      return fail(
        "not_registered",
        "invite transactions sent but the Safe is not registered as human yet",
      );
    }

    // 8. Success.
    const final = await getHubStatus(safeAddress as `0x${string}`);
    return {
      ok: true,
      owners,
      safeAddress,
      isHuman: true,
      avatar: final.avatar,
      txHashes,
      alreadyRegistered: false,
    };
  } catch (err) {
    return fail("server_error", errorMessage(err));
  }
}

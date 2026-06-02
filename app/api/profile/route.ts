import { NextResponse } from "next/server";
import { z } from "zod";
import type { Address } from "viem";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { fetchFarcasterCard } from "@/lib/farcaster/neynar";
import {
  buildCirclesProfile,
  cidV0ToDigest,
  circlesProfileName,
  isDigestSet,
  prepareProfileTx,
  readMetadataDigest,
  relayProfileTx,
  uploadProfile,
} from "@/lib/circles/profile";
import type {
  ProfileErrorCode,
  ProfileErrorResponse,
  ProfilePrepareResponse,
  ProfileRelayResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// `relay` broadcasts one Safe tx and waits for its receipt on Gnosis.
export const maxDuration = 60;

const STATUS: Record<ProfileErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  no_profile: 422,
  upload_failed: 502,
  relay_failed: 502,
  server_error: 500,
};

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const bodySchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("prepare"), safeAddress: addr }),
  z.object({
    step: z.literal("relay"),
    safeAddress: addr,
    digest: bytes32,
    signerAddress: addr,
    // 65-byte ECDSA sig from eth_signTypedData_v4 (0x + 130 hex); allow longer
    // for forward-compat with stacked/contract signatures.
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/),
  }),
]);

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function fail(code: ProfileErrorCode, message: string) {
  return NextResponse.json<ProfileErrorResponse>(
    { error: code, message },
    { status: STATUS[code] },
  );
}

/**
 * Set the caller's Circles profile (name + avatar) on a Safe they own. Two steps
 * (idempotent, failure-isolated; completely separate from /api/onboard):
 *
 *   prepare -> verify auth, short-circuit if a digest is already set, build the
 *     profile from the fid's Farcaster identity, pin it, and return the unsigned
 *     Safe-tx EIP-712 typed data for the user to sign (gas-free).
 *   relay   -> rebuild that exact tx, attach the user's owner signature, and
 *     submit execTransaction AS the operator (pays gas). A bad signature simply
 *     reverts on-chain; the operator's exposure is one NameRegistry write.
 *
 * The fid gates endpoint access; the real authorization is the on-chain owner
 * signature, so a caller can only set a profile on a Safe they actually own.
 */
export async function POST(request: Request) {
  try {
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      return fail("unauthorized", "missing or invalid Quick Auth token");
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail("invalid_request", "malformed request body");
    }
    const body = parsed.data;
    const safe = body.safeAddress as Address;

    if (body.step === "prepare") {
      // Idempotency: never overwrite an already-set (possibly user-customized)
      // profile, and never prompt a signature we don't need.
      const current = await readMetadataDigest(safe);
      if (isDigestSet(current)) {
        return NextResponse.json<ProfilePrepareResponse>({ alreadySet: true });
      }

      const card = await fetchFarcasterCard(auth.fid).catch(() => null);
      const name = circlesProfileName(card);
      if (!name) {
        return fail("no_profile", "no Farcaster display name or username to use");
      }

      // name is non-null here, so buildCirclesProfile returns a profile.
      const profile = (await buildCirclesProfile(card))!;

      let cid: string;
      try {
        cid = await uploadProfile(profile);
      } catch (err) {
        console.error(`[profile] upload failed for fid=${auth.fid}:`, errorMessage(err));
        return fail("upload_failed", "could not save your profile right now");
      }

      const digest = cidV0ToDigest(cid);
      const typedData = await prepareProfileTx(safe, digest);
      return NextResponse.json<ProfilePrepareResponse>({
        alreadySet: false,
        name: profile.name,
        hasImage: Boolean(profile.previewImageUrl),
        digest,
        typedData,
      });
    }

    // step === "relay"
    try {
      const txHash = await relayProfileTx({
        safe,
        digest: body.digest as `0x${string}`,
        signerAddress: body.signerAddress as Address,
        signature: body.signature,
      });
      return NextResponse.json<ProfileRelayResponse>({ txHash });
    } catch (err) {
      console.error(`[profile] relay failed for fid=${auth.fid}:`, errorMessage(err));
      return fail("relay_failed", "could not set your profile on-chain — please retry");
    }
  } catch (err) {
    return fail("server_error", errorMessage(err));
  }
}

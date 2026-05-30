// NOTE: do NOT add `import "server-only"` here.
// This module is imported by both the Next.js server route (app/api/onboard/route.ts)
// AND the tsx M1 script (scripts/spike-onboard.ts) which runs in plain Node, where
// `server-only` throws.

import { type Address, type Hash } from "viem";
import Safe from "@safe-global/protocol-kit";
import type { TransactionRequest } from "@aboutcircles/sdk-types";

import { env } from "@/lib/env";
import {
  HUB_V2,
  HUB_ABI,
  HOUSE_INVITER,
  getInviteFarm,
  getInvitations,
  getPublicClient,
} from "@/lib/circles/config";

/** Read Hub v2 registration status for an address. */
export async function getHubStatus(
  addr: Address,
): Promise<{ isHuman: boolean; avatar: Address }> {
  const client = getPublicClient();
  const [isHuman, avatar] = await Promise.all([
    client.readContract({
      address: HUB_V2,
      abi: HUB_ABI,
      functionName: "isHuman",
      args: [addr],
    }),
    client.readContract({
      address: HUB_V2,
      abi: HUB_ABI,
      functionName: "avatars",
      args: [addr],
    }),
  ]);
  return { isHuman, avatar: avatar as Address };
}

/** Remaining invite quota for an inviter (defaults to the house inviter). */
export async function getQuota(inviter?: Address): Promise<bigint> {
  return getInviteFarm().getQuota((inviter ?? HOUSE_INVITER) as Address);
}

/**
 * Execute a single SDK-built transaction AS the house inviter Safe via
 * protocol-kit (sign + execute), then wait for its receipt. Returns the hash.
 *
 * IMPORTANT: a Safe's `execTransaction` emits `ExecutionSuccess` even when the
 * INNER call reverts (it surfaces an `ExecutionFailure` event instead of
 * bubbling the revert). So a successful receipt is NOT proof the inner call
 * worked — callers must assert the on-chain effect (e.g. `isHuman`) afterward.
 */
async function execAsInviterSafe(
  kit: Safe,
  label: string,
  tx: TransactionRequest,
): Promise<Hash> {
  const to = tx.to;
  const value = (tx.value ?? 0n).toString();
  const data = tx.data ?? "0x";

  console.log(
    `[inviteSafe] ${label} to=${to} value=${value} data=${data.slice(0, 10)}...`,
  );

  const safeTx = await kit.createTransaction({
    transactions: [{ to, value, data }],
  });
  const signed = await kit.signTransaction(safeTx);
  const res = await kit.executeTransaction(signed);
  const hash = res.hash as Hash;

  console.log(
    `[inviteSafe] ${label} hash=${hash} https://gnosisscan.io/tx/${hash}`,
  );

  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * One-time inviter setup. Before an inviter Safe can spend invite quota, the
 * InvitationModule must (a) be enabled on the Safe and (b) TRUST the inviter
 * (`trustInviter`). Merely enabling the module is not enough — without the trust
 * step the farm `safeTransferFrom` into the module reverts
 * (`0xff1f28fc(bot, inviter)`). `Invitations.ensureInviterSetup` returns exactly
 * the missing setup txs (empty once complete), which we execute AS the inviter
 * Safe. Idempotent: a no-op after the first successful run.
 */
export async function ensureInviterSetup(): Promise<{ txHashes: Hash[] }> {
  const setupTxs = await getInvitations().ensureInviterSetup(
    HOUSE_INVITER as Address,
  );
  if (setupTxs.length === 0) {
    console.log("[ensureInviterSetup] already set up, nothing to do");
    return { txHashes: [] };
  }

  const kit = await Safe.init({
    provider: env.GNOSIS_RPC_URL,
    signer: env.INVITER_OWNER_PK,
    safeAddress: env.INVITER_SAFE_ADDRESS,
  });

  const txHashes: Hash[] = [];
  for (let i = 0; i < setupTxs.length; i++) {
    console.log(`[ensureInviterSetup] running setup tx ${i + 1}/${setupTxs.length}`);
    txHashes.push(await execAsInviterSafe(kit, `setup[${i}]`, setupTxs[i]));
  }
  return { txHashes };
}

/**
 * Invite a Safe into Circles. Runs one-time inviter setup if needed, then
 * executes the invitation transactions AS the house inviter Safe, in order,
 * waiting for each receipt before the next.
 *
 * Uses `Invitations.generateInvite(inviter, invitee)` — the SDK's path for "a
 * user who already has a Safe wallet but is NOT yet registered in the Hub",
 * which is exactly our case. It runs the pathfinder and routes 96 CRC through
 * trusted proxy inviters (an `operateFlowMatrix` flow the Hub permits).
 *
 * Do NOT use the lower-level `InviteFarm.generateInvites` here: it builds a raw
 * farm bot-token `safeTransferFrom` that the Hub rejects with
 * `TrustRequired(bot, inviter)` when the inviter holds no own CRC and the bot
 * token isn't on a permitted trust flow into the module.
 */
export async function inviteSafe(
  safeAddr: Address,
): Promise<{ txHashes: Hash[] }> {
  // One-time: ensure the InvitationModule is enabled + trusts the inviter.
  // Idempotent (returns no txs once complete).
  const { txHashes: setupHashes } = await ensureInviterSetup();

  const transactions = await getInvitations().generateInvite(
    HOUSE_INVITER as Address,
    safeAddr as Address,
  );

  const kit = await Safe.init({
    provider: env.GNOSIS_RPC_URL,
    signer: env.INVITER_OWNER_PK,
    safeAddress: env.INVITER_SAFE_ADDRESS,
  });

  const txHashes: Hash[] = [...setupHashes];
  for (let i = 0; i < transactions.length; i++) {
    // Execute sequentially, awaiting each receipt (later txs depend on earlier).
    txHashes.push(await execAsInviterSafe(kit, `tx[${i}]`, transactions[i]));
  }

  return { txHashes };
}

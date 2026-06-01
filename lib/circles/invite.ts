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

export interface PreflightCheck {
  name: "quota" | "inviter_human";
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  quota: bigint;
  checks: PreflightCheck[];
  /** First failing check, or null when all pass. */
  failed: PreflightCheck | null;
}

/**
 * Read-only invite preconditions. Runs BEFORE the user's Safe is deployed so a
 * doomed onboard costs ZERO gas and broadcasts nothing.
 *
 * Checks: quota > 0, and the inviter is a registered Circles human.
 *
 * NOTE: we deliberately do NOT pre-check `isTrusted(bot, inviter)`. `claimInvite`
 * self-grants that trust with a 0-second TTL (expires in the claim block), so it
 * reads `false` out-of-band for every healthy inviter — pre-checking it would
 * false-negate every onboard. What actually makes the trust valid at transfer
 * time is executing claim + transfer ATOMICALLY in one Safe tx; see `inviteSafe`.
 */
export async function preflightInvite(
  inviter: Address = HOUSE_INVITER,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  const quota = await getQuota(inviter);
  checks.push({ name: "quota", ok: quota > 0n, detail: `quota=${quota.toString()}` });

  const { isHuman } = await getHubStatus(inviter);
  checks.push({ name: "inviter_human", ok: isHuman, detail: `isHuman=${isHuman}` });

  const failed = checks.find((c) => !c.ok) ?? null;
  return { ok: !failed, quota, checks, failed };
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
 * Execute MULTIPLE SDK-built transactions AS the house inviter Safe in ONE
 * atomic Safe transaction (protocol-kit batches >1 tx via MultiSend). Required
 * for the farm invite pair: `claimInvite` self-grants the `bot -> inviter` trust
 * with a 0-second TTL (expiry == claim block timestamp), so the follow-up
 * `safeTransferFrom` MUST run in the SAME block/tx or the Hub reverts
 * `TrustRequired(bot, inviter)`. Returns the single tx hash.
 */
async function execBatchAsInviterSafe(
  kit: Safe,
  label: string,
  txs: TransactionRequest[],
): Promise<Hash> {
  const transactions = txs.map((tx) => ({
    to: tx.to,
    value: (tx.value ?? 0n).toString(),
    data: tx.data ?? "0x",
  }));

  console.log(
    `[inviteSafe] ${label} atomic batch (${transactions.length} tx): ` +
      transactions.map((t) => `${t.to}:${t.data.slice(0, 10)}`).join(", "),
  );

  const safeTx = await kit.createTransaction({ transactions });
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
 * Invite an existing Safe into Circles via the house inviter's prepaid farm
 * quota. Runs one-time inviter setup (idempotent), then executes the farm
 * invitation transactions AS the house inviter Safe.
 *
 * Uses `InviteFarm.generateInvites(inviter, [invitee])`, which returns
 * `[claimTx, transferTx]`:
 *   1. `claimInvite()` — consumes ONE prepaid quota unit, yielding a farm "bot"
 *      ERC-1155 token AND self-granting `bot -> inviter` trust with a 0-second
 *      TTL (valid only within the claim block).
 *   2. `Hub.safeTransferFrom(inviter -> InvitationModule, botId, 96 CRC,
 *      abi.encode(invitee))` — the Hub calls the module's `onERC1155Received`,
 *      which (after re-checking `isTrusted(bot, inviter)`) makes the INVITEE Safe
 *      self-call `registerHuman(inviter)` => `isHuman(invitee) === true`.
 *
 * CRITICAL: the two txs MUST run ATOMICALLY in ONE Safe transaction. The
 * bot->inviter trust from step 1 has a 0-second TTL, so executing them as
 * separate txs (different blocks) makes step 2 see expired trust and revert
 * `TrustRequired(bot, inviter)` (`0xff1f28fc`, masked as Safe `GS013`). The
 * Circles app batches them in one 4337 UserOp; we batch them via MultiSend
 * (`execBatchAsInviterSafe`).
 *
 * The 96 CRC comes from PREPAID FARM QUOTA (the claimed bot token), not the
 * inviter's own CRC — no `personalMint` needed; only `getQuota(inviter) > 0`.
 *
 * PRECONDITION: the invitee Safe MUST have the InvitationModule
 * (`0x00738aca…`, == `farm.invitationModule()`) enabled so the module can
 * self-call it. We enable it at Safe creation (`buildAccountConfig` /
 * `ENABLE_MODULES_DATA` in `circles/safe.ts`).
 */
export async function inviteSafe(
  safeAddr: Address,
): Promise<{ txHashes: Hash[] }> {
  // One-time: ensure the InvitationModule is enabled + trusts the inviter.
  // Idempotent (returns no txs once complete).
  const { txHashes: setupHashes } = await ensureInviterSetup();

  const { transactions } = await getInviteFarm().generateInvites(
    HOUSE_INVITER as Address,
    [safeAddr as Address],
  );

  const kit = await Safe.init({
    provider: env.GNOSIS_RPC_URL,
    signer: env.INVITER_OWNER_PK,
    safeAddress: env.INVITER_SAFE_ADDRESS,
  });

  // Claim + transfer in ONE atomic Safe tx — the bot->inviter trust has a
  // 0-second TTL, so they cannot be split across blocks (see doc above).
  const inviteHash = await execBatchAsInviterSafe(kit, "invite", transactions);

  return { txHashes: [...setupHashes, inviteHash] };
}

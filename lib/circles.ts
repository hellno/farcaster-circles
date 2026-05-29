// NOTE: do NOT add `import "server-only"` here.
// This module is imported by both the Next.js server route (app/api/onboard/route.ts)
// AND the tsx M1 script (scripts/spike-onboard.ts) which runs in plain Node, where
// `server-only` throws.

import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { gnosis } from "viem/chains";
import Safe from "@safe-global/protocol-kit";
import { InviteFarm, Invitations } from "@aboutcircles/sdk-invitations";
import type { CirclesConfig, TransactionRequest } from "@aboutcircles/sdk-types";

import { env } from "./env";

// --- On-chain Gnosis (chain 100) addresses (all confirmed to have code) ---
export const HUB_V2 = "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8" as Address;
export const INVITATION_FARM = "0xd28b7C4f148B1F1E190840A1f7A796C5525D8902" as Address;
export const INVITATION_MODULE = "0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5" as Address;
export const SAFE_4337_MODULE = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226" as Address;
export const SAFE_MODULE_SETUP = "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47" as Address;
export const REFERRALS_MODULE = "0x12105a9B291aF2ABb0591001155A75949b062CE5" as Address;
export const NAME_REGISTRY = "0xA27566fD89162cC3D40Cb59c87AAaA49B85F3474" as Address;
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
export const HOUSE_INVITER = "0xC3CCd9455b301D01d69DFB0b9Fc38Bee39829598" as Address;

// --- Minimal Hub v2 ABI: isHuman(address) -> bool, avatars(address) -> address ---
export const HUB_ABI = [
  {
    type: "function",
    name: "isHuman",
    stateMutability: "view",
    inputs: [{ name: "_human", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "avatars",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Canonical Circles config for chain 100 (Gnosis). circlesRpcUrl comes from env. */
export function getCirclesConfig(): CirclesConfig {
  return {
    circlesRpcUrl: env.CIRCLES_RPC_URL,
    profileServiceUrl: "https://rpc.aboutcircles.com/profiles/",
    referralsServiceUrl: "https://referrals.aboutcircles.com/",
    v2HubAddress: "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8",
    nameRegistryAddress: "0xA27566fD89162cC3D40Cb59c87AAaA49B85F3474",
    baseGroupMintPolicy: "0xcCa27c26CF7BAC2a9928f42201d48220F0e3a549",
    standardTreasury: "0x08F90aB73A515308f03A718257ff9887ED330C6e",
    coreMembersGroupDeployer: "0xFEca40Eb02FB1f4F5F795fC7a03c1A27819B1Ded",
    baseGroupFactoryAddress: "0xD0B5Bd9962197BEaC4cbA24244ec3587f19Bd06d",
    liftERC20Address: "0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5",
    invitationFarmAddress: "0xd28b7C4f148B1F1E190840A1f7A796C5525D8902",
    referralsModuleAddress: "0x12105a9B291aF2ABb0591001155A75949b062CE5",
    invitationModuleAddress: "0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5",
  };
}

/** InviteFarm bound to the canonical chain-100 config. */
export function getInviteFarm(): InviteFarm {
  return new InviteFarm(getCirclesConfig());
}

/** Invitations helper (exposes one-time inviter setup: enableModule + trustInviter). */
export function getInvitations(): Invitations {
  return new Invitations(getCirclesConfig());
}

/** viem PublicClient for Gnosis, pointed at the node RPC (not the Circles RPC). */
export function getPublicClient(): PublicClient {
  return createPublicClient({
    chain: gnosis,
    transport: http(env.GNOSIS_RPC_URL),
  });
}

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

/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase A verification spike for the in-app Circles claim flow.
// Goal: figure out empirically whether `register.asHuman` deploys a Safe,
// whether it must be called from a Safe vs an EOA, and what Gelato sponsorship
// needs to look like. Run once against a real distribution slug.
//
//   pnpm tsx scripts/spike-claim.ts
//
// Required env (in .env.local — see .env.example "Spike" block):
//   CIRCLES_REFERRAL_SLUG
//   PIMLICO_API_KEY
//   PIMLICO_SPONSORSHIP_POLICY_ID  (sp_... from Pimlico dashboard)
//   GNOSIS_RPC_URL          (optional, defaults to https://rpc.gnosischain.com)
//   SPIKE_THROWAWAY_PK      (optional, only for Branch 3 fallback)
//
// Iteration helpers (skip the API call when retrying — each /referrals/d/{slug}
// hit consumes one key from your session quota):
//   SPIKE_DISPENSED_PK       0x… already-dispensed private key
//   SPIKE_DISPENSED_INVITER  0x… inviter address that came back with it
//
// Branches are tried in order; first to succeed exits. Each branch logs the
// full call sequence so we can map it to the production flow.
import "dotenv/config";

import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

import { ethers } from "ethers";
import { Sdk, circlesConfig } from "@circles-sdk/sdk";
import { PrivateKeyContractRunner } from "@circles-sdk/adapter-ethers";

import { Safe4337Pack } from "@safe-global/relay-kit";

const OP_CALL = 0;

const HUB_V2: Address = "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8";

const HUB_ABI = [
  {
    type: "function",
    name: "isHuman",
    stateMutability: "view",
    inputs: [{ name: "human", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "registerHuman",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_inviter", type: "address" },
      { name: "_metadataDigest", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "avatars",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function log(tag: string, value: unknown): void {
  const stamp = new Date().toISOString().slice(11, 23);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    console.log(`[${stamp}] ${tag}: ${value}`);
  } else {
    console.log(`[${stamp}] ${tag}:`, JSON.stringify(value, null, 2));
  }
}

function gnosisscanTx(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

function gnosisscanAddr(addr: string): string {
  return `https://gnosisscan.io/address/${addr}`;
}

interface DispensedKey {
  privateKey: Hex;
  inviter: Address;
  claimUrl?: string;
  sessionSlug?: string;
}

async function dispense(slug: string): Promise<DispensedKey> {
  const url = `https://rpc.aboutcircles.com/referrals/d/${slug}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  log("dispense.status", res.status);
  const body: unknown = await res.json().catch(() => ({}));
  log("dispense.body", body);
  if (!res.ok) throw new Error(`dispense failed (${res.status})`);
  const b = body as Record<string, unknown>;
  return {
    privateKey: b.privateKey as Hex,
    inviter: (b.inviter as Address).toLowerCase() as Address,
    claimUrl: b.claimUrl as string | undefined,
    sessionSlug: b.sessionSlug as string | undefined,
  };
}

async function preflight(
  publicClient: PublicClient,
  addr: Address,
  label: string,
): Promise<{ isHuman: boolean; hasCode: boolean; avatar: Address }> {
  const [isHuman, code, avatar] = await Promise.all([
    publicClient.readContract({
      address: HUB_V2,
      abi: HUB_ABI,
      functionName: "isHuman",
      args: [addr],
    }) as Promise<boolean>,
    publicClient.getCode({ address: addr }),
    publicClient.readContract({
      address: HUB_V2,
      abi: HUB_ABI,
      functionName: "avatars",
      args: [addr],
    }) as Promise<Address>,
  ]);
  log(`preflight.${label}`, {
    addr,
    isHuman,
    hasCode: !!code,
    avatar,
  });
  return { isHuman, hasCode: !!code, avatar };
}

async function assertRegistered(
  publicClient: PublicClient,
  addr: Address,
): Promise<void> {
  const { isHuman, avatar } = await preflight(publicClient, addr, "post-claim");
  if (!isHuman) throw new Error(`not registered as human: ${addr}`);
  console.log(`\n✅ SUCCESS — ${addr} is a registered Circles human.`);
  console.log(`   avatars[${addr}] = ${avatar}`);
  console.log(`   ${gnosisscanAddr(addr)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 1 — Circles SDK directly with the dispensed key as the EOA signer.
// If it succeeds, the avatar = the dispensed EOA (plain key, no Safe).
// This is the simplest possible flow; tells us whether the team's pitch about
// "make the farcaster EOA a signer of that account" is post-hoc (i.e. we'd
// add the FC EOA later via Safe wrap) or required up-front.
// ─────────────────────────────────────────────────────────────────────────────
async function branch1_sdkDirect(
  publicClient: PublicClient,
  d: DispensedKey,
): Promise<boolean> {
  console.log("\n━━━ BRANCH 1: Circles SDK with dispensed EOA as signer ━━━");
  try {
    const provider = new ethers.JsonRpcProvider(
      process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com",
    );
    const runner = new PrivateKeyContractRunner(provider, d.privateKey);
    await runner.init();
    const runnerAddr = (await (runner as any).address) as Address;
    log("branch1.runner.address", runnerAddr);

    await preflight(publicClient, runnerAddr, "branch1-pre");

    const sdk = new Sdk(runner as any, circlesConfig["100"]);
    log("branch1.sdk.ready", "calling acceptInvitation");
    const avatar = await sdk.acceptInvitation(d.inviter, {
      name: "Spike Test",
      description: "Phase A spike — please ignore",
      previewImageUrl: "",
      imageUrl: "",
    } as any);
    log("branch1.avatar", { address: (avatar as any).address });

    await assertRegistered(publicClient, runnerAddr);
    return true;
  } catch (e) {
    log("branch1.failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 2 — Deploy a 4337-enabled Safe (single owner = dispensed key) and
// call hub.registerHuman via a sponsored UserOperation through Pimlico's
// bundler + verifying paymaster on Gnosis Chain. The avatar = the Safe.
// We can later add Farcaster EOA / passkey signers as extra Safe owners.
// ─────────────────────────────────────────────────────────────────────────────
async function branch2_safeViaPimlico(
  publicClient: PublicClient,
  d: DispensedKey,
): Promise<boolean> {
  console.log("\n━━━ BRANCH 2: Safe 4337 + Pimlico sponsored UserOp ━━━");
  try {
    const rpc = process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com";
    const apiKey = required("PIMLICO_API_KEY");
    const policyId = required("PIMLICO_SPONSORSHIP_POLICY_ID");
    const pimlicoUrl = `https://api.pimlico.io/v2/100/rpc?apikey=${apiKey}`;
    const ownerAccount = privateKeyToAccount(d.privateKey);
    log("branch2.owner.address", ownerAccount.address);
    log("branch2.policyId", policyId);

    // Init the Safe 4337 pack — pointed at Pimlico for both bundling & sponsorship.
    const safe4337Pack = await Safe4337Pack.init({
      provider: rpc,
      signer: d.privateKey,
      bundlerUrl: pimlicoUrl,
      paymasterOptions: {
        isSponsored: true,
        paymasterUrl: pimlicoUrl,
        sponsorshipPolicyId: policyId,
      } as any,
      options: {
        owners: [ownerAccount.address],
        threshold: 1,
      },
    });
    const safeAddress = (await safe4337Pack.protocolKit.getAddress()) as Address;
    log("branch2.safe.predicted", safeAddress);
    await preflight(publicClient, safeAddress, "branch2-pre");

    // Encode the Circles claim call.
    const hubIface = new ethers.Interface([
      "function registerHuman(address _inviter, bytes32 _metadataDigest)",
    ]);
    const claimData = hubIface.encodeFunctionData("registerHuman", [
      d.inviter,
      "0x" + "00".repeat(32),
    ]) as Hex;
    log("branch2.claimData", claimData.slice(0, 66) + "…");

    // Build the UserOp (Safe4337Pack handles deploy-on-first-tx automatically).
    const safeOperation = await safe4337Pack.createTransaction({
      transactions: [
        {
          to: HUB_V2,
          value: "0",
          data: claimData,
          operation: OP_CALL,
        },
      ],
    });
    const signed = await safe4337Pack.signSafeOperation(safeOperation);
    log("branch2.userop.signed", "ok");

    const userOpHash = await safe4337Pack.executeTransaction({
      executable: signed,
    });
    log("branch2.userOpHash", userOpHash);

    // Poll Pimlico for the bundled tx hash.
    let txHash: string | undefined;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const receipt = await safe4337Pack.getUserOperationReceipt(userOpHash);
        log(`branch2.pimlico.poll[${i}]`, {
          hasReceipt: !!receipt,
          success: (receipt as any)?.success,
          txHash: (receipt as any)?.receipt?.transactionHash,
        });
        if (receipt) {
          txHash = (receipt as any).receipt?.transactionHash;
          if ((receipt as any).success === false) {
            throw new Error(`UserOp reverted: ${JSON.stringify(receipt)}`);
          }
          break;
        }
      } catch (e) {
        log(`branch2.pimlico.poll[${i}].err`, e instanceof Error ? e.message : String(e));
      }
    }
    if (!txHash) throw new Error("Pimlico UserOp did not finalize in 120s");
    log("branch2.tx", gnosisscanTx(txHash));

    await assertRegistered(publicClient, safeAddress);
    return true;
  } catch (e) {
    log("branch2.failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 3 — Pure-viem fallback. Throwaway EOA pays Gnosis gas, calls
// hub.registerHuman directly. Confirms the baseline contract behavior without
// any Gelato/Safe machinery in the way.
// ─────────────────────────────────────────────────────────────────────────────
async function branch3_throwawayEoa(
  publicClient: PublicClient,
  d: DispensedKey,
): Promise<boolean> {
  console.log("\n━━━ BRANCH 3: throwaway EOA pays gas, direct registerHuman ━━━");
  const throwawayPk = process.env.SPIKE_THROWAWAY_PK as Hex | undefined;
  if (!throwawayPk) {
    log("branch3.skipped", "SPIKE_THROWAWAY_PK not set");
    return false;
  }
  try {
    const { createWalletClient } = await import("viem");
    const account = privateKeyToAccount(throwawayPk);
    log("branch3.throwaway.address", account.address);
    const balance = await publicClient.getBalance({ address: account.address });
    log("branch3.throwaway.balance", balance.toString());
    if (balance === BigInt(0)) throw new Error("throwaway has 0 xDAI");

    const walletClient = createWalletClient({
      account,
      chain: gnosis,
      transport: http(process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com"),
    });

    // Important: this calls registerHuman from the throwaway, so the avatar
    // becomes the throwaway EOA. The dispensed key isn't actually used — this
    // branch is a sanity check that the hub accepts plain EOA callers at all.
    const hash = await walletClient.writeContract({
      address: HUB_V2,
      abi: HUB_ABI,
      functionName: "registerHuman",
      args: [d.inviter, ("0x" + "00".repeat(32)) as Hex],
    });
    log("branch3.tx", gnosisscanTx(hash));

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log("branch3.receipt.status", receipt.status);

    await assertRegistered(publicClient, account.address);
    return true;
  } catch (e) {
    log("branch3.failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function main(): Promise<void> {
  const publicClient = createPublicClient({
    chain: gnosis,
    transport: http(process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com"),
  });

  console.log("\n═══ Circles in-app claim spike ═══");
  console.log(`rpc:  ${process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com"}`);
  log("dispensedKeyHashIfYouCare", keccak256(toHex("placeholder")).slice(0, 18));

  const reusedPk = process.env.SPIKE_DISPENSED_PK as Hex | undefined;
  const reusedInviter = process.env.SPIKE_DISPENSED_INVITER as Address | undefined;
  let d: DispensedKey;
  if (reusedPk && reusedInviter) {
    log("reuse.dispensedKey", "skipping /referrals/d call — using SPIKE_DISPENSED_PK");
    d = {
      privateKey: reusedPk,
      inviter: reusedInviter.toLowerCase() as Address,
    };
  } else {
    const slug = required("CIRCLES_REFERRAL_SLUG");
    console.log(`slug: ${slug}`);
    d = await dispense(slug);
  }
  log("dispensed", {
    inviter: d.inviter,
    addressDerivedFromKey: privateKeyToAccount(d.privateKey).address,
    sessionSlug: d.sessionSlug,
    claimUrl: d.claimUrl,
  });

  if (await branch1_sdkDirect(publicClient, d)) {
    console.log("\n🏁 Branch 1 succeeded. Phase B should use the Circles SDK with the dispensed key.");
    return;
  }
  if (await branch2_safeViaPimlico(publicClient, d)) {
    console.log("\n🏁 Branch 2 succeeded. Phase B should use Safe 4337 + Pimlico.");
    return;
  }
  if (await branch3_throwawayEoa(publicClient, d)) {
    console.log("\n🏁 Branch 3 succeeded. Phase B baseline works; revisit sponsorship.");
    return;
  }
  throw new Error("All branches failed. See logs above.");
}

main().catch((err) => {
  console.error("\n❌ Spike failed:", err);
  process.exit(1);
});

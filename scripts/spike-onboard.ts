// Load env from .env.local first (Next convention), then .env as a fallback,
// so the spike picks up whichever file holds your keys.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { type Address, type Hash, type Hex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getHubStatus, getQuota, inviteSafe } from "../lib/circles/invite";
import {
  assertSafeReady,
  deployUserSafe,
  normalizeOwners,
  predictUserSafe,
} from "../lib/circles/safe";
import { env } from "../lib/env";

// --- tiny logging / link helpers (mirror spike-claim.ts conventions) ---

function log(...args: unknown[]): void {
  console.log(...args);
}

function txLink(hash: Hash): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

function addressLink(addr: Address): string {
  return `https://gnosisscan.io/address/${addr}`;
}

function appLink(addr: Address): string {
  return `https://app.aboutcircles.com/?address=${addr}`;
}

// Best-effort decode of an on-chain revert reason for clearer failure output.
function describeError(err: unknown): string {
  if (err instanceof Error) {
    // viem errors expose a flattened `shortMessage` and a nested cause chain.
    const anyErr = err as Error & {
      shortMessage?: string;
      details?: string;
      cause?: unknown;
    };
    const parts: string[] = [];
    if (anyErr.shortMessage) parts.push(anyErr.shortMessage);
    if (anyErr.details) parts.push(anyErr.details);
    if (parts.length === 0) parts.push(err.message);
    let cause = anyErr.cause;
    let depth = 0;
    while (cause && depth < 5) {
      const c = cause as Error & {
        shortMessage?: string;
        reason?: string;
        cause?: unknown;
      };
      const msg = c.shortMessage ?? c.reason ?? c.message;
      if (msg) parts.push(`caused by: ${msg}`);
      cause = c.cause;
      depth += 1;
    }
    return parts.join(" | ");
  }
  return String(err);
}

function resolveOwners(): Address[] {
  const raw = (process.env.SPIKE_OWNER_ADDRESS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const owners =
    raw.length > 0
      ? raw
      : [privateKeyToAccount(env.DEPLOYER_PK as Hex).address];

  const normalized = normalizeOwners(owners);
  if (normalized.length === 0) {
    throw new Error(
      "No valid owner addresses (set SPIKE_OWNER_ADDRESS or DEPLOYER_PK)",
    );
  }
  return normalized;
}

async function main(): Promise<void> {
  const owners = resolveOwners();
  log("owners:", owners.join(", "));

  // 1. Predict the user Safe address.
  const { safeAddress } = await predictUserSafe(owners);
  log("predicted safe:", safeAddress);
  log("  ", addressLink(safeAddress));

  // 2. Preflight: bail early if already a Circles human; otherwise ensure quota.
  const pre = await getHubStatus(safeAddress);
  if (pre.isHuman) {
    log("already registered as a Circles human, nothing to do");
    printSuccess(safeAddress, pre.avatar);
    process.exit(0);
  }

  const quota = await getQuota();
  log("house inviter quota:", quota.toString());
  if (quota <= 0n) {
    throw new Error("house inviter out of quota (getQuota() returned 0)");
  }

  // 3. Deploy (or detect existing deployment of) the user Safe.
  const dep = await deployUserSafe(owners);
  if (dep.alreadyDeployed) {
    log("safe already deployed:", dep.safeAddress);
  } else {
    log("safe deployed:", dep.safeAddress);
    if (dep.txHash) {
      log("  deploy tx:", dep.txHash);
      log("  ", txLink(dep.txHash));
    }
  }

  // 4. Verify modules / fallback handler / version / threshold / owners.
  await assertSafeReady(safeAddress, owners);
  log("safe ready: modules + fallback + version + threshold + owners OK");

  // 5. Invite the Safe from the house inviter (claim + transfer).
  const { txHashes } = await inviteSafe(safeAddress);
  log("invite transactions:");
  txHashes.forEach((hash, i) => {
    log(`  [${i}] ${hash}`);
    log("     ", txLink(hash));
  });

  // 6. Confirm the Safe is now a registered Circles human with a real avatar.
  const post = await getHubStatus(safeAddress);
  if (!post.isHuman) {
    throw new Error(
      `invite completed but safe ${safeAddress} is still not a Circles human`,
    );
  }
  if (post.avatar === zeroAddress) {
    throw new Error(
      `safe ${safeAddress} reports isHuman but avatar is the zero address`,
    );
  }

  printSuccess(safeAddress, post.avatar);
  process.exit(0);
}

function printSuccess(safeAddress: Address, avatar: Address): void {
  log("");
  log("================ SUCCESS ================");
  log("safe address:", safeAddress);
  log("avatar:      ", avatar);
  log("gnosisscan:  ", addressLink(safeAddress));
  log("circles app: ", appLink(safeAddress));
  log("========================================");
}

main().catch((err) => {
  console.error("spike-onboard failed:", describeError(err));
  process.exit(1);
});

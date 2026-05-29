// Read-only smoke test for the Circles self-onboard wiring.
// Spends NOTHING, broadcasts NOTHING, needs NO real keys. It only does eth_call /
// read RPC against live Gnosis + the Circles RPC to prove the mechanism is wired up.
//
//   GNOSIS_RPC_URL=https://rpc.gnosischain.com \
//   DEPLOYER_PK=0x<any 32-byte hex, throwaway/unfunded> \
//   pnpm tsx scripts/smoke-readonly.ts
//
// What it checks:
//   1. predictUserSafe(owners) -> deterministic CREATE2 address (protocol-kit)
//   2. getQuota() of the house inviter (expect > 0)
//   3. getHubStatus(houseInviter) -> isHuman true (sanity: house inviter is a real human)
//   4. getHubStatus(predictedSafe) -> not yet human (expected: fresh address)
//   5. generateInvites(houseInviter, [predictedSafe]) -> the 2 unsigned txs
//      (claimTx -> InvitationFarm.claimInvite, transferTx -> Hub.safeTransferFrom value 96e18)
import "dotenv/config";

import { decodeFunctionData, parseAbi, type Address } from "viem";

import {
  HOUSE_INVITER,
  INVITATION_FARM,
  HUB_V2,
  getInviteFarm,
} from "../lib/circles/config";
import { getHubStatus, getQuota } from "../lib/circles/invite";
import { normalizeOwners, predictUserSafe } from "../lib/circles/safe";

const DECODE_ABI = parseAbi([
  "function claimInvite()",
  "function claimInvites(uint256 numberOfInvites)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

function decode(to: string, data: string): string {
  try {
    const d = decodeFunctionData({ abi: DECODE_ABI, data: data as `0x${string}` });
    return `${d.functionName}(${(d.args ?? []).map((a) => String(a)).join(", ")})`;
  } catch {
    return `selector ${data.slice(0, 10)}`;
  }
}

async function main(): Promise<void> {
  // Two arbitrary, well-known checksum addresses just to derive a fresh Safe.
  const owners = normalizeOwners([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ]);
  console.log("owners:", owners.join(", "));

  console.log("\n[1] predictUserSafe (protocol-kit CREATE2)...");
  const { safeAddress } = await predictUserSafe(owners);
  console.log("    predicted safe:", safeAddress);

  console.log("\n[2] getQuota(house inviter)...");
  const quota = await getQuota();
  console.log("    quota:", quota.toString(), quota > 0n ? "OK (>0)" : "ZERO");

  console.log("\n[3] getHubStatus(house inviter) — sanity, expect isHuman=true...");
  const houseStatus = await getHubStatus(HOUSE_INVITER);
  console.log("    isHuman:", houseStatus.isHuman, "avatar:", houseStatus.avatar);

  console.log("\n[4] getHubStatus(predicted safe) — expect isHuman=false (fresh)...");
  const safeStatus = await getHubStatus(safeAddress);
  console.log("    isHuman:", safeStatus.isHuman, "avatar:", safeStatus.avatar);

  console.log("\n[5] generateInvites(house inviter, [predicted safe]) — read-only build...");
  const { transactions } = await getInviteFarm().generateInvites(
    HOUSE_INVITER as Address,
    [safeAddress as Address],
  );
  console.log(`    returned ${transactions.length} tx(s):`);
  transactions.forEach((tx, i) => {
    const to = (tx.to ?? "").toString();
    const value = (tx.value ?? 0n).toString();
    let tag = "";
    if (to.toLowerCase() === INVITATION_FARM.toLowerCase()) tag = " [InvitationFarm]";
    else if (to.toLowerCase() === HUB_V2.toLowerCase()) tag = " [Hub v2]";
    console.log(`    tx[${i}] to=${to}${tag} value=${value}`);
    console.log(`          ${decode(to, (tx.data ?? "0x").toString())}`);
  });

  console.log("\n================ SMOKE OK ================");
  console.log("Wiring proven read-only. No keys used, nothing spent/broadcast.");
  console.log("The remaining proof (deploy + invite on-chain) needs funded keys — see M1 run.");
}

main().catch((err) => {
  console.error("\nsmoke-readonly FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

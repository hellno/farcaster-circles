// NOTE: do NOT add `import "server-only"` here.
// This module is imported by both the Next.js server route (app/api/onboard/route.ts)
// AND the tsx M1 script (scripts/spike-onboard.ts) which runs in plain Node, where
// `server-only` throws.

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { gnosis } from "viem/chains";
import { InviteFarm, Invitations } from "@aboutcircles/sdk-invitations";
import type { CirclesConfig } from "@aboutcircles/sdk-types";

import { env } from "@/lib/env";

// --- On-chain Gnosis (chain 100) addresses (all confirmed to have code) ---
export const HUB_V2 = "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8" as Address;
export const INVITATION_FARM = "0xd28b7C4f148B1F1E190840A1f7A796C5525D8902" as Address;
export const INVITATION_MODULE = "0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5" as Address;
export const SAFE_4337_MODULE = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226" as Address;
export const SAFE_MODULE_SETUP = "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47" as Address;
export const REFERRALS_MODULE = "0x12105a9B291aF2ABb0591001155A75949b062CE5" as Address;
export const NAME_REGISTRY = "0xA27566fD89162cC3D40Cb59c87AAaA49B85F3474" as Address;
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

// D7: single source of truth — the address used for quota / setup / invite target
// is the SAME Safe that signs (env.INVITER_SAFE_ADDRESS). They cannot diverge.
export const HOUSE_INVITER = env.INVITER_SAFE_ADDRESS as Address;

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

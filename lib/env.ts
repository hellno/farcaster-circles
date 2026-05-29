function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get NEYNAR_API_KEY(): string {
    return requireEnv("NEYNAR_API_KEY");
  },
  get FARCASTER_DOMAIN(): string {
    return requireEnv("FARCASTER_DOMAIN");
  },
  // Gnosis Chain node RPC. Defaults to the public endpoint; override for a
  // private/rate-limited-safe RPC when running real broadcasts at volume.
  get GNOSIS_RPC_URL(): string {
    return process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com";
  },
  // Funded xDAI EOA that pays gas to deploy the user's Safe (M1/M2).
  get DEPLOYER_PK(): string {
    const v = requireEnv("DEPLOYER_PK");
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error("DEPLOYER_PK must be a 0x-prefixed 32-byte hex string");
    }
    return v;
  },
  // The Circles "house inviter" Safe whose prepaid quota funds onboarding.
  // Defaults to the project's house inviter; override to use a different one.
  get INVITER_SAFE_ADDRESS(): string {
    const v =
      process.env.INVITER_SAFE_ADDRESS ??
      "0xC3CCd9455b301D01d69DFB0b9Fc38Bee39829598";
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error(
        "INVITER_SAFE_ADDRESS must be a 0x-prefixed 20-byte hex address",
      );
    }
    return v;
  },
  // Owner key of INVITER_SAFE_ADDRESS that authorizes the two invite txs.
  // Defaults to DEPLOYER_PK, since in the common case one EOA both deploys and
  // owns the inviter Safe (threshold 1). Set separately only if they differ.
  get INVITER_OWNER_PK(): string {
    const v = process.env.INVITER_OWNER_PK ?? process.env.DEPLOYER_PK;
    if (!v) {
      throw new Error("Missing required env var: INVITER_OWNER_PK (or DEPLOYER_PK)");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error("INVITER_OWNER_PK must be a 0x-prefixed 32-byte hex string");
    }
    return v;
  },
  get CIRCLES_RPC_URL(): string {
    return process.env.CIRCLES_RPC_URL ?? "https://rpc.aboutcircles.com/";
  },
  // Ethereum mainnet RPC for ENS reverse resolution (public default).
  get ETH_RPC_URL(): string {
    return process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
  },
  // Base mainnet RPC for basename reverse resolution (public default).
  get BASE_RPC_URL(): string {
    return process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  },
  get SPIKE_OWNER_ADDRESS(): string | undefined {
    return process.env.SPIKE_OWNER_ADDRESS;
  },
  // Optional: the operator's own fid, used as the "viewer" for follow/mutual
  // signals (free hub) and Neynar debug context.
  get DEBUG_VIEWER_FID(): number | undefined {
    const v = process.env.DEBUG_VIEWER_FID;
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  },
  // Anti-spam gate policy for /api/onboard. One of:
  //   off | powerBadge | mutual | powerBadgeOrMutual | powerBadgeAndMutual
  // Defaults to "off" (no gating). "mutual" needs DEBUG_VIEWER_FID set.
  get ONBOARD_GATE(): string {
    return process.env.ONBOARD_GATE ?? "off";
  },
  // Comma-separated fids that always bypass the gate (e.g. the operator's own
  // test accounts / teammates). The operator's own fid (DEBUG_VIEWER_FID) is
  // always allowed regardless of this list.
  get ONBOARD_ALLOWLIST_FIDS(): number[] {
    return (process.env.ONBOARD_ALLOWLIST_FIDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  },
  // M3 (gasless, stretch) — sponsored UserOp deploy via Pimlico.
  get PIMLICO_API_KEY(): string | undefined {
    return process.env.PIMLICO_API_KEY;
  },
  get PIMLICO_SPONSORSHIP_POLICY_ID(): string | undefined {
    return process.env.PIMLICO_SPONSORSHIP_POLICY_ID;
  },
  // Public, accessed both server- and client-side and at build time via
  // generateMetadata / OG images. Default to empty string so module load
  // never throws; downstream code must handle the empty case.
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "",
};

/**
 * Whether to include verbose `debug` payloads in API responses. On by default
 * outside production (so `pnpm dev` / tunnel testing shows everything); can be
 * forced on in production with ONBOARD_DEBUG=true.
 */
export function isDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ONBOARD_DEBUG === "true"
  );
}

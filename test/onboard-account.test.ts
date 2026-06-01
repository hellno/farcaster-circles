import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the farcaster + circles layers BEFORE importing the service.
vi.mock("@/lib/farcaster/neynar", () => ({
  fetchVerifiedEthAddresses: vi.fn(),
  fetchUserProfile: vi.fn(async () => null),
}));
vi.mock("@/lib/farcaster/gating-signals", () => ({
  getSpamSignals: vi.fn(),
}));
vi.mock("@/lib/circles/safe", () => ({
  normalizeOwners: vi.fn((addrs: string[]) => {
    // light real-ish normalize: dedupe lowercase, checksum-skip-invalid
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of addrs) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
      const k = a.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  }),
  predictUserSafe: vi.fn(async () => ({ safeAddress: "0x" + "1".repeat(40), kit: {} })),
  deployUserSafe: vi.fn(async () => ({ safeAddress: "0x" + "1".repeat(40), txHash: null, alreadyDeployed: true })),
  assertSafeReady: vi.fn(async () => {}),
}));
vi.mock("@/lib/circles/invite", () => ({
  getHubStatus: vi.fn(),
  getQuota: vi.fn(),
  preflightInvite: vi.fn(),
  inviteSafe: vi.fn(async () => ({ txHashes: [] })),
}));

const PREFLIGHT_OK = {
  ok: true,
  quota: 5n,
  checks: [
    { name: "quota", ok: true, detail: "quota=5" },
    { name: "inviter_human", ok: true, detail: "isHuman=true" },
  ],
  failed: null,
};

import { onboardAccount } from "@/lib/onboarding/onboard-account";
import * as neynar from "@/lib/farcaster/neynar";
import * as signalsMod from "@/lib/farcaster/gating-signals";
import * as invite from "@/lib/circles/invite";
import * as safeMod from "@/lib/circles/safe";

const CONNECTED = "0x" + "c".repeat(40);
const VERIFIED = "0x" + "d".repeat(40);
const NOT_VERIFIED = "0x" + "e".repeat(40);

function spam(over = {}) {
  return {
    fid: 7, isOperator: false, allowlisted: false, powerBadge: null,
    operatorFollowsUser: null, userFollowsOperator: null,
    mutualWithOperator: null, verifiedAddressCount: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (signalsMod.getSpamSignals as any).mockResolvedValue(spam());
  (neynar.fetchVerifiedEthAddresses as any).mockResolvedValue([VERIFIED]);
  (invite.getQuota as any).mockResolvedValue(5n);
  (invite.preflightInvite as any).mockResolvedValue(PREFLIGHT_OK);
  (invite.getHubStatus as any).mockResolvedValue({ isHuman: false, avatar: "0x" + "0".repeat(40) });
});

const base = { fid: 7, connectedAddress: CONNECTED, debug: true, reqId: "test01" };

describe("onboardAccount — owner re-validation security guard (route.ts:144-147)", () => {
  it("REJECTS additionalOwners not in the fid's verified set", async () => {
    // not-verified must reach poll; make it already-human so we stop early & inspect debug.
    (invite.getHubStatus as any).mockResolvedValue({ isHuman: true, avatar: "0x" + "9".repeat(40) });
    const out = await onboardAccount({ ...base, additionalOwners: [NOT_VERIFIED] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.debug?.rejectedAdditionalOwners).toContain(NOT_VERIFIED);
      expect(out.response.debug?.acceptedAdditionalOwners).not.toContain(NOT_VERIFIED);
      expect(out.response.debug?.owners).not.toContain(NOT_VERIFIED);
    }
    // Security EFFECT (not just the debug payload): the chain layer must never
    // be handed the un-verified address as a Safe owner.
    expect(safeMod.predictUserSafe).toHaveBeenCalledTimes(1);
    const predictedOwners = (safeMod.predictUserSafe as any).mock.calls[0][0] as string[];
    expect(predictedOwners.map((a) => a.toLowerCase())).not.toContain(
      NOT_VERIFIED.toLowerCase(),
    );
    expect(predictedOwners.map((a) => a.toLowerCase())).toContain(
      CONNECTED.toLowerCase(),
    );
  });

  it("ACCEPTS additionalOwners that ARE in the verified set", async () => {
    (invite.getHubStatus as any).mockResolvedValue({ isHuman: true, avatar: "0x" + "9".repeat(40) });
    const out = await onboardAccount({ ...base, additionalOwners: [VERIFIED] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.debug?.acceptedAdditionalOwners).toContain(VERIFIED);
    }
    // Security EFFECT: the verified co-signer IS handed to the chain layer.
    const predictedOwners = (safeMod.predictUserSafe as any).mock.calls[0][0] as string[];
    expect(predictedOwners.map((a) => a.toLowerCase())).toContain(
      VERIFIED.toLowerCase(),
    );
  });

  it("falls back to connected-wallet-only when verified-set fetch throws (NOT reject user)", async () => {
    (neynar.fetchVerifiedEthAddresses as any).mockRejectedValue(new Error("hub down"));
    (invite.getHubStatus as any).mockResolvedValue({ isHuman: true, avatar: "0x" + "9".repeat(40) });
    const out = await onboardAccount({ ...base, additionalOwners: [VERIFIED] });
    expect(out.ok).toBe(true); // user not rejected
    if (out.ok) {
      // with empty verified set, the previously-verified addr is now rejected
      expect(out.response.debug?.acceptedAdditionalOwners).not.toContain(VERIFIED);
    }
  });
});

describe("onboardAccount — outcomes (chain layer mocked)", () => {
  it("gated when policy blocks", async () => {
    // Force a blocking policy via env at call time.
    process.env.ONBOARD_GATE = "powerBadge";
    (signalsMod.getSpamSignals as any).mockResolvedValue(spam({ powerBadge: false }));
    const out = await onboardAccount(base);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("gated");
    process.env.ONBOARD_GATE = "off";
  });

  it("no_quota when the preflight quota check fails", async () => {
    (invite.preflightInvite as any).mockResolvedValue({
      ok: false,
      quota: 0n,
      checks: [{ name: "quota", ok: false, detail: "quota=0" }],
      failed: { name: "quota", ok: false, detail: "quota=0" },
    });
    const out = await onboardAccount(base);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("no_quota");
    expect(safeMod.deployUserSafe).not.toHaveBeenCalled();
  });

  it("inviter_unavailable when the inviter is not a registered human — fails BEFORE any deploy", async () => {
    (invite.preflightInvite as any).mockResolvedValue({
      ok: false,
      quota: 98n,
      checks: [
        { name: "quota", ok: true, detail: "quota=98" },
        { name: "inviter_human", ok: false, detail: "isHuman=false" },
      ],
      failed: { name: "inviter_human", ok: false, detail: "isHuman=false" },
    });
    const out = await onboardAccount(base);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("inviter_unavailable");
    expect(safeMod.deployUserSafe).not.toHaveBeenCalled();
    expect(invite.inviteSafe).not.toHaveBeenCalled();
  });

  it("already-human returns ok with alreadyRegistered=true and spends no quota", async () => {
    (invite.getHubStatus as any).mockResolvedValue({ isHuman: true, avatar: "0x" + "9".repeat(40) });
    const out = await onboardAccount(base);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.alreadyRegistered).toBe(true);
      expect(out.response.isHuman).toBe(true);
      expect(out.response.txHashes).toEqual([]);
    }
    expect(invite.inviteSafe).not.toHaveBeenCalled();
  });
});

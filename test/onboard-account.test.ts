import { describe, it, expect, vi, beforeEach } from "vitest";

// The wrapper is now a THIN Farcaster layer over the transport-agnostic core, so
// mock the CORE here (not safe/invite). The chain-sequence specifics
// (already-human, no_quota, deploy_failed, ...) are covered by
// test/onboard-safe.test.ts; this file tests the WRAPPER's own responsibilities:
// owner re-validation, the anti-spam gate, outcome mapping, and progress fan-out.
vi.mock("@/lib/farcaster/neynar", () => ({
  fetchVerifiedEthAddresses: vi.fn(),
  fetchUserProfile: vi.fn(async () => null),
}));
vi.mock("@/lib/farcaster/gating-signals", () => ({
  getSpamSignals: vi.fn(),
}));
// normalizeOwners is the only thing the wrapper still imports from safe.
vi.mock("@/lib/circles/safe", () => ({
  normalizeOwners: vi.fn((addrs: string[]) => {
    // light real-ish normalize: dedupe lowercase, skip-invalid, sort lowercase
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
}));
vi.mock("@/lib/circles/onboard-safe", () => ({
  onboardSafeToCircles: vi.fn(),
}));

const SAFE = "0x" + "1".repeat(40);
const AVATAR = "0x" + "9".repeat(40);
const INVITE_HASHES = ["0x" + "a".repeat(64), "0x" + "b".repeat(64)];

import { onboardAccount } from "@/lib/onboarding/onboard-account";
import * as neynar from "@/lib/farcaster/neynar";
import * as signalsMod from "@/lib/farcaster/gating-signals";
import { onboardSafeToCircles } from "@/lib/circles/onboard-safe";
import type {
  ChainOnboardOutcome,
  ChainOnboardSuccess,
  ChainOnboardFailure,
  OnboardProgress,
} from "@/lib/types";

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

/** A success outcome the core returns for the happy path (owners filled per-call). */
function chainSuccess(owners: string[]): ChainOnboardSuccess {
  return {
    ok: true,
    owners,
    safeAddress: SAFE,
    isHuman: true,
    avatar: AVATAR,
    txHashes: INVITE_HASHES,
    alreadyRegistered: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(signalsMod.getSpamSignals).mockResolvedValue(spam() as never);
  vi.mocked(neynar.fetchVerifiedEthAddresses).mockResolvedValue([VERIFIED] as never);
  // Default: the core succeeds, echoing back whatever owner set it was handed.
  vi.mocked(onboardSafeToCircles).mockImplementation(
    async (args) => chainSuccess(args.owners),
  );
});

const base = { fid: 7, connectedAddress: CONNECTED, debug: true, reqId: "test01" };

describe("onboardAccount — anti-spam gate (Farcaster layer)", () => {
  it("gated when policy blocks — returns code 'gated' and NEVER calls the core", async () => {
    process.env.ONBOARD_GATE = "powerBadge";
    vi.mocked(signalsMod.getSpamSignals).mockResolvedValue(
      spam({ powerBadge: false }) as never,
    );

    const out = await onboardAccount(base);

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("gated");
    // The gate runs BEFORE any spend — the chain core must not be touched.
    expect(onboardSafeToCircles).not.toHaveBeenCalled();

    process.env.ONBOARD_GATE = "off";
  });
});

describe("onboardAccount — outcome mapping (core mocked)", () => {
  it("maps a ChainOnboardSuccess to OnboardSuccess (response fields + debug)", async () => {
    const out = await onboardAccount(base);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.safeAddress).toBe(SAFE);
      expect(out.response.avatar).toBe(AVATAR);
      expect(out.response.isHuman).toBe(true);
      expect(out.response.alreadyRegistered).toBe(false);
      expect(out.response.txHashes).toEqual(INVITE_HASHES);
      expect(out.response.modules).toEqual({ invitation: true, erc4337: true });
      expect(out.response.debug).toBeDefined();
      expect(out.response.debug?.safeAddress).toBe(SAFE);
    }
  });

  it("propagates alreadyRegistered=true straight through", async () => {
    vi.mocked(onboardSafeToCircles).mockResolvedValue({
      ok: true,
      owners: [CONNECTED],
      safeAddress: SAFE,
      isHuman: true,
      avatar: AVATAR,
      txHashes: [],
      alreadyRegistered: true,
    } satisfies ChainOnboardOutcome);

    const out = await onboardAccount(base);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.alreadyRegistered).toBe(true);
      expect(out.response.txHashes).toEqual([]);
    }
  });

  it("maps a ChainOnboardFailure to OnboardFailure (code + message + txHashes)", async () => {
    const failure: ChainOnboardFailure = {
      ok: false,
      code: "no_quota",
      message: "house inviter exhausted, request a new quota grant",
      owners: [CONNECTED],
      safeAddress: SAFE,
      txHashes: [],
      quota: "0",
    };
    vi.mocked(onboardSafeToCircles).mockResolvedValue(failure);

    const out = await onboardAccount(base);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("no_quota");
      expect(out.message).toBe(
        "house inviter exhausted, request a new quota grant",
      );
      // No txs broadcast -> the wrapper omits the field entirely.
      expect(out.txHashes).toBeUndefined();
      expect(out.debug?.quota).toBe("0");
    }
  });

  it("carries txHashes through on a partial failure (invite_failed)", async () => {
    const failure: ChainOnboardFailure = {
      ok: false,
      code: "not_registered",
      message: "invite transactions sent but the Safe is not registered as human yet",
      owners: [CONNECTED],
      safeAddress: SAFE,
      txHashes: INVITE_HASHES,
      quota: "5",
    };
    vi.mocked(onboardSafeToCircles).mockResolvedValue(failure);

    const out = await onboardAccount(base);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("not_registered");
      expect(out.txHashes).toEqual(INVITE_HASHES);
    }
  });
});

describe("onboardAccount — owner re-validation security guard", () => {
  it("DROPS additionalOwners not in the fid's verified set before calling the core", async () => {
    const out = await onboardAccount({ ...base, additionalOwners: [NOT_VERIFIED] });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.debug?.rejectedAdditionalOwners).toContain(NOT_VERIFIED);
      expect(out.response.debug?.acceptedAdditionalOwners).not.toContain(NOT_VERIFIED);
    }
    // Security EFFECT: the core is handed ONLY the normalized accepted owners.
    expect(onboardSafeToCircles).toHaveBeenCalledTimes(1);
    const passedOwners = vi.mocked(onboardSafeToCircles).mock.calls[0][0].owners;
    expect(passedOwners.map((a) => a.toLowerCase())).toContain(CONNECTED.toLowerCase());
    expect(passedOwners.map((a) => a.toLowerCase())).not.toContain(
      NOT_VERIFIED.toLowerCase(),
    );
  });

  it("KEEPS additionalOwners that ARE verified and hands them to the core", async () => {
    const out = await onboardAccount({ ...base, additionalOwners: [VERIFIED] });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.debug?.acceptedAdditionalOwners).toContain(VERIFIED);
    }
    const passedOwners = vi.mocked(onboardSafeToCircles).mock.calls[0][0].owners;
    expect(passedOwners.map((a) => a.toLowerCase())).toContain(VERIFIED.toLowerCase());
  });

  it("falls back to connected-wallet-only when the verified-set fetch throws", async () => {
    vi.mocked(neynar.fetchVerifiedEthAddresses).mockRejectedValue(new Error("hub down"));

    const out = await onboardAccount({ ...base, additionalOwners: [VERIFIED] });

    expect(out.ok).toBe(true); // user not rejected
    if (out.ok) {
      expect(out.response.debug?.acceptedAdditionalOwners).not.toContain(VERIFIED);
    }
    const passedOwners = vi.mocked(onboardSafeToCircles).mock.calls[0][0].owners;
    expect(passedOwners.map((a) => a.toLowerCase())).not.toContain(VERIFIED.toLowerCase());
  });
});

describe("onboardAccount — progress fan-out (CQ3)", () => {
  it("forwards the core's events to onProgress AND records them in debug.steps", async () => {
    // Drive the mock to emit a couple of progress events via the onProgress arg
    // the wrapper supplies, then resolve ok.
    vi.mocked(onboardSafeToCircles).mockImplementation(
      async (args, onProgress) => {
        onProgress?.({ type: "progress", stage: "predicting" });
        onProgress?.({ type: "progress", stage: "registering", attempt: 1 });
        return chainSuccess(args.owners);
      },
    );

    const received: OnboardProgress[] = [];
    const out = await onboardAccount({ ...base, onProgress: (e) => received.push(e) });

    // The external sink saw exactly the events the core emitted.
    expect(received).toEqual([
      { type: "progress", stage: "predicting" },
      { type: "progress", stage: "registering", attempt: 1 },
    ]);

    // ...and the SAME events left a `chain:` trail in the debug steps, so the two
    // sinks can never drift.
    expect(out.ok).toBe(true);
    if (out.ok) {
      const steps = out.response.debug?.steps ?? [];
      expect(steps).toContain("chain: predicting");
      expect(steps).toContain("chain: registering (attempt 1)");
    }
  });
});

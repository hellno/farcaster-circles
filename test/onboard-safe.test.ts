import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the circles chain layer BEFORE importing the core so its tests never
// touch a real chain. Mirrors the vi.mock pattern in test/onboard-account.test.ts.
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
  predictUserSafe: vi.fn(async () => ({ safeAddress: SAFE, kit: {} })),
  deployUserSafe: vi.fn(async () => ({ safeAddress: SAFE, txHash: null, alreadyDeployed: true })),
  assertSafeReady: vi.fn(async () => {}),
}));
vi.mock("@/lib/circles/invite", () => ({
  getHubStatus: vi.fn(),
  getQuota: vi.fn(),
  preflightInvite: vi.fn(),
  inviteSafe: vi.fn(async () => ({ txHashes: [] })),
}));

const SAFE = "0x" + "1".repeat(40);
const CONNECTED = "0x" + "c".repeat(40);
const AVATAR = "0x" + "9".repeat(40);
const ZERO = "0x" + "0".repeat(40);
const INVITE_HASHES = ["0x" + "a".repeat(64), "0x" + "b".repeat(64)];

const PREFLIGHT_OK = {
  ok: true,
  quota: 5n,
  checks: [
    { name: "quota", ok: true, detail: "quota=5" },
    { name: "inviter_human", ok: true, detail: "isHuman=true" },
  ],
  failed: null,
};

import { onboardSafeToCircles } from "@/lib/circles/onboard-safe";
import * as invite from "@/lib/circles/invite";
import * as safeMod from "@/lib/circles/safe";
import type { OnboardProgress } from "@/lib/types";

beforeEach(() => {
  // clearAllMocks wipes call history but NOT implementations set via mockRejectedValue
  // in a prior test, so re-assert every default impl each run for full isolation.
  vi.clearAllMocks();
  vi.mocked(safeMod.predictUserSafe).mockResolvedValue({ safeAddress: SAFE, kit: {} } as never);
  vi.mocked(safeMod.deployUserSafe).mockResolvedValue({
    safeAddress: SAFE,
    txHash: null,
    alreadyDeployed: true,
  } as never);
  vi.mocked(safeMod.assertSafeReady).mockResolvedValue(undefined);
  vi.mocked(invite.getQuota).mockResolvedValue(5n);
  vi.mocked(invite.preflightInvite).mockResolvedValue(PREFLIGHT_OK as never);
  vi.mocked(invite.getHubStatus).mockResolvedValue({ isHuman: false, avatar: ZERO } as never);
  vi.mocked(invite.inviteSafe).mockResolvedValue({ txHashes: INVITE_HASHES } as never);
});

/** Collect the stage of every emitted progress event into an ordered array. */
function makeSink() {
  const stages: string[] = [];
  const events: OnboardProgress[] = [];
  const onProgress = vi.fn((e: OnboardProgress) => {
    stages.push(e.stage);
    events.push(e);
  });
  return { stages, events, onProgress };
}

const base = { owners: [CONNECTED] };

describe("onboardSafeToCircles — happy path", () => {
  it("runs the full sequence, returns ok, and propagates txHashes", async () => {
    // already-registered short-circuit must NOT fire; flip to human only on the
    // poll so the whole sequence runs.
    vi.mocked(invite.getHubStatus)
      .mockResolvedValueOnce({ isHuman: false, avatar: ZERO } as never) // step 2 precheck
      .mockResolvedValueOnce({ isHuman: true, avatar: AVATAR } as never) // step 7 poll #1
      .mockResolvedValue({ isHuman: true, avatar: AVATAR } as never); // step 8 final

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.alreadyRegistered).toBe(false);
      expect(out.isHuman).toBe(true);
      expect(out.avatar).toBe(AVATAR);
      expect(out.safeAddress).toBe(SAFE);
      expect(out.owners).toEqual([CONNECTED]);
      expect(out.txHashes).toEqual(INVITE_HASHES);
    }

    expect(stages).toEqual([
      "predicting",
      "preflight",
      "deploying",
      "verifying",
      "inviting",
      "registering",
    ]);
  });
});

describe("onboardSafeToCircles — already-human idempotent short-circuit", () => {
  it("returns ok alreadyRegistered=true, stages=[predicting] only, no preflight/deploy/invite", async () => {
    vi.mocked(invite.getHubStatus).mockResolvedValue({ isHuman: true, avatar: AVATAR } as never);

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.alreadyRegistered).toBe(true);
      expect(out.isHuman).toBe(true);
      expect(out.avatar).toBe(AVATAR);
      expect(out.txHashes).toEqual([]);
    }

    expect(stages).toEqual(["predicting"]);
    expect(invite.preflightInvite).not.toHaveBeenCalled();
    expect(safeMod.deployUserSafe).not.toHaveBeenCalled();
    expect(invite.inviteSafe).not.toHaveBeenCalled();
  });
});

describe("onboardSafeToCircles — preflight failures", () => {
  it("no_quota when the preflight quota check fails — deploy NOT called, stages end at preflight", async () => {
    vi.mocked(invite.preflightInvite).mockResolvedValue({
      ok: false,
      quota: 0n,
      checks: [{ name: "quota", ok: false, detail: "quota=0" }],
      failed: { name: "quota", ok: false, detail: "quota=0" },
    } as never);

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("no_quota");
      expect(out.message).toBe("house inviter exhausted, request a new quota grant");
      expect(out.quota).toBe("0");
      expect(out.safeAddress).toBe(SAFE);
      expect(out.owners).toEqual([CONNECTED]);
      expect(out.txHashes).toEqual([]);
    }

    expect(stages).toEqual(["predicting", "preflight"]);
    expect(safeMod.deployUserSafe).not.toHaveBeenCalled();
  });

  it("inviter_unavailable when the inviter is not a registered human", async () => {
    vi.mocked(invite.preflightInvite).mockResolvedValue({
      ok: false,
      quota: 98n,
      checks: [
        { name: "quota", ok: true, detail: "quota=98" },
        { name: "inviter_human", ok: false, detail: "isHuman=false" },
      ],
      failed: { name: "inviter_human", ok: false, detail: "isHuman=false" },
    } as never);

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("inviter_unavailable");
      expect(out.message).toBe(
        "onboarding is temporarily unavailable — the inviter can't issue invites right now",
      );
      expect(out.quota).toBe("98");
    }

    expect(stages).toEqual(["predicting", "preflight"]);
    expect(safeMod.deployUserSafe).not.toHaveBeenCalled();
    expect(invite.inviteSafe).not.toHaveBeenCalled();
  });
});

describe("onboardSafeToCircles — on-chain step failures", () => {
  it("deploy_failed when deployUserSafe rejects — verifying NOT emitted", async () => {
    vi.mocked(safeMod.deployUserSafe).mockRejectedValue(new Error("deploy boom"));

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("deploy_failed");
      expect(out.message).toBe("deploy boom");
      expect(out.safeAddress).toBe(SAFE);
      expect(out.quota).toBe("5");
      expect(out.txHashes).toEqual([]);
    }

    expect(stages).toEqual(["predicting", "preflight", "deploying"]);
    expect(stages).not.toContain("verifying");
    expect(safeMod.assertSafeReady).not.toHaveBeenCalled();
  });

  it("safe_not_ready when assertSafeReady rejects", async () => {
    vi.mocked(safeMod.assertSafeReady).mockRejectedValue(new Error("not ready"));

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("safe_not_ready");
      expect(out.message).toBe("not ready");
    }

    expect(stages).toEqual(["predicting", "preflight", "deploying", "verifying"]);
    expect(invite.inviteSafe).not.toHaveBeenCalled();
  });

  it("invite_failed when inviteSafe rejects — txHashes stays []", async () => {
    vi.mocked(invite.inviteSafe).mockRejectedValue(new Error("invite boom"));

    const { stages, onProgress } = makeSink();
    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("invite_failed");
      expect(out.message).toBe("invite boom");
      expect(out.txHashes).toEqual([]);
    }

    expect(stages).toEqual([
      "predicting",
      "preflight",
      "deploying",
      "verifying",
      "inviting",
    ]);
  });

  it("not_registered when getHubStatus never flips to human — carries txHashes", async () => {
    // Stays isHuman:false for the precheck AND every poll. Fake timers so the
    // 12 x 2s poll loop resolves instantly instead of waiting ~24s.
    vi.mocked(invite.getHubStatus).mockResolvedValue({ isHuman: false, avatar: ZERO } as never);
    vi.useFakeTimers();

    const { stages, onProgress } = makeSink();
    const promise = onboardSafeToCircles(base, onProgress);
    // Drain the chained setTimeout(2000) waits between polls.
    await vi.runAllTimersAsync();
    const out = await promise;
    vi.useRealTimers();

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("not_registered");
      expect(out.message).toBe(
        "invite transactions sent but the Safe is not registered as human yet",
      );
      expect(out.txHashes).toEqual(INVITE_HASHES);
      expect(out.quota).toBe("5");
    }

    // One `registering` emit per poll attempt (12), 1-based attempt numbers.
    const registering = stages.filter((s) => s === "registering");
    expect(registering.length).toBe(12);
    expect(stages.slice(0, 5)).toEqual([
      "predicting",
      "preflight",
      "deploying",
      "verifying",
      "inviting",
    ]);
  });
});

describe("onboardSafeToCircles — progress sink robustness", () => {
  it("onProgress omitted (undefined): happy path still returns ok", async () => {
    vi.mocked(invite.getHubStatus)
      .mockResolvedValueOnce({ isHuman: false, avatar: ZERO } as never)
      .mockResolvedValue({ isHuman: true, avatar: AVATAR } as never);

    const out = await onboardSafeToCircles(base);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.alreadyRegistered).toBe(false);
      expect(out.txHashes).toEqual(INVITE_HASHES);
    }
  });

  it("a sink that THROWS on every call cannot break the chain", async () => {
    vi.mocked(invite.getHubStatus)
      .mockResolvedValueOnce({ isHuman: false, avatar: ZERO } as never)
      .mockResolvedValue({ isHuman: true, avatar: AVATAR } as never);

    const onProgress = vi.fn(() => {
      throw new Error("faulty sink");
    });

    const out = await onboardSafeToCircles(base, onProgress);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.alreadyRegistered).toBe(false);
      expect(out.avatar).toBe(AVATAR);
      expect(out.txHashes).toEqual(INVITE_HASHES);
    }
    // The sink WAS invoked (and threw) — proving the swallow path ran.
    expect(onProgress).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the BOUNDARIES detectAccount calls out to. Deliberately do NOT mock
// `@/lib/circles/safe` — buildCandidateOwnerSets must use the REAL
// normalizeOwners so the candidate-shape assertions are meaningful.
// (`safe.ts` imports env, which test/setup-env.ts provides; predictUserSafe is
// never reached because findRegisteredSafe is mocked.)
vi.mock("@/lib/farcaster/neynar", () => ({ fetchVerifiedEthAddresses: vi.fn() }));
vi.mock("@/lib/names", () => ({
  resolveNames: vi.fn(),
  recommendedSigners: vi.fn(),
}));
vi.mock("@/lib/circles/account-status", () => ({ findRegisteredSafe: vi.fn() }));
vi.mock("@/lib/circles/profile", () => ({
  readMetadataDigest: vi.fn(),
  isDigestSet: vi.fn(),
}));
vi.mock("@safe-global/protocol-kit", () => ({ default: { init: vi.fn() } }));

import Safe from "@safe-global/protocol-kit";
import {
  buildCandidateOwnerSets,
  detectAccount,
  MAX_VERIFIED_FANOUT,
} from "@/lib/onboarding/detect-account";
import { fetchVerifiedEthAddresses } from "@/lib/farcaster/neynar";
import { resolveNames, recommendedSigners } from "@/lib/names";
import { findRegisteredSafe } from "@/lib/circles/account-status";
import { readMetadataDigest, isDigestSet } from "@/lib/circles/profile";

// Distinct hex fixtures so normalizeOwners' sort/dedupe is observable.
const CONNECTED = "0x" + "c".repeat(40);
const RECOMMENDED = "0x" + "a".repeat(40); // sorts before CONNECTED (a < c)
const VERIFIED_EXTRA = "0x" + "e".repeat(40); // unnamed verified, sorts after CONNECTED
const SAFE = ("0x" + "5".repeat(40)) as `0x${string}`;
const ZERO_DIGEST = "0x" + "0".repeat(64);
const SET_DIGEST = "0x" + "f".repeat(64);

const FID = 7;

/** Lowercase + sort a set of addresses so expectations match normalizeOwners. */
function sortedLower(addrs: string[]): string[] {
  return [...addrs]
    .map((a) => a.toLowerCase())
    .sort((x, y) => x.localeCompare(y));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVerifiedEthAddresses).mockResolvedValue([] as never);
  vi.mocked(resolveNames).mockResolvedValue({} as never);
  vi.mocked(recommendedSigners).mockReturnValue([]);
  vi.mocked(findRegisteredSafe).mockResolvedValue(null);
  vi.mocked(readMetadataDigest).mockResolvedValue(ZERO_DIGEST as never);
  vi.mocked(isDigestSet).mockReturnValue(false);
  vi.mocked(Safe.init).mockResolvedValue({
    getOwners: vi.fn().mockResolvedValue([CONNECTED]),
  } as never);
});

describe("buildCandidateOwnerSets (pure)", () => {
  it("default shape: 3 distinct sets (C1 named, C2 connected-only, C3 all-verified)", () => {
    // recommended ⊂ verified, with an EXTRA unnamed verified so C3 differs from C1.
    const verified = [RECOMMENDED, VERIFIED_EXTRA];
    const recommended = [RECOMMENDED.toLowerCase()];

    const sets = buildCandidateOwnerSets(CONNECTED, verified, recommended);

    expect(sets).toHaveLength(3);
    // C1: connected + recommended
    expect(sets[0].map((a) => a.toLowerCase())).toEqual(
      sortedLower([CONNECTED, RECOMMENDED]),
    );
    // C2: connected only
    expect(sets[1].map((a) => a.toLowerCase())).toEqual([
      CONNECTED.toLowerCase(),
    ]);
    // C3: connected + all verified
    expect(sets[2].map((a) => a.toLowerCase())).toEqual(
      sortedLower([CONNECTED, RECOMMENDED, VERIFIED_EXTRA]),
    );
  });

  it("connected-only: no verified, no recommended → exactly one set [connected]", () => {
    const sets = buildCandidateOwnerSets(CONNECTED, [], []);
    expect(sets).toHaveLength(1);
    expect(sets[0].map((a) => a.toLowerCase())).toEqual([
      CONNECTED.toLowerCase(),
    ]);
  });

  it("all-verified differs: recommended ⊂ verified (unnamed extra) → C1/C2/C3 distinct", () => {
    const verified = [RECOMMENDED, VERIFIED_EXTRA];
    const recommended = [RECOMMENDED.toLowerCase()];

    const sets = buildCandidateOwnerSets(CONNECTED, verified, recommended);

    expect(sets).toHaveLength(3);
    const keys = sets.map((s) => s.join(","));
    expect(new Set(keys).size).toBe(3); // all distinct
  });

  it("dedup when no verified: C1 == C2 == C3 collapse → exactly one candidate", () => {
    // verified=[] → C3 == C2; recommended=[] → C1 == C2. All collapse.
    const sets = buildCandidateOwnerSets(CONNECTED, [], []);
    expect(sets).toHaveLength(1);
  });

  it("verified-set cap (Codex #10): 11 verified → C3 absent (only C1/C2)", () => {
    // 11 distinct verified addresses (> MAX_VERIFIED_FANOUT).
    const verified = Array.from(
      { length: MAX_VERIFIED_FANOUT + 1 },
      (_, i) => "0x" + i.toString(16).padStart(40, "0"),
    );
    const recommended = [verified[0].toLowerCase()];

    const sets = buildCandidateOwnerSets(CONNECTED, verified, recommended);

    // C3 (all-verified) is skipped → at most 2 sets (C1, C2).
    expect(sets.length).toBeLessThanOrEqual(2);
    // No candidate contains the whole 11-address verified set.
    for (const cand of sets) {
      expect(cand.length).toBeLessThan(verified.length + 1);
    }
  });
});

describe("detectAccount — candidate building / fail-soft", () => {
  it("verified-fetch failure → C2-only candidates ([[connected]])", async () => {
    vi.mocked(fetchVerifiedEthAddresses).mockRejectedValue(new Error("hub down"));

    await detectAccount(FID, CONNECTED);

    expect(findRegisteredSafe).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(findRegisteredSafe).mock.calls[0][0];
    expect(passed).toHaveLength(1);
    expect(passed[0].map((a) => a.toLowerCase())).toEqual([
      CONNECTED.toLowerCase(),
    ]);
  });

  it("over-cap STILL resolves names + builds C1; only C3 (all-verified) is skipped (Codex #10)", async () => {
    // RECOMMENDED (named) + 10 unnamed verified = 11 (> MAX_VERIFIED_FANOUT).
    const verified = [
      RECOMMENDED,
      ...Array.from(
        { length: MAX_VERIFIED_FANOUT },
        (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
      ),
    ];
    vi.mocked(fetchVerifiedEthAddresses).mockResolvedValue(verified as never);
    vi.mocked(recommendedSigners).mockReturnValue([RECOMMENDED.toLowerCase()]);

    await detectAccount(FID, CONNECTED);

    // Name resolution must mirror the UNCAPPED onboard signer picker — it runs
    // over the full verified set so detection reconstructs the same C1 the user's
    // Safe was created with (the bug this fixes: over-cap users wrongly hit Create).
    expect(resolveNames).toHaveBeenCalledWith(verified);
    expect(recommendedSigners).toHaveBeenCalled();

    const passed = vi.mocked(findRegisteredSafe).mock.calls[0][0];
    const keys = passed.map((c) => c.map((a) => a.toLowerCase()).join(","));
    // C1 = connected + recommended is probed...
    expect(keys).toContain(sortedLower([CONNECTED, RECOMMENDED]).join(","));
    // ...but the all-verified C3 candidate is skipped past the cap.
    for (const cand of passed) {
      expect(cand.length).toBeLessThan(verified.length + 1);
    }
  });
});

describe("detectAccount — found branch", () => {
  it("found + profileSet true + ownerMatch true", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(readMetadataDigest).mockResolvedValue(SET_DIGEST as never);
    vi.mocked(isDigestSet).mockReturnValue(true);
    vi.mocked(Safe.init).mockResolvedValue({
      getOwners: vi.fn().mockResolvedValue([CONNECTED]),
    } as never);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toEqual({
      found: true,
      safeAddress: SAFE,
      profileSet: true,
      ownerMatch: true,
    });
  });

  it("found + profileSet false", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(readMetadataDigest).mockResolvedValue(ZERO_DIGEST as never);
    vi.mocked(isDigestSet).mockReturnValue(false);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toMatchObject({ found: true, safeAddress: SAFE, profileSet: false });
  });

  it("digest read fails → profileSet:null, still found:true (Codex #6)", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(readMetadataDigest).mockRejectedValue(new Error("rpc down"));

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toMatchObject({ found: true, safeAddress: SAFE, profileSet: null });
  });

  it("ownerMatch:false when getOwners omits the connected wallet (Codex #7)", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(Safe.init).mockResolvedValue({
      getOwners: vi.fn().mockResolvedValue([RECOMMENDED]), // connected not present
    } as never);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toMatchObject({ found: true, ownerMatch: false });
  });

  it("ownerMatch:true (case-insensitive) when getOwners includes the connected wallet", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(Safe.init).mockResolvedValue({
      // returned uppercased to prove case-insensitive comparison
      getOwners: vi.fn().mockResolvedValue([CONNECTED.toUpperCase()]),
    } as never);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toMatchObject({ found: true, ownerMatch: true });
  });

  it("getOwners throws → ownerMatch:false, still found:true", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue({
      safeAddress: SAFE,
      owners: [SAFE],
    });
    vi.mocked(Safe.init).mockResolvedValue({
      getOwners: vi.fn().mockRejectedValue(new Error("rpc down")),
    } as never);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toMatchObject({ found: true, ownerMatch: false });
  });
});

describe("detectAccount — not found", () => {
  it("findRegisteredSafe → null → { found: false }", async () => {
    vi.mocked(findRegisteredSafe).mockResolvedValue(null);

    const res = await detectAccount(FID, CONNECTED);

    expect(res).toEqual({ found: false });
  });
});

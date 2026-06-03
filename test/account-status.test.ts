import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two chain boundaries BEFORE importing the module under test so the
// tests never touch a real chain. Mirrors the vi.mock pattern in
// test/onboard-safe.test.ts.
vi.mock("@/lib/circles/safe", () => ({ predictUserSafe: vi.fn() }));
vi.mock("@/lib/circles/invite", () => ({ getHubStatus: vi.fn() }));

import { findRegisteredSafe, type HumanCache } from "@/lib/circles/account-status";
import { predictUserSafe } from "@/lib/circles/safe";
import { getHubStatus } from "@/lib/circles/invite";
import type { Address } from "viem";

// One distinct owner-set per candidate slot; predictUserSafe maps each set to a
// deterministic, distinct safe so we can assert WHICH candidate matched.
const OWNERS_1 = ["0x" + "1".repeat(40)] as Address[];
const OWNERS_2 = ["0x" + "2".repeat(40)] as Address[];
const OWNERS_3 = ["0x" + "3".repeat(40)] as Address[];

const SAFE_1 = ("0x" + "a".repeat(40)) as Address;
const SAFE_2 = ("0x" + "b".repeat(40)) as Address;
const SAFE_3 = ("0x" + "c".repeat(40)) as Address;

// candidate first-owner -> predicted safe
const SAFE_FOR: Record<string, Address> = {
  [OWNERS_1[0]]: SAFE_1,
  [OWNERS_2[0]]: SAFE_2,
  [OWNERS_3[0]]: SAFE_3,
};

const ZERO = "0x" + "0".repeat(40);

beforeEach(() => {
  // clearAllMocks wipes call history but NOT impls set via mockRejectedValue in a
  // prior test, so re-assert every default impl each run for full isolation.
  vi.clearAllMocks();
  vi.mocked(predictUserSafe).mockImplementation(
    async (owners) =>
      ({ safeAddress: SAFE_FOR[(owners as Address[])[0]], kit: {} }) as never,
  );
  // default: nobody is human (per-test overrides drive the hits)
  vi.mocked(getHubStatus).mockResolvedValue({
    isHuman: false,
    avatar: ZERO,
  } as never);
});

/** Resolve getHubStatus from a set of safes that should report isHuman:true. */
function humansAre(...humans: Address[]) {
  const set = new Set(humans.map((h) => h.toLowerCase()));
  vi.mocked(getHubStatus).mockImplementation(
    async (addr) =>
      ({
        isHuman: set.has((addr as Address).toLowerCase()),
        avatar: ZERO,
      }) as never,
  );
}

/**
 * Fresh, never-caching cache for the read-driven tests so the module-level
 * `defaultHumanCache` (positive, monotonic, process-lifetime) can't leak a hit
 * from one test into the next.
 */
const noCache = (): HumanCache => ({ get: () => false, set: () => {} });

describe("findRegisteredSafe", () => {
  it("C1 hit skips C2/C3 (one predict, one read)", async () => {
    humansAre(SAFE_1);

    const result = await findRegisteredSafe(
      [OWNERS_1, OWNERS_2, OWNERS_3],
      noCache(),
    );

    expect(result).toEqual({ safeAddress: SAFE_1, owners: OWNERS_1 });
    expect(predictUserSafe).toHaveBeenCalledTimes(1);
    expect(getHubStatus).toHaveBeenCalledTimes(1);
  });

  it("C2 hit (two predicts, two reads)", async () => {
    humansAre(SAFE_2);

    const result = await findRegisteredSafe(
      [OWNERS_1, OWNERS_2, OWNERS_3],
      noCache(),
    );

    expect(result).toEqual({ safeAddress: SAFE_2, owners: OWNERS_2 });
    expect(predictUserSafe).toHaveBeenCalledTimes(2);
    expect(getHubStatus).toHaveBeenCalledTimes(2);
  });

  it("C3 hit (C1+C2 false, C3 true)", async () => {
    humansAre(SAFE_3);

    const result = await findRegisteredSafe(
      [OWNERS_1, OWNERS_2, OWNERS_3],
      noCache(),
    );

    expect(result).toEqual({ safeAddress: SAFE_3, owners: OWNERS_3 });
    expect(predictUserSafe).toHaveBeenCalledTimes(3);
    expect(getHubStatus).toHaveBeenCalledTimes(3);
  });

  it("no hit -> null, all candidates were read", async () => {
    // default impl: nobody human
    const result = await findRegisteredSafe(
      [OWNERS_1, OWNERS_2, OWNERS_3],
      noCache(),
    );

    expect(result).toBeNull();
    expect(predictUserSafe).toHaveBeenCalledTimes(3);
    expect(getHubStatus).toHaveBeenCalledTimes(3);
  });

  it("RPC throw propagates (errors are not swallowed)", async () => {
    vi.mocked(getHubStatus).mockRejectedValue(new Error("rpc"));

    await expect(
      findRegisteredSafe([OWNERS_1, OWNERS_2, OWNERS_3], noCache()),
    ).rejects.toThrow("rpc");
  });

  it("positive cache get short-circuits the read", async () => {
    const cache: HumanCache = {
      get: vi.fn((safe) => safe.toLowerCase() === SAFE_1.toLowerCase()),
      set: vi.fn(),
    };

    const result = await findRegisteredSafe([OWNERS_1, OWNERS_2, OWNERS_3], cache);

    expect(result).toEqual({ safeAddress: SAFE_1, owners: OWNERS_1 });
    expect(getHubStatus).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled(); // already cached -> no re-write
  });

  it("positive cache set on true only (never stores negatives)", async () => {
    const cache: HumanCache = { get: vi.fn(() => false), set: vi.fn() };

    // Hit on C2 -> set called once with SAFE_2.
    humansAre(SAFE_2);
    const hit = await findRegisteredSafe([OWNERS_1, OWNERS_2, OWNERS_3], cache);
    expect(hit).toEqual({ safeAddress: SAFE_2, owners: OWNERS_2 });
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(SAFE_2);

    // All-negative run -> set never called (negatives never stored).
    vi.mocked(cache.set).mockClear();
    vi.mocked(getHubStatus).mockResolvedValue({
      isHuman: false,
      avatar: ZERO,
    } as never);
    const miss = await findRegisteredSafe([OWNERS_1, OWNERS_2, OWNERS_3], cache);
    expect(miss).toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("key isolation: separate calls key set on the right safe", async () => {
    const cache: HumanCache = { get: vi.fn(() => false), set: vi.fn() };

    // First call: only C1 is human -> set(SAFE_1).
    humansAre(SAFE_1);
    await findRegisteredSafe([OWNERS_1, OWNERS_2], cache);

    // Second call: only C3 is human -> set(SAFE_3). No cross-pollination.
    humansAre(SAFE_3);
    await findRegisteredSafe([OWNERS_3, OWNERS_2], cache);

    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenNthCalledWith(1, SAFE_1);
    expect(cache.set).toHaveBeenNthCalledWith(2, SAFE_3);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// getHubStatus reads the Hub via getPublicClient().readContract. Mock the config
// boundary so we can drive the two reads (isHuman / avatars) independently and
// assert the avatar read is best-effort while isHuman stays authoritative.
vi.mock("@/lib/circles/config", () => ({
  HUB_V2: "0x" + "1".repeat(40),
  HUB_ABI: [],
  HOUSE_INVITER: "0x" + "2".repeat(40),
  getInviteFarm: vi.fn(),
  getInvitations: vi.fn(),
  getPublicClient: vi.fn(),
}));

import { getHubStatus } from "@/lib/circles/invite";
import { getPublicClient } from "@/lib/circles/config";

const ADDR = ("0x" + "a".repeat(40)) as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getHubStatus — avatar read is best-effort (isHuman authoritative)", () => {
  it("returns isHuman with a zeroAddress avatar when the avatars read fails", async () => {
    // A flaky avatars read must NOT turn an already-registered check into an
    // error — the Safe IS a human, the avatar is just cosmetic.
    const readContract = vi.fn((args: { functionName: string }) =>
      args.functionName === "isHuman"
        ? Promise.resolve(true)
        : Promise.reject(new Error("avatars revert")),
    );
    vi.mocked(getPublicClient).mockReturnValue({ readContract } as never);

    const res = await getHubStatus(ADDR);

    expect(res.isHuman).toBe(true);
    expect(res.avatar).toBe(ZERO);
  });

  it("still returns the real avatar on the happy path", async () => {
    const readContract = vi.fn((args: { functionName: string }) =>
      args.functionName === "isHuman" ? Promise.resolve(true) : Promise.resolve(ADDR),
    );
    vi.mocked(getPublicClient).mockReturnValue({ readContract } as never);

    const res = await getHubStatus(ADDR);

    expect(res).toEqual({ isHuman: true, avatar: ADDR });
  });

  it("propagates when the isHuman read fails (registration state truly unknown)", async () => {
    const readContract = vi.fn((args: { functionName: string }) =>
      args.functionName === "isHuman"
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve(ADDR),
    );
    vi.mocked(getPublicClient).mockReturnValue({ readContract } as never);

    await expect(getHubStatus(ADDR)).rejects.toThrow("rpc down");
  });
});

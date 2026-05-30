import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

import {
  normalizeOwners,
  buildAccountConfig,
  ENABLE_MODULES_DATA,
} from "@/lib/circles/safe";
import {
  INVITATION_MODULE,
  SAFE_4337_MODULE,
  SAFE_MODULE_SETUP,
} from "@/lib/circles/config";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("normalizeOwners", () => {
  it("dedupes case-insensitively", () => {
    expect(normalizeOwners([A, A.toUpperCase().replace("0X", "0x")])).toEqual([
      getAddress(A),
    ]);
  });
  it("checksums each address", () => {
    expect(normalizeOwners([A])).toEqual([getAddress(A)]);
  });
  it("sorts by lowercase deterministically regardless of input order", () => {
    expect(normalizeOwners([B, A])).toEqual(normalizeOwners([A, B]));
    expect(normalizeOwners([B, A])).toEqual([getAddress(A), getAddress(B)]);
  });
  it("skips invalid addresses", () => {
    expect(normalizeOwners(["not-an-address", "0x123", A])).toEqual([
      getAddress(A),
    ]);
  });
  it("returns [] for all-invalid input", () => {
    expect(normalizeOwners(["x", ""])).toEqual([]);
  });
});

describe("ENABLE_MODULES_DATA byte-equality", () => {
  it("encodes enableModules([INVITATION_MODULE, SAFE_4337_MODULE])", () => {
    const expected = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "enableModules",
          stateMutability: "nonpayable",
          inputs: [{ name: "modules", type: "address[]" }],
          outputs: [],
        },
      ] as const,
      functionName: "enableModules",
      args: [[INVITATION_MODULE, SAFE_4337_MODULE]],
    });
    expect(ENABLE_MODULES_DATA).toBe(expected);
  });
});

describe("buildAccountConfig", () => {
  it("threshold 1, module setup as `to`, 4337 as fallback handler", () => {
    const cfg = buildAccountConfig(normalizeOwners([A, B]));
    expect(cfg.threshold).toBe(1);
    expect(cfg.to).toBe(SAFE_MODULE_SETUP);
    expect(cfg.fallbackHandler).toBe(SAFE_4337_MODULE);
    expect(cfg.data).toBe(ENABLE_MODULES_DATA);
  });
});

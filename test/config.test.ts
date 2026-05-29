import { describe, it, expect } from "vitest";

import { HOUSE_INVITER } from "@/lib/circles/config";
import { env } from "@/lib/env";

describe("circles/config — HOUSE_INVITER single source of truth (D7)", () => {
  it("HOUSE_INVITER equals env.INVITER_SAFE_ADDRESS", () => {
    expect(HOUSE_INVITER.toLowerCase()).toBe(
      env.INVITER_SAFE_ADDRESS.toLowerCase(),
    );
  });

  it("HOUSE_INVITER is a checksummed 20-byte address", () => {
    expect(HOUSE_INVITER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

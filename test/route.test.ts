import { describe, it, expect } from "vitest";

import { STATUS } from "@/app/api/onboard/route";
import type { OnboardErrorCode } from "@/lib/types";

describe("onboard route — STATUS map", () => {
  const expected: Record<OnboardErrorCode, number> = {
    unauthorized: 401,
    invalid_request: 400,
    gated: 403,
    no_quota: 503,
    deploy_failed: 500,
    safe_not_ready: 500,
    invite_failed: 500,
    not_registered: 502,
    server_error: 500,
  };

  it("maps every OnboardErrorCode to the correct HTTP status", () => {
    expect(STATUS).toEqual(expected);
  });

  it("is exhaustive over the union (no missing or extra codes)", () => {
    const allCodes: OnboardErrorCode[] = [
      "unauthorized", "invalid_request", "gated", "no_quota",
      "deploy_failed", "safe_not_ready", "invite_failed",
      "not_registered", "server_error",
    ];
    expect(Object.keys(STATUS).sort()).toEqual([...allCodes].sort());
    for (const code of allCodes) {
      expect(typeof STATUS[code]).toBe("number");
    }
  });
});

import { describe, it, expect } from "vitest";

import { evaluateGate, type GatePolicy } from "@/lib/farcaster/gating-policy";
import type { SpamSignals } from "@/lib/types";

function signals(over: Partial<SpamSignals> = {}): SpamSignals {
  return {
    fid: 100,
    isOperator: false,
    allowlisted: false,
    powerBadge: null,
    operatorFollowsUser: null,
    userFollowsOperator: null,
    mutualWithOperator: null,
    verifiedAddressCount: 0,
    ...over,
  };
}

describe("evaluateGate — bypass", () => {
  it("operator always allowed regardless of policy", () => {
    const r = evaluateGate("powerBadgeAndMutual", signals({ isOperator: true }));
    expect(r).toEqual({ allowed: true, reason: "operator" });
  });
  it("allowlisted fid always allowed regardless of policy", () => {
    const r = evaluateGate("mutual", signals({ allowlisted: true }));
    expect(r).toEqual({ allowed: true, reason: "allowlisted fid" });
  });
});

describe("evaluateGate — off", () => {
  it("allows even with no signals", () => {
    expect(evaluateGate("off", signals()).allowed).toBe(true);
  });
});

describe("evaluateGate — powerBadge", () => {
  it("allows with power badge", () => {
    expect(evaluateGate("powerBadge", signals({ powerBadge: true })).allowed).toBe(true);
  });
  it("blocks without power badge", () => {
    expect(evaluateGate("powerBadge", signals({ powerBadge: false })).allowed).toBe(false);
  });
  it("blocks on null power badge (fail-closed)", () => {
    expect(evaluateGate("powerBadge", signals({ powerBadge: null })).allowed).toBe(false);
  });
});

describe("evaluateGate — mutual", () => {
  it("allows on mutual", () => {
    expect(evaluateGate("mutual", signals({ mutualWithOperator: true })).allowed).toBe(true);
  });
  it("blocks without mutual", () => {
    expect(evaluateGate("mutual", signals({ mutualWithOperator: false })).allowed).toBe(false);
  });
  it("blocks on null mutual (fail-closed)", () => {
    expect(evaluateGate("mutual", signals({ mutualWithOperator: null })).allowed).toBe(false);
  });
});

describe("evaluateGate — powerBadgeOrMutual", () => {
  it("allows when only power badge", () => {
    expect(evaluateGate("powerBadgeOrMutual",
      signals({ powerBadge: true, mutualWithOperator: false })).allowed).toBe(true);
  });
  it("allows when only mutual", () => {
    expect(evaluateGate("powerBadgeOrMutual",
      signals({ powerBadge: false, mutualWithOperator: true })).allowed).toBe(true);
  });
  it("blocks when neither", () => {
    expect(evaluateGate("powerBadgeOrMutual",
      signals({ powerBadge: false, mutualWithOperator: false })).allowed).toBe(false);
  });
});

describe("evaluateGate — powerBadgeAndMutual", () => {
  it("allows when both", () => {
    expect(evaluateGate("powerBadgeAndMutual",
      signals({ powerBadge: true, mutualWithOperator: true })).allowed).toBe(true);
  });
  it("blocks when only one", () => {
    expect(evaluateGate("powerBadgeAndMutual",
      signals({ powerBadge: true, mutualWithOperator: false })).allowed).toBe(false);
    expect(evaluateGate("powerBadgeAndMutual",
      signals({ powerBadge: false, mutualWithOperator: true })).allowed).toBe(false);
  });
  it("blocks when neither", () => {
    expect(evaluateGate("powerBadgeAndMutual",
      signals({ powerBadge: false, mutualWithOperator: false })).allowed).toBe(false);
  });
});

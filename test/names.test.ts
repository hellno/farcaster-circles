import { describe, it, expect } from "vitest";

import { recommendedSigners } from "@/lib/names";
import type { NameInfo } from "@/lib/types";

function info(over: Partial<NameInfo> = {}): NameInfo {
  return { address: "0x0", ens: null, basename: null, primary: null, ...over };
}

const NAMED = "0xAAaAAAaaAAAAaAAAaaAaAAAaAAAaaaAAaAAaAAAa";
const NAMED_LOWER = NAMED.toLowerCase();
const PLAIN = "0xBbBBbBBbbBBbbBbbBBBbBbBBBbBBbBBBBbbBBBbB";
const PLAIN_LOWER = PLAIN.toLowerCase();

describe("recommendedSigners", () => {
  it("recommends only addresses with a distinct (ENS / basename) primary name", () => {
    const names: Record<string, NameInfo> = {
      [NAMED_LOWER]: info({ ens: "vitalik.eth", primary: "vitalik.eth" }),
      [PLAIN_LOWER]: info(),
    };
    expect(recommendedSigners([NAMED, PLAIN], names)).toEqual([NAMED_LOWER]);
  });

  it("recommends a basename-only address (no ENS)", () => {
    const names: Record<string, NameInfo> = {
      [NAMED_LOWER]: info({ basename: "alice.base.eth", primary: "alice.base.eth" }),
    };
    expect(recommendedSigners([NAMED], names)).toEqual([NAMED_LOWER]);
  });

  it("recommends nothing when no address resolves to a name", () => {
    expect(recommendedSigners([NAMED, PLAIN], {})).toEqual([]);
  });

  it("returns lowercased keys regardless of input casing", () => {
    const names: Record<string, NameInfo> = {
      [NAMED_LOWER]: info({ primary: "x.eth" }),
    };
    expect(recommendedSigners([NAMED.toUpperCase()], names)).toEqual([
      NAMED_LOWER,
    ]);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";

import { fetchFarcasterCard } from "@/lib/farcaster/neynar";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function userData(type: string, value: string) {
  return { data: { userDataBody: { type, value } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFarcasterCard", () => {
  // Regression (stale-pfp bug): the keyless public hub (hub.pinata.cloud) serves
  // FROZEN snapshots and answers 200, so the old hub-first order baked a
  // months-old pfp into the share card and the on-chain Circles avatar. The card
  // MUST prefer live Neynar and not even consult the hub when Neynar answers —
  // even if the hub would also return (stale) data.
  it("uses live Neynar, not the stale hub, when both have data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/v2/farcaster/user/bulk")) {
        return jsonResponse({
          users: [
            {
              fid: 7,
              username: "carol",
              display_name: "Carol",
              pfp_url: "https://pfp/new.png",
            },
          ],
        });
      }
      if (url.includes("/v1/userDataByFid")) {
        return jsonResponse({
          messages: [userData("USER_DATA_TYPE_PFP", "https://pfp/STALE.png")],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchFarcasterCard(7)).toEqual({
      username: "carol",
      displayName: "Carol",
      pfpUrl: "https://pfp/new.png",
    });
    // The frozen hub must not be consulted at all when Neynar answers.
    expect(
      fetchMock.mock.calls.some(([u]) =>
        String(u).includes("/v1/userDataByFid"),
      ),
    ).toBe(false);
  });

  it("falls back displayName to username when Neynar omits display_name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v2/farcaster/user/bulk")) {
          return jsonResponse({
            users: [{ fid: 1, username: "bob", pfp_url: "https://pfp/bob.png" }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    expect(await fetchFarcasterCard(1)).toEqual({
      username: "bob",
      displayName: "bob",
      pfpUrl: "https://pfp/bob.png",
    });
  });

  it("falls back to the hub when Neynar returns no user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v2/farcaster/user/bulk")) {
          return jsonResponse({ users: [] });
        }
        if (url.includes("/v1/userDataByFid")) {
          return jsonResponse({
            messages: [
              userData("USER_DATA_TYPE_PFP", "https://pfp/alice.png"),
              userData("USER_DATA_TYPE_DISPLAY", "Alice"),
              userData("USER_DATA_TYPE_USERNAME", "alice"),
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    expect(await fetchFarcasterCard(123)).toEqual({
      username: "alice",
      displayName: "Alice",
      pfpUrl: "https://pfp/alice.png",
    });
  });

  it("falls back to the hub (display→username) when Neynar errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v2/farcaster/user/bulk")) {
          return jsonResponse({}, false, 500);
        }
        if (url.includes("/v1/userDataByFid")) {
          return jsonResponse({
            messages: [
              userData("USER_DATA_TYPE_USERNAME", "dan"),
              userData("USER_DATA_TYPE_PFP", "https://pfp/dan.png"),
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const card = await fetchFarcasterCard(8);
    expect(card).toEqual({
      username: "dan",
      displayName: "dan",
      pfpUrl: "https://pfp/dan.png",
    });
  });

  it("returns null when both Neynar and the hub fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 500)));
    expect(await fetchFarcasterCard(9)).toBeNull();
  });
});

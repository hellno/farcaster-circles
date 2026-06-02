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
  it("parses pfp / display / username from the free hub", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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

  it("falls back displayName to username when the hub omits display", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/userDataByFid")) {
          return jsonResponse({
            messages: [
              userData("USER_DATA_TYPE_USERNAME", "bob"),
              userData("USER_DATA_TYPE_PFP", "https://pfp/bob.png"),
            ],
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

  it("falls back to Neynar when the hub has no usable data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/userDataByFid")) {
          return jsonResponse({ messages: [] });
        }
        if (url.includes("/v2/farcaster/user/bulk")) {
          return jsonResponse({
            users: [
              {
                fid: 7,
                username: "carol",
                display_name: "Carol",
                pfp_url: "https://pfp/carol.png",
              },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    expect(await fetchFarcasterCard(7)).toEqual({
      username: "carol",
      displayName: "Carol",
      pfpUrl: "https://pfp/carol.png",
    });
  });

  it("falls back to Neynar when the hub errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/userDataByFid")) {
          return jsonResponse({}, false, 500);
        }
        if (url.includes("/v2/farcaster/user/bulk")) {
          return jsonResponse({
            users: [{ fid: 8, username: "dan", display_name: "Dan", pfp_url: "" }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const card = await fetchFarcasterCard(8);
    expect(card?.username).toBe("dan");
  });

  it("returns null when both the hub and Neynar fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 500)));
    expect(await fetchFarcasterCard(9)).toBeNull();
  });
});

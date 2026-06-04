import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the boundaries the route depends on so we exercise the route's transport
// logic (pre-stream JSON branches + the SSE stream) without auth, env, or any
// real onboarding work.
vi.mock("@/lib/farcaster/auth", () => ({
  verifyQuickAuth: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  isDebugEnabled: vi.fn(() => false),
}));
vi.mock("@/lib/onboarding/onboard-account", () => ({
  onboardAccount: vi.fn(),
  // The route still imports buildDebug for its outer-catch error path.
  buildDebug: vi.fn(() => undefined),
}));

import { POST } from "@/app/api/onboard/route";
import { STATUS } from "@/lib/onboarding/status";
import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { onboardAccount } from "@/lib/onboarding/onboard-account";
import { parseSseFrames } from "@/lib/sse";
import type { OnboardErrorCode } from "@/lib/types";

const CONNECTED = "0x" + "c".repeat(40);
const SAFE = "0x" + "1".repeat(40);
const AVATAR = "0x" + "9".repeat(40);

function postRequest(body: unknown, withAuth = true): Request {
  return new Request("http://test/api/onboard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Drain an SSE Response body into ordered parsed JSON frames. */
async function readFrames(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  const { messages } = parseSseFrames(text);
  return messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyQuickAuth).mockResolvedValue({ fid: 7 });
});

describe("onboard route — STATUS map", () => {
  const expected: Record<OnboardErrorCode, number> = {
    unauthorized: 401,
    invalid_request: 400,
    gated: 403,
    no_quota: 503,
    inviter_unavailable: 503,
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
      "inviter_unavailable", "deploy_failed", "safe_not_ready",
      "invite_failed", "not_registered", "server_error",
    ];
    expect(Object.keys(STATUS).sort()).toEqual([...allCodes].sort());
    for (const code of allCodes) {
      expect(typeof STATUS[code]).toBe("number");
    }
  });
});

describe("onboard route — pre-stream JSON branches", () => {
  it("401 JSON when Quick Auth fails (no stream opened)", async () => {
    vi.mocked(verifyQuickAuth).mockResolvedValue(null);

    const res = await POST(postRequest({ connectedAddress: CONNECTED }, false));

    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(onboardAccount).not.toHaveBeenCalled();
  });

  it("400 JSON when the body is invalid (bad connectedAddress)", async () => {
    const res = await POST(postRequest({ connectedAddress: "nope" }));

    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(onboardAccount).not.toHaveBeenCalled();
  });
});

describe("onboard route — SSE stream", () => {
  it("streams progress frames then a terminal `result` frame on success", async () => {
    vi.mocked(onboardAccount).mockImplementation(async (args) => {
      // Emit a couple of progress ticks via the route-supplied sink, then resolve.
      args.onProgress?.({ type: "progress", stage: "predicting" });
      args.onProgress?.({ type: "progress", stage: "deploying", safeAddress: SAFE });
      return {
        ok: true,
        response: {
          safeAddress: SAFE,
          isHuman: true,
          avatar: AVATAR,
          modules: { invitation: true, erc4337: true },
          txHashes: [],
          alreadyRegistered: false,
        },
      };
    });

    const res = await POST(postRequest({ connectedAddress: CONNECTED }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");

    const frames = await readFrames(res);
    expect(frames).toEqual([
      { type: "progress", stage: "predicting" },
      { type: "progress", stage: "deploying", safeAddress: SAFE },
      {
        type: "result",
        result: {
          safeAddress: SAFE,
          isHuman: true,
          avatar: AVATAR,
          modules: { invitation: true, erc4337: true },
          txHashes: [],
          alreadyRegistered: false,
        },
      },
    ]);
  });

  it("delivers a flow failure as a terminal `error` frame (HTTP stays 200)", async () => {
    vi.mocked(onboardAccount).mockResolvedValue({
      ok: false,
      code: "no_quota",
      message: "house inviter exhausted, request a new quota grant",
    });

    const res = await POST(postRequest({ connectedAddress: CONNECTED }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const frames = await readFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "error",
      error: {
        error: "no_quota",
        message: "house inviter exhausted, request a new quota grant",
      },
    });
  });

  it("carries txHashes in the terminal error frame when present", async () => {
    const hashes = ["0x" + "a".repeat(64)];
    vi.mocked(onboardAccount).mockResolvedValue({
      ok: false,
      code: "not_registered",
      message: "invite transactions sent but the Safe is not registered as human yet",
      txHashes: hashes,
    });

    const res = await POST(postRequest({ connectedAddress: CONNECTED }));
    const frames = await readFrames(res);

    expect(frames[frames.length - 1]).toMatchObject({
      type: "error",
      error: { error: "not_registered", txHashes: hashes },
    });
  });
});

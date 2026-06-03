import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercise the route's transport + branching by mocking its boundaries: auth and
// the detection core. The route's job is orchestration (Quick Auth 401, zod 400,
// and — the load-bearing bit — fail-open to 200 found:false on ANY detect
// failure, D4) — not the detection work itself.
vi.mock("@/lib/farcaster/auth", () => ({ verifyQuickAuth: vi.fn() }));
vi.mock("@/lib/onboarding/detect-account", () => ({ detectAccount: vi.fn() }));

import { POST } from "@/app/api/account-status/route";
import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { detectAccount } from "@/lib/onboarding/detect-account";

const CONNECTED = "0x" + "c".repeat(40);
const SAFE = "0x" + "1".repeat(40);

function post(body: unknown, withAuth = true): Request {
  return new Request("http://test/api/account-status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyQuickAuth).mockResolvedValue({ fid: 7 });
  vi.mocked(detectAccount).mockResolvedValue({ found: false });
});

describe("account-status route — auth + body validation", () => {
  it("401 when Quick Auth fails (detection never runs)", async () => {
    vi.mocked(verifyQuickAuth).mockResolvedValue(null);
    const res = await POST(post({ connectedAddress: CONNECTED }, false));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
    expect(detectAccount).not.toHaveBeenCalled();
  });

  it("400 when connectedAddress is malformed (detection never runs)", async () => {
    const res = await POST(post({ connectedAddress: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(detectAccount).not.toHaveBeenCalled();
  });

  it("400 when connectedAddress is missing", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(detectAccount).not.toHaveBeenCalled();
  });
});

describe("account-status route — detection (200)", () => {
  it("200 found:true (full) and calls detectAccount with (fid, connectedAddress)", async () => {
    const status = {
      found: true,
      safeAddress: SAFE,
      profileSet: true,
      ownerMatch: true,
    };
    vi.mocked(detectAccount).mockResolvedValue(status);
    const res = await POST(post({ connectedAddress: CONNECTED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
    expect(detectAccount).toHaveBeenCalledWith(7, CONNECTED);
  });

  it("200 echoes profileSet:false", async () => {
    const status = {
      found: true,
      safeAddress: SAFE,
      profileSet: false,
      ownerMatch: true,
    };
    vi.mocked(detectAccount).mockResolvedValue(status);
    const res = await POST(post({ connectedAddress: CONNECTED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it("200 echoes profileSet:null (digest read failed, still found)", async () => {
    const status = {
      found: true,
      safeAddress: SAFE,
      profileSet: null,
      ownerMatch: true,
    };
    vi.mocked(detectAccount).mockResolvedValue(status);
    const res = await POST(post({ connectedAddress: CONNECTED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it("200 echoes ownerMatch:false (connected wallet no longer an owner)", async () => {
    const status = {
      found: true,
      safeAddress: SAFE,
      profileSet: true,
      ownerMatch: false,
    };
    vi.mocked(detectAccount).mockResolvedValue(status);
    const res = await POST(post({ connectedAddress: CONNECTED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it("200 found:false when no Safe is detected", async () => {
    vi.mocked(detectAccount).mockResolvedValue({ found: false });
    const res = await POST(post({ connectedAddress: CONNECTED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
  });
});

describe("account-status route — fail-open (D4)", () => {
  it("detect throws → 200 found:false + server log (never gates onboarding)", async () => {
    vi.mocked(detectAccount).mockRejectedValue(new Error("rpc throttled"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(post({ connectedAddress: CONNECTED }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

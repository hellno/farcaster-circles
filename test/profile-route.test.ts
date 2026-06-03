import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercise the route's transport + branching by mocking its boundaries: auth,
// the Farcaster identity lookup, and the whole chain/profile core. The route's
// job is orchestration (idempotency short-circuit, no-name 422, prepare/relay
// shaping, error mapping) — not the chain work itself.
vi.mock("@/lib/farcaster/auth", () => ({ verifyQuickAuth: vi.fn() }));
vi.mock("@/lib/farcaster/neynar", () => ({ fetchFarcasterCard: vi.fn() }));
vi.mock("@/lib/circles/profile", () => ({
  readMetadataDigest: vi.fn(),
  isDigestSet: vi.fn(),
  circlesProfileName: vi.fn(),
  buildCirclesProfile: vi.fn(),
  uploadProfile: vi.fn(),
  cidV0ToDigest: vi.fn(),
  digestToCidV0: vi.fn(),
  fetchSavedProfile: vi.fn(),
  prepareProfileTx: vi.fn(),
  relayProfileTx: vi.fn(),
}));

import { POST } from "@/app/api/profile/route";
import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { fetchFarcasterCard } from "@/lib/farcaster/neynar";
import {
  readMetadataDigest,
  isDigestSet,
  circlesProfileName,
  buildCirclesProfile,
  uploadProfile,
  cidV0ToDigest,
  digestToCidV0,
  fetchSavedProfile,
  prepareProfileTx,
  relayProfileTx,
} from "@/lib/circles/profile";

const SAFE = "0x" + "1".repeat(40);
const SIGNER = "0x" + "c".repeat(40);
const SIG = "0x" + "b".repeat(130);
const DIGEST = "0x" + "e".repeat(64);
const ZERO = "0x" + "0".repeat(64);
const TX_HASH = "0x" + "a".repeat(64);
const TYPED_DATA = {
  types: { SafeTx: [] },
  primaryType: "SafeTx",
  domain: { chainId: "100" },
  message: {},
};

function post(body: unknown, withAuth = true): Request {
  return new Request("http://test/api/profile", {
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
  vi.mocked(readMetadataDigest).mockResolvedValue(ZERO as `0x${string}`);
  vi.mocked(isDigestSet).mockReturnValue(false);
  vi.mocked(fetchFarcasterCard).mockResolvedValue({
    username: "alice",
    displayName: "Alice",
    pfpUrl: "https://cdn.example/p.png",
  });
  vi.mocked(circlesProfileName).mockReturnValue("Alice");
  vi.mocked(buildCirclesProfile).mockResolvedValue({
    name: "Alice",
    previewImageUrl: "data:image/jpeg;base64,AAA",
  });
  vi.mocked(uploadProfile).mockResolvedValue("Qmcid");
  vi.mocked(cidV0ToDigest).mockReturnValue(DIGEST as `0x${string}`);
  vi.mocked(digestToCidV0).mockReturnValue(DIGEST as `0x${string}`);
  vi.mocked(fetchSavedProfile).mockResolvedValue(null);
  vi.mocked(prepareProfileTx).mockResolvedValue(TYPED_DATA);
  vi.mocked(relayProfileTx).mockResolvedValue(TX_HASH as `0x${string}`);
});

describe("profile route — auth + body validation", () => {
  it("401 when Quick Auth fails", async () => {
    vi.mocked(verifyQuickAuth).mockResolvedValue(null);
    const res = await POST(post({ step: "prepare", safeAddress: SAFE }, false));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
    expect(readMetadataDigest).not.toHaveBeenCalled();
  });

  it("400 when step is missing / unknown", async () => {
    const res = await POST(post({ safeAddress: SAFE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("400 when safeAddress is malformed", async () => {
    const res = await POST(post({ step: "prepare", safeAddress: "nope" }));
    expect(res.status).toBe(400);
  });

  it("400 on relay with a missing/short signature (no broadcast)", async () => {
    const res = await POST(
      post({
        step: "relay",
        safeAddress: SAFE,
        digest: DIGEST,
        signerAddress: SIGNER,
        signature: "0x12",
      }),
    );
    expect(res.status).toBe(400);
    expect(relayProfileTx).not.toHaveBeenCalled();
  });

  it("400 on relay with a malformed digest", async () => {
    const res = await POST(
      post({
        step: "relay",
        safeAddress: SAFE,
        digest: "0xabc",
        signerAddress: SIGNER,
        signature: SIG,
      }),
    );
    expect(res.status).toBe(400);
    expect(relayProfileTx).not.toHaveBeenCalled();
  });
});

describe("profile route — prepare", () => {
  it("short-circuits with alreadySet when a digest is already set (idempotent)", async () => {
    vi.mocked(isDigestSet).mockReturnValue(true);
    const res = await POST(post({ step: "prepare", safeAddress: SAFE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alreadySet: true });
    expect(uploadProfile).not.toHaveBeenCalled();
    expect(prepareProfileTx).not.toHaveBeenCalled();
  });

  it("422 no_profile when the fid has no usable name", async () => {
    vi.mocked(circlesProfileName).mockReturnValue(null);
    const res = await POST(post({ step: "prepare", safeAddress: SAFE }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_profile");
    expect(uploadProfile).not.toHaveBeenCalled();
  });

  it("uploads + builds typed data and returns the prepare payload", async () => {
    const res = await POST(post({ step: "prepare", safeAddress: SAFE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      alreadySet: false,
      name: "Alice",
      hasImage: true,
      hasBio: false,
      digest: DIGEST,
      typedData: TYPED_DATA,
    });
    expect(uploadProfile).toHaveBeenCalledTimes(1);
    expect(prepareProfileTx).toHaveBeenCalledWith(SAFE, DIGEST);
  });

  it("502 upload_failed when the profile service rejects", async () => {
    vi.mocked(uploadProfile).mockRejectedValue(new Error("pin 500"));
    const res = await POST(post({ step: "prepare", safeAddress: SAFE }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("upload_failed");
    expect(prepareProfileTx).not.toHaveBeenCalled();
  });
});

describe("profile route — prepare (overwrite / edit)", () => {
  it("overwrite, changed: builds typed data from name + bio overrides", async () => {
    // isDigestSet would short-circuit the legacy path — assert overwrite skips it.
    vi.mocked(isDigestSet).mockReturnValue(true);
    // current on-chain digest differs from the rebuilt one (cidV0ToDigest → DIGEST).
    vi.mocked(readMetadataDigest).mockResolvedValue(ZERO as `0x${string}`);
    vi.mocked(buildCirclesProfile).mockResolvedValue({
      name: "Bob",
      description: "new bio",
      previewImageUrl: "data:image/jpeg;base64,AAA",
    });

    const res = await POST(
      post({
        step: "prepare",
        safeAddress: SAFE,
        name: "Bob",
        description: "new bio",
        overwrite: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      alreadySet: false,
      name: "Bob",
      description: "new bio",
      hasImage: true,
      hasBio: true,
      digest: DIGEST,
      typedData: TYPED_DATA,
    });
    expect(buildCirclesProfile).toHaveBeenCalledWith(expect.anything(), {
      name: "Bob",
      description: "new bio",
    });
    expect(prepareProfileTx).toHaveBeenCalledWith(SAFE, DIGEST);
  });

  it("overwrite, unchanged: returns { noChange: true } without preparing/relaying (D6)", async () => {
    // The rebuilt digest equals the current on-chain digest.
    vi.mocked(readMetadataDigest).mockResolvedValue(DIGEST as `0x${string}`);
    vi.mocked(cidV0ToDigest).mockReturnValue(DIGEST as `0x${string}`);

    const res = await POST(
      post({
        step: "prepare",
        safeAddress: SAFE,
        name: "Alice",
        overwrite: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noChange: true });
    // upload happens BEFORE the compare; the signature steps are skipped.
    expect(uploadProfile).toHaveBeenCalledTimes(1);
    expect(prepareProfileTx).not.toHaveBeenCalled();
    expect(relayProfileTx).not.toHaveBeenCalled();
  });

  it("overwrite, no usable name: 422 no_profile", async () => {
    vi.mocked(buildCirclesProfile).mockResolvedValue(null);
    const res = await POST(
      post({ step: "prepare", safeAddress: SAFE, overwrite: true }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_profile");
    expect(uploadProfile).not.toHaveBeenCalled();
    expect(prepareProfileTx).not.toHaveBeenCalled();
  });

  it("overwrite, name falls back to the Farcaster name: 200 (not 422)", async () => {
    // No name in the body — builder derives it from the card's Farcaster name.
    vi.mocked(buildCirclesProfile).mockResolvedValue({
      name: "Alice",
      previewImageUrl: "data:image/jpeg;base64,AAA",
    });
    const res = await POST(
      post({ step: "prepare", safeAddress: SAFE, overwrite: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadySet).toBe(false);
    expect(body.name).toBe("Alice");
  });

  it("overwrite, oversized bio within zod max: clamped by the builder, not rejected (no 400)", async () => {
    const longBio = "x".repeat(8000);
    vi.mocked(buildCirclesProfile).mockResolvedValue({
      name: "Alice",
      description: "x".repeat(256), // builder clamp (unit-tested in T2)
      previewImageUrl: "data:image/jpeg;base64,AAA",
    });
    const res = await POST(
      post({
        step: "prepare",
        safeAddress: SAFE,
        overwrite: true,
        description: longBio,
      }),
    );
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
  });
});

describe("profile route — current", () => {
  it("returns the saved profile", async () => {
    vi.mocked(fetchSavedProfile).mockResolvedValue({
      name: "Saved",
      description: "saved bio",
    });

    const res = await POST(post({ step: "current", safeAddress: SAFE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Saved",
      description: "saved bio",
    });
  });

  it("returns nulls when nothing is saved", async () => {
    vi.mocked(fetchSavedProfile).mockResolvedValue(null);

    const res = await POST(post({ step: "current", safeAddress: SAFE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: null,
      description: null,
    });
  });
});

describe("profile route — relay", () => {
  it("relays the signed tx once and returns the tx hash", async () => {
    const res = await POST(
      post({
        step: "relay",
        safeAddress: SAFE,
        digest: DIGEST,
        signerAddress: SIGNER,
        signature: SIG,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: TX_HASH });
    expect(relayProfileTx).toHaveBeenCalledTimes(1);
    expect(relayProfileTx).toHaveBeenCalledWith({
      safe: SAFE,
      digest: DIGEST,
      signerAddress: SIGNER,
      signature: SIG,
    });
  });

  it("502 relay_failed when execution / confirmation fails", async () => {
    vi.mocked(relayProfileTx).mockRejectedValue(new Error("GS026"));
    const res = await POST(
      post({
        step: "relay",
        safeAddress: SAFE,
        digest: DIGEST,
        signerAddress: SIGNER,
        signature: SIG,
      }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("relay_failed");
  });
});

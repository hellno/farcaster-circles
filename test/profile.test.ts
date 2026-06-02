import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock state, declared via vi.hoisted so the hoisted vi.mock factories
// below can close over it without hitting the temporal-dead-zone trap.
const h = vi.hoisted(() => {
  const TX_HASH = "0x" + "a".repeat(64);
  const SAFE = "0x" + "1".repeat(40);
  const kit = {
    createTransaction: vi.fn(),
    getContractVersion: vi.fn(() => "1.4.1"),
    getChainId: vi.fn(async () => 100n),
    executeTransaction: vi.fn(async () => ({ hash: TX_HASH })),
  };
  const publicClient = {
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(async () => ({})),
  };
  return { TX_HASH, SAFE, kit, publicClient };
});

// Mock the chain boundaries so the unit tests never touch a real node:
//  - protocol-kit `Safe` (build / sign / execute) → a controllable kit.
//  - `getPublicClient` → a fake for the NameRegistry read + receipt wait.
// Everything else (pure helpers, fetch-based upload/thumbnail) runs for real;
// `global.fetch` is stubbed per test.
vi.mock("@safe-global/protocol-kit", () => ({
  default: { init: vi.fn(async () => h.kit) },
  EthSafeSignature: vi.fn((signer: string, signature: string) => ({
    signer,
    signature,
  })),
  generateTypedData: vi.fn(() => ({
    types: { SafeTx: [{ name: "to", type: "address" }] },
    primaryType: "SafeTx",
    domain: { chainId: 100n, verifyingContract: h.SAFE },
    message: { to: "0x", value: 0n, nonce: 0n },
  })),
}));

vi.mock("@/lib/circles/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/circles/config")>();
  return { ...actual, getPublicClient: vi.fn(() => h.publicClient) };
});

import Safe, {
  EthSafeSignature,
  generateTypedData,
} from "@safe-global/protocol-kit";
import { NAME_REGISTRY } from "@/lib/circles/config";
import {
  buildCirclesProfile,
  cidV0ToDigest,
  circlesProfileName,
  encodeUpdateMetadataDigest,
  isDigestSet,
  makeAvatarThumbnail,
  MAX_PROFILE_NAME,
  prepareProfileTx,
  readMetadataDigest,
  relayProfileTx,
  uploadProfile,
} from "@/lib/circles/profile";

const { TX_HASH, SAFE } = h;
const SIGNER = ("0x" + "c".repeat(40)) as `0x${string}`;
const SIG = "0x" + "b".repeat(130);
// A real Circles CIDv0 and its bare 32-byte sha2-256 digest (verified on-chain).
const CID = "QmeSfDUEg5yc2UMSHwFgNs8wP53j8P3qugwuppiH8169E9";
const CID_DIGEST =
  "0xef450c518c23ba95b860a2dd4680222687048b7d7452352ba58c93f674ae1dc2";
const ZERO_DIGEST = "0x" + "0".repeat(64);

beforeEach(() => {
  // Clears call history only — factory implementations survive.
  vi.clearAllMocks();
});

function card(
  over: Partial<{ username: string; displayName: string; pfpUrl: string }>,
) {
  return { username: "", displayName: "", pfpUrl: "", ...over };
}

describe("circlesProfileName", () => {
  it("prefers displayName", () => {
    expect(
      circlesProfileName(card({ displayName: "Alice", username: "al" })),
    ).toBe("Alice");
  });

  it("falls back to username when displayName is empty", () => {
    expect(circlesProfileName(card({ username: "alice" }))).toBe("alice");
  });

  it("returns null when neither is present", () => {
    expect(circlesProfileName(card({}))).toBeNull();
    expect(circlesProfileName(null)).toBeNull();
  });

  it("trims and clamps an over-length name to MAX_PROFILE_NAME", () => {
    const long = "x".repeat(MAX_PROFILE_NAME + 20);
    const out = circlesProfileName(card({ displayName: long }))!;
    expect(out).toHaveLength(MAX_PROFILE_NAME);
  });

  it("treats whitespace-only as no name", () => {
    expect(circlesProfileName(card({ displayName: "   " }))).toBeNull();
  });
});

describe("cidV0ToDigest", () => {
  it("decodes a real CIDv0 to its bare 32-byte digest", () => {
    expect(cidV0ToDigest(CID)).toBe(CID_DIGEST);
  });

  it("throws on a non-CIDv0 string", () => {
    expect(() => cidV0ToDigest("not-a-cid!")).toThrow();
  });
});

describe("isDigestSet", () => {
  it("is false for the zero digest, true otherwise (case-insensitive)", () => {
    expect(isDigestSet(ZERO_DIGEST)).toBe(false);
    expect(isDigestSet(CID_DIGEST)).toBe(true);
    expect(isDigestSet(CID_DIGEST.toUpperCase())).toBe(true);
  });
});

describe("makeAvatarThumbnail", () => {
  it("returns null for empty / non-http inputs (no fetch)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    expect(await makeAvatarThumbnail(null)).toBeNull();
    expect(await makeAvatarThumbnail("")).toBeNull();
    expect(await makeAvatarThumbnail("ipfs://Qm...")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resizes via the images.weserv.nl proxy and returns a base64 data URI", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(jpeg, { status: 200 }));
    const out = await makeAvatarThumbnail("https://cdn.example/pfp.png");
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("images.weserv.nl");
    expect(url).toContain("output=jpg");
    expect(url).toContain("w=256");
    // The source URL is forwarded (scheme stripped, encoded).
    expect(url).toContain(encodeURIComponent("cdn.example/pfp.png"));
  });

  it("returns null on a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 502 }),
    );
    expect(await makeAvatarThumbnail("https://cdn.example/pfp.png")).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    expect(await makeAvatarThumbnail("https://cdn.example/pfp.png")).toBeNull();
  });

  it("returns null when the encoded thumbnail is too large", async () => {
    const big = new Uint8Array(300_000); // base64 ≈ 400KB > cap
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(big, { status: 200 }),
    );
    expect(await makeAvatarThumbnail("https://cdn.example/pfp.png")).toBeNull();
  });
});

describe("buildCirclesProfile", () => {
  it("returns null when there is no usable name", async () => {
    expect(await buildCirclesProfile(card({}))).toBeNull();
  });

  it("includes a previewImageUrl when the thumbnail succeeds", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const p = await buildCirclesProfile(
      card({ displayName: "Alice", pfpUrl: "https://cdn.example/p.png" }),
    );
    expect(p?.name).toBe("Alice");
    expect(p?.previewImageUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("keeps the name but omits the image when the thumbnail fails", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    const p = await buildCirclesProfile(
      card({ displayName: "Alice", pfpUrl: "https://cdn.example/p.png" }),
    );
    expect(p).toEqual({ name: "Alice" });
  });
});

describe("uploadProfile", () => {
  it("POSTs the profile to the service `/pin` endpoint and returns the cid", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ cid: CID }), { status: 200 }));
    const cid = await uploadProfile({ name: "Alice" });
    expect(cid).toBe(CID);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/pin$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: "Alice",
    });
  });

  it("throws on a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("nope", { status: 400 }),
    );
    await expect(uploadProfile({ name: "Alice" })).rejects.toThrow();
  });

  it("throws when the service returns no cid", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(uploadProfile({ name: "Alice" })).rejects.toThrow();
  });
});

describe("encodeUpdateMetadataDigest", () => {
  it("encodes the updateMetadataDigest(bytes32) selector + arg", () => {
    const data = encodeUpdateMetadataDigest(CID_DIGEST);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBe(2 + 8 + 64); // 0x + 4-byte selector + 32-byte arg
    expect(data.endsWith(CID_DIGEST.slice(2))).toBe(true);
  });
});

describe("readMetadataDigest", () => {
  it("reads avatarToMetaDataDigest from the NameRegistry", async () => {
    h.publicClient.readContract.mockResolvedValue(CID_DIGEST);
    const out = await readMetadataDigest(SAFE);
    expect(out).toBe(CID_DIGEST);
    expect(h.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: NAME_REGISTRY,
        functionName: "avatarToMetaDataDigest",
        args: [SAFE],
      }),
    );
  });
});

describe("prepareProfileTx", () => {
  it("builds a single NameRegistry write and returns its EIP-712 typed data", async () => {
    h.kit.createTransaction.mockResolvedValue({
      data: { to: NAME_REGISTRY, value: "0", nonce: 0 },
    });
    const typedData = await prepareProfileTx(SAFE, CID_DIGEST);

    expect(Safe.init).toHaveBeenCalledWith(
      expect.objectContaining({ safeAddress: SAFE }),
    );
    const txArg = h.kit.createTransaction.mock.calls[0][0].transactions[0];
    expect(txArg.to).toBe(NAME_REGISTRY);
    expect(txArg.value).toBe("0");
    expect(txArg.data).toBe(encodeUpdateMetadataDigest(CID_DIGEST));
    expect(generateTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        safeAddress: SAFE,
        safeVersion: "1.4.1",
        chainId: 100n,
      }),
    );
    // bigints serialized to strings so it survives JSON / eth_signTypedData_v4.
    expect(typedData.domain.chainId).toBe("100");
    expect(typedData.primaryType).toBe("SafeTx");
  });
});

describe("relayProfileTx", () => {
  beforeEach(() => {
    h.kit.createTransaction.mockResolvedValue({
      data: { to: NAME_REGISTRY, value: "0", nonce: 0 },
      addSignature: vi.fn(),
    });
  });

  it("attaches the owner signature, executes once as the operator, and confirms the digest", async () => {
    h.publicClient.readContract.mockResolvedValue(CID_DIGEST); // digest stuck
    const hash = await relayProfileTx({
      safe: SAFE,
      digest: CID_DIGEST,
      signerAddress: SIGNER,
      signature: SIG,
    });

    expect(hash).toBe(TX_HASH);
    // Target is always the NameRegistry — the client cannot redirect it.
    const txArg = h.kit.createTransaction.mock.calls[0][0].transactions[0];
    expect(txArg.to).toBe(NAME_REGISTRY);
    expect(txArg.data).toBe(encodeUpdateMetadataDigest(CID_DIGEST));
    expect(EthSafeSignature).toHaveBeenCalledWith(SIGNER, SIG);
    expect(h.kit.executeTransaction).toHaveBeenCalledTimes(1);
    expect(h.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
    });
  });

  it("throws if the digest did not stick (lying ExecutionSuccess / bad signature)", async () => {
    h.publicClient.readContract.mockResolvedValue(ZERO_DIGEST);
    await expect(
      relayProfileTx({
        safe: SAFE,
        digest: CID_DIGEST,
        signerAddress: SIGNER,
        signature: SIG,
      }),
    ).rejects.toThrow();
  });
});

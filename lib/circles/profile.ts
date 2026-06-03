import "server-only";

import {
  bytesToHex,
  encodeFunctionData,
  hexToBytes,
  type Address,
  type Hash,
} from "viem";
import Safe, {
  EthSafeSignature,
  generateTypedData,
} from "@safe-global/protocol-kit";
import type { Profile } from "@aboutcircles/sdk-types";

import { env } from "@/lib/env";
import {
  NAME_REGISTRY,
  NAME_REGISTRY_ABI,
  getCirclesConfig,
  getPublicClient,
} from "@/lib/circles/config";
import type { FarcasterCard } from "@/lib/farcaster/neynar";
import type { ProfileTypedData } from "@/lib/types";

/**
 * Set a freshly onboarded Safe's Circles profile (name + avatar) from the user's
 * Farcaster identity. Mechanism A (issue #5): the profile metadata is uploaded to
 * the Circles profile service (off-chain, IPFS-pinned) and its CID digest is
 * written on-chain to the NameRegistry BY the avatar (the user's Safe). Since the
 * operator is NOT an owner of that Safe, the USER signs the Safe tx once
 * (EIP-712, gas-free) and the operator relays `execTransaction` (pays gas).
 *
 * This whole module is a failure-isolated, post-success step: it lives entirely
 * outside `/api/onboard` and a failure here never affects onboarding.
 */

/** Circles convention: profile names are short. Clamp to avoid service rejects. */
export const MAX_PROFILE_NAME = 36;
/** Circles profile bios are short. Clamp (do NOT reject), mirroring MAX_PROFILE_NAME. */
export const MAX_PROFILE_DESCRIPTION = 256;
/** Avatar thumbnail target — small enough to inline as a base64 data URI. */
const THUMB_PX = 256;
/** Defensive cap on the encoded thumbnail; skip the image if it exceeds this. */
const MAX_THUMB_DATA_URI = 200_000;

const ZERO_DIGEST =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The Circles profile `name` derived from a Farcaster card: prefer the display
 * name, fall back to the username. Trimmed and clamped. Returns null when the
 * card carries neither (the "Set profile" action is then unavailable).
 */
export function circlesProfileName(card: FarcasterCard | null): string | null {
  if (!card) return null;
  const raw = (card.displayName || card.username || "").trim();
  if (!raw) return null;
  return raw.length > MAX_PROFILE_NAME ? raw.slice(0, MAX_PROFILE_NAME) : raw;
}

/**
 * Decode a CIDv0 ("Qm…", base58btc of `0x12 0x20 <32-byte sha2-256>`) to the
 * bare 32-byte digest the NameRegistry stores. Verified against a live Circles
 * profile CID (see test/profile.test.ts). Throws on a malformed CID.
 */
export function cidV0ToDigest(cidV0: string): `0x${string}` {
  const decoded = base58Decode(cidV0);
  if (decoded.length !== 34 || decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`not a CIDv0 (expected 34-byte 0x1220… multihash): ${cidV0}`);
  }
  return bytesToHex(decoded.subarray(2)); // drop the multihash prefix
}

/**
 * Encode a bare 32-byte NameRegistry digest back to its CIDv0 ("Qm…") — the
 * inverse of cidV0ToDigest. Prepends the 0x12 0x20 sha2-256 multihash prefix and
 * base58btc-encodes. Round-trips with cidV0ToDigest (see test). Throws on a
 * non-32-byte digest.
 */
export function digestToCidV0(digest: `0x${string}`): string {
  const body = hexToBytes(digest);
  if (body.length !== 32) {
    throw new Error(`expected a 32-byte digest: ${digest}`);
  }
  const full = new Uint8Array(34);
  full[0] = 0x12;
  full[1] = 0x20;
  full.set(body, 2);
  return base58Encode(full);
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58btc decode (Bitcoin alphabet). */
function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of str) {
    const val = BASE58_ALPHABET.indexOf(ch);
    if (val === -1) throw new Error(`invalid base58 char: ${ch}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" maps to a leading zero byte.
  for (const ch of str) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

/** Minimal base58btc encode (Bitcoin alphabet) — inverse of base58Decode. */
function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  // Each leading zero byte maps to a leading "1".
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let k = digits.length - 1; k >= 0; k--) out += BASE58_ALPHABET[digits[k]];
  return out;
}

/**
 * Fetch the Farcaster pfp, resize to a small square JPEG, and base64-encode it
 * as a `data:` URI for the profile's `previewImageUrl` — the format the Circles
 * app actually renders (confirmed: live profiles store inline base64 thumbnails,
 * not remote URLs). Resizing is delegated to the dependency-free images.weserv.nl
 * proxy. Best-effort: any failure returns null so the name still gets set.
 */
export async function makeAvatarThumbnail(
  pfpUrl: string | null | undefined,
): Promise<string | null> {
  if (!pfpUrl) return null;
  const m = /^https?:\/\/(.+)$/i.exec(pfpUrl.trim());
  if (!m) return null; // only remote http(s) images are resizable via the proxy
  try {
    const proxied =
      `https://images.weserv.nl/?url=${encodeURIComponent(m[1])}` +
      `&w=${THUMB_PX}&h=${THUMB_PX}&fit=cover&output=jpg&q=80`;
    const res = await fetch(proxied, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const dataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
    if (dataUri.length > MAX_THUMB_DATA_URI) return null;
    return dataUri;
  } catch {
    return null;
  }
}

/**
 * Build the Circles `Profile` from a Farcaster card: name (required) + an inline
 * avatar thumbnail (best-effort). Returns null when there's no usable name.
 *
 * Optional `overrides` let the user supply their own name/description (the edit
 * flow): a non-empty override name wins over the card's Farcaster name, and a
 * non-empty description is added. Both are trimmed and clamped (NOT rejected) to
 * MAX_PROFILE_NAME / MAX_PROFILE_DESCRIPTION. Whitespace-only overrides are
 * ignored. The no-args call is unchanged (purely additive).
 */
export async function buildCirclesProfile(
  card: FarcasterCard | null,
  overrides?: { name?: string; description?: string },
): Promise<Profile | null> {
  const overrideName = overrides?.name?.trim();
  const name = overrideName
    ? overrideName.slice(0, MAX_PROFILE_NAME)
    : circlesProfileName(card);
  if (!name) return null;
  const previewImageUrl = await makeAvatarThumbnail(card?.pfpUrl);
  const profile: Profile = previewImageUrl ? { name, previewImageUrl } : { name };
  const d = overrides?.description?.trim();
  if (d) profile.description = d.slice(0, MAX_PROFILE_DESCRIPTION);
  return profile;
}

/**
 * Upload a profile to the Circles profile service (IPFS pin) and return its
 * CIDv0. Mirrors `@circles-sdk/profiles` `Profiles.create` (POST `…/pin` →
 * `{ cid }`); hand-rolled to avoid a production dependency on a package that is
 * otherwise only a transitive devDependency. Throws on a non-2xx response.
 */
export async function uploadProfile(profile: Profile): Promise<string> {
  const base = getCirclesConfig().profileServiceUrl;
  const url = `${base.endsWith("/") ? base : base + "/"}pin`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `profile service ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { cid?: string };
  if (!data.cid) throw new Error("profile service returned no cid");
  return data.cid;
}

/** Read a Safe's current NameRegistry metadata digest (ZERO_DIGEST == unset). */
export async function readMetadataDigest(safe: Address): Promise<`0x${string}`> {
  const digest = await getPublicClient().readContract({
    address: NAME_REGISTRY,
    abi: NAME_REGISTRY_ABI,
    functionName: "avatarToMetaDataDigest",
    args: [safe],
  });
  return digest as `0x${string}`;
}

/** True when the Safe already has a profile digest set (idempotency guard). */
export function isDigestSet(digest: string): boolean {
  return digest.toLowerCase() !== ZERO_DIGEST;
}

/**
 * Read a Safe's currently saved Circles profile via the profile service. Reads
 * the on-chain digest, converts it to its CIDv0, and GETs the pinned doc
 * (`…/get?cid=<cid>`, the read counterpart to uploadProfile's `…/pin`). Returns
 * only the fields we prefill with. Best-effort: an unset digest OR any
 * read/parse failure returns null (caller falls back to a Farcaster default).
 */
export async function fetchSavedProfile(safe: Address): Promise<Profile | null> {
  try {
    const digest = await readMetadataDigest(safe);
    if (!isDigestSet(digest)) return null;
    const cid = digestToCidV0(digest);
    const base = getCirclesConfig().profileServiceUrl;
    const url = `${base.endsWith("/") ? base : base + "/"}get?cid=${cid}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<Profile>;
    if (!data || typeof data.name !== "string") return null;
    const out: Profile = { name: data.name };
    if (typeof data.description === "string") out.description = data.description;
    return out;
  } catch {
    return null;
  }
}

/** Calldata for `NameRegistry.updateMetadataDigest(digest)`. */
export function encodeUpdateMetadataDigest(digest: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: NAME_REGISTRY_ABI,
    functionName: "updateMetadataDigest",
    args: [digest],
  });
}

/** Recursively stringify bigints so the typed data is JSON-serializable. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        jsonSafe(v),
      ]),
    );
  }
  return value;
}

/**
 * Build the unsigned `updateMetadataDigest` Safe transaction for the user's Safe
 * and return its EIP-712 typed data for the client to sign. The server fully
 * controls `to`/`value`/`data` (a single NameRegistry write); the only variable
 * is the on-chain Safe nonce, read by protocol-kit at build time.
 */
export async function prepareProfileTx(
  safe: Address,
  digest: `0x${string}`,
): Promise<ProfileTypedData> {
  const kit = await initUserSafe(safe);
  const safeTx = await kit.createTransaction({
    transactions: [
      { to: NAME_REGISTRY, value: "0", data: encodeUpdateMetadataDigest(digest) },
    ],
  });
  const typedData = generateTypedData({
    safeAddress: safe,
    safeVersion: kit.getContractVersion(),
    chainId: await kit.getChainId(),
    data: safeTx.data,
  });
  return jsonSafe(typedData) as ProfileTypedData;
}

/**
 * Relay the user-signed profile transaction: rebuild the EXACT Safe tx the user
 * signed (server-controlled to/value/data; same on-chain nonce), attach the
 * owner signature, and submit `execTransaction` AS the operator (pays gas, not
 * an owner). A bad/expired signature simply reverts on-chain (safe failure). We
 * re-assert the digest stuck afterward, since a Safe's `ExecutionSuccess` lies.
 */
export async function relayProfileTx(args: {
  safe: Address;
  digest: `0x${string}`;
  signerAddress: Address;
  signature: string;
}): Promise<Hash> {
  const { safe, digest, signerAddress, signature } = args;
  const kit = await initUserSafe(safe);
  const safeTx = await kit.createTransaction({
    transactions: [
      { to: NAME_REGISTRY, value: "0", data: encodeUpdateMetadataDigest(digest) },
    ],
  });
  safeTx.addSignature(new EthSafeSignature(signerAddress, signature));

  const res = await kit.executeTransaction(safeTx);
  const hash = res.hash as Hash;
  await getPublicClient().waitForTransactionReceipt({ hash });

  const after = await readMetadataDigest(safe);
  if (after.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(
      "execTransaction succeeded but the metadata digest was not set (likely an invalid signature)",
    );
  }
  return hash;
}

/** protocol-kit bound to the USER's Safe, with the operator as the gas payer. */
function initUserSafe(safe: Address): Promise<Safe> {
  return Safe.init({
    provider: env.GNOSIS_RPC_URL,
    signer: env.DEPLOYER_PK,
    safeAddress: safe,
  });
}

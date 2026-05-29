import "server-only";

import {
  createPublicClient,
  getAddress,
  http,
  namehash,
  type Address,
} from "viem";
import { base, mainnet } from "viem/chains";

import { env } from "./env";
import type { NameInfo } from "./types";

// Base L2 resolver used by Basenames for reverse records.
const BASE_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as Address;
const L2_RESOLVER_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "string" }],
  },
] as const;

// NOTE: clients are created per-call (cheap, a couple per onboarding) rather than
// memoized in a shared-typed variable — annotating a mainnet and a Base client
// with the same `PublicClient` type triggers viem's "two unrelated PublicClient
// types" error. Local consts let each keep its own inferred chain type.

/** Mainnet ENS reverse (.eth). null on no record or failure. */
async function resolveEns(address: Address): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(env.ETH_RPC_URL),
    });
    return await client.getEnsName({ address });
  } catch {
    return null;
  }
}

/** Base basename reverse (.base.eth) via the L2 resolver. null on none/failure. */
async function resolveBasename(address: Address): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: base,
      transport: http(env.BASE_RPC_URL),
    });
    const node = namehash(`${address.toLowerCase().slice(2)}.addr.reverse`);
    const name = await client.readContract({
      address: BASE_L2_RESOLVER,
      abi: L2_RESOLVER_ABI,
      functionName: "name",
      args: [node],
    });
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Resolve one address to its ENS + basename, with a `primary` (ENS preferred). */
export async function resolveName(addr: string): Promise<NameInfo> {
  const address = getAddress(addr);
  const [ens, basename] = await Promise.all([
    resolveEns(address),
    resolveBasename(address),
  ]);
  return { address, ens, basename, primary: ens ?? basename ?? null };
}

/**
 * Resolve many addresses to names, keyed by lowercased address. Dedupes input
 * and resolves all concurrently. Invalid addresses are skipped.
 */
export async function resolveNames(
  addresses: string[],
): Promise<Record<string, NameInfo>> {
  const uniq = new Map<string, string>();
  for (const a of addresses) {
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) uniq.set(a.toLowerCase(), a);
  }
  const results = await Promise.all(
    [...uniq.values()].map((a) => resolveName(a)),
  );
  const map: Record<string, NameInfo> = {};
  for (const r of results) map[r.address.toLowerCase()] = r;
  return map;
}

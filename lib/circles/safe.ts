import Safe from "@safe-global/protocol-kit";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

import { env } from "@/lib/env";
import {
  INVITATION_MODULE,
  SAFE_4337_MODULE,
  SAFE_MODULE_SETUP,
} from "@/lib/circles/config";

// keccak256 of a stable label so every onboard produces the same Safe address
// for a given owner set. protocol-kit coerces this 0x-hex string to uint256.
export const SALT_NONCE: string = keccak256(
  encodePacked(["string"], ["farcaster-circles:onboard:v1"]),
);

const ENABLE_MODULES_ABI = [
  {
    type: "function",
    name: "enableModules",
    stateMutability: "nonpayable",
    inputs: [{ name: "modules", type: "address[]" }],
    outputs: [],
  },
] as const;

// delegatecall payload run during Safe setup (to: SAFE_MODULE_SETUP) that
// enables the invitation module and the 4337 module on the new Safe.
export const ENABLE_MODULES_DATA = encodeFunctionData({
  abi: ENABLE_MODULES_ABI,
  functionName: "enableModules",
  args: [[INVITATION_MODULE, SAFE_4337_MODULE]],
});

export function normalizeOwners(addrs: string[]): Address[] {
  const seen = new Set<string>();
  const owners: Address[] = [];
  for (const raw of addrs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) continue;
    const checksummed = getAddress(raw);
    const key = checksummed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(checksummed);
  }
  // Sort by lowercase so the owner array (and thus the predicted Safe address)
  // is deterministic regardless of input ordering.
  owners.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return owners;
}

export function buildAccountConfig(owners: Address[]): {
  owners: string[];
  threshold: number;
  to: string;
  data: string;
  fallbackHandler: string;
} {
  return {
    owners,
    threshold: 1,
    to: SAFE_MODULE_SETUP,
    data: ENABLE_MODULES_DATA,
    fallbackHandler: SAFE_4337_MODULE,
  };
}

export async function predictUserSafe(
  owners: Address[],
): Promise<{ safeAddress: Address; kit: Safe }> {
  const kit = await Safe.init({
    provider: env.GNOSIS_RPC_URL,
    signer: env.DEPLOYER_PK,
    predictedSafe: {
      safeAccountConfig: buildAccountConfig(owners),
      safeDeploymentConfig: {
        safeVersion: "1.4.1",
        saltNonce: SALT_NONCE,
      },
    },
  });
  const safeAddress = (await kit.getAddress()) as Address;
  return { safeAddress, kit };
}

export async function deployUserSafe(
  owners: Address[],
): Promise<{ safeAddress: Address; txHash: Hash | null; alreadyDeployed: boolean }> {
  const { safeAddress, kit } = await predictUserSafe(owners);

  if (await kit.isSafeDeployed()) {
    return { safeAddress, txHash: null, alreadyDeployed: true };
  }

  const deployTx = await kit.createSafeDeploymentTransaction();

  const account = privateKeyToAccount(env.DEPLOYER_PK as Hex);
  const wallet = createWalletClient({
    account,
    chain: gnosis,
    transport: http(env.GNOSIS_RPC_URL),
  });

  const txHash = await wallet.sendTransaction({
    to: deployTx.to as Address,
    value: BigInt(deployTx.value),
    data: deployTx.data as Hex,
  });

  const publicClient = createPublicClient({
    chain: gnosis,
    transport: http(env.GNOSIS_RPC_URL),
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { safeAddress, txHash, alreadyDeployed: false };
}

export async function assertSafeReady(
  addr: Address,
  owners: Address[],
): Promise<void> {
  const kit = await Safe.init({
    provider: env.GNOSIS_RPC_URL,
    safeAddress: addr,
  });

  if (!(await kit.isSafeDeployed())) {
    throw new Error(`assertSafeReady: Safe ${addr} is not deployed`);
  }

  if (!(await kit.isModuleEnabled(INVITATION_MODULE))) {
    throw new Error(
      `assertSafeReady: invitation module ${INVITATION_MODULE} not enabled on ${addr}`,
    );
  }

  if (!(await kit.isModuleEnabled(SAFE_4337_MODULE))) {
    throw new Error(
      `assertSafeReady: 4337 module ${SAFE_4337_MODULE} not enabled on ${addr}`,
    );
  }

  const fallbackHandler = await kit.getFallbackHandler();
  if (fallbackHandler.toLowerCase() !== SAFE_4337_MODULE.toLowerCase()) {
    throw new Error(
      `assertSafeReady: fallbackHandler is ${fallbackHandler}, expected ${SAFE_4337_MODULE}`,
    );
  }

  const threshold = await kit.getThreshold();
  if (threshold !== 1) {
    throw new Error(`assertSafeReady: threshold is ${threshold}, expected 1`);
  }

  const version = await kit.getContractVersion();
  if (version !== "1.4.1") {
    throw new Error(
      `assertSafeReady: contract version is ${version}, expected 1.4.1`,
    );
  }

  const onchainOwners = new Set(
    (await kit.getOwners()).map((o) => o.toLowerCase()),
  );
  for (const owner of owners) {
    if (!onchainOwners.has(owner.toLowerCase())) {
      throw new Error(
        `assertSafeReady: expected owner ${owner} is not present on Safe ${addr}`,
      );
    }
  }
}

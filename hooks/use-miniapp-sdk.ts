"use client";

import { useEffect, useState } from "react";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export interface MiniappUser {
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
}

export interface MiniappState {
  fid: number | null;
  token: string | null;
  ready: boolean;
  inHost: boolean;
  error: string | null;
  provider: Eip1193Provider | null;
  chains: string[] | null;
  user: MiniappUser | null;
  /** The complete, unmodified Farcaster mini-app SDK context (debug only). */
  contextRaw: unknown;
}

const INITIAL_STATE: MiniappState = {
  fid: null,
  token: null,
  ready: false,
  inHost: false,
  error: null,
  provider: null,
  chains: null,
  user: null,
  contextRaw: null,
};

interface MiniappWallet {
  getEthereumProvider?: () => Promise<Eip1193Provider | null | undefined>;
  ethProvider?: Eip1193Provider | null;
}

export function useMiniappSdk(): MiniappState {
  const [state, setState] = useState<MiniappState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        const context = await sdk.context;
        const ctxUser = context?.user;
        const fid = ctxUser?.fid ?? null;
        const user: MiniappUser | null = ctxUser
          ? {
              username: ctxUser.username ?? null,
              displayName: ctxUser.displayName ?? null,
              pfpUrl: ctxUser.pfpUrl ?? null,
            }
          : null;

        let token: string | null = null;
        try {
          const result = await sdk.quickAuth.getToken();
          token = result?.token ?? null;
        } catch {
          token = null;
        }

        let provider: Eip1193Provider | null = null;
        try {
          const wallet = sdk.wallet as unknown as MiniappWallet;
          provider = (await wallet.getEthereumProvider?.()) ?? wallet.ethProvider ?? null;
        } catch {
          provider = null;
        }

        let chains: string[] | null = null;
        try {
          const getChains = (sdk as unknown as { getChains?: () => Promise<string[]> })
            .getChains;
          chains = (await getChains?.()) ?? null;
        } catch {
          chains = null;
        }

        if (cancelled) return;

        setState({
          fid,
          token,
          ready: false,
          inHost: true,
          error: null,
          provider,
          chains,
          user,
          contextRaw: context ?? null,
        });

        requestAnimationFrame(() => {
          sdk.actions.ready().catch(() => {});
          if (!cancelled) {
            setState((prev) => ({ ...prev, ready: true }));
          }
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          fid: null,
          token: null,
          ready: false,
          inHost: false,
          error: err instanceof Error ? err.message : "Failed to initialize Mini App SDK",
          provider: null,
          chains: null,
          user: null,
          contextRaw: null,
        });
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

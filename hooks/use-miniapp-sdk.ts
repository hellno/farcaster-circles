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

        // Detect the Farcaster host first. In a normal browser tab this is
        // false, and the host-only calls below (context, quickAuth, wallet)
        // would otherwise throw "Failed to fetch" / postMessage timeouts.
        const inHost = await sdk.isInMiniApp();
        if (!inHost) {
          if (!cancelled) {
            setState({ ...INITIAL_STATE, inHost: false, ready: true });
          }
          return;
        }

        let context: Awaited<typeof sdk.context> | null = null;
        try {
          context = await sdk.context;
        } catch {
          context = null;
        }
        const ctxUser = context?.user;
        const fid = ctxUser?.fid ?? null;
        const user: MiniappUser | null = ctxUser
          ? {
              username: ctxUser.username ?? null,
              displayName: ctxUser.displayName ?? null,
              pfpUrl: ctxUser.pfpUrl ?? null,
            }
          : null;

        // Resolve auth + wallet BEFORE revealing the app, so the primary
        // button is already live when the host splash lifts (no disabled ->
        // enabled flash). Each is guarded: a failure leaves it null but never
        // aborts init, so ready() below still runs and the card always shows.
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

        if (cancelled) return;

        setState({
          fid,
          token,
          ready: false,
          inHost: true,
          error: null,
          provider,
          chains: null,
          user,
          contextRaw: context ?? null,
        });

        requestAnimationFrame(() => {
          sdk.actions.ready().catch(() => {});
          if (!cancelled) {
            setState((prev) => ({ ...prev, ready: true }));
          }
        });

        // Chains are debug-only; fetch them after the app is up.
        try {
          const getChains = (sdk as unknown as { getChains?: () => Promise<string[]> })
            .getChains;
          const chains = (await getChains?.()) ?? null;
          if (!cancelled) setState((prev) => ({ ...prev, chains }));
        } catch {
          // Non-fatal: chains only feed the debug panel.
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          ...INITIAL_STATE,
          inHost: false,
          ready: true,
          error: err instanceof Error ? err.message : "Failed to initialize Mini App SDK",
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

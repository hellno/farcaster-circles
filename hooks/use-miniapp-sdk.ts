"use client";
import { useEffect, useState } from "react";

export interface MiniappState {
  fid: number | null;
  token: string | null;
  ready: boolean;
  inHost: boolean; // true if we detected a Farcaster host
  error: string | null;
}

export function useMiniappSdk(): MiniappState {
  const [state, setState] = useState<MiniappState>({
    fid: null,
    token: null,
    ready: false,
    inHost: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        const ctx = await sdk.context;
        const fid = ctx?.user?.fid ?? null;
        const inHost = fid !== null;
        // Get JWT lazily (only when we have a host)
        let token: string | null = null;
        if (inHost) {
          try {
            const r = await sdk.quickAuth.getToken();
            token = r?.token ?? null;
          } catch {}
        }
        if (cancelled) return;
        setState({ fid, token, ready: false, inHost, error: null });
        // ready() AFTER first render — use rAF in next microtask
        requestAnimationFrame(() => {
          sdk.actions.ready().catch(() => {});
          if (!cancelled) setState((s) => ({ ...s, ready: true }));
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          fid: null,
          token: null,
          ready: false,
          inHost: false,
          error: (e as Error).message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

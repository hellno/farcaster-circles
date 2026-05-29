"use client";

import { useEffect, useState } from "react";

import { FooterDisclaimer } from "@/components/footer-disclaimer";
import { Button } from "@/components/ui/button";
import { useMiniappSdk } from "@/hooks/use-miniapp-sdk";
import type {
  DebugMeResponse,
  NameInfo,
  NamesResponse,
  OnboardResponse,
  VerifiedAddressesResponse,
} from "@/lib/types";

type Phase = "idle" | "connecting" | "submitting" | "done" | "error";

const CIRCLES_APP_URL = "https://app.aboutcircles.com";
const DEBUG_ENABLED = process.env.NODE_ENV !== "production";

function gnosisScanAddress(address: string): string {
  return `https://gnosisscan.io/address/${address}`;
}

function gnosisScanTx(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function OnboardApp() {
  const sdk = useMiniappSdk();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<OnboardResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Signer picker: the fid's verified addresses, each toggleable. The connected
  // wallet is always an owner and is not in this list.
  const [verifiedAddrs, setVerifiedAddrs] = useState<string[]>([]);
  const [verifiedLoaded, setVerifiedLoaded] = useState(false);
  // keyed by lowercased address -> included?
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // keyed by lowercased address -> resolved ENS/basename
  const [names, setNames] = useState<Record<string, NameInfo>>({});

  // Debug state.
  const [rawResponse, setRawResponse] = useState<unknown>(null);
  const [lastConnectedAddress, setLastConnectedAddress] = useState<
    string | null
  >(null);
  const [debugMe, setDebugMe] = useState<unknown>(null);
  const [debugMeBusy, setDebugMeBusy] = useState(false);

  const busy = phase === "connecting" || phase === "submitting";

  // Load the fid's verified addresses (and their names) once we have a token.
  useEffect(() => {
    if (!sdk.token || verifiedLoaded) return;
    const token = sdk.token;
    let cancelled = false;

    async function loadVerified() {
      try {
        const res = await fetch("/api/verified-addresses", {
          headers: { authorization: "Bearer " + token },
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as VerifiedAddressesResponse;
        if (cancelled) return;
        const addrs = data.verifiedAddresses ?? [];
        setVerifiedAddrs(addrs);
        // Pre-select all (auto = all verified; user can deselect).
        const sel: Record<string, boolean> = {};
        for (const a of addrs) sel[a.toLowerCase()] = true;
        setSelected(sel);

        // Resolve names (ENS + basename) for the list — best effort.
        if (addrs.length > 0) {
          try {
            const nres = await fetch("/api/names", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + token,
              },
              body: JSON.stringify({ addresses: addrs }),
            });
            if (!cancelled && nres.ok) {
              const ndata = (await nres.json()) as NamesResponse;
              if (!cancelled) setNames(ndata.names ?? {});
            }
          } catch {
            // Names are cosmetic; ignore failures.
          }
        }
      } catch {
        // Non-fatal: onboarding works with the connected wallet alone.
      } finally {
        if (!cancelled) setVerifiedLoaded(true);
      }
    }

    loadVerified();
    return () => {
      cancelled = true;
    };
  }, [sdk.token, verifiedLoaded]);

  function toggle(addr: string) {
    const key = addr.toLowerCase();
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function runQuickAuthCheck() {
    setDebugMe(null);
    setDebugMeBusy(true);
    try {
      if (!sdk.token) {
        setDebugMe({
          error: "no Quick Auth token (open inside a Farcaster client)",
        });
        return;
      }
      const res = await fetch("/api/debug/me", {
        headers: { authorization: "Bearer " + sdk.token },
      });
      const data = (await res.json()) as
        | DebugMeResponse
        | { error: string; message?: string };
      setDebugMe({ httpStatus: res.status, ...data });
    } catch (err) {
      setDebugMe({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDebugMeBusy(false);
    }
  }

  async function handleOnboard() {
    setErrorMsg(null);
    setResult(null);

    if (!sdk.token) {
      setPhase("error");
      setErrorMsg("Open this app inside a Farcaster client to continue.");
      return;
    }
    if (!sdk.provider) {
      setPhase("error");
      setErrorMsg("Connect a wallet in your Farcaster client");
      return;
    }

    try {
      setPhase("connecting");
      const accounts = (await sdk.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const connectedAddress = accounts?.[0];
      if (!connectedAddress) {
        setPhase("error");
        setErrorMsg("Connect a wallet in your Farcaster client");
        return;
      }
      setLastConnectedAddress(connectedAddress);

      const additionalOwners = verifiedAddrs.filter(
        (a) => selected[a.toLowerCase()],
      );

      setPhase("submitting");
      const res = await fetch("/api/onboard", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + sdk.token,
        },
        body: JSON.stringify({ connectedAddress, additionalOwners }),
      });
      const data = await res.json();
      setRawResponse({ httpStatus: res.status, ...data });

      if (!res.ok) {
        setPhase("error");
        setErrorMsg(
          (data && typeof data.message === "string" && data.message) ||
            "Something went wrong while creating your Circles account.",
        );
        return;
      }

      setResult(data as OnboardResponse);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "Unexpected error.");
    }
  }

  const selectedCount =
    1 /* connected wallet, always */ +
    verifiedAddrs.filter((a) => selected[a.toLowerCase()]).length;

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Farcaster Circles</h1>
        <p className="text-sm text-muted-foreground">
          Create your Circles account, gas-free, in one tap.
        </p>
      </header>

      {!sdk.inHost ? (
        <div className="rounded-md border bg-muted p-3 text-sm">
          Open this mini-app inside a Farcaster client (Warpcast) to connect your
          wallet and create your Circles account.
        </div>
      ) : null}

      {phase === "error" && errorMsg ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {errorMsg}
        </div>
      ) : null}

      {phase === "done" && result ? (
        <div className="flex flex-col gap-3 rounded-md border p-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Your Circles Safe</span>
            <code className="break-all font-mono text-xs">
              {result.safeAddress}
            </code>
          </div>

          <div className="text-sm">
            {result.alreadyRegistered ? (
              <span>Already registered as a human on Circles ✅</span>
            ) : result.isHuman ? (
              <span>Registered as a human on Circles ✅</span>
            ) : (
              <span>Safe created.</span>
            )}
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <Button
              type="button"
              variant="default"
              onClick={() => openExternal(CIRCLES_APP_URL)}
            >
              Open Circles app
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => openExternal(gnosisScanAddress(result.safeAddress))}
            >
              View Safe on Gnosisscan
            </Button>
          </div>

          {result.txHashes.length > 0 ? (
            <div className="flex flex-col gap-0.5 pt-1 text-xs text-muted-foreground">
              {result.txHashes.map((h) => (
                <a
                  key={h}
                  href={gnosisScanTx(h)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block break-all underline"
                >
                  {shortAddr(h)}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* Signer picker: connected wallet (locked) + verified addresses. */}
          <section className="flex flex-col gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">Account signers</span>
              <span className="text-xs text-muted-foreground">
                {selectedCount} selected
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              These addresses can control your Circles account. Your connected
              wallet is always included; uncheck any verified address you’d
              rather not add.
            </p>

            <label className="flex items-center gap-2 rounded bg-muted/50 px-2 py-2">
              <input type="checkbox" checked disabled readOnly />
              <span className="flex-1">Connected wallet</span>
              <span className="text-xs text-muted-foreground">always</span>
            </label>

            {!verifiedLoaded ? (
              <p className="text-xs text-muted-foreground">
                Loading your verified addresses…
              </p>
            ) : verifiedAddrs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No verified addresses found — just your connected wallet will be
                a signer.
              </p>
            ) : (
              verifiedAddrs.map((addr) => {
                const name = names[addr.toLowerCase()]?.primary ?? null;
                return (
                  <label
                    key={addr}
                    className="flex items-center gap-2 px-2 py-1.5"
                  >
                    <input
                      type="checkbox"
                      checked={!!selected[addr.toLowerCase()]}
                      onChange={() => toggle(addr)}
                      disabled={busy}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      {name ? (
                        <>
                          <span className="truncate font-medium">{name}</span>
                          <code className="truncate font-mono text-[10px] text-muted-foreground">
                            {shortAddr(addr)}
                          </code>
                        </>
                      ) : (
                        <code className="truncate font-mono text-xs">
                          {shortAddr(addr)}
                        </code>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      verified
                    </span>
                  </label>
                );
              })
            )}
          </section>

          <Button
            type="button"
            onClick={handleOnboard}
            disabled={busy || !sdk.token}
          >
            {phase === "connecting"
              ? "Connecting wallet…"
              : phase === "submitting"
                ? "Creating your account…"
                : "Create my Circles account"}
          </Button>
        </>
      )}

      {DEBUG_ENABLED ? (
        <details className="rounded-md border bg-muted/40 p-3 text-xs" open>
          <summary className="cursor-pointer font-medium">Debug</summary>

          <div className="mt-3 flex flex-col gap-1 font-mono">
            <DebugRow label="inHost" value={String(sdk.inHost)} />
            <DebugRow label="ready" value={String(sdk.ready)} />
            <DebugRow
              label="fid (from SDK ctx)"
              value={sdk.fid == null ? "—" : String(sdk.fid)}
            />
            <DebugRow label="username" value={sdk.user?.username ?? "—"} />
            <DebugRow
              label="displayName"
              value={sdk.user?.displayName ?? "—"}
            />
            <DebugRow
              label="quickAuth token"
              value={sdk.token ? `present (${sdk.token.length} chars)` : "MISSING"}
            />
            <DebugRow
              label="wallet provider"
              value={sdk.provider ? "present" : "MISSING"}
            />
            <DebugRow
              label="chains"
              value={sdk.chains ? sdk.chains.join(", ") || "[]" : "—"}
            />
            <DebugRow
              label="context captured"
              value={
                sdk.contextRaw
                  ? "yes"
                  : "NO — hard-reload the mini-app (stale bundle)"
              }
            />
            <DebugRow
              label="verified addrs loaded"
              value={verifiedLoaded ? `${verifiedAddrs.length}` : "loading…"}
            />
            <DebugRow
              label="connectedAddress (last)"
              value={lastConnectedAddress ?? "—"}
            />
            {sdk.error ? <DebugRow label="SDK error" value={sdk.error} /> : null}
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runQuickAuthCheck}
              disabled={debugMeBusy}
            >
              {debugMeBusy
                ? "Checking…"
                : "Run Quick Auth check (/api/debug/me)"}
            </Button>
            <p className="text-muted-foreground">
              Verifies your token server-side and shows signals (power badge,
              mutual follow), the gate verdict, and the Neynar profile. Spends no
              quota.
            </p>
          </div>

          {debugMe != null ? (
            <DebugJson title="Quick Auth result (/api/debug/me)" value={debugMe} />
          ) : null}

          {rawResponse != null ? (
            <DebugJson title="Last /api/onboard response" value={rawResponse} />
          ) : null}

          {Object.keys(names).length > 0 ? (
            <DebugJson title="Resolved names (ENS / basename)" value={names} />
          ) : null}

          <DebugJson
            title="Full Farcaster SDK context (client-side)"
            value={sdk.contextRaw ?? "(none — not in a Farcaster host)"}
          />
        </details>
      ) : null}

      <FooterDisclaimer />
    </main>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-right">{value}</span>
    </div>
  );
}

function DebugJson({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="mt-3">
      <div className="mb-1 font-medium">{title}</div>
      <pre className="max-h-72 overflow-auto rounded bg-background p-2 text-[10px] leading-snug">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

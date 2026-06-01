"use client";

import { useEffect, useRef, useState } from "react";

import { useMiniappSdk } from "@/hooks/use-miniapp-sdk";
import type {
  DebugMeResponse,
  NameInfo,
  NamesResponse,
  OnboardResponse,
  VerifiedAddressesResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase = "idle" | "connecting" | "submitting" | "done" | "error";

const CIRCLES_APP_URL = "https://app.aboutcircles.com";
const DEBUG_ENABLED = process.env.NODE_ENV !== "production";

// Compact "what happens" strip — kept to three taps-of-the-eye chips.
const STEPS = [
  { n: "01", label: "Mint Safe" },
  { n: "02", label: "Verify human" },
  { n: "03", label: "Earn daily" },
] as const;

// Milestones surfaced in the waiting state. We can't stream real progress from
// a single POST, so these advance on a timer and hold on the last one until the
// server actually responds — honest-ish, and it keeps people from leaving.
const MINT_MILESTONES = [
  "Connecting your wallet",
  "Deploying your Safe",
  "Registering you as human",
  "Opening your Circles stream",
] as const;

function gnosisScanAddress(address: string): string {
  return `https://gnosisscan.io/address/${address}`;
}

function gnosisScanTx(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

  // Waiting-state presentation only (does not affect onboarding logic).
  const [mintStage, setMintStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const mintStartRef = useRef(0);

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

  // Elapsed timer while the account is being created (presentation only).
  // The start time lives in a ref (set in handleOnboard) so the count stays
  // continuous across connecting -> submitting instead of resetting.
  useEffect(() => {
    const isBusy = phase === "connecting" || phase === "submitting";
    if (!isBusy) return;
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - mintStartRef.current) / 1000));
    }, 250);
    return () => clearInterval(tick);
  }, [phase]);

  // Advance the milestone copy while the POST is in flight (presentation only).
  useEffect(() => {
    if (phase !== "submitting") return;
    const adv = setInterval(() => {
      setMintStage((s) => Math.min(s + 1, MINT_MILESTONES.length - 1));
    }, 4500);
    return () => clearInterval(adv);
  }, [phase]);

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
      // Reset the waiting-state counters at the start of each attempt.
      mintStartRef.current = Date.now();
      setElapsed(0);
      setMintStage(0);
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

  const doneStatus = result?.alreadyRegistered
    ? "Already a human on Circles."
    : result?.isHuman
      ? "Registered as a human on Circles."
      : "Your Safe is live on Gnosis.";

  const certified = !!(result?.alreadyRegistered || result?.isHuman);

  return (
    <main className="edition flex min-h-svh w-full justify-center px-4 py-6">
      <span className="grain" aria-hidden />

      <div className="relative flex w-full max-w-md flex-col gap-5">
        {/* ── Masthead (hidden during the minting screen for focus) ──── */}
        {!busy ? (
          <header className="rise" style={{ animationDelay: "0ms" }}>
            <div className="kicker flex items-center justify-between text-[var(--ink-soft)]">
              <span>The Daily Circle</span>
              <span aria-hidden>✶</span>
              <span>{sdk.fid != null ? `No. ${sdk.fid}` : "Edition I"}</span>
            </div>

            <hr className="rule mt-2.5" />

            <h1 className="display mt-3.5 text-[clamp(2.4rem,12vw,3.3rem)] uppercase">
              Money
              <br />
              that{" "}
              <span className="box-decoration-clone bg-[var(--sun)] px-1.5 [-webkit-box-decoration-break:clone]">
                grows
              </span>
              <br />
              on you.
            </h1>

            <p className="mt-3 max-w-[34ch] text-[14px] leading-snug text-[var(--ink-soft)]">
              Personal currency for humans — a fresh stream of money, minted just
              by being you. Set up your account, gas-free, in one tap.
            </p>

            <div className="kicker mt-3 flex items-center gap-2 text-[var(--ink-soft)]">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--flame)]" />
              <span>
                {sdk.user?.username
                  ? `Printed for @${sdk.user.username}`
                  : "First pressing"}
              </span>
            </div>
            <hr className="rule-thin mt-3" />
          </header>
        ) : null}

        {/* ── Not in a Farcaster host ──────────────────────────────── */}
        {!sdk.inHost && !busy ? (
          <NoticeBlock tone="cobalt" label="Open in Warpcast" delay="60ms">
            This edition only prints inside a Farcaster client. Open it in
            Warpcast to connect your wallet and mint your Circles account.
          </NoticeBlock>
        ) : null}

        {/* ── Error ────────────────────────────────────────────────── */}
        {phase === "error" && errorMsg ? (
          <NoticeBlock tone="flame" label="Stop the press" delay="60ms">
            {errorMsg}
          </NoticeBlock>
        ) : null}

        {phase === "done" && result ? (
          /* ── The front-page win ─────────────────────────────────── */
          <section className="flex flex-col gap-6">
            <div className="relative mx-auto grid h-32 w-full place-items-center">
              <span
                className="ring-ripple"
                style={{ animationDelay: "0s" }}
                aria-hidden
              />
              <span
                className="ring-ripple"
                style={{ animationDelay: "1.05s" }}
                aria-hidden
              />
              <div className="coin grid h-24 w-24 place-items-center rounded-full bg-[var(--sun)]">
                <CheckMark />
              </div>
            </div>

            <header
              className="rise text-center"
              style={{ animationDelay: "120ms" }}
            >
              <h2 className="display text-6xl uppercase">You’re in.</h2>
              <p className="mt-2 text-[15px] text-[var(--ink-soft)]">
                {doneStatus}
              </p>
            </header>

            {/* Certificate of the freshly minted Safe */}
            <div
              className="panel-pop rise relative bg-[var(--paper-2)] p-4"
              style={{ animationDelay: "200ms" }}
            >
              <span className="kicker text-[var(--ink-soft)]">
                Your Circles Safe
              </span>
              <code className="mono mt-1.5 block break-all text-[13px] leading-snug">
                {result.safeAddress}
              </code>

              <span className="stamp pointer-events-none absolute -top-3.5 right-3 grid place-items-center rounded-full border-[2.5px] border-[var(--cobalt)] px-3 py-2 text-center text-[var(--cobalt)]">
                <span className="kicker leading-none">
                  {certified ? "Certified" : "Safe"}
                </span>
                <span className="display text-sm leading-none">
                  {certified ? "HUMAN" : "LIVE"}
                </span>
              </span>
            </div>

            <div
              className="rise flex flex-col gap-3"
              style={{ animationDelay: "280ms" }}
            >
              <button
                type="button"
                className="block-btn h-14 w-full bg-[var(--sun)] text-base text-[var(--ink)]"
                onClick={() => openExternal(CIRCLES_APP_URL)}
              >
                Open the Circles app →
              </button>
              <button
                type="button"
                className="block-btn h-12 w-full bg-[var(--paper)] text-sm text-[var(--ink)]"
                onClick={() =>
                  openExternal(gnosisScanAddress(result.safeAddress))
                }
              >
                View Safe on Gnosisscan
              </button>
            </div>

            {result.txHashes.length > 0 ? (
              <div className="rise" style={{ animationDelay: "340ms" }}>
                <span className="kicker text-[var(--ink-soft)]">
                  On-chain receipts
                </span>
                <div className="mono mt-1.5 flex flex-col gap-1 text-xs">
                  {result.txHashes.map((h) => (
                    <a
                      key={h}
                      href={gnosisScanTx(h)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 break-all underline decoration-2 underline-offset-2 hover:text-[var(--cobalt)]"
                    >
                      <span aria-hidden>↳</span>
                      {shortAddr(h)}
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : busy ? (
          /* ── The press is running ───────────────────────────────── */
          <MintingState phase={phase} mintStage={mintStage} elapsed={elapsed} />
        ) : (
          /* ── The setup edition ──────────────────────────────────── */
          <>
            {/* Hero coin wearing your face, emitting currency */}
            <div className="rise" style={{ animationDelay: "80ms" }}>
              <CoinMark busy={false} pfpUrl={sdk.user?.pfpUrl ?? null} />
            </div>

            {/* What happens — compact three-step strip */}
            <div className="rise" style={{ animationDelay: "130ms" }}>
              <span className="kicker text-[var(--ink-soft)]">
                What happens →
              </span>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {STEPS.map((s) => (
                  <div
                    key={s.n}
                    className="panel flex flex-col gap-0.5 px-2.5 py-2"
                  >
                    <span className="display text-lg leading-none text-[var(--sun-deep)]">
                      {s.n}
                    </span>
                    <span className="text-[12px] font-semibold leading-tight">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Keyholders — collapsed by default; most people never edit it */}
            <details className="disclosure panel rise" style={{ animationDelay: "180ms" }}>
              <summary className="flex items-center justify-between bg-[var(--ink)] px-3.5 py-2.5">
                <span className="kicker text-[var(--paper)]">Signers</span>
                <span className="flex items-center gap-2">
                  <span className="kicker rounded-full bg-[var(--sun)] px-2 py-0.5 text-[var(--ink)]">
                    {selectedCount} selected
                  </span>
                  <span className="chev text-[var(--paper)]" aria-hidden>
                    ▾
                  </span>
                </span>
              </summary>

              <div className="px-3.5 pb-3 pt-2.5">
                <p className="text-[13px] leading-snug text-[var(--ink-soft)]">
                  These addresses can sign for your account. Your connected
                  wallet is always in; uncheck any verified address you’d rather
                  leave out.
                </p>

                <label className="mt-2.5 flex items-center gap-3 rounded-md bg-[var(--paper-2)] px-2.5 py-2.5">
                  <input
                    type="checkbox"
                    className="sr-cb"
                    checked
                    disabled
                    readOnly
                  />
                  <span className="cb-box" aria-hidden />
                  <span className="flex-1 text-[14px] font-semibold">
                    Connected wallet
                  </span>
                  <span className="kicker text-[var(--ink-soft)]">always</span>
                </label>

                {!verifiedLoaded ? (
                  <p className="mono mt-2.5 text-xs text-[var(--ink-soft)]">
                    Reading your verified addresses…
                  </p>
                ) : verifiedAddrs.length === 0 ? (
                  <p className="mt-2.5 text-[13px] text-[var(--ink-soft)]">
                    No verified addresses — your connected wallet signs alone.
                  </p>
                ) : (
                  <div className="mt-1">
                    {verifiedAddrs.map((addr) => {
                      const name = names[addr.toLowerCase()]?.primary ?? null;
                      const on = !!selected[addr.toLowerCase()];
                      return (
                        <label
                          key={addr}
                          className="rule-thin flex cursor-pointer items-center gap-3 border-t py-2.5"
                        >
                          <input
                            type="checkbox"
                            className="sr-cb"
                            checked={on}
                            onChange={() => toggle(addr)}
                            disabled={busy}
                          />
                          <span className="cb-box" aria-hidden />
                          <span className="flex min-w-0 flex-1 flex-col">
                            {name ? (
                              <>
                                <span className="truncate text-[14px] font-semibold">
                                  {name}
                                </span>
                                <code className="mono truncate text-[11px] text-[var(--ink-soft)]">
                                  {shortAddr(addr)}
                                </code>
                              </>
                            ) : (
                              <code className="mono truncate text-[13px]">
                                {shortAddr(addr)}
                              </code>
                            )}
                          </span>
                          <span className="kicker text-[var(--ink-soft)]">
                            verified
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </details>

            {/* The print button — pinned to the bottom, always one tap away */}
            <div className="sticky-cta">
              <button
                type="button"
                onClick={handleOnboard}
                disabled={!sdk.token}
                className="block-btn h-16 w-full bg-[var(--sun)] text-lg text-[var(--ink)]"
              >
                <span aria-hidden>◎</span>
                Mint my account
              </button>
              <p className="kicker mt-2 text-center text-[var(--ink-soft)]">
                Gas-free · No seed phrase · Yours to keep
              </p>
            </div>
          </>
        )}

        {/* ── Colophon ─────────────────────────────────────────────── */}
        <footer className="mt-1">
          <hr className="rule-thin mb-3" />
          <p className="kicker text-[var(--ink-soft)]">Colophon</p>
          <p className="mt-1 text-[11px] leading-snug text-[var(--ink-soft)]">
            Independent project. Built alongside the Circles team; not officially
            endorsed by Circles or Gnosis.
          </p>
        </footer>

        {/* ── Printer’s marks (dev only) ───────────────────────────── */}
        {DEBUG_ENABLED ? (
          <details className="panel bg-[var(--paper-2)] text-xs">
            <summary className="kicker cursor-pointer bg-[var(--ink)] px-3 py-2 text-[var(--paper)]">
              Printer’s marks · dev
            </summary>

            <div className="px-3 py-3">
              <div className="flex flex-col gap-1">
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
                  value={
                    sdk.token ? `present (${sdk.token.length} chars)` : "MISSING"
                  }
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
                {sdk.error ? (
                  <DebugRow label="SDK error" value={sdk.error} />
                ) : null}
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={runQuickAuthCheck}
                  disabled={debugMeBusy}
                  className="block-btn h-9 bg-[var(--cobalt)] px-3 text-xs text-[var(--paper)]"
                >
                  {debugMeBusy
                    ? "Checking…"
                    : "Run Quick Auth check (/api/debug/me)"}
                </button>
                <p className="text-[var(--ink-soft)]">
                  Verifies your token server-side and shows signals (power badge,
                  mutual follow), the gate verdict, and the Neynar profile. Spends
                  no quota.
                </p>
              </div>

              {debugMe != null ? (
                <DebugJson
                  title="Quick Auth result (/api/debug/me)"
                  value={debugMe}
                />
              ) : null}

              {rawResponse != null ? (
                <DebugJson
                  title="Last /api/onboard response"
                  value={rawResponse}
                />
              ) : null}

              {Object.keys(names).length > 0 ? (
                <DebugJson title="Resolved names (ENS / basename)" value={names} />
              ) : null}

              <DebugJson
                title="Full Farcaster SDK context (client-side)"
                value={sdk.contextRaw ?? "(none — not in a Farcaster host)"}
              />
            </div>
          </details>
        ) : null}
      </div>
    </main>
  );
}

/* ── Presentational pieces ─────────────────────────────────────────────── */

function MintingState({
  phase,
  mintStage,
  elapsed,
}: {
  phase: Phase;
  mintStage: number;
  elapsed: number;
}) {
  const current =
    phase === "connecting"
      ? 0
      : Math.min(1 + mintStage, MINT_MILESTONES.length - 1);

  return (
    <section className="flex min-h-[72svh] flex-col">
      <div className="kicker flex items-center justify-between text-[var(--ink-soft)]">
        <span>The Daily Circle</span>
        <span>Going to press</span>
      </div>
      <hr className="rule mt-2.5" />

      {/* the press at work */}
      <div className="relative mx-auto mt-8 mb-2 grid h-44 w-44 place-items-center">
        <span className="ring-ripple fast" style={{ animationDelay: "0s" }} aria-hidden />
        <span className="ring-ripple fast" style={{ animationDelay: "0.45s" }} aria-hidden />
        <span className="ring-ripple fast" style={{ animationDelay: "0.9s" }} aria-hidden />
        <span
          className="spin absolute inset-[-12px] rounded-full border-[3px] border-dashed border-[var(--cobalt)]"
          aria-hidden
        />
        <div className="coin shimmer relative grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-[var(--sun)]">
          <CirclesGlyph />
        </div>
      </div>

      <h2 className="display mt-4 text-center text-4xl uppercase">
        Minting your
        <br />
        account…
      </h2>
      <p className="mx-auto mt-2 max-w-[30ch] text-center text-[14px] leading-snug text-[var(--ink-soft)]">
        Writing to Gnosis. This usually takes 15–30 seconds.
      </p>

      {/* live milestone ledger */}
      <ol className="panel mt-6">
        {MINT_MILESTONES.map((m, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={m}
              className={cn(
                "flex items-center gap-3 px-3.5 py-2.5",
                i > 0 && "rule-thin border-t",
              )}
            >
              <span className="grid h-6 w-6 flex-none place-items-center">
                {done ? (
                  <span className="grid h-5 w-5 place-items-center rounded-full border-2 border-[var(--ink)] bg-[var(--sun)]">
                    <MiniCheck />
                  </span>
                ) : active ? (
                  <span
                    className="spin h-4 w-4 rounded-full border-2 border-[var(--ink)] border-t-transparent"
                    aria-hidden
                  />
                ) : (
                  <span className="h-5 w-5 rounded-full border-2 border-[var(--ink)] opacity-25" />
                )}
              </span>
              <span
                className={cn(
                  "text-[14px]",
                  done && "text-[var(--ink-soft)] line-through decoration-[1.5px]",
                  active && "font-semibold",
                  !done && !active && "opacity-45",
                )}
              >
                {m}
                {active ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="kicker mt-4 flex items-center justify-between text-[var(--ink-soft)]">
        <span>Elapsed {fmtElapsed(elapsed)}</span>
        <span className="flex items-center gap-1.5 text-[var(--flame)]">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--flame)]" />
          Keep this open
        </span>
      </div>
    </section>
  );
}

function CoinMark({ busy, pfpUrl }: { busy: boolean; pfpUrl: string | null }) {
  return (
    <div className="relative mx-auto grid h-36 w-36 place-items-center">
      <span
        className={cn("ring-ripple", busy && "fast")}
        style={{ animationDelay: "0s" }}
        aria-hidden
      />
      <span
        className={cn("ring-ripple", busy && "fast")}
        style={{ animationDelay: "1.05s" }}
        aria-hidden
      />
      <span
        className={cn("ring-ripple", busy && "fast")}
        style={{ animationDelay: "2.1s" }}
        aria-hidden
      />
      <div className="coin relative grid h-26 w-26 place-items-center overflow-hidden rounded-full bg-[var(--sun)]">
        <CirclesGlyph />
        {pfpUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pfpUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
      </div>
    </div>
  );
}

function CirclesGlyph() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-14 w-14"
      aria-hidden
      fill="none"
      stroke="var(--ink)"
      strokeWidth="5"
    >
      <circle cx="50" cy="50" r="9" fill="var(--ink)" stroke="none" />
      <circle cx="50" cy="50" r="23" />
      <circle cx="50" cy="50" r="38" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-12 w-12"
      aria-hidden
      fill="none"
      stroke="var(--ink)"
      strokeWidth="9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M24 52 L43 70 L78 30" />
    </svg>
  );
}

function MiniCheck() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-3 w-3"
      aria-hidden
      fill="none"
      stroke="var(--ink)"
      strokeWidth="16"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 54 L42 72 L78 30" />
    </svg>
  );
}

function NoticeBlock({
  tone,
  label,
  delay,
  children,
}: {
  tone: "cobalt" | "flame";
  label: string;
  delay: string;
  children: React.ReactNode;
}) {
  const bg = tone === "cobalt" ? "bg-[var(--cobalt)]" : "bg-[var(--flame)]";
  return (
    <div className="panel-pop rise" style={{ animationDelay: delay }}>
      <div className={cn("kicker px-3.5 py-2 text-[var(--paper)]", bg)}>
        {label}
      </div>
      <p className="px-3.5 py-3 text-[14px] leading-snug">{children}</p>
    </div>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mono flex justify-between gap-3">
      <span className="text-[var(--ink-soft)]">{label}</span>
      <span className="break-all text-right">{value}</span>
    </div>
  );
}

function DebugJson({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="mt-3">
      <div className="kicker mb-1 text-[var(--ink-soft)]">{title}</div>
      <pre className="mono max-h-72 overflow-auto border-2 border-[var(--ink)] bg-[var(--paper)] p-2 text-[10px] leading-snug">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

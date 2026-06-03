"use client";

import { useEffect, useRef, useState } from "react";

import { env } from "@/lib/env";
import { useMiniappSdk } from "@/hooks/use-miniapp-sdk";
import { parseSseFrames } from "@/lib/sse";
import type {
  AccountStatus,
  AccountStatusFound,
  DebugMeResponse,
  NameInfo,
  OnboardResponse,
  OnboardStage,
  OnboardStreamEvent,
  ProfileCurrentResponse,
  ProfileErrorResponse,
  ProfilePrepareResponse,
  ProfileRelayResponse,
  VerifiedAddressesResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase = "idle" | "connecting" | "submitting" | "done" | "error" | "manage";

type ProfilePhase =
  | "idle"
  | "editing"
  | "preparing"
  | "signing"
  | "relaying"
  | "done"
  | "alreadySet"
  | "error";

const DEBUG_ENABLED = process.env.NODE_ENV !== "production";

// The human whose prepaid invite quota powers this onboarding. Surfaced in the
// masthead so the invitee knows whose invite they're spending.
const INVITER_HANDLE = env.NEXT_PUBLIC_INVITER_HANDLE;

// Compact "what happens" strip — kept to three taps-of-the-eye chips.
const STEPS = [
  { n: "01", label: "Create wallet" },
  { n: "02", label: "Verify human" },
  { n: "03", label: "Earn daily" },
] as const;

// Milestones surfaced in the waiting state. These are driven by REAL progress
// events streamed from /api/onboard (see STAGE_TO_MILESTONE) — the index only
// ever moves forward as the chain work advances.
const MINT_MILESTONES = [
  "Connecting your wallet",
  "Creating your smart wallet",
  "Verifying you're human",
  "Starting your Circles",
] as const;

// Frontend-owned mapping from a server OnboardStage to a milestone index. This
// is UI presentation, so it lives here (the stages themselves carry no copy).
// Milestone 3 "Starting your Circles" is shown on the terminal result.
const STAGE_TO_MILESTONE: Record<OnboardStage, number> = {
  predicting: 0,
  preflight: 0, // "Connecting your wallet"
  deploying: 1,
  verifying: 1, // "Creating your smart wallet"
  inviting: 2,
  registering: 2, // "Verifying you're human"
};

function gnosisScanAddress(address: string): string {
  return `https://gnosisscan.io/address/${address}`;
}

function gnosisScanTx(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

// The Gnosis app profile page for an address — where the freshly onboarded
// Safe (and its Circles balance) shows up.
function gnosisAppProfile(address: string): string {
  return `https://app.gnosis.io/p/${address}`;
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

  // Returning-user detection (issue #6, D9). A registered user lands on the
  // `manage` phase; `account` carries the on-chain facts that drive its
  // Set-profile sub-block. Detection is automatic, non-blocking, and fail-open.
  const [account, setAccount] = useState<AccountStatusFound | null>(null);
  // Mirror of `phase` so the one-shot detect effect can read the latest value
  // without depending on `phase` (which would re-run / re-trigger the wallet).
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  // Ensures auto-detect runs at most once per mount.
  const detectedRef = useRef(false);

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

  // Post-success "Set Circles profile" action (optional, failure-isolated —
  // never touches `phase`/`result`).
  const [profilePhase, setProfilePhase] = useState<ProfilePhase>("idle");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileTxHash, setProfileTxHash] = useState<string | null>(null);

  // Edit-profile form state (issue #5, D3/D4). `edit*` hold the live inputs;
  // `editBase*` are the read-back baseline used for the changed-check (D6).
  const [editName, setEditName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editBaseName, setEditBaseName] = useState("");
  const [editBaseBio, setEditBaseBio] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editReadFailed, setEditReadFailed] = useState(false);
  // True while the save round-trip belongs to an EDIT (so the saving phases
  // render edit progress, not the first-time "Set your Circles profile" CTA).
  const [editFlow, setEditFlow] = useState(false);

  // Debug state.
  const [rawResponse, setRawResponse] = useState<unknown>(null);
  const [lastConnectedAddress, setLastConnectedAddress] = useState<
    string | null
  >(null);
  const [debugMe, setDebugMe] = useState<unknown>(null);
  const [debugMeBusy, setDebugMeBusy] = useState(false);

  const busy = phase === "connecting" || phase === "submitting";
  const profileBusy =
    profilePhase === "preparing" ||
    profilePhase === "signing" ||
    profilePhase === "relaying";
  // The action only makes sense when we have an identity to write and a wallet
  // to sign with. (The server still re-checks and 422s if there's no name.)
  const canSetProfile = !!(
    (sdk.user?.displayName || sdk.user?.username) &&
    sdk.provider &&
    sdk.token
  );

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
        setNames(data.names ?? {});
        // Auto-select only the recommended (distinctly-named) addresses; the
        // rest stay off so a user's pile of throwaway verifications isn't
        // silently added as signers. The server decides `recommended`, so the
        // default — and the predicted Safe address — is fixed up front and
        // doesn't depend on name-resolution timing.
        const recommended = new Set(
          (data.recommended ?? []).map((a) => a.toLowerCase()),
        );
        const sel: Record<string, boolean> = {};
        for (const a of addrs) sel[a.toLowerCase()] = recommended.has(a.toLowerCase());
        setSelected(sel);
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

  // Returning-user auto-detect (issue #6, D9). Runs once on load as soon as the
  // host, wallet provider, and Quick Auth token are ready. NON-BLOCKING: the
  // Create screen renders immediately while this resolves in the background, and
  // FAIL-OPEN (D4): any error or `found:false` leaves us on Create with nothing
  // shown. We only swap to `manage` when the user hasn't started onboarding.
  //
  // The in-host guard (`sdk.inHost`) is critical: `eth_requestAccounts` is
  // silent inside the Farcaster host but PROMPTS (or throws) in a plain browser.
  useEffect(() => {
    if (detectedRef.current) return;
    if (!(sdk.ready && sdk.inHost && sdk.provider && sdk.token)) return;
    detectedRef.current = true; // run at most once
    const provider = sdk.provider;
    const token = sdk.token;
    let cancelled = false;

    (async () => {
      try {
        // Silent in-host: this does not prompt inside the Farcaster host.
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        const connectedAddress = accounts?.[0];
        if (!connectedAddress) return;
        if (!cancelled) setLastConnectedAddress(connectedAddress);

        const res = await fetch("/api/account-status", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + token,
          },
          body: JSON.stringify({ connectedAddress }),
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as AccountStatus;
        if (cancelled || !data.found) return;

        // Only swap if the user hasn't already started onboarding manually — a
        // tap on "Create" before detection resolves wins (phaseRef mirrors the
        // latest phase so we read it without re-running this effect).
        if (phaseRef.current !== "idle") return;
        setAccount(data);
        setResult({
          safeAddress: data.safeAddress,
          isHuman: true,
          avatar: "",
          modules: { invitation: true, erc4337: true },
          txHashes: [],
          alreadyRegistered: true,
        });
        setPhase("manage");
      } catch {
        // Fail-open (D4): any error → stay on Create.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sdk.ready, sdk.inHost, sdk.provider, sdk.token]);

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

      // Pre-stream failures (auth 401, bad body 400, server 500) come back as a
      // normal JSON response with a non-2xx status — not a stream.
      if (!res.ok || !res.body) {
        const data = await res.json();
        setRawResponse({ httpStatus: res.status, ...data });
        setPhase("error");
        setErrorMsg(
          (data && typeof data.message === "string" && data.message) ||
            "Something went wrong while creating your Circles account.",
        );
        return;
      }

      // Success path: consume the SSE progress stream. Each `data:` frame is one
      // OnboardStreamEvent; progress ticks drive the milestone, and exactly one
      // terminal event (result | error) closes it.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawTerminal = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { messages, rest } = parseSseFrames(
          buffer + decoder.decode(value, { stream: true }),
        );
        buffer = rest;
        for (const message of messages) {
          let ev: OnboardStreamEvent;
          try {
            ev = JSON.parse(message) as OnboardStreamEvent;
          } catch {
            // A single malformed frame shouldn't abort the whole stream.
            continue;
          }
          switch (ev.type) {
            case "progress":
              // Monotonic: real progress only ever moves the milestone forward.
              setMintStage((prev) =>
                Math.max(prev, STAGE_TO_MILESTONE[ev.stage] ?? prev),
              );
              break;
            case "result":
              setRawResponse({ httpStatus: 200, ...ev.result });
              setResult(ev.result);
              setPhase("done");
              sawTerminal = true;
              break;
            case "error":
              setRawResponse({ httpStatus: 200, ...ev.error });
              setErrorMsg(ev.error.message);
              setPhase("error");
              sawTerminal = true;
              break;
          }
        }
      }

      // A dropped stream must not leave an infinite spinner. The flow is
      // idempotent, so retrying resolves it.
      if (!sawTerminal) {
        setPhase("error");
        setErrorMsg(
          "Lost connection before finishing. Tap to try again — your progress is saved.",
        );
      }
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "Unexpected error.");
    }
  }

  // Share the win back to Farcaster. The embed URL carries a per-fid OG card
  // (the user's pfp), and tapping it launches the app — so each onboard can pull
  // the next person in. Falls back to the page origin when APP_URL isn't set
  // (e.g. local tunnel testing).
  async function shareToFarcaster() {
    if (sdk.fid == null) return;
    const base = env.NEXT_PUBLIC_APP_URL || window.location.origin;
    await sdk.composeCast({
      text: `I just set up my Circles account — money that grows on you. Thanks for the invite @${INVITER_HANDLE} 🌱`,
      embeds: [`${base}/share/${sdk.fid}`],
    });
  }

  // Optional post-success step: write the user's Farcaster name + photo to their
  // Circles profile. The user signs ONE gas-free EIP-712 Safe tx; the operator
  // relays it. Fully isolated from onboarding — any failure (incl. a rejected
  // signature) only sets `profilePhase`, never the onboard `phase`/`result`.
  async function handleSetProfile() {
    if (!sdk.token || !sdk.provider || !result) return;
    const token = sdk.token;
    const provider = sdk.provider;
    setProfileMsg(null);
    setProfilePhase("preparing");
    try {
      const prepRes = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({ step: "prepare", safeAddress: result.safeAddress }),
      });
      const prep = (await prepRes.json()) as
        | ProfilePrepareResponse
        | ProfileErrorResponse;
      if (!prepRes.ok) {
        setProfilePhase("error");
        setProfileMsg(
          (prep as ProfileErrorResponse).message ||
            "Couldn't prepare your profile.",
        );
        return;
      }
      const prepared = prep as ProfilePrepareResponse;
      // The first-time path never sends `overwrite`, so the server won't return
      // `noChange` here; handle it defensively for exhaustive narrowing.
      if ("noChange" in prepared && prepared.noChange) {
        setProfilePhase("alreadySet");
        return;
      }
      if ("alreadySet" in prepared && prepared.alreadySet) {
        setProfilePhase("alreadySet");
        return;
      }
      const needs = prepared as Extract<
        ProfilePrepareResponse,
        { alreadySet: false }
      >;

      // Sign with the connected owner. We captured it during onboard; re-request
      // if missing (e.g. a fresh session landing straight on the done screen).
      let signer = lastConnectedAddress;
      if (!signer) {
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        signer = accounts?.[0] ?? null;
      }
      if (!signer) {
        setProfilePhase("error");
        setProfileMsg("Connect a wallet to sign.");
        return;
      }

      setProfilePhase("signing");
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [signer, JSON.stringify(needs.typedData)],
      })) as string;

      setProfilePhase("relaying");
      const relayRes = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          step: "relay",
          safeAddress: result.safeAddress,
          digest: needs.digest,
          signerAddress: signer,
          signature,
        }),
      });
      const relay = (await relayRes.json()) as
        | ProfileRelayResponse
        | ProfileErrorResponse;
      if (!relayRes.ok) {
        setProfilePhase("error");
        setProfileMsg(
          (relay as ProfileErrorResponse).message ||
            "Couldn't set your profile.",
        );
        return;
      }
      setProfileTxHash((relay as ProfileRelayResponse).txHash);
      setProfilePhase("done");
    } catch (err) {
      // Most commonly: the user rejected the signature. Recoverable — tap again.
      setProfilePhase("error");
      setProfileMsg(
        err instanceof Error ? err.message : "Couldn't set your profile.",
      );
    }
  }

  // Open the edit form (issue #5, D3/D4) for an ALREADY-SET profile. Reads back
  // the saved name + bio and pre-fills each field by priority: saved value →
  // Farcaster default → empty. The pre-filled values become the baseline for the
  // changed-check. A failed read (network/non-ok) OR a `name:null` response
  // (which, for an already-set profile, means the READ failed — not "unset")
  // falls back to the Farcaster defaults and shows a subtle note. Isolated from
  // onboarding: only touches edit + profile state, never `phase`/`result`.
  async function openEditProfile() {
    if (!result) return;
    setProfileMsg(null);
    setProfileTxHash(null);
    setEditReadFailed(false);
    setEditFlow(true);
    setProfilePhase("editing");
    setEditLoading(true);
    const fcName = sdk.user?.displayName || sdk.user?.username || "";
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sdk.token ? { authorization: "Bearer " + sdk.token } : {}),
        },
        body: JSON.stringify({
          step: "current",
          safeAddress: result.safeAddress,
        }),
      });
      const data = (await res.json()) as ProfileCurrentResponse;
      if (!res.ok) throw new Error("read failed");
      const readFailed = data.name === null; // already-set ⇒ null means read failed
      // Name falls back to the Farcaster identity; bio has no default → empty.
      const name = (data.name ?? fcName) || "";
      const bio = data.description ?? "";
      setEditName(name);
      setEditBio(bio);
      setEditBaseName(name);
      setEditBaseBio(bio);
      setEditReadFailed(readFailed);
    } catch {
      // Fall back to the Farcaster name + empty bio, with a heads-up note.
      setEditName(fcName);
      setEditBio("");
      setEditBaseName(fcName);
      setEditBaseBio("");
      setEditReadFailed(true);
    } finally {
      setEditLoading(false);
    }
  }

  // Cancel the edit and return to the "already set" summary (the Edit-profile
  // panel) — NOT the "done" success panel, which would falsely read "Profile
  // updated ✓". `alreadySet` restores the Edit button in both the done-screen
  // and the #6 Manage contexts. No network.
  function cancelEdit() {
    setProfileMsg(null);
    setEditFlow(false);
    setProfilePhase("alreadySet");
  }

  // Save an edited profile (issue #5): prepare(overwrite) → noChange | sign →
  // relay. Reuses the sign+relay block from `handleSetProfile`. On any error we
  // return to `editing` with the entered values preserved (never clear
  // `editName`/`editBio`). Failure-isolated: only edit + profile state.
  async function handleSaveProfile() {
    if (!sdk.token || !sdk.provider || !result) return;
    const token = sdk.token;
    const provider = sdk.provider;
    setProfileMsg(null);
    setProfilePhase("preparing");
    try {
      const prepRes = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          step: "prepare",
          safeAddress: result.safeAddress,
          name: editName,
          description: editBio,
          overwrite: true,
        }),
      });
      const prep = (await prepRes.json()) as
        | ProfilePrepareResponse
        | ProfileErrorResponse;
      if (!prepRes.ok) {
        setProfilePhase("editing");
        setProfileMsg(
          (prep as ProfileErrorResponse).message ||
            "Couldn't prepare your profile.",
        );
        return;
      }
      const prepared = prep as ProfilePrepareResponse;
      if ("noChange" in prepared && prepared.noChange) {
        setProfileMsg("Nothing changed");
        setProfilePhase("done");
        return;
      }
      if ("alreadySet" in prepared && prepared.alreadySet) {
        // Defensive: the overwrite path shouldn't return this. Treat as done.
        setProfilePhase("done");
        return;
      }
      const needs = prepared as Extract<
        ProfilePrepareResponse,
        { alreadySet: false }
      >;

      // Sign with the connected owner; re-request if we don't have it yet.
      let signer = lastConnectedAddress;
      if (!signer) {
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        signer = accounts?.[0] ?? null;
      }
      if (!signer) {
        setProfilePhase("editing");
        setProfileMsg("Connect a wallet to sign.");
        return;
      }

      setProfilePhase("signing");
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [signer, JSON.stringify(needs.typedData)],
      })) as string;

      setProfilePhase("relaying");
      const relayRes = await fetch("/api/profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          step: "relay",
          safeAddress: result.safeAddress,
          digest: needs.digest,
          signerAddress: signer,
          signature,
        }),
      });
      const relay = (await relayRes.json()) as
        | ProfileRelayResponse
        | ProfileErrorResponse;
      if (!relayRes.ok) {
        setProfilePhase("editing");
        setProfileMsg(
          (relay as ProfileErrorResponse).message ||
            "Couldn't update your profile.",
        );
        return;
      }
      setProfileTxHash((relay as ProfileRelayResponse).txHash);
      setProfilePhase("done");
    } catch (err) {
      // Most commonly: the user rejected the signature. Recoverable — values kept.
      setProfilePhase("editing");
      setProfileMsg(
        err instanceof Error ? err.message : "Couldn't update your profile.",
      );
    }
  }

  const canShare = sdk.inHost && sdk.fid != null;

  const selectedCount =
    1 /* connected wallet, always */ +
    verifiedAddrs.filter((a) => selected[a.toLowerCase()]).length;

  const doneStatus = result?.alreadyRegistered
    ? "You're already on Circles."
    : result?.isHuman
      ? "You're verified as a human on Circles."
      : "Your account is live on Gnosis.";

  const certified = !!(result?.alreadyRegistered || result?.isHuman);

  // Returning-user (manage) Set-profile branching (issue #6, D5). All the logic
  // lives in these flags so the JSX stays a set of simple ternaries and
  // `handleSetProfile` stays dumb. Manage never offers "Update" (out of scope).
  const isManage = phase === "manage";
  // Only offer Set when we KNOW the profile is unset, the connected wallet is
  // still an on-chain owner (so the relayed signature would be valid), and we
  // actually have a name + wallet to write with (canSetProfile) — otherwise the
  // CTA would be a dead button.
  const manageCanSet =
    isManage &&
    account?.profileSet === false &&
    account?.ownerMatch !== false &&
    canSetProfile;
  const manageAlreadySet = isManage && account?.profileSet === true;
  const manageOwnerMismatch = isManage && account?.ownerMatch === false;

  // Save gating (issue #5, D6): disabled until the trimmed name or bio differs
  // from the read-back baseline.
  const editUnchanged =
    editName.trim() === editBaseName.trim() &&
    editBio.trim() === editBaseBio.trim();

  return (
    <main className="edition flex min-h-svh w-full justify-center px-4 py-6">
      <span className="grain" aria-hidden />

      <div className="relative flex w-full max-w-md flex-col gap-5">
        {/* ── Masthead (hidden during the minting screen for focus) ──── */}
        {!busy ? (
          <header className="rise" style={{ animationDelay: "0ms" }}>
            <div className="kicker flex items-center justify-between text-[var(--ink-soft)]">
              <span>Circles</span>
              {sdk.user?.username ? (
                <span style={{ textTransform: "none" }}>
                  @{sdk.user.username}
                </span>
              ) : null}
            </div>

            <hr className="rule mt-2.5" />

            <p className="kicker mt-3.5 text-[var(--ink-soft)]">
              Personal invite from{" "}
              <span className="font-bold text-[var(--cobalt)]">
                @{INVITER_HANDLE}
              </span>
            </p>

            <h1 className="display mt-1.5 text-[clamp(2.4rem,12vw,3.3rem)] uppercase">
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
              Personal currency for humans. Set up your account, gas-free, in
              one tap.
            </p>

            <hr className="rule-thin mt-4" />
          </header>
        ) : null}

        {/* ── Not in a Farcaster host ──────────────────────────────── */}
        {!sdk.inHost && !busy ? (
          <NoticeBlock tone="cobalt" label="Open in Farcaster" delay="60ms">
            This mini app runs inside the Farcaster app. Open it there to
            connect your wallet and create your Circles account.
          </NoticeBlock>
        ) : null}

        {/* ── Error ────────────────────────────────────────────────── */}
        {phase === "error" && errorMsg ? (
          <NoticeBlock tone="flame" label="Something went wrong" delay="60ms">
            {errorMsg}
          </NoticeBlock>
        ) : null}

        {(phase === "done" || phase === "manage") && result ? (
          /* ── The front-page win (also the returning-user Manage state) ── */
          <section className="flex flex-col gap-6">
            <div className="relative mx-auto grid h-28 w-28 place-items-center">
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
              <h2 className="display text-6xl uppercase">
                {isManage ? "Welcome back." : "You’re in."}
              </h2>
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
                Your smart wallet
              </span>
              <code className="mono mt-1.5 block break-all text-[13px] leading-snug">
                {result.safeAddress}
              </code>

              <span className="stamp pointer-events-none absolute -top-3.5 right-3 grid place-items-center rounded-full border-[2.5px] border-[var(--cobalt)] px-3 py-2 text-center text-[var(--cobalt)]">
                <span className="kicker leading-none">
                  {certified ? "Verified" : "Account"}
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
              {canShare ? (
                <button
                  type="button"
                  className="block-btn h-14 w-full bg-[var(--sun)] text-base text-[var(--ink)]"
                  onClick={shareToFarcaster}
                >
                  <span aria-hidden>◎</span>
                  Share to Farcaster
                </button>
              ) : null}
              <button
                type="button"
                className="block-btn h-12 w-full bg-[var(--paper)] text-sm text-[var(--ink)]"
                onClick={() => openExternal(gnosisAppProfile(result.safeAddress))}
              >
                Open in Gnosis app →
              </button>
              <button
                type="button"
                className="block-btn h-12 w-full bg-[var(--paper)] text-sm text-[var(--ink)]"
                onClick={() =>
                  openExternal(gnosisScanAddress(result.safeAddress))
                }
              >
                View on Gnosisscan
              </button>
            </div>

            {/* Personalize: name + photo onto the Circles account.
                done: success summary (set OR updated OR "Nothing changed").
                editing (issue #5, D8): the edit form, opened from an already-set
                  profile (done screen or #6 Manage). The saving phases of an edit
                  (preparing/signing/relaying, gated by `editFlow`) render progress
                  here too so they don't fall through to the first-time CTA.
                manage (issue #6, D5): driven by the on-chain account facts —
                Set ONLY when the profile is known-unset and the connected wallet
                is still an owner; "Edit profile" when already set; owner-mismatch
                info otherwise; hidden when profileSet is null (can't confirm). */}
            {(!isManage && canSetProfile) ||
            manageCanSet ||
            manageAlreadySet ||
            manageOwnerMismatch ||
            profilePhase === "done" ||
            profilePhase === "editing" ||
            profilePhase === "alreadySet" ||
            (profileBusy && editFlow) ? (
              <div className="rise" style={{ animationDelay: "320ms" }}>
                {profilePhase === "done" ? (
                  <div className="panel-pop relative bg-[var(--paper-2)] p-4">
                    <span className="kicker text-[var(--ink-soft)]">
                      Circles profile
                    </span>
                    {profileMsg === "Nothing changed" ? (
                      <p className="mt-1 text-[14px] font-semibold">
                        Nothing changed
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-[14px] font-semibold">
                          Profile updated ✓
                        </p>
                        <p className="mt-0.5 text-[13px] text-[var(--ink-soft)]">
                          Your name{sdk.user?.pfpUrl ? " and photo" : ""} now show
                          in the Circles app.
                        </p>
                        {profileTxHash ? (
                          <a
                            href={gnosisScanTx(profileTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mono mt-1.5 inline-flex items-center gap-2 break-all text-xs underline decoration-2 underline-offset-2 hover:text-[var(--cobalt)]"
                          >
                            <span aria-hidden>↳</span>
                            {shortAddr(profileTxHash)}
                          </a>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : profilePhase === "editing" ? (
                  <div className="panel-pop bg-[var(--paper-2)] p-4">
                    <span className="kicker text-[var(--ink-soft)]">
                      Circles profile
                    </span>
                    <p className="mt-1 text-[15px] font-semibold">
                      Edit your Circles profile
                    </p>

                    {/* Read-only avatar — follows the Farcaster pfp. */}
                    <div className="mt-3 flex items-center gap-3">
                      {sdk.user?.pfpUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={sdk.user.pfpUrl}
                          alt=""
                          decoding="async"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          className="h-12 w-12 flex-none rounded-full border-2 border-[var(--ink)] object-cover"
                        />
                      ) : null}
                      <span className="kicker text-[var(--ink-soft)]">
                        Photo follows your Farcaster pfp
                      </span>
                    </div>

                    <div className="mt-3 flex flex-col gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="kicker text-[var(--ink-soft)]">
                          Name
                        </span>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          // Match MAX_PROFILE_NAME so the changed-check (D6) lines
                          // up with the server clamp — chars past 36 are dropped on
                          // save and would otherwise enable Save for a no-op edit.
                          maxLength={36}
                          disabled={editLoading}
                          className="border-2 border-[var(--ink)] bg-[var(--paper)] px-2.5 py-2 text-[14px]"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="kicker text-[var(--ink-soft)]">Bio</span>
                        <textarea
                          value={editBio}
                          onChange={(e) => setEditBio(e.target.value)}
                          maxLength={256}
                          rows={3}
                          disabled={editLoading}
                          className="resize-none border-2 border-[var(--ink)] bg-[var(--paper)] px-2.5 py-2 text-[14px] leading-snug"
                        />
                      </label>
                    </div>

                    {editLoading ? (
                      <p className="mono mt-2 text-xs text-[var(--ink-soft)]">
                        Loading your profile…
                      </p>
                    ) : editReadFailed ? (
                      <p className="mt-2 text-[12px] text-[var(--ink-soft)]">
                        Couldn’t load your saved profile — saving will set it from
                        your Farcaster identity.
                      </p>
                    ) : null}

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={handleSaveProfile}
                        disabled={editUnchanged || editLoading}
                        className="block-btn h-12 flex-1 bg-[var(--cobalt)] text-sm text-[var(--paper)] disabled:opacity-50"
                      >
                        Save changes
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="block-btn h-12 flex-1 bg-[var(--paper)] text-sm text-[var(--ink)]"
                      >
                        Cancel
                      </button>
                    </div>

                    {profileMsg ? (
                      <p className="mt-2 text-[13px] text-[var(--flame)]">
                        {profileMsg} Tap to retry.
                      </p>
                    ) : null}
                  </div>
                ) : profileBusy && editFlow ? (
                  /* Save round-trip from an edit: inline progress (no Set CTA). */
                  <div className="panel-pop bg-[var(--paper-2)] p-4">
                    <span className="kicker text-[var(--ink-soft)]">
                      Circles profile
                    </span>
                    <button
                      type="button"
                      disabled
                      className="block-btn mt-2 h-12 w-full bg-[var(--cobalt)] text-sm text-[var(--paper)] opacity-80"
                    >
                      {profilePhase === "preparing"
                        ? "Preparing…"
                        : profilePhase === "signing"
                          ? "Confirm in your wallet…"
                          : "Saving…"}
                    </button>
                  </div>
                ) : profilePhase === "alreadySet" || manageAlreadySet ? (
                  <div className="panel-pop bg-[var(--paper-2)] p-4">
                    <span className="kicker text-[var(--ink-soft)]">
                      Circles profile
                    </span>
                    <p className="mt-1 text-[14px]">Your Circles profile is set.</p>
                    <button
                      type="button"
                      onClick={openEditProfile}
                      className="block-btn mt-3 h-12 w-full bg-[var(--cobalt)] text-sm text-[var(--paper)]"
                    >
                      Edit profile
                    </button>
                  </div>
                ) : manageOwnerMismatch ? (
                  <NoticeBlock
                    tone="cobalt"
                    label="Manage in the Gnosis app"
                    delay="320ms"
                  >
                    This Circles account exists, but your connected wallet isn’t
                    one of its signers. Open it in the Gnosis app to manage it.
                  </NoticeBlock>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleSetProfile}
                      disabled={profileBusy}
                      className="block-btn h-14 w-full bg-[var(--cobalt)] text-base text-[var(--paper)]"
                    >
                      {profilePhase === "preparing"
                        ? "Preparing…"
                        : profilePhase === "signing"
                          ? "Confirm in your wallet…"
                          : profilePhase === "relaying"
                            ? "Setting profile…"
                            : "Set your Circles profile"}
                    </button>
                    <p className="kicker mt-2 text-center text-[var(--ink-soft)]">
                      Use your Farcaster name
                      {sdk.user?.pfpUrl ? " + photo" : ""} · One tap to sign ·
                      Gas-free
                    </p>
                    {profilePhase === "error" && profileMsg ? (
                      <p className="mt-2 text-[13px] text-[var(--flame)]">
                        {profileMsg} Tap to retry.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {result.txHashes.length > 0 ? (
              <div className="rise" style={{ animationDelay: "340ms" }}>
                <span className="kicker text-[var(--ink-soft)]">
                  Transactions
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
          <MintingState mintStage={mintStage} elapsed={elapsed} />
        ) : (
          /* ── The setup edition ──────────────────────────────────── */
          <>
            {/* Hero coin wearing your face, emitting currency */}
            <div className="rise" style={{ animationDelay: "80ms" }}>
              <CoinMark busy={false} pfpUrl={sdk.user?.pfpUrl ?? null} />
            </div>

            {/* What happens — compact three-step strip */}
            <div className="rise" style={{ animationDelay: "130ms" }}>
              <h2 className="kicker text-[var(--ink-soft)]">What happens</h2>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {STEPS.map((s) => (
                  <div
                    key={s.n}
                    className="panel flex flex-col gap-0.5 px-2.5 py-2"
                  >
                    <span className="display text-lg leading-none text-[var(--ink)]">
                      {s.n}
                    </span>
                    <span className="min-h-[2.5em] text-[12px] font-semibold leading-tight text-balance">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Keyholders — collapsed by default; most people never edit it */}
            <details className="disclosure panel rise" style={{ animationDelay: "180ms" }}>
              <summary className="flex min-h-[44px] items-center justify-between bg-[var(--ink)] px-3.5 py-2.5">
                <span className="kicker text-[var(--paper)]">Signers</span>
                <span className="flex items-center gap-2">
                  <span className="kicker rounded-full bg-[var(--sun)] px-2 py-0.5 text-[var(--ink)]">
                    {selectedCount > 1
                      ? `Wallet + ${selectedCount - 1} verified`
                      : "Wallet only"}
                  </span>
                  <span className="chev text-[var(--paper)]" aria-hidden>
                    ▾
                  </span>
                </span>
              </summary>

              <div className="px-3.5 pb-3 pt-2.5">
                <p className="text-[13px] leading-snug text-[var(--ink-soft)]">
                  These addresses can sign for your account. Your connected
                  wallet is always in. Named addresses (ENS or Base) are added
                  by default; check any others you’d like to include.
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
                    No verified addresses. Your connected wallet signs alone.
                  </p>
                ) : (
                  <div className="mt-1">
                    {verifiedAddrs.map((addr) => {
                      const name = names[addr.toLowerCase()]?.primary ?? null;
                      const on = !!selected[addr.toLowerCase()];
                      return (
                        <label
                          key={addr}
                          className="rule-thin flex cursor-pointer items-center gap-3 border-t px-2.5 py-2.5"
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
                Create my account
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
          <p className="kicker text-[var(--ink-soft)]">About</p>
          <p className="mt-1 text-[11px] leading-snug text-[var(--ink-soft)]">
            Independent project. Built alongside the Circles team; not officially
            endorsed by Circles or Gnosis.
          </p>
        </footer>

        {/* ── Printer’s marks (dev only) ───────────────────────────── */}
        {DEBUG_ENABLED ? (
          <details className="panel bg-[var(--paper-2)] text-xs">
            <summary className="kicker cursor-pointer bg-[var(--ink)] px-3 py-2 text-[var(--paper)]">
              Debug
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
                      : "NO. Hard-reload the mini-app (stale bundle)"
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
  mintStage,
  elapsed,
}: {
  mintStage: number;
  elapsed: number;
}) {
  // mintStage is the ACTUAL milestone index (0..3), driven by stream events.
  // It is 0 during `connecting`, so no special-case is needed.
  const current = Math.min(mintStage, MINT_MILESTONES.length - 1);

  return (
    <section className="flex min-h-[72svh] flex-col">
      <div className="kicker flex items-center justify-between text-[var(--ink-soft)]">
        <span>Circles</span>
        <span>Setting up</span>
      </div>
      <hr className="rule mt-2.5" />

      {/* the press at work */}
      <div className="relative mx-auto mt-8 mb-2 grid h-36 w-36 place-items-center">
        <span className="ring-ripple fast" style={{ animationDelay: "0s" }} aria-hidden />
        <span className="ring-ripple fast" style={{ animationDelay: "0.93s" }} aria-hidden />
        <span className="ring-ripple fast" style={{ animationDelay: "1.87s" }} aria-hidden />
        <span
          className="spin-slow absolute inset-[-12px] rounded-full border-[3px] border-dashed border-[var(--cobalt)]"
          aria-hidden
        />
        <div className="coin shimmer relative grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-[var(--sun)]">
          <CirclesGlyph />
        </div>
      </div>

      <h2 className="display mt-4 text-center text-4xl uppercase">
        Creating your
        <br />
        account…
      </h2>
      <p className="mx-auto mt-2 max-w-[30ch] text-center text-[14px] leading-snug text-[var(--ink-soft)]">
        Writing to Gnosis. This usually takes 15 to 30 seconds.
      </p>

      {/* live milestone ledger — announced to screen readers as it advances */}
      <ol className="panel mt-6" role="status" aria-live="polite">
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
    <div className="relative mx-auto grid h-32 w-32 place-items-center">
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
      <div className="coin relative grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-[var(--sun)]">
        <CirclesGlyph />
        {pfpUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pfpUrl}
            alt=""
            decoding="async"
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
    <div
      className="panel-pop rise"
      style={{ animationDelay: delay }}
      role={tone === "flame" ? "alert" : "status"}
    >
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

"use client";

import { useEffect, useState } from "react";

import { useMiniappSdk } from "@/hooks/use-miniapp-sdk";

interface Capabilities {
  hasPublicKeyCredential: boolean;
  hasCredentialsApi: boolean;
  platformAuthenticatorAvailable: boolean | "unknown";
  conditionalUiAvailable: boolean | "unknown";
  userAgent: string;
  isSecureContext: boolean;
  origin: string;
}

type CreateResult =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "ok";
      credentialId: string;
      publicKeyAlgo: number | null;
      attestationFormat: string | null;
      publicKeyXY: { x: string; y: string } | null;
    }
  | { status: "error"; name: string; message: string };

type ChainProbeResult =
  | { status: "idle" }
  | { status: "running"; step: string }
  | {
      status: "ok";
      providerFound: boolean;
      accountsBefore: string[];
      chainIdBefore: string | null;
      switchedTo100: boolean | "rejected" | "errored";
      switchError: string | null;
      chainIdAfter: string | null;
      sendTxSupported: boolean | "untested";
      sendTxError: string | null;
    }
  | { status: "error"; name: string; message: string };

function buf2hex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function detectCapabilities(): Promise<Capabilities> {
  const hasPublicKeyCredential =
    typeof window !== "undefined" && "PublicKeyCredential" in window;
  const hasCredentialsApi =
    typeof navigator !== "undefined" && !!navigator.credentials;

  let platformAuthenticatorAvailable: boolean | "unknown" = "unknown";
  let conditionalUiAvailable: boolean | "unknown" = "unknown";

  if (hasPublicKeyCredential) {
    try {
      platformAuthenticatorAvailable =
        await (window as unknown as {
          PublicKeyCredential: {
            isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
          };
        }).PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.() ??
        false;
    } catch {
      platformAuthenticatorAvailable = false;
    }
    try {
      conditionalUiAvailable =
        await (window as unknown as {
          PublicKeyCredential: {
            isConditionalMediationAvailable?: () => Promise<boolean>;
          };
        }).PublicKeyCredential.isConditionalMediationAvailable?.() ?? false;
    } catch {
      conditionalUiAvailable = false;
    }
  }

  return {
    hasPublicKeyCredential,
    hasCredentialsApi,
    platformAuthenticatorAvailable,
    conditionalUiAvailable,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    origin: typeof window !== "undefined" ? window.location.origin : "",
  };
}

async function createPasskey(rpName: string, userName: string): Promise<CreateResult> {
  if (!("PublicKeyCredential" in window) || !navigator.credentials) {
    return {
      status: "error",
      name: "Unsupported",
      message: "PublicKeyCredential / navigator.credentials not available.",
    };
  }
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const userId = new Uint8Array(16);
    crypto.getRandomValues(userId);

    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: rpName },
        user: { id: userId, name: userName, displayName: userName },
        // Circles uses Safe's WebAuthn verifier which expects P-256 (ES256, -7)
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;

    if (!cred) {
      return {
        status: "error",
        name: "NoCredential",
        message: "navigator.credentials.create returned null.",
      };
    }

    const response = cred.response as AuthenticatorAttestationResponse;
    let pubKeyAlgo: number | null = null;
    let attestationFormat: string | null = null;
    let publicKeyXY: { x: string; y: string } | null = null;

    try {
      pubKeyAlgo = response.getPublicKeyAlgorithm?.() ?? null;
    } catch {}

    try {
      const pubKey = response.getPublicKey?.();
      if (pubKey) {
        // The exported SPKI for ES256 is a SubjectPublicKeyInfo wrapping the
        // uncompressed point. The raw point begins with 0x04 then x (32 bytes)
        // then y (32 bytes). Look for the 0x04 marker in the trailing 65 bytes.
        const u8 = new Uint8Array(pubKey);
        if (u8.length >= 65) {
          const tail = u8.slice(u8.length - 65);
          if (tail[0] === 0x04) {
            publicKeyXY = {
              x: "0x" + buf2hex(tail.slice(1, 33)),
              y: "0x" + buf2hex(tail.slice(33, 65)),
            };
          }
        }
      }
    } catch {}

    try {
      // attestationObject is CBOR; we peek the first byte after the "fmt" key.
      // Avoid pulling in a CBOR dep — fall back to "n/a" if parsing fails.
      const ao = new Uint8Array(response.attestationObject);
      const decoded = new TextDecoder().decode(ao);
      const m = decoded.match(/fmt[\x00-\xff]?([a-z\-]+)/);
      attestationFormat = m?.[1] ?? null;
    } catch {}

    return {
      status: "ok",
      credentialId: cred.id,
      publicKeyAlgo: pubKeyAlgo,
      attestationFormat,
      publicKeyXY,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      status: "error",
      name: e?.name ?? "Error",
      message: e?.message ?? String(err),
    };
  }
}

async function probeGnosisChain(): Promise<ChainProbeResult> {
  try {
    const { sdk } = await import("@farcaster/miniapp-sdk");
    const provider = (sdk as unknown as {
      wallet?: { ethProvider?: {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      } };
    }).wallet?.ethProvider;

    if (!provider) {
      return {
        status: "ok",
        providerFound: false,
        accountsBefore: [],
        chainIdBefore: null,
        switchedTo100: "errored",
        switchError: "sdk.wallet.ethProvider not exposed by host",
        chainIdAfter: null,
        sendTxSupported: "untested",
        sendTxError: null,
      };
    }

    let accountsBefore: string[] = [];
    try {
      accountsBefore = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    } catch {
      try {
        accountsBefore = (await provider.request({ method: "eth_accounts" })) as string[];
      } catch {}
    }

    let chainIdBefore: string | null = null;
    try {
      chainIdBefore = (await provider.request({ method: "eth_chainId" })) as string;
    } catch {}

    let switchedTo100: boolean | "rejected" | "errored" = false;
    let switchError: string | null = null;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x64" }],
      });
      switchedTo100 = true;
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e?.code === 4001) {
        switchedTo100 = "rejected";
      } else {
        switchedTo100 = "errored";
      }
      switchError = e?.message ?? String(err);
    }

    let chainIdAfter: string | null = null;
    try {
      chainIdAfter = (await provider.request({ method: "eth_chainId" })) as string;
    } catch {}

    let sendTxSupported: boolean | "untested" = "untested";
    let sendTxError: string | null = null;
    if (switchedTo100 === true && accountsBefore[0]) {
      try {
        const txHash = await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: accountsBefore[0],
              to: accountsBefore[0],
              value: "0x0",
              data: "0x",
              gas: "0x30000",
            },
          ],
        });
        sendTxSupported = true;
        sendTxError = `tx hash: ${String(txHash).slice(0, 20)}… (confirmed — you can ignore this in production, was a 0-wei self-transfer)`;
      } catch (err) {
        const e = err as { code?: number; message?: string };
        if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? "")) {
          sendTxSupported = true;
          sendTxError = "method exposed (user rejected the prompt — that's the proof it works)";
        } else if (/method|not supported|unsupported/i.test(e?.message ?? "")) {
          sendTxSupported = false;
          sendTxError = e?.message ?? String(err);
        } else {
          sendTxSupported = false;
          sendTxError = e?.message ?? String(err);
        }
      }
    }

    return {
      status: "ok",
      providerFound: true,
      accountsBefore,
      chainIdBefore,
      switchedTo100,
      switchError,
      chainIdAfter,
      sendTxSupported,
      sendTxError,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      status: "error",
      name: e?.name ?? "Error",
      message: e?.message ?? String(err),
    };
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
      <span style={{ color: "#888" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono, monospace)", textAlign: "right", wordBreak: "break-all" }}>
        {value}
      </span>
    </div>
  );
}

export function PasskeyProbe() {
  const mini = useMiniappSdk();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [result, setResult] = useState<CreateResult>({ status: "idle" });
  const [chainResult, setChainResult] = useState<ChainProbeResult>({ status: "idle" });

  useEffect(() => {
    detectCapabilities().then(setCaps);
  }, []);

  async function run() {
    setResult({ status: "running" });
    const r = await createPasskey(
      "Circles Onboard Probe",
      mini.fid ? `fid-${mini.fid}` : "probe-user",
    );
    setResult(r);
  }

  async function runChainProbe() {
    setChainResult({ status: "running", step: "calling wallet_switchEthereumChain…" });
    const r = await probeGnosisChain();
    setChainResult(r);
  }

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 640,
        margin: "0 auto",
        fontFamily: "system-ui, sans-serif",
        color: "#eee",
        background: "#0b0a14",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Passkey probe</h1>
      <p style={{ color: "#aaa", lineHeight: 1.4, marginBottom: 24 }}>
        Tests whether this browser/webview can create a P-256 platform passkey.
        Required for the Circles in-app claim flow (ReferralsModule.claimAccount).
      </p>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #222", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px 0", color: "#bbb" }}>Farcaster mini-app context</h2>
        <Row label="In Warpcast host" value={String(mini.inHost)} />
        <Row label="FID" value={mini.fid ? String(mini.fid) : "—"} />
        <Row label="SDK ready" value={String(mini.ready)} />
        {mini.error ? <Row label="SDK error" value={mini.error} /> : null}
      </section>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #222", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px 0", color: "#bbb" }}>WebAuthn capabilities</h2>
        {!caps ? (
          <p style={{ color: "#888" }}>Detecting…</p>
        ) : (
          <>
            <Row label="window.PublicKeyCredential" value={String(caps.hasPublicKeyCredential)} />
            <Row label="navigator.credentials" value={String(caps.hasCredentialsApi)} />
            <Row label="Platform authenticator" value={String(caps.platformAuthenticatorAvailable)} />
            <Row label="Conditional UI" value={String(caps.conditionalUiAvailable)} />
            <Row label="Secure context" value={String(caps.isSecureContext)} />
            <Row label="Origin" value={caps.origin} />
            <Row label="User agent" value={caps.userAgent} />
          </>
        )}
      </section>

      <button
        onClick={run}
        disabled={result.status === "running"}
        style={{
          width: "100%",
          padding: "14px 18px",
          background: result.status === "running" ? "#333" : "#7c5cff",
          color: "white",
          border: "none",
          borderRadius: 8,
          fontSize: 16,
          fontWeight: 600,
          cursor: result.status === "running" ? "default" : "pointer",
        }}
      >
        {result.status === "running" ? "Waiting for authenticator…" : "Try creating a passkey"}
      </button>

      <section style={{ marginTop: 24, padding: 16, border: "1px solid #222", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px 0", color: "#bbb" }}>Create result</h2>
        {result.status === "idle" && <p style={{ color: "#888" }}>Tap the button to test.</p>}
        {result.status === "running" && <p style={{ color: "#888" }}>Prompting authenticator…</p>}
        {result.status === "ok" && (
          <>
            <Row label="Status" value="OK ✅" />
            <Row label="Credential id" value={result.credentialId} />
            <Row label="Algorithm" value={result.publicKeyAlgo === -7 ? "ES256 (P-256) ✅" : String(result.publicKeyAlgo)} />
            <Row label="Attestation fmt" value={result.attestationFormat ?? "—"} />
            <Row label="Pub key x" value={result.publicKeyXY?.x ?? "—"} />
            <Row label="Pub key y" value={result.publicKeyXY?.y ?? "—"} />
          </>
        )}
        {result.status === "error" && (
          <>
            <Row label="Status" value="Error ❌" />
            <Row label="Name" value={result.name} />
            <Row label="Message" value={result.message} />
          </>
        )}
      </section>

      <section style={{ marginTop: 24, padding: 16, border: "1px solid #222", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px 0", color: "#bbb" }}>Gnosis Chain (100) wallet probe</h2>
        <p style={{ color: "#888", fontSize: 12, marginTop: 0 }}>
          Tests whether the Farcaster host&apos;s wallet provider supports chainId 100. This will trigger a real `eth_sendTransaction` confirmation for a 0-wei self-transfer — <strong>reject it</strong>. The rejection itself proves the method is exposed.
        </p>
        <button
          onClick={runChainProbe}
          disabled={chainResult.status === "running"}
          style={{
            width: "100%",
            padding: "12px 18px",
            background: chainResult.status === "running" ? "#333" : "#3b8eea",
            color: "white",
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: chainResult.status === "running" ? "default" : "pointer",
            marginBottom: 12,
          }}
        >
          {chainResult.status === "running" ? chainResult.step : "Test Gnosis Chain switch"}
        </button>
        {chainResult.status === "idle" && <p style={{ color: "#888" }}>Tap the button to test.</p>}
        {chainResult.status === "ok" && (
          <>
            <Row label="ethProvider exposed" value={String(chainResult.providerFound)} />
            <Row label="accounts" value={chainResult.accountsBefore[0] ?? "—"} />
            <Row label="chainId before" value={chainResult.chainIdBefore ?? "—"} />
            <Row label="switch to 0x64 (100)" value={String(chainResult.switchedTo100)} />
            {chainResult.switchError ? <Row label="switch error" value={chainResult.switchError} /> : null}
            <Row label="chainId after" value={chainResult.chainIdAfter ?? "—"} />
            <Row
              label="sendTx on Gnosis"
              value={chainResult.sendTxSupported === true ? "supported ✅" : chainResult.sendTxSupported === false ? "blocked ❌" : "not tested"}
            />
            {chainResult.sendTxError ? <Row label="sendTx error" value={chainResult.sendTxError} /> : null}
          </>
        )}
        {chainResult.status === "error" && (
          <>
            <Row label="Status" value="Error ❌" />
            <Row label="Name" value={chainResult.name} />
            <Row label="Message" value={chainResult.message} />
          </>
        )}
      </section>
    </main>
  );
}

export interface UserSummary {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
}

export interface OnboardModules {
  invitation: boolean;
  erc4337: boolean;
}

export interface OnboardRequest {
  connectedAddress: string;
  /**
   * Verified addresses the user chose to ALSO add as Safe signers. The server
   * re-validates each against the fid's real verified set (so deselects are
   * honored and arbitrary addresses can't be injected). The connected wallet is
   * always an owner regardless of this list.
   */
  additionalOwners?: string[];
}

// ---------- Neynar profile (debug / context) ----------

export interface NeynarViewerRelation {
  viewerFid: number;
  viewerFollowsUser: boolean | null; // does the viewer (operator) follow this user
  userFollowsViewer: boolean | null; // does this user follow the viewer (operator)
  mutual: boolean | null;
}

export interface NeynarProfile {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
  neynarScore: number | null;
  custodyAddress: string | null;
  verifiedEthAddresses: string[];
  viewer: NeynarViewerRelation | null;
  /** The complete, unmodified Neynar user object (debug only). */
  raw: Record<string, unknown> | null;
}

// ---------- anti-spam signals (free / keyless) ----------

export interface SpamSignals {
  fid: number;
  /** This fid IS the operator (DEBUG_VIEWER_FID) — always allowed. */
  isOperator: boolean;
  /** This fid is in ONBOARD_ALLOWLIST_FIDS — always allowed. */
  allowlisted: boolean;
  /** Warpcast power badge. NOTE: considered stale/outdated; not used for gating. */
  powerBadge: boolean | null;
  /** Operator (DEBUG_VIEWER_FID) follows this user. null = unknown / no viewer. */
  operatorFollowsUser: boolean | null;
  /** This user follows the operator. */
  userFollowsOperator: boolean | null;
  /** Both directions true (operator/allowlisted are treated as mutual). */
  mutualWithOperator: boolean | null;
  /** Count of the fid's verified ETH addresses. */
  verifiedAddressCount: number;
}

// ---------- name resolution (ENS + basename) ----------

export interface NameInfo {
  address: string; // checksummed
  ens: string | null; // mainnet ENS reverse (.eth)
  basename: string | null; // Base basename reverse (.base.eth)
  primary: string | null; // ens ?? basename
}

export interface NamesResponse {
  names: Record<string, NameInfo>; // keyed by lowercased address
}

export interface NamesErrorResponse {
  error: "unauthorized" | "invalid_request" | "server_error";
  message: string;
}

// ---------- /api/verified-addresses ----------

export interface VerifiedAddressesResponse {
  /** The fid's verified ETH addresses (checksummed). */
  verifiedAddresses: string[];
  /** ENS / basename for each, keyed by lowercased address (best-effort). */
  names: Record<string, NameInfo>;
  /**
   * The lowercased addresses the UI should auto-select as co-signers by
   * default: those with a distinct name (ENS / basename). Decided server-side
   * so the default — and thus the resulting Safe address — doesn't depend on
   * client-side name-resolution timing. Plain addresses are opt-in.
   */
  recommended: string[];
  /** Source actually used: free hub, Neynar fallback, or none on failure. */
  source: "hub" | "neynar" | "none";
}

export interface VerifiedAddressesErrorResponse {
  error: "unauthorized" | "server_error";
  message: string;
}

// ---------- /api/profile (set Circles name + avatar, post-onboard) ----------

/**
 * EIP-712 typed data for a Safe transaction, as produced by protocol-kit's
 * `generateTypedData` and consumed by the wallet's `eth_signTypedData_v4`.
 * Numeric fields are serialized to strings before crossing the wire (bigints
 * don't JSON-encode), which is valid EIP-712 for uint256 inputs.
 */
export interface ProfileTypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export interface ProfilePrepareRequest {
  /** The user's Safe address (from the onboard result). */
  safeAddress: string;
}

/** Profile already set on-chain — no signature needed (idempotent). */
export interface ProfilePrepareAlreadySet {
  alreadySet: true;
}

/** Profile not set — client must sign `typedData` and POST it to `relay`. */
export interface ProfilePrepareNeedsSignature {
  alreadySet: false;
  /** The Circles profile name we'll set (displayName || username, clamped). */
  name: string;
  /** Whether an avatar thumbnail was attached to the uploaded profile. */
  hasImage: boolean;
  /** 0x-prefixed 32-byte metadata digest (the uploaded profile's CID). */
  digest: string;
  /** Safe-tx typed data to sign with `eth_signTypedData_v4`. */
  typedData: ProfileTypedData;
}

export type ProfilePrepareResponse =
  | ProfilePrepareAlreadySet
  | ProfilePrepareNeedsSignature;

export interface ProfileRelayRequest {
  safeAddress: string;
  /** Must equal the digest returned by `prepare` (0x + 64 hex). */
  digest: string;
  /** The owner address that produced `signature`. */
  signerAddress: string;
  /** The owner's `eth_signTypedData_v4` signature over the prepared Safe tx. */
  signature: string;
}

export interface ProfileRelayResponse {
  txHash: string;
}

export type ProfileErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "no_profile" // the fid has no usable display name / username
  | "upload_failed" // profile service (IPFS pin) rejected/unreachable
  | "relay_failed" // operator execTransaction failed or digest didn't stick
  | "server_error";

export interface ProfileErrorResponse {
  error: ProfileErrorCode;
  message: string;
}

// ---------- onboard debug payload (dev only) ----------

export interface OnboardDebug {
  reqId: string;
  verifiedFid: number; // from Quick Auth (cryptographically verified)
  connectedAddress: string; // from the client wallet (NOT verified to the fid)
  connectedAddressIsVerified: boolean | null; // is it among the fid's verified/custody addrs
  requestedAdditionalOwners: string[]; // what the client asked to add
  acceptedAdditionalOwners: string[]; // survived server-side verified-set check
  rejectedAdditionalOwners: string[]; // dropped: not in the fid's verified set
  owners: string[];
  safeAddress: string | null;
  quota: string | null;
  steps: string[];
  profile: NeynarProfile | null;
  profileError: string | null;
  signals: SpamSignals | null;
  gate: { policy: string; allowed: boolean; reason: string } | null;
}

export interface OnboardResponse {
  safeAddress: string;
  isHuman: boolean;
  avatar: string;
  modules: OnboardModules;
  txHashes: string[];
  alreadyRegistered: boolean;
  debug?: OnboardDebug;
}

export type OnboardErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "gated"
  | "no_quota"
  | "inviter_unavailable"
  | "deploy_failed"
  | "safe_not_ready"
  | "invite_failed"
  | "not_registered"
  | "server_error";

export interface OnboardErrorResponse {
  error: OnboardErrorCode;
  message: string;
  txHashes?: string[];
  debug?: OnboardDebug;
}

// ---------- /api/debug/me ----------

export interface DebugMeResponse {
  verifiedFid: number;
  domain: string;
  profile: NeynarProfile | null;
  profileError: string | null; // why profile is null (e.g. missing NEYNAR_API_KEY)
  neynarKeyConfigured: boolean;
  viewerFidConfigured: number | null;
  signals: SpamSignals | null; // free/keyless anti-spam signals
  gate: { policy: string; allowed: boolean; reason: string } | null;
}

export interface DebugMeErrorResponse {
  error: "unauthorized" | "server_error";
  message: string;
}

// ---------- onboard service result union (D2) ----------

/** The two route-level codes the SERVICE never emits (route owns auth + parse). */
export type OnboardRouteErrorCode = "unauthorized" | "invalid_request";

/** The codes the SERVICE (onboardAccount) can emit. Subset of OnboardErrorCode. */
export type OnboardServiceErrorCode = Exclude<
  OnboardErrorCode,
  OnboardRouteErrorCode
>;
// = "gated" | "no_quota" | "deploy_failed" | "safe_not_ready"
//   | "invite_failed" | "not_registered" | "server_error"

export interface OnboardSuccess {
  ok: true;
  /** 200 success body, already shaped for the HTTP response. */
  response: OnboardResponse;
}

export interface OnboardFailure {
  ok: false;
  code: OnboardServiceErrorCode;
  message: string;
  /** Present on invite_failed / not_registered (txs were broadcast). */
  txHashes?: string[];
  /** Debug payload built by the service (shared buildDebug). */
  debug?: OnboardDebug;
}

export type OnboardOutcome = OnboardSuccess | OnboardFailure;

// ---------- progress streaming (SSE) ----------

/**
 * Semantic step the chain onboarding is on. Stable machine ids — NO UI copy.
 * The frontend maps these to user-facing milestones; a CLI renders its own.
 */
export type OnboardStage =
  | "predicting" // deriving the deterministic Safe address
  | "preflight" // read-only quota + inviter-human checks
  | "deploying" // deploying the Safe (operator pays gas)
  | "verifying" // assertSafeReady (modules + fallback + owners)
  | "inviting" // atomic claim + transfer
  | "registering"; // polling Hub.isHuman until it flips

/**
 * One progress tick emitted by the chain core. Machine data only, no UI copy.
 * Already shaped as a wire event (`type:"progress"`) so the route can forward
 * it to the SSE stream without re-wrapping.
 */
export interface OnboardProgress {
  type: "progress";
  stage: OnboardStage;
  /** Set from `predicting` onward. */
  safeAddress?: string;
  /** On `registering`: 1-based poll attempt. */
  attempt?: number;
}

/**
 * Error codes the CHAIN core can emit. The Farcaster-only `gated` is excluded
 * by construction — the core never sees the gate — so the separation is a
 * compile-time guarantee, not a convention.
 */
export type ChainOnboardErrorCode = Exclude<OnboardServiceErrorCode, "gated">;

export interface ChainOnboardSuccess {
  ok: true;
  /** Normalized (sorted, deduped) owner set the core actually used. */
  owners: string[];
  safeAddress: string;
  isHuman: true;
  avatar: string;
  txHashes: string[];
  /** True when the Safe was already a registered human (idempotent no-op). */
  alreadyRegistered: boolean;
}

export interface ChainOnboardFailure {
  ok: false;
  code: ChainOnboardErrorCode;
  message: string;
  /** Normalized owner set the core resolved to (for debug). */
  owners: string[];
  /** Predicted address, or null if prediction itself failed. */
  safeAddress: string | null;
  /** Any txs broadcast before the failure (invite partials). */
  txHashes: string[];
  /** Inviter quota observed at preflight, for debug. */
  quota: string | null;
}

/**
 * What `onboardSafeToCircles` resolves to. Transport-agnostic: the route maps
 * it to a terminal SSE event; a script or CLI can consume it directly.
 */
export type ChainOnboardOutcome = ChainOnboardSuccess | ChainOnboardFailure;

/**
 * The discriminated event union sent over the SSE channel — one JSON object per
 * `data:` line. Progress ticks during the run; exactly one terminal event
 * (`result` | `error`) closes it.
 */
export type OnboardStreamEvent =
  | OnboardProgress
  | { type: "result"; result: OnboardResponse }
  | { type: "error"; error: OnboardErrorResponse };

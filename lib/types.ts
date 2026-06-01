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
  /** Source actually used: free hub, Neynar fallback, or none on failure. */
  source: "hub" | "neynar" | "none";
}

export interface VerifiedAddressesErrorResponse {
  error: "unauthorized" | "server_error";
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

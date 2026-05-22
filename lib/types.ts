export interface Candidate {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
  score: number; // > MIN_SCORE
  followedBy: true; // always true post-filter
}

export interface AssignmentRecord {
  shortcode: string;
  inviterFid: number;
  inviteeFid: number;
  inviteeUsername: string;
  assignedAt: number; // unix ms
  firstOpenedAt: number | null; // first non-bot redirect ts
  openCount: number; // total redirect hits (incl. bots)
}

export interface Assignment {
  inviteeFid: number;
  inviteeUsername: string;
  shortcode: string;
  shortUrl: string;
  dmDeepLink: string;
}

export interface CandidatesResponse {
  candidates: Candidate[];
  cached: boolean;
}

export interface AssignRequest {
  inviterFid: number;
  invitees: { fid: number; username: string }[]; // length 1..MAX_INVITES_PER_BATCH
}

export interface AssignResponse {
  assignments: Assignment[];
}

export type AssignErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "invalid_request"
  | "candidate_filter_failed"
  | "server_misconfigured";

export interface AssignErrorResponse {
  error: AssignErrorCode;
  message: string;
  retryAfter?: number;
}

export interface UserSummary {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
}

import type { OnboardErrorCode } from "@/lib/types";

/**
 * Maps each OnboardErrorCode to its HTTP status. Lives here rather than in the
 * route module because App Router route files may only export route handlers and
 * config — an exported `STATUS` const trips Next's route-type validation (a build
 * error). The route imports it for its pre-stream JSON branches, and the test
 * imports it to assert the map stays exhaustive over OnboardErrorCode.
 */
export const STATUS: Record<OnboardErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  gated: 403,
  no_quota: 503,
  inviter_unavailable: 503,
  deploy_failed: 500,
  safe_not_ready: 500,
  invite_failed: 500,
  not_registered: 502,
  server_error: 500,
};

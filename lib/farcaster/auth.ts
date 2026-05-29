import "server-only";

import { createClient, Errors } from "@farcaster/quick-auth";

import { env } from "../env";

const client = createClient();

/**
 * Verify a Farcaster Quick Auth JWT from the request's Authorization header.
 *
 * Returns the inviter's `{ fid }` on success, or `null` if the header is
 * missing, malformed, or the token fails verification. Non-verification
 * errors are re-thrown so callers can decide whether to 500.
 */
export async function verifyQuickAuth(
  req: Request,
): Promise<{ fid: number } | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  try {
    const payload = await client.verifyJwt({
      token,
      domain: env.FARCASTER_DOMAIN,
    });

    // Quick Auth payloads put the fid in `sub`. It comes through as a number
    // in current versions; coerce defensively.
    const subRaw: unknown = (payload as { sub?: unknown }).sub;
    const fid =
      typeof subRaw === "number"
        ? subRaw
        : typeof subRaw === "string" && /^\d+$/.test(subRaw)
          ? Number(subRaw)
          : null;
    if (fid == null || !Number.isFinite(fid)) return null;
    return { fid };
  } catch (e) {
    if (e instanceof Errors.InvalidTokenError) return null;
    throw e;
  }
}

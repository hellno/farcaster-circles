import { NextRequest, NextResponse } from "next/server";

import { fetchMutuals } from "@/lib/neynar";
import { getCachedCandidates, setCachedCandidates } from "@/lib/kv";
import type { Candidate, CandidatesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const fidParam = request.nextUrl.searchParams.get("fid");
  const fid = fidParam !== null ? Number(fidParam) : NaN;

  if (!Number.isInteger(fid) || fid <= 0) {
    return NextResponse.json(
      { error: "invalid_request", message: "fid required" },
      { status: 400 },
    );
  }

  // Cache hit path.
  try {
    const cached = await getCachedCandidates(fid);
    if (cached) {
      const body: CandidatesResponse = { candidates: cached, cached: true };
      return NextResponse.json(body, {
        status: 200,
        headers: {
          "Cache-Control":
            "public, s-maxage=300, stale-while-revalidate=60",
        },
      });
    }
  } catch (err) {
    console.error("candidates cache read failed", errorMessage(err));
    // Fall through to live fetch.
  }

  let candidates: Candidate[];
  try {
    candidates = await fetchMutuals(fid);
  } catch (err) {
    const message = errorMessage(err);
    if (message.startsWith("Neynar 429")) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "Neynar rate limit hit, try again in 30s",
        },
        {
          status: 429,
          headers: { "Retry-After": "30" },
        },
      );
    }
    console.error("fetchMutuals failed", message);
    return NextResponse.json(
      { error: "candidate_filter_failed", message },
      { status: 500 },
    );
  }

  try {
    await setCachedCandidates(fid, candidates);
  } catch (err) {
    console.error("candidates cache write failed", errorMessage(err));
    // Non-fatal: still return the candidates.
  }

  const body: CandidatesResponse = { candidates, cached: false };
  return NextResponse.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { verifyQuickAuth } from "@/lib/auth";
import { MAX_INVITES_PER_BATCH } from "@/lib/constants";
import { env } from "@/lib/env";
import { buildInviteDmText, composeDmDeepLink } from "@/lib/farcaster";
import {
  getAssignment,
  getIdempotentShortcode,
  newShortcode,
  setAssignment,
  setIdempotentShortcode,
} from "@/lib/kv";
import { fetchMutuals } from "@/lib/neynar";
import type {
  Assignment,
  AssignmentRecord,
  AssignResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AssignRequestSchema = z.object({
  inviterFid: z.number().int().positive(),
  invitees: z
    .array(
      z.object({
        fid: z.number().int().positive(),
        username: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_INVITES_PER_BATCH),
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function resolveAppOrigin(request: NextRequest): string {
  const configured = env.NEXT_PUBLIC_APP_URL;
  if (configured && configured.length > 0) {
    return configured.replace(/\/$/, "");
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Fail fast if the magic link isn't configured.
  try {
    void env.CIRCLES_MAGIC_LINK;
  } catch (err) {
    return NextResponse.json(
      { error: "server_misconfigured", message: errorMessage(err) },
      { status: 500 },
    );
  }

  const auth = await verifyQuickAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in via Farcaster" },
      { status: 401 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = AssignRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return NextResponse.json(
      { error: "invalid_request", message: issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  if (body.inviterFid !== auth.fid) {
    return NextResponse.json(
      { error: "unauthorized", message: "fid mismatch" },
      { status: 401 },
    );
  }

  // Server-enforced quality gate: re-validate every invitee.
  let allowedFids: Set<number>;
  try {
    const mutuals = await fetchMutuals(auth.fid);
    allowedFids = new Set(mutuals.map((m) => m.fid));
  } catch (err) {
    const message = errorMessage(err);
    if (message.startsWith("Neynar 429")) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "Neynar rate limit hit, try again in 30s",
          retryAfter: 30,
        },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }
    console.error("assign fetchMutuals failed", message);
    return NextResponse.json(
      { error: "candidate_filter_failed", message },
      { status: 500 },
    );
  }

  for (const invitee of body.invitees) {
    if (!allowedFids.has(invitee.fid)) {
      return NextResponse.json(
        {
          error: "candidate_filter_failed",
          message: `${invitee.username} failed quality gate`,
        },
        { status: 400 },
      );
    }
  }

  const records: AssignmentRecord[] = [];

  for (const invitee of body.invitees) {
    // Idempotent: same (inviter, invitee) pair returns the same shortcode.
    const existingShortcode = await getIdempotentShortcode(
      auth.fid,
      invitee.fid,
    );
    if (existingShortcode) {
      const existing = await getAssignment(existingShortcode);
      if (existing) {
        records.push(existing);
        continue;
      }
      // Idempotency key existed but record vanished — fall through and mint
      // a fresh one. The same shortcode key gets overwritten below.
    }

    // Mint a new shortcode, retrying on the (vanishingly rare) collision.
    let shortcode: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = newShortcode();
      const collision = await getAssignment(candidate);
      if (!collision) {
        shortcode = candidate;
        break;
      }
    }
    if (!shortcode) {
      return NextResponse.json(
        {
          error: "candidate_filter_failed",
          message: "shortcode generation failed after 5 retries",
        },
        { status: 500 },
      );
    }

    const record: AssignmentRecord = {
      shortcode,
      inviterFid: auth.fid,
      inviteeFid: invitee.fid,
      inviteeUsername: invitee.username,
      assignedAt: Date.now(),
      firstOpenedAt: null,
      openCount: 0,
    };

    await setAssignment(record);
    await setIdempotentShortcode(auth.fid, invitee.fid, shortcode);

    records.push(record);
  }

  const origin = resolveAppOrigin(request);

  const assignments: Assignment[] = records.map((r) => {
    const shortUrl = `${origin}/r/${r.shortcode}`;
    const dmDeepLink = composeDmDeepLink(
      r.inviteeFid,
      buildInviteDmText({
        inviteeUsername: r.inviteeUsername,
        shortUrl,
      }),
    );
    return {
      inviteeFid: r.inviteeFid,
      inviteeUsername: r.inviteeUsername,
      shortcode: r.shortcode,
      shortUrl,
      dmDeepLink,
    };
  });

  const responseBody: AssignResponse = { assignments };
  return NextResponse.json(responseBody, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

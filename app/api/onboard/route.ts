import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyQuickAuth } from "@/lib/farcaster/auth";
import { isDebugEnabled } from "@/lib/env";
import {
  onboardAccount,
  buildDebug,
  type DebugState,
} from "@/lib/onboarding/onboard-account";
import { STATUS } from "@/lib/onboarding/status";
import type {
  OnboardErrorResponse,
  OnboardStreamEvent,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Worst case is ~deploy + the 24s registration poll. The operator can raise this
// on Vercel Pro if a congested Gnosis block pushes a run past the cap.
export const maxDuration = 60;

const bodySchema = z.object({
  connectedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  additionalOwners: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional(),
});

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * A DebugState with every field at its empty default. Used for the pre-flow
 * branches (auth fail, bad body, outer catch) where the service never ran, so
 * only `reqId`, `verifiedFid`, and `steps` carry meaningful values.
 */
function emptyDebugState(
  reqId: string,
  verifiedFid: number,
  steps: string[],
): DebugState {
  return {
    reqId,
    verifiedFid,
    connectedAddress: "",
    connectedAddressIsVerified: null,
    requestedAdditionalOwners: [],
    acceptedAdditionalOwners: [],
    rejectedAdditionalOwners: [],
    owners: [],
    safeAddress: null,
    quota: null,
    steps,
    profile: null,
    profileError: null,
    signals: null,
    gate: null,
  };
}

export async function POST(request: Request) {
  const reqId = shortId();
  const debug = isDebugEnabled();

  // ---- Pre-stream (still plain JSON with STATUS codes) ----
  // Auth + body parse happen BEFORE any stream opens, so an HTTP status is still
  // meaningful here. Once the body is valid we switch to an SSE stream and the
  // flow's outcome (success or error) is delivered as a terminal stream event.
  let auth: { fid: number } | null;
  try {
    // 1. Quick Auth.
    auth = await verifyQuickAuth(request);
  } catch (err) {
    // A throw from the auth stage (verifyQuickAuth re-throws non-token errors)
    // returns a structured server_error JSON, not Next's plain-text 500 fallback.
    console.log(`[onboard][${reqId}] server_error: ${errorMessage(err)}`);
    return NextResponse.json<OnboardErrorResponse>(
      {
        error: "server_error",
        message: errorMessage(err),
        debug: buildDebug(
          debug,
          emptyDebugState(reqId, -1, [`server_error: ${errorMessage(err)}`]),
        ),
      },
      { status: STATUS.server_error },
    );
  }
  if (!auth) {
    console.log(`[onboard][${reqId}] auth: FAILED (no/invalid Quick Auth token)`);
    return NextResponse.json<OnboardErrorResponse>(
      {
        error: "unauthorized",
        message: "missing or invalid auth token",
        debug: buildDebug(
          debug,
          emptyDebugState(reqId, -1, [
            "auth: FAILED (no/invalid Quick Auth token)",
          ]),
        ),
      },
      { status: STATUS.unauthorized },
    );
  }

  // 2. Parse body.
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    console.log(`[onboard][${reqId}] body: INVALID`);
    return NextResponse.json<OnboardErrorResponse>(
      {
        error: "invalid_request",
        message: "connectedAddress must be a 0x-prefixed 20-byte address",
        debug: buildDebug(
          debug,
          emptyDebugState(reqId, auth.fid, [
            `auth: OK verifiedFid=${auth.fid}`,
            "body: INVALID",
          ]),
        ),
      },
      { status: STATUS.invalid_request },
    );
  }
  const { connectedAddress, additionalOwners } = parsed.data;
  const authedFid = auth.fid;

  // ---- Stream (SSE) ----
  // Kick off the flow WITHOUT awaiting it in the handler and forward each
  // progress tick (plus the terminal result/error) as a `data:` frame.
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: OnboardStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // Comment-line pings keep the Cloudflare tunnel / intermediary proxies from
      // dropping an otherwise-idle connection during the long deploy/poll phases.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 12000);

      onboardAccount({
        fid: authedFid,
        connectedAddress,
        additionalOwners,
        debug,
        reqId,
        onProgress: (e) => send(e),
      })
        .then((outcome) => {
          if (outcome.ok) {
            send({ type: "result", result: outcome.response });
          } else {
            send({
              type: "error",
              error: {
                error: outcome.code,
                message: outcome.message,
                ...(outcome.txHashes ? { txHashes: outcome.txHashes } : {}),
                debug: outcome.debug,
              },
            });
          }
        })
        .catch((err) => {
          send({
            type: "error",
            error: {
              error: "server_error",
              message: errorMessage(err),
              debug: buildDebug(
                debug,
                emptyDebugState(reqId, authedFid, [
                  `server_error: ${errorMessage(err)}`,
                ]),
              ),
            },
          });
        })
        .finally(() => {
          clearInterval(heartbeat);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      // Client disconnected. Stop enqueuing, but DO NOT abort the flow: per
      // design the on-chain work must run to completion (idempotent) even if
      // nobody is listening.
      closed = true;
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

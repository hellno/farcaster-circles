import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyQuickAuth } from "@/lib/auth";
import { resolveNames } from "@/lib/names";
import type { NamesErrorResponse, NamesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(20),
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Reverse-resolve addresses to ENS (.eth) + basename (.base.eth) so the signer
 * picker can show human-readable names. Quick Auth'd to avoid an open RPC proxy;
 * reads public chain data only, spends no quota.
 */
export async function POST(request: Request) {
  try {
    const auth = await verifyQuickAuth(request);
    if (!auth) {
      return NextResponse.json<NamesErrorResponse>(
        { error: "unauthorized", message: "missing or invalid Quick Auth token" },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json<NamesErrorResponse>(
        { error: "invalid_request", message: "addresses must be 0x-prefixed (max 20)" },
        { status: 400 },
      );
    }

    const names = await resolveNames(parsed.data.addresses);
    return NextResponse.json<NamesResponse>(
      { names },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json<NamesErrorResponse>(
      { error: "server_error", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

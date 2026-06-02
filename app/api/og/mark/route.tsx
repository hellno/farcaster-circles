import { ImageResponse } from "next/og";

import { COLORS, CirclesGlyph, Coin } from "@/lib/og/shared";

// Node runtime, consistent with the other og routes.
export const runtime = "nodejs";

// The mark never changes, so cache it hard once rendered.
const CACHE = "public, max-age=31536000, immutable";

/**
 * Square brand mark — the coin glyph on the paper ground. Serves as both the
 * Mini App `iconUrl` and `splashImageUrl`. No text, so no font load is needed.
 */
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.paper,
        }}
      >
        <Coin size={680}>
          <CirclesGlyph size={420} />
        </Coin>
      </div>
    ),
    { width: 1024, height: 1024, headers: { "Cache-Control": CACHE } },
  );
}

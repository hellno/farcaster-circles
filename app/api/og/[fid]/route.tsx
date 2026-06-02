/* Satori renders these cards, not the DOM — next/image and alt text don't apply. */
/* eslint-disable jsx-a11y/alt-text, @next/next/no-img-element */
import { ImageResponse } from "next/og";

import { env } from "@/lib/env";
import { fetchFarcasterCard } from "@/lib/farcaster/neynar";
import { loadOgFonts } from "@/lib/og/fonts";
import {
  COLORS,
  CirclesGlyph,
  Coin,
  FONT_DISPLAY,
  FONT_MONO,
  Frame,
  Kicker,
  OG_SIZE,
} from "@/lib/og/shared";

export const runtime = "nodejs";

// Per-fid card. Cold-render once, then long-cache (the "cached per fid"
// requirement). A stale pfp is acceptable; the win-moment never changes.
const CACHE = "public, max-age=31536000, immutable";

const COIN_SIZE = 360;

/**
 * Load a pfp as a PNG data URI so Satori never has to fetch (or decode) it
 * itself. Satori only handles PNG/JPEG, but Warpcast pfps are usually WebP, so
 * we route through the wsrv.nl image proxy to coerce to a 400px PNG square,
 * with a direct PNG/JPEG fetch as a fallback. Any failure returns null and the
 * card falls back to the Circles glyph.
 */
async function loadPfpDataUri(pfpUrl: string): Promise<string | null> {
  if (!pfpUrl || !/^https?:\/\//.test(pfpUrl)) return null;

  async function tryFetch(
    url: string,
    accept: (ct: string) => boolean,
  ): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { accept: "image/*" },
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!accept(ct)) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > 5_000_000) return null;
      const mime = ct.includes("jpeg") || ct.includes("jpg")
        ? "image/jpeg"
        : "image/png";
      return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
    } catch {
      return null;
    }
  }

  const proxied = `https://wsrv.nl/?url=${encodeURIComponent(
    pfpUrl,
  )}&w=400&h=400&fit=cover&output=png`;
  return (
    (await tryFetch(proxied, (ct) => ct.startsWith("image/"))) ??
    (await tryFetch(pfpUrl, (ct) => ct.includes("png") || ct.includes("jpeg")))
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fid: string }> },
) {
  const { fid: fidStr } = await params;
  const fid = Number(fidStr);
  if (!Number.isInteger(fid) || fid <= 0 || fid > 1_000_000_000) {
    return new Response("invalid fid", { status: 400 });
  }

  const [fonts, card] = await Promise.all([
    loadOgFonts(),
    fetchFarcasterCard(fid).catch(() => null),
  ]);

  const pfpDataUri = card?.pfpUrl ? await loadPfpDataUri(card.pfpUrl) : null;
  const username = card?.username ? `@${card.username}` : `fid ${fid}`;
  const initial = (card?.displayName || card?.username || "C")
    .charAt(0)
    .toUpperCase();

  const coinInner = pfpDataUri ? (
    <img
      src={pfpDataUri}
      width={COIN_SIZE}
      height={COIN_SIZE}
      style={{ width: COIN_SIZE, height: COIN_SIZE, objectFit: "cover" }}
    />
  ) : card?.pfpUrl ? (
    <span
      style={{
        fontFamily: FONT_DISPLAY,
        fontWeight: 800,
        fontSize: 200,
        color: COLORS.ink,
      }}
    >
      {initial}
    </span>
  ) : (
    <CirclesGlyph size={210} />
  );

  return new ImageResponse(
    (
      <Frame>
        {/* masthead */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Kicker>Circles</Kicker>
          <Kicker color={COLORS.cobalt}>{username}</Kicker>
        </div>

        {/* headline + coin with stamp */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 48,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                fontFamily: FONT_DISPLAY,
                fontWeight: 800,
                fontSize: 140,
                lineHeight: 0.9,
                letterSpacing: -4,
                textTransform: "uppercase",
                color: COLORS.ink,
              }}
            >
              <span style={{ display: "flex" }}>You&rsquo;re</span>
              <span style={{ display: "flex" }}>in.</span>
            </div>
            <span
              style={{
                marginTop: 28,
                fontFamily: FONT_MONO,
                fontWeight: 700,
                fontSize: 30,
                color: COLORS.inkSoft,
              }}
            >
              Verified as a human on Circles.
            </span>
          </div>

          <div style={{ display: "flex", position: "relative" }}>
            <Coin size={COIN_SIZE}>{coinInner}</Coin>
            <div
              style={{
                display: "flex",
                position: "absolute",
                top: -18,
                right: -10,
                transform: "rotate(-8deg)",
                flexDirection: "column",
                alignItems: "center",
                background: COLORS.paper,
                border: `4px solid ${COLORS.cobalt}`,
                borderRadius: 9999,
                padding: "10px 22px",
                color: COLORS.cobalt,
              }}
            >
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontWeight: 700,
                  fontSize: 16,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Verified
              </span>
              <span
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontWeight: 800,
                  fontSize: 28,
                  lineHeight: 1,
                }}
              >
                HUMAN
              </span>
            </div>
          </div>
        </div>

        {/* footer */}
        <div style={{ display: "flex" }}>
          <Kicker>
            {`Money that grows on you · Invited by @${env.NEXT_PUBLIC_INVITER_HANDLE}`}
          </Kicker>
        </div>
      </Frame>
    ),
    { ...OG_SIZE, fonts, headers: { "Cache-Control": CACHE } },
  );
}

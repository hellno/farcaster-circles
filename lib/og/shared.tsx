// Shared building blocks for the `next/og` cards (static landing + per-fid).
// Everything here is rendered by Satori, NOT React DOM — so styling is inline
// `style` objects only (no className/Tailwind), and any container with more than
// one child must set `display: "flex"`. Colors + type mirror the editorial
// `.edition` theme in `app/globals.css`.

import type { ReactElement, ReactNode } from "react";

// Farcaster embeds want a 3:2 image (spec: 600x400 .. 3000x2000). 1200x800 is
// the recommended sweet spot.
export const OG_SIZE = { width: 1200, height: 800 } as const;

export const COLORS = {
  paper: "#f3e8cf",
  paper2: "#ecdcb8",
  ink: "#161009",
  inkSoft: "#4a3f2c",
  sun: "#f7a90a",
  sunDeep: "#e07b00",
  cobalt: "#2222cf",
} as const;

export const FONT_DISPLAY = "Bricolage Grotesque";
export const FONT_MONO = "Space Mono";

/** The three nested rings + dot — the app's coin mark. */
export function CirclesGlyph({
  size = 200,
  stroke = COLORS.ink,
}: {
  size?: number;
  stroke?: string;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke={stroke}
      strokeWidth={5}
    >
      <circle cx="50" cy="50" r="9" fill={stroke} stroke="none" />
      <circle cx="50" cy="50" r="23" />
      <circle cx="50" cy="50" r="38" />
    </svg>
  );
}

/**
 * The sun-gold coin: an ink-bordered disc with the signature hard block shadow.
 * `children` is centered inside (a pfp image, the glyph, or an initial).
 */
export function Coin({
  size,
  children,
}: {
  size: number;
  children: ReactElement;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 9999,
        background: COLORS.sun,
        border: `${Math.round(size * 0.025)}px solid ${COLORS.ink}`,
        boxShadow: `${Math.round(size * 0.06)}px ${Math.round(size * 0.06)}px 0 0 ${COLORS.ink}`,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** Mono uppercase kicker line, matching `.kicker` in globals.css. */
export function Kicker({
  children,
  color = COLORS.inkSoft,
  size = 26,
}: {
  children: string;
  color?: string;
  size?: number;
}): ReactElement {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: size * 0.18,
        textTransform: "uppercase",
        color,
      }}
    >
      {children}
    </span>
  );
}

/**
 * The outer frame shared by both cards: paper ground with an inset ink border,
 * padded content area laid out top-to-bottom. Direct children are spread with
 * `space-between` (pass top / middle / bottom blocks).
 */
export function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: COLORS.paper,
        padding: 40,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          border: `6px solid ${COLORS.ink}`,
          background: COLORS.paper,
          padding: "56px 64px",
          justifyContent: "space-between",
        }}
      >
        {children}
      </div>
    </div>
  );
}

import type { Metadata } from "next";

import { OnboardApp } from "@/components/onboard-app";
import { buildMiniappEmbed } from "@/lib/farcaster/miniapp-embed";
import { fetchFarcasterCard } from "@/lib/farcaster/neynar";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

// Short, stable token derived from the pfp URL (djb2). Runtime-agnostic (no
// crypto import) — it's only a cache key, not a security boundary. A changed pfp
// yields a new token → a new OG image URL → a cache miss everywhere.
function pfpVersion(pfpUrl: string | null | undefined): string {
  if (!pfpUrl) return "0";
  let h = 5381;
  for (let i = 0; i < pfpUrl.length; i++) {
    h = ((h << 5) + h + pfpUrl.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// Per-fid share target: the URL a freshly onboarded user casts. Its embed card
// is the dynamic per-fid OG image; tapping the card launches the app so the
// viewer can onboard too (the viral loop).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ fid: string }>;
}): Promise<Metadata> {
  const { fid } = await params;
  if (!APP_URL) return {};

  // Cache-bust the per-fid card by the CURRENT pfp. The OG route long-caches its
  // render (and Farcaster's image proxy caches by URL), so without a version a
  // pfp change would never surface. Best-effort: a failed lookup yields v=0 and
  // the route still renders (it fetches the card itself).
  const card = await fetchFarcasterCard(Number(fid)).catch(() => null);
  const imageUrl = `${APP_URL}/api/og/${fid}?v=${pfpVersion(card?.pfpUrl)}`;
  const embed = JSON.stringify(
    buildMiniappEmbed({
      appUrl: APP_URL,
      imageUrl,
      buttonTitle: "Set up Circles",
    }),
  );

  const title = "I'm on Circles";
  const description =
    "Money that grows on you. Set up your Circles account, gas-free, in one tap.";

  return {
    title,
    description,
    openGraph: { title, description, images: [imageUrl] },
    other: {
      "fc:miniapp": embed,
      "fc:frame": embed, // back-compat with older clients
    },
  };
}

// Direct/browser visits get the normal onboarding screen.
export default function SharePage() {
  return <OnboardApp />;
}

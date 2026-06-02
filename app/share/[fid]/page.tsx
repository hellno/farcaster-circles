import type { Metadata } from "next";

import { OnboardApp } from "@/components/onboard-app";
import { buildMiniappEmbed } from "@/lib/farcaster/miniapp-embed";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

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

  const imageUrl = `${APP_URL}/api/og/${fid}`;
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

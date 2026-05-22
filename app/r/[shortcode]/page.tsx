import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { headers } from "next/headers";

import { env } from "@/lib/env";
import { getAssignment, updateAssignment } from "@/lib/kv";
import { fetchUserByFid } from "@/lib/neynar";

interface Props {
  params: Promise<{ shortcode: string }>;
}

const CRAWLER_UA = /bot|crawl|spider|slurp|facebookexternalhit|embed|preview|warpcast|farcaster|telegram|whatsapp|twitter|discord|slack|linkedin|skype|pinterest|google|bing|duckduck/i;

function isCrawler(ua: string | null): boolean {
  if (!ua) return false;
  return CRAWLER_UA.test(ua);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shortcode } = await params;
  const record = await getAssignment(shortcode);
  if (!record) {
    return { title: "Invite not found — Circles Onboard" };
  }
  const inviter = await fetchUserByFid(record.inviterFid).catch(() => null);
  const inviterLabel =
    inviter?.displayName ?? inviter?.username ?? `fid ${record.inviterFid}`;
  const title = `${inviterLabel} invited you to Circles`;
  const description =
    "Tap to join — this is a personal invite link.";
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function Page({ params }: Props) {
  const { shortcode } = await params;
  const record = await getAssignment(shortcode);
  if (!record) notFound();

  const h = await headers();
  const ua = h.get("user-agent");
  const crawler = isCrawler(ua);

  if (!crawler) {
    // Only count real human opens. Bots (unfurlers) hit this constantly and
    // would otherwise poison openCount / firstOpenedAt.
    // eslint-disable-next-line react-hooks/purity -- server-only page, no React render concerns
    const firstOpenedAt = record.firstOpenedAt ?? Date.now();
    await updateAssignment(shortcode, {
      openCount: record.openCount + 1,
      firstOpenedAt,
    });
    redirect(env.CIRCLES_MAGIC_LINK);
  }

  // Crawler: serve a tiny HTML body so the unfurler keeps the OG metadata
  // from generateMetadata + the colocated opengraph-image.tsx.
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <p>Personal Circles invite. Open in a browser to continue.</p>
    </main>
  );
}

import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  Hanken_Grotesk,
  Space_Mono,
} from "next/font/google";

import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { buildMiniappEmbed } from "@/lib/farcaster/miniapp-embed";
import { cn } from "@/lib/utils";

// Editorial type system: a wonky display grotesque for mastheads, a clean
// grotesque for body copy, and a typewriter mono for on-chain data / tickers.
const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
});
const fontSans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const fontMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

// The main app embed. `imageUrl` is the generated static landing card
// (`/api/og`), not a static file. `fc:frame` is emitted alongside `fc:miniapp`
// for back-compat with older clients.
const OG_IMAGE_URL = `${APP_URL}/api/og`;
const miniappEmbed = APP_URL
  ? JSON.stringify(
      buildMiniappEmbed({
        appUrl: APP_URL,
        imageUrl: OG_IMAGE_URL,
        buttonTitle: "Open Circles Onboard",
      }),
    )
  : "";

export const metadata: Metadata = {
  title: "Circles Onboard",
  description: "Create your Circles account, gas-free, in one tap.",
  metadataBase: APP_URL ? new URL(APP_URL) : undefined,
  openGraph: {
    title: "Circles Onboard",
    description: "Create your Circles account, gas-free, in one tap.",
    images: APP_URL ? [OG_IMAGE_URL] : [],
  },
  other: miniappEmbed
    ? { "fc:miniapp": miniappEmbed, "fc:frame": miniappEmbed }
    : {},
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        "font-sans",
        fontDisplay.variable,
        fontSans.variable,
        fontMono.variable,
      )}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

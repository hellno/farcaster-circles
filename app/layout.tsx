import type { Metadata } from "next";
import { Geist_Mono, Roboto } from "next/font/google";

import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const roboto = Roboto({ subsets: ["latin"], variable: "--font-sans" });
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

export const metadata: Metadata = {
  title: "Circles Onboard",
  description: "Invite your Farcaster mutuals to Circles in one tap.",
  metadataBase: APP_URL ? new URL(APP_URL) : undefined,
  openGraph: {
    title: "Circles Onboard",
    description: "Invite your Farcaster mutuals to Circles in one tap.",
    images: APP_URL ? [`${APP_URL}/og.png`] : [],
  },
  other: APP_URL
    ? {
        "fc:miniapp": JSON.stringify({
          version: "1",
          imageUrl: `${APP_URL}/og.png`,
          button: {
            title: "Open Circles Onboard",
            action: {
              type: "launch_miniapp",
              name: "Circles Onboard",
              url: APP_URL,
              splashImageUrl: `${APP_URL}/splash.png`,
              splashBackgroundColor: "#0b0a14",
            },
          },
        }),
      }
    : {},
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", roboto.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

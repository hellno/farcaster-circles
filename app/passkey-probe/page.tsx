import type { Metadata } from "next";

import { PasskeyProbe } from "@/components/passkey-probe";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "";

export const metadata: Metadata = {
  title: "Passkey probe — Circles Onboard",
  description:
    "Tests whether this Warpcast in-app browser supports WebAuthn passkey creation.",
  other: APP_URL
    ? {
        "fc:miniapp": JSON.stringify({
          version: "1",
          imageUrl: `${APP_URL}/og.png`,
          button: {
            title: "Run passkey probe",
            action: {
              type: "launch_miniapp",
              name: "Passkey probe",
              url: `${APP_URL}/passkey-probe`,
              splashImageUrl: `${APP_URL}/splash.png`,
              splashBackgroundColor: "#0b0a14",
            },
          },
        }),
      }
    : {},
};

export default function Page() {
  return <PasskeyProbe />;
}

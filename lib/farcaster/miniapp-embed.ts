// Single source of truth for the `fc:miniapp` embed object (the JSON that goes
// in the `fc:miniapp` / `fc:frame` meta tags). Used by the root layout (main
// app embed) and the per-fid share page. Pure — safe to import anywhere.

const APP_NAME = "Circles Onboard";
const SPLASH_BACKGROUND_COLOR = "#f3e8cf"; // --paper

export interface MiniappEmbed {
  version: "1";
  imageUrl: string;
  button: {
    title: string;
    action: {
      type: "launch_miniapp";
      name: string;
      url: string;
      splashImageUrl: string;
      splashBackgroundColor: string;
    };
  };
}

/**
 * Build the Mini App embed. `appUrl` is the canonical app origin (no trailing
 * slash); `imageUrl` is the absolute 3:2 card image; `buttonTitle` is the CTA
 * (keep ≤ 32 chars per the embed spec). `launchUrl` defaults to `appUrl` so the
 * card always opens the onboarding flow even when shared from a per-fid page.
 */
export function buildMiniappEmbed({
  appUrl,
  imageUrl,
  buttonTitle,
  launchUrl,
}: {
  appUrl: string;
  imageUrl: string;
  buttonTitle: string;
  launchUrl?: string;
}): MiniappEmbed {
  return {
    version: "1",
    imageUrl,
    button: {
      title: buttonTitle,
      action: {
        type: "launch_miniapp",
        name: APP_NAME,
        url: launchUrl ?? appUrl,
        splashImageUrl: `${appUrl}/api/og/mark`,
        splashBackgroundColor: SPLASH_BACKGROUND_COLOR,
      },
    },
  };
}

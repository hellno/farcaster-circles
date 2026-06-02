import { describe, it, expect } from "vitest";

import { buildMiniappEmbed } from "@/lib/farcaster/miniapp-embed";

describe("buildMiniappEmbed", () => {
  it("builds a v1 launch_miniapp embed with splash + defaults", () => {
    const e = buildMiniappEmbed({
      appUrl: "https://app.example",
      imageUrl: "https://app.example/api/og",
      buttonTitle: "Open",
    });
    expect(e.version).toBe("1");
    expect(e.imageUrl).toBe("https://app.example/api/og");
    expect(e.button.title).toBe("Open");
    expect(e.button.action.type).toBe("launch_miniapp");
    expect(e.button.action.name).toBe("Circles Onboard");
    // url defaults to appUrl so the card always opens the onboarding flow.
    expect(e.button.action.url).toBe("https://app.example");
    expect(e.button.action.splashImageUrl).toBe(
      "https://app.example/api/og/mark",
    );
    expect(e.button.action.splashBackgroundColor).toBe("#f3e8cf");
  });

  it("uses launchUrl override when provided", () => {
    const e = buildMiniappEmbed({
      appUrl: "https://a",
      imageUrl: "https://a/og",
      buttonTitle: "x",
      launchUrl: "https://a/go",
    });
    expect(e.button.action.url).toBe("https://a/go");
  });

  it("round-trips through JSON for the fc:miniapp meta tag", () => {
    const e = buildMiniappEmbed({
      appUrl: "https://a",
      imageUrl: "https://a/og",
      buttonTitle: "Set up Circles",
    });
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });
});

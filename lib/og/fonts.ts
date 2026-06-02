// Font loading for `next/og` (Satori) image generation. Satori needs raw font
// buffers — it cannot use the `next/font/google` CSS the rest of the app loads —
// so we commit static TTFs under ./fonts and read them from disk. We resolve the
// path via `new URL("./fonts/x", import.meta.url)` (which the bundler statically
// detects and traces the file into the build output), then read with `fs` rather
// than `fetch` — Node's runtime can't fetch a `file://` URL, only the edge
// runtime can, and these routes run on Node. Buffers are cached in module scope.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 800;
  style: "normal";
};

let cached: OgFont[] | null = null;

async function read(file: string): Promise<Buffer> {
  return readFile(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));
}

/**
 * The two typefaces the cards use, in the shape `ImageResponse` expects:
 * Bricolage Grotesque ExtraBold for display headlines, Space Mono Bold for the
 * mono kickers / addresses. Mirrors the editorial type system in
 * `app/globals.css` (`--font-display` / `--font-mono`).
 */
export async function loadOgFonts(): Promise<OgFont[]> {
  if (cached) return cached;
  const [display, mono] = await Promise.all([
    read("BricolageGrotesque-ExtraBold.ttf"),
    read("SpaceMono-Bold.ttf"),
  ]);
  cached = [
    { name: "Bricolage Grotesque", data: display, weight: 800, style: "normal" },
    { name: "Space Mono", data: mono, weight: 700, style: "normal" },
  ];
  return cached;
}

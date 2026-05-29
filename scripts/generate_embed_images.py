#!/usr/bin/env python3
"""Generate OG (1200x800) and splash (200x200) PNGs for the Farcaster mini app
using OpenAI's gpt-image-1 model. Downscales source renders with LANCZOS to the
exact final dimensions.

Reads OPENAI_API_KEY from the environment. Exits with a clear error if unset.
"""
from __future__ import annotations

import base64
import io
import os
import sys
from pathlib import Path

from PIL import Image
from openai import OpenAI, BadRequestError

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
OG_PATH = PUBLIC_DIR / "og.png"
SPLASH_PATH = PUBLIC_DIR / "splash.png"

MODEL = "gpt-image-1"

OG_PROMPT = (
    "3D illustration on a flat lavender purple background (#9B8BFF). "
    "Left half: a cluster of small purple-blue spheres arranged in a loose "
    "hexagonal mesh, suggesting a social graph. Right half: a cluster of larger "
    "orange-to-purple gradient orbs (matte 3D with subtle film grain, soft "
    "top-left lighting) arranged in a Circles trust-graph shape. Between the "
    "two clusters, a single thin glowing line traces from one purple sphere on "
    "the left to one orange orb on the right \u2014 a referral arc. Dark navy "
    "headline (#1A1A4E) in the upper-right reading \"Bring your friends to "
    "Circles\" in a bold geometric sans-serif font, with a smaller subhead "
    "beneath: \"One tap. One vouch.\" Generous margin around the headline. "
    "Subtle grain texture overall. No logos. No phone. No UI elements. "
    "Editorial poster composition. 1200x800 pixels, 3:2 aspect ratio."
)

SPLASH_PROMPT = (
    "3D illustration on a flat lavender purple background (#9B8BFF). Two orbs: "
    "one small purple-blue sphere on the left, one slightly larger orange-to-"
    "purple gradient orb on the right, connected by a single thin curved arc. "
    "Matte 3D shading, subtle film grain, soft top-left key light. Centered "
    "with ~20px padding on all sides. No text. No logos. Square composition. "
    "200x200 pixels."
)

# Minimal fallback prompts in case the originals trip a policy filter.
OG_FALLBACK = (
    "3D illustration, flat lavender purple background. Left: a cluster of small "
    "purple-blue spheres in a loose hexagonal mesh. Right: a cluster of larger "
    "orange-to-purple gradient matte orbs in a trust-graph shape. A single thin "
    "glowing arc connects one purple sphere on the left to one orange orb on "
    "the right. Soft top-left light, subtle grain. Editorial poster "
    "composition. 3:2 aspect ratio."
)

SPLASH_FALLBACK = (
    "3D illustration, flat lavender purple background. Two orbs: one small "
    "purple-blue sphere and one slightly larger orange-to-purple gradient orb, "
    "connected by a thin curved arc. Matte 3D shading, soft top-left light. "
    "Centered, square composition."
)


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def generate(client: OpenAI, prompt: str, size: str, label: str) -> bytes:
    """Call gpt-image-1 and return raw PNG bytes. Retries once with a simpler
    prompt if the API rejects the original on content-policy grounds."""
    attempts = [(prompt, "original")]
    if label == "og":
        attempts.append((OG_FALLBACK, "fallback"))
    else:
        attempts.append((SPLASH_FALLBACK, "fallback"))

    last_err: Exception | None = None
    for p, tag in attempts:
        print(f"[{label}] requesting {size} from {MODEL} ({tag} prompt)...", flush=True)
        try:
            resp = client.images.generate(
                model=MODEL,
                prompt=p,
                size=size,
                quality="high",
                n=1,
            )
        except BadRequestError as e:
            last_err = e
            msg = str(e)
            print(f"[{label}] BadRequestError on {tag} prompt: {msg}", flush=True)
            # Only retry once on policy-style failures; for other errors break.
            if "safety" in msg.lower() or "policy" in msg.lower() or "moderation" in msg.lower():
                continue
            raise
        except Exception as e:
            last_err = e
            raise

        if tag == "fallback":
            print(f"[{label}] NOTE: used fallback prompt instead of original.", flush=True)

        b64 = resp.data[0].b64_json
        if not b64:
            raise RuntimeError(f"[{label}] API returned no b64_json payload")
        return base64.b64decode(b64)

    raise RuntimeError(f"[{label}] all prompt attempts failed; last error: {last_err}")


def save_resized(raw_png: bytes, out_path: Path, final_size: tuple[int, int]) -> tuple[int, int]:
    img = Image.open(io.BytesIO(raw_png))
    if img.mode != "RGB":
        img = img.convert("RGB")
    resized = img.resize(final_size, Image.LANCZOS)
    resized.save(out_path, format="PNG", optimize=True)
    return resized.size


def main() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        die("OPENAI_API_KEY is not set in the environment. Aborting (no interactive prompt).")

    if not PUBLIC_DIR.is_dir():
        die(f"Expected public dir does not exist: {PUBLIC_DIR}")

    client = OpenAI(api_key=api_key)

    # OG: render 1536x1024 (3:2), downscale to 1200x800.
    og_raw = generate(client, OG_PROMPT, "1536x1024", "og")
    og_dims = save_resized(og_raw, OG_PATH, (1200, 800))
    print(f"[og] saved {OG_PATH} at {og_dims[0]}x{og_dims[1]}", flush=True)

    # Splash: render 1024x1024, downscale to 200x200.
    splash_raw = generate(client, SPLASH_PROMPT, "1024x1024", "splash")
    splash_dims = save_resized(splash_raw, SPLASH_PATH, (200, 200))
    print(f"[splash] saved {SPLASH_PATH} at {splash_dims[0]}x{splash_dims[1]}", flush=True)

    # Final verification via PIL.
    for p in (OG_PATH, SPLASH_PATH):
        with Image.open(p) as im:
            print(f"VERIFY {p} -> {im.size[0]}x{im.size[1]} {im.format}")


if __name__ == "__main__":
    main()

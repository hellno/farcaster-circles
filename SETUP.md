# Setup

One-time steps before deploying or running anything serious.

## 1. Create a private GitHub repo

`farcaster-circles` (or similar) under your account. Keep private until you've validated the flow end-to-end.

## 2. Request invite quota from the Circles team

Send a Telegram message to the Circles team along these lines:

> Hi — I'm building a Farcaster→Circles onboarding miniapp.
> Could you allocate ~50 invites against my Circles avatar at
> `0xC3CCd9455b301D01d69DFB0b9Fc38Bee39829598`? Happy to share the miniapp design doc.

This is the only step that can block you for days. Start it first.

## 3. Create a magic link in the Invitation Manager

Once quota is granted, open the Circles Invitation Manager (linked from <https://app.aboutcircles.com>) and mint **one multi-claim magic link** with as many claims as your quota allows.

It looks like `https://circles.gnosis.io/invitation/{code}`.

Copy it into `.env` / Vercel env vars as `CIRCLES_MAGIC_LINK`. **Do not commit it.** Anyone holding this URL can consume a claim.

## 4. Sign up for Neynar

Get a free API key at <https://dev.neynar.com>.

## 5. Set up Vercel

- Create a Vercel project linked to this repo.
- Provision a Vercel KV instance.
- Copy KV credentials into the project's env vars (`KV_REST_API_URL`, `KV_REST_API_TOKEN`).
- Also set: `NEYNAR_API_KEY`, `FARCASTER_DOMAIN` (your prod domain), `NEXT_PUBLIC_APP_URL` (full URL), `CIRCLES_MAGIC_LINK` (from step 3).

## 6. Sign the Farcaster manifest

Visit <https://miniapps.farcaster.xyz/docs/guides/publishing> and sign a manifest for your production domain. Replace the placeholder values in `public/.well-known/farcaster.json` with the signed `accountAssociation`. Commit the signed manifest.

**Re-sign if you change domains.** This trips people up.

## 7. Validate the embed metadata

Open the Farcaster preview tool, paste your `NEXT_PUBLIC_APP_URL`, and confirm the embed renders correctly.

## 8. Run one real end-to-end invite

The v1 success gate. Open the app from inside Warpcast, pick a real mutual, send the DM, have them redeem at `circles.gnosis.io`. Confirm they end up as a registered Circles human. Then verify the Invitation Manager shows one claim consumed.

## 9. Watch the magic link's remaining claims

The miniapp does **not** know how many claims your magic link has left. Check the Invitation Manager periodically and mint a new link / update `CIRCLES_MAGIC_LINK` if it runs dry.

## 10. Make the repo public (optional)

Once #8 succeeds, you can flip the repo to public if you want others to fork it.

## Troubleshooting

- **Splash never dismisses** — `sdk.actions.ready()` not called or called before first paint. Check `hooks/use-miniapp-sdk.ts`.
- **`401 unauthorized` on /assign** — Quick Auth JWT not making it through, or `FARCASTER_DOMAIN` mismatch with the signed manifest. They must match exactly.
- **`500 server_misconfigured`** — `CIRCLES_MAGIC_LINK` is unset or not a `https://circles.gnosis.io/invitation/...` URL.
- **`429 rate_limited`** — Neynar tier exceeded. Wait or upgrade.

# Circles Onboard

A Farcaster mini app that lets you invite your **mutual Farcaster follows** to [Circles](https://aboutcircles.com) with one tap, via a private DM.

> Personal project by @hellno. Independent — not officially endorsed by Circles or Gnosis.

## What it does

1. Reads your Farcaster mutuals via Neynar.
2. Filters to high-quality mutuals (`neynar_user_score > 0.7`).
3. Lets you select up to 5.
4. For each pick, mints a per-invitee shortcode (`/r/{shortcode}`) and opens a Warpcast DM compose with that personal link prefilled.
5. Recipient taps the link, the app stamps `firstOpenedAt`/`openCount`, then redirects them to your single Circles magic link at `circles.gnosis.io/invitation/{code}`. Circles handles the rest of onboarding (Safe deploy, gas, profile).

This app does **not** call the Circles SDK, hold any private keys, or touch any on-chain contract. The Circles team hosts the redeem flow end-to-end. Allocation of claims against your magic link happens in the Circles Invitation Manager — the miniapp just gates and tracks who you sent the link to.

## Stack

- Next.js 16 App Router on Vercel
- React 19, TypeScript strict, Tailwind v4, shadcn (radix-luma)
- `@farcaster/miniapp-sdk` for mini-app auth + actions
- `@farcaster/quick-auth` for backend JWT verification
- `@vercel/kv` for assignment records + idempotency
- Neynar v2 API for mutuals + score

## Environment variables

See `.env.example`. Required at runtime:

| Var | Where | Notes |
|-----|-------|-------|
| `NEYNAR_API_KEY` | server | Free tier OK |
| `FARCASTER_DOMAIN` | server | Must exactly match the signed manifest's domain |
| `KV_REST_API_URL` | server | Vercel KV |
| `KV_REST_API_TOKEN` | server | Vercel KV |
| `NEXT_PUBLIC_APP_URL` | server + client | e.g. `https://farcaster-circles.vercel.app` |
| `CIRCLES_MAGIC_LINK` | server | Your single multi-claim invite URL from the Invitation Manager |

## Local dev

```bash
pnpm install
cp .env.example .env.local  # fill in values
pnpm dev
```

Mini apps must be tested inside Warpcast (or a Farcaster client) since the SDK relies on host context. For pure-route testing, hit `/api/candidates?fid=...` and `/r/{shortcode}` directly.

## Setup before going live

See **`SETUP.md`** for the one-time steps (quota request, manifest signing, generating the magic link). Do this in order — the app will not work without a magic link issued by the Circles team.

## Forking this app

If you want to run your own instance for your own social graph, you'll need your own Circles invite quota and your own magic link. DM the Circles team on Telegram and ask — see SETUP.md for the message template.

## License

MIT.

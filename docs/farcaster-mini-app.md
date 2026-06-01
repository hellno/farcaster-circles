# Building a Farcaster mini app

This repo is a working example of a Farcaster mini app. This guide explains the
mini-app-specific pieces so you can lift the pattern into your own app. It does
not re-document the whole flow; for that see [architecture](./architecture.md).

## What a mini app is (1-minute primer)

A Farcaster mini app is a normal web app that runs **inside a Farcaster client**
(the Farcaster app, formerly Warpcast) in an embedded webview. The host gives
your page two things a normal browser cannot:

1. **Context** — who the user is (`fid`, username, pfp) without a login screen.
2. **A wallet provider** — an EIP-1193 provider wired to the user's wallet.

Your app talks to the host through `@farcaster/miniapp-sdk`. The host shows a
**splash screen** until your app calls `sdk.actions.ready()`, then reveals it.

Official docs: <https://miniapps.farcaster.xyz/docs>. This guide assumes you've
skimmed that.

## The four moving parts in this repo

| Concern | File |
|---------|------|
| Client SDK wiring (host detect, ready, token, wallet) | `hooks/use-miniapp-sdk.ts` |
| Server-side auth (verify the user's identity) | `lib/farcaster/auth.ts` |
| Embed metadata so a cast renders a launch button | `app/layout.tsx` |
| The published manifest (domain ownership) | `public/.well-known/farcaster.json` |

## 1. The SDK hook: `hooks/use-miniapp-sdk.ts`

This is the part most worth copying. It returns a single `MiniappState` and
handles the three subtle things people get wrong.

### Detect the host first

```ts
const inHost = await sdk.isInMiniApp();
if (!inHost) {
  // plain browser: render an "open in Farcaster" state, make ZERO host calls
  setState({ ...INITIAL_STATE, inHost: false, ready: true });
  return;
}
```

`sdk.context`, `sdk.quickAuth.getToken()`, and the wallet provider only work
inside a host. Calling them in a normal browser tab throws `Failed to fetch`.
Gate everything behind `isInMiniApp()` so a browser visit degrades cleanly
instead of erroring.

### Call `ready()` so the splash dismisses, and call it reliably

The host hides your app behind a splash until `ready()`. If your init throws or
hangs before `ready()`, the splash never lifts and the host eventually closes
the card. So:

- Gather context, **then call `ready()`**. Do not block `ready()` on slow or
  failure-prone work.
- This repo fetches the Quick Auth token and wallet provider **before** `ready()`
  on purpose, so the primary button is already enabled when the splash lifts (no
  disabled-then-enabled flash). Each of those calls is wrapped in try/catch, so a
  failure leaves the field null but never prevents `ready()`.

```ts
requestAnimationFrame(() => {
  sdk.actions.ready().catch(() => {});
  setState((prev) => ({ ...prev, ready: true }));
});
```

If you ever see "splash never dismisses," the cause is almost always `ready()`
not being called (or being called before first paint). That is the first thing
to check.

### Get the Quick Auth token (for your backend)

```ts
const result = await sdk.quickAuth.getToken();
token = result?.token ?? null;
```

The token is a JWT the host signs. You send it to your own backend as
`Authorization: Bearer <token>` and verify it there (next section). That is how
your server learns the caller's `fid` without trusting the client.

### Get the wallet provider

```ts
const provider = (await sdk.wallet.getEthereumProvider?.()) ?? sdk.wallet.ethProvider ?? null;
```

A standard EIP-1193 provider. This app only uses it for `eth_requestAccounts`
(to read the connected address); it never asks the user to sign, because the
backend does all the on-chain work. Your app may use it for more.

## 2. Server-side auth: `lib/farcaster/auth.ts`

Never trust a `fid` sent from the client. Verify the JWT:

```ts
import { createClient, Errors } from "@farcaster/quick-auth";
const client = createClient();

const payload = await client.verifyJwt({ token, domain: env.FARCASTER_DOMAIN });
// the fid is in payload.sub
```

`domain` **must exactly match** the domain in your signed manifest, or
verification fails. A mismatch here is the usual cause of `401`s. The verified
`fid` is the only identity your server should act on; `app/api/onboard/route.ts`
calls `verifyQuickAuth` first and passes the result into the flow.

## 3. Embed metadata: `app/layout.tsx`

When your app URL is shared in a cast, Farcaster reads the `fc:miniapp` meta tag
to render a launch button and splash. This repo sets it in `generateMetadata`'s
`other` field:

```ts
other: {
  "fc:miniapp": JSON.stringify({
    version: "1",
    imageUrl: `${APP_URL}/og.png`,
    button: {
      title: "Open Circles Onboard",
      action: { type: "launch_miniapp", name, url, splashImageUrl, splashBackgroundColor },
    },
  }),
}
```

Keep `splashBackgroundColor` matching your app's first-paint color so the
launch does not flash a different shade before your UI loads.

## 4. The manifest: `public/.well-known/farcaster.json`

Proves you own the domain and carries the app's name/icon/splash. The
`accountAssociation` block must be **signed for your production domain** via
<https://miniapps.farcaster.xyz/docs/guides/publishing>. The placeholders in the
committed file (`TODO_SIGN_FOR_PROD_DOMAIN`) are intentional; replace them after
you have a domain. Re-sign if you change domains. See [SETUP](../SETUP.md).

## Testing it

A mini app needs the host context, so the full experience only works inside a
Farcaster client (or its mini app preview tool). In a plain browser you'll get
the "Open in Farcaster" state by design. For backend testing, hit the API routes
directly with a valid Quick Auth token, or use `GET /api/debug/me` (dev only) to
inspect the verified token, profile, and gate verdict without spending anything.

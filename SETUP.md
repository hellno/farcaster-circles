# Setup

One-time steps to run your own instance. The app registers users by spending
**on-chain invite quota** held by your inviter Safe, paying deploy gas from an
operator EOA. You need both before anything works.

New to the moving parts? Read [docs/circles-invite-and-safe.md](./docs/circles-invite-and-safe.md)
first; it explains the inviter Safe, the farm quota, and the modules.

## 1. Request invite quota from the Circles team

This is the only step that can block you for days, so start it first. Message the
Circles team on Telegram, along these lines:

> Hi, I'm building a Farcaster to Circles onboarding mini app. Could you grant
> invite quota to my Circles inviter Safe at `0xYOUR_INVITER_SAFE`? Happy to
> share the design.

The inviter Safe is the Circles avatar/Safe whose quota funds onboarding. If you
do not have one yet, create a Circles account first and use that Safe address.

## 2. Provision the quota in the Invitations Manager

Once the team has assigned you quota, open the Invitations Manager:

<https://circles.gnosis.io/admin/invitations-manager>

Create an invite allocation / distribution session for your inviter Safe. This is
what puts the **on-chain farm quota** on the Safe. The app reads it directly via
`getQuota(INVITER_SAFE_ADDRESS)` (see `lib/circles/invite.ts`); there is no link
or token to copy into env. You can re-check remaining quota here anytime, and the
onboard preflight returns `no_quota` when it runs dry.

## 3. Set up the operator EOA

Create a dedicated EOA (a fresh private key) to act as the backend operator:

- Put its key in `DEPLOYER_PK` (0x + 64 hex). It pays gas to deploy each user's Safe.
- Fund it with a small amount of **xDAI** on Gnosis (deploys are cheap; top up as needed).
- In the common case this same EOA owns the inviter Safe (threshold 1), so
  `INVITER_OWNER_PK` defaults to `DEPLOYER_PK`. Set `INVITER_OWNER_PK` separately
  only if a different key owns the inviter Safe.

Keep these keys in `.env.local` (gitignored) and your host's env vars. **Never
commit them** — they control real funds and your invite quota.

## 4. Point the app at your inviter Safe

Set `INVITER_SAFE_ADDRESS` to your Safe from step 1. (It defaults to the
project's house inviter, which you cannot spend.)

## 5. Sign up for Neynar

Get a free API key at <https://dev.neynar.com> and set `NEYNAR_API_KEY`. Used for
the caller's verified addresses and the anti-spam signals.

## 6. RPCs (optional)

The public defaults in `lib/env.ts` work for testing. For real volume, set
`GNOSIS_RPC_URL` (and optionally `CIRCLES_RPC_URL`, `ETH_RPC_URL`, `BASE_RPC_URL`)
to private, rate-limit-safe endpoints.

## 7. Sign the Farcaster manifest

Visit <https://miniapps.farcaster.xyz/docs/guides/publishing> and sign a manifest
for your production domain. Replace the `TODO_SIGN_FOR_PROD_DOMAIN` placeholders
in `public/.well-known/farcaster.json` with the signed `accountAssociation`, and
fill in the real `iconUrl` / `homeUrl` / `imageUrl` / `splashImageUrl`. Set
`FARCASTER_DOMAIN` to that exact domain. Commit the signed manifest.

**Re-sign if you change domains.** A `FARCASTER_DOMAIN` that does not match the
manifest is the usual cause of `401`s.

## 8. Validate the embed

Open the Farcaster preview tool, paste your `NEXT_PUBLIC_APP_URL`, and confirm the
launch button + splash render.

## 9. One real end-to-end onboard

The success gate: open the app inside a Farcaster client, tap **Create my
account**, and confirm you end up with a live Safe and `isHuman ✅` without
leaving the app. Then check the Invitations Manager shows one unit of quota
consumed.

## 10. (Optional) anti-spam gate

Leave `ONBOARD_GATE=off` while testing. To restrict who can onboard, set a policy
(`powerBadge` / `mutual` / ...) and put your own fid in `DEBUG_VIEWER_FID`. Add
trusted fids to `ONBOARD_ALLOWLIST_FIDS` to always allow them.

## Troubleshooting

- **Splash never dismisses** — `sdk.actions.ready()` not called (init threw before
  it). Check `hooks/use-miniapp-sdk.ts`. See [the mini app guide](./docs/farcaster-mini-app.md).
- **`401 unauthorized`** — Quick Auth JWT missing, or `FARCASTER_DOMAIN` does not
  match the signed manifest. They must match exactly.
- **`403 gated`** — the caller failed `ONBOARD_GATE`. Set `off` or allowlist them.
- **`503 no_quota`** — your inviter Safe is out of quota. Provision more in the
  Invitations Manager (step 2).
- **`503 inviter_unavailable`** — the inviter Safe is not a registered Circles
  human, or preflight failed. Make sure it is a real Circles account.
- **`500 deploy_failed` / `safe_not_ready`** — usually the operator EOA is out of
  xDAI, or an RPC issue. Fund it / switch RPC.
- **`502 not_registered`** — the invite txs sent but `isHuman` did not flip in
  time. Check the tx on gnosisscan; a `TrustRequired` / `GS013` revert means the
  claim+transfer did not run atomically (see `lib/circles/invite.ts`).

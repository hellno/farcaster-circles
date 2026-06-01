# Circles Onboard

A Farcaster mini app that creates a [Circles](https://aboutcircles.com) account
for the user in one tap, gas-free, without leaving the app. Tap once: the backend
deploys a Safe smart account for you and spends prepaid invite quota to register
it as a Circles human. You never sign a transaction or see a seed phrase.

> Independent project. Built alongside the Circles team; not officially endorsed
> by Circles or Gnosis.

## Use this repo to learn

It is also meant as a worked reference for two things people often have to piece
together from scratch:

- **[Building a Farcaster mini app](./docs/farcaster-mini-app.md)** — SDK init,
  host detection, the `ready()` splash, Quick Auth, the manifest, and the embed.
- **[Circles invite + Safe generation](./docs/circles-invite-and-safe.md)** —
  deterministic Safe deploy with the right modules, the invite farm, and the
  atomic claim+transfer that registers a human.
- **[Architecture](./docs/architecture.md)** — module map and the end-to-end
  onboard flow with diagrams.

## What it does

1. The user opens the app inside a Farcaster client and taps "Create my account".
2. The client sends a Quick Auth JWT to `POST /api/onboard`; the server verifies
   it and learns the user's `fid`.
3. The server resolves the Safe owners (the connected wallet, plus any verified
   addresses the user kept), runs an optional anti-spam gate, and predicts the
   Safe address.
4. It deploys the user's Safe (operator pays gas) with the Circles invitation
   module and Safe 4337 module enabled.
5. It spends one unit of the **house inviter's prepaid farm quota** to register
   the Safe as a human, executing claim + transfer in one atomic Safe transaction.
6. It polls the Hub until `isHuman` is true and returns the live Safe address.

Unlike a hosted redeem link, this app **does** call Circles on-chain, **does**
hold backend operator keys, and **does** broadcast transactions. The user signs
nothing; the backend does all the on-chain work.

## Stack

- Next.js 16 App Router (Turbopack), React 19, TypeScript strict, Tailwind v4 + shadcn.
- `viem` + `@safe-global/protocol-kit` for Safe deploy and signing.
- `@aboutcircles/sdk-invitations` for the invite farm.
- `@farcaster/miniapp-sdk` (client) + `@farcaster/quick-auth` (server JWT verify).
- Neynar v2 for the fid's verified addresses and anti-spam signals.
- Target chain: Gnosis (chain 100). The user's Safe enables the ERC-4337 module, but deploy gas is paid by the operator EOA; a sponsored gasless deploy via Pimlico is prototyped in `scripts/spike-claim.ts` and is not wired into the onboard flow.

## Environment variables

`lib/env.ts` is the single source of truth and validates these at access time.

**Required**

| Var | Notes |
|-----|-------|
| `NEYNAR_API_KEY` | Free tier OK. Verified addresses + anti-spam signals. |
| `FARCASTER_DOMAIN` | Must exactly match your signed manifest's domain (Quick Auth verify). |
| `DEPLOYER_PK` | Funded xDAI EOA (0x + 64 hex). Pays gas to deploy the user's Safe. |

**Inviter** (the Safe that holds your Circles quota)

| Var | Default | Notes |
|-----|---------|-------|
| `INVITER_SAFE_ADDRESS` | the project's house inviter | Set this to **your own** inviter Safe. |
| `INVITER_OWNER_PK` | `DEPLOYER_PK` | Owner key of the inviter Safe (threshold 1). Set only if it differs from the deployer. |

**RPCs** (public defaults; override for rate-limit-safe endpoints)

| Var | Default |
|-----|---------|
| `GNOSIS_RPC_URL` | `https://rpc.gnosischain.com` |
| `CIRCLES_RPC_URL` | `https://rpc.aboutcircles.com/` |
| `ETH_RPC_URL` | `https://ethereum-rpc.publicnode.com` (ENS reverse) |
| `BASE_RPC_URL` | `https://mainnet.base.org` (basename reverse) |

**App + optional**

| Var | Notes |
|-----|-------|
| `NEXT_PUBLIC_APP_URL` | Full prod URL, e.g. `https://your-app.vercel.app`. Used server + client + OG. |
| `ONBOARD_GATE` | Anti-spam policy: `off` (default) / `powerBadge` / `mutual` / `powerBadgeOrMutual` / `powerBadgeAndMutual`. |
| `ONBOARD_ALLOWLIST_FIDS` | Comma-separated fids that always bypass the gate. |
| `DEBUG_VIEWER_FID` | Operator's own fid; required for `mutual` gating and richer debug. |
| `ONBOARD_DEBUG` | Set `true` to include the verbose debug payload in production responses. |
| `PIMLICO_API_KEY`, `PIMLICO_SPONSORSHIP_POLICY_ID` | Read by `lib/env.ts` for the gasless-deploy spike (`scripts/spike-claim.ts`). **Not used by the onboard flow**, which pays deploy gas from the operator EOA. |

There is **no** `CIRCLES_MAGIC_LINK` and no Vercel KV. Those belonged to a removed
earlier flow. Invite capacity now lives as on-chain quota on your inviter Safe
(see [SETUP](./SETUP.md)).

## Local dev

```bash
pnpm install
cp .env.example .env.local   # fill in values
pnpm dev
```

A mini app needs the Farcaster host, so the full flow only works inside a
Farcaster client (or its mini app preview tool). In a plain browser you'll see
the "Open in Farcaster" state by design. For backend testing, call the API routes
directly with a valid Quick Auth token:

- `POST /api/onboard` — the onboard flow.
- `GET /api/verified-addresses` — the caller's verified eth addresses.
- `POST /api/names` — ENS / basename reverse resolution (cosmetic).
- `GET /api/debug/me` — verifies your token and shows the gate verdict + profile, spends nothing (dev only).

## Running your own instance

This is not a turnkey fork. To actually register users you need **your own
Circles invite quota** and a **funded operator EOA**. See **[SETUP](./SETUP.md)**
for the one-time steps (request quota, provision it in the Invitations Manager,
configure the operator + inviter Safe, sign the manifest). Without quota on your
inviter Safe, onboarding preflight fails with `no_quota`.

## License

MIT.

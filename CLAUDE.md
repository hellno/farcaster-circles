# CLAUDE.md

Guidance for AI agents (Claude Code and similar) working in this repo. Humans:
start with [README](./README.md) and [docs/architecture.md](./docs/architecture.md).

## What this is

A Farcaster mini app that onboards a user to Circles in one tap: the backend
deploys the user's Safe and spends prepaid invite quota to register it as a
Circles human, on Gnosis (chain 100). The user signs nothing.

## Commands

```bash
pnpm dev        # next dev --turbopack
pnpm build      # production build (run before claiming a change compiles)
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
pnpm test       # vitest run
pnpm format     # prettier --write
```

Always run `pnpm typecheck` and `pnpm lint` after edits. `pnpm build` is the
real gate (catches font/CSS/route issues `typecheck` misses).

## Architecture

See [docs/architecture.md](./docs/architecture.md) for the module map and flow
diagrams. The onboard flow lives in `lib/onboarding/onboard-account.ts`
(orchestrator) which calls `lib/circles/*` (Safe + invite) and
`lib/farcaster/*` (auth + gating). The single client screen is
`components/onboard-app.tsx`; the SDK wiring is `hooks/use-miniapp-sdk.ts`.

## Conventions

- **Config goes through `lib/env.ts`.** Don't read `process.env` directly
  elsewhere; add new vars to `env.ts` with the same validation pattern.
- **`server-only`** sits on server modules, with two deliberate exceptions:
  `lib/circles/config.ts` and `lib/circles/invite.ts` are imported by the
  `scripts/` tsx helpers in plain Node, where `server-only` throws. Do not add
  it there (there is a comment at the top of each).
- **Error model:** `onboardAccount` returns the `OnboardOutcome` discriminated
  union (`ok: true | false` with a stable `code`); the route maps `code` to HTTP
  via `STATUS` in `app/api/onboard/route.ts`. Preserve those codes; clients and
  the docs depend on them.
- **Tests:** vitest, in `test/`. Add a regression test for any bug fix that
  involves logic (not pure CSS/markup).
- **Secrets:** `DEPLOYER_PK` / `INVITER_OWNER_PK` control real funds. They live in
  `.env.local` (gitignored) only. Never commit secret values or invite links.

## Load-bearing gotchas (do not "simplify" these)

- **Atomic invite batch** (`lib/circles/invite.ts`): `claimInvite` self-grants a
  `bot -> inviter` trust with a **0-second TTL**, so claim + transfer MUST run in
  one Safe transaction (MultiSend). Splitting them reverts `TrustRequired` /
  `GS013`. This was a real bug; keep them atomic.
- **`ExecutionSuccess` lies:** a Safe's `execTransaction` emits success even when
  the inner call reverts. Never treat a receipt as proof; assert the on-chain
  effect (the flow polls `Hub.isHuman`).
- **Mini app init** (`hooks/use-miniapp-sdk.ts`): gate host-only SDK calls behind
  `sdk.isInMiniApp()` (they throw "Failed to fetch" in a plain browser), and
  always reach `sdk.actions.ready()` or the host splash never dismisses.
- **`FARCASTER_DOMAIN`** must exactly match the signed manifest, or Quick Auth
  verification 401s.

## Idempotency + cost ordering

The flow is idempotent (deterministic Safe address; returns early if already
`isHuman`) and orders read-only checks (gate, preflight) **before** any deploy or
quota spend so a doomed onboard costs nothing. Keep that ordering when editing
`onboard-account.ts`.

# TODOS

Deferred work, captured with enough context to pick up cold.

## env.ts domain split
- **What:** Split `lib/env.ts` (one flat accessor object) into domain-scoped groups so it stops being a cross-domain junk drawer.
- **Why:** It currently mixes Farcaster (`NEYNAR_API_KEY`, `FARCASTER_DOMAIN`), Circles/chain (`GNOSIS_RPC_URL`, `DEPLOYER_PK`, `INVITER_SAFE_ADDRESS`, `INVITER_OWNER_PK`, `CIRCLES_RPC_URL`), client-public (`NEXT_PUBLIC_APP_URL`), name resolution (`ETH_RPC_URL`, `BASE_RPC_URL`), gate config (`ONBOARD_GATE`, `ONBOARD_ALLOWLIST_FIDS`, `DEBUG_VIEWER_FID`), script-only (`SPIKE_OWNER_ADDRESS`), and future Pimlico keys. After the `farcaster/` + `circles/` split, `env` stays the one file that defeats the findability goal.
- **Pros:** An agent finds Circles secrets next to Circles code; smaller blast radius when adding a key.
- **Cons:** Touches every import site of `env`; risk of churn for modest gain; the lazy-getter pattern must be preserved per group.
- **Context:** Keep the `requireEnv` lazy-getter pattern (env validated on first access, not module load). Likely shape: `env.farcaster.*`, `env.circles.*`, `env.public.*`, or per-domain `env.ts` files re-exported. Surfaced by the Codex outside-voice pass during `/plan-eng-review` (2026-05-29).
- **Depends on / blocked by:** Best done after the findability refactor (`specs/circles-refactor-findability.md`) lands, so the domain folders exist to home the split.

## types.ts per-domain split
- **What:** Move server-only domain types out of the single root `lib/types.ts` into their domains; keep only client-shared types at root.
- **Why:** `types.ts` holds Neynar profile types, `SpamSignals`, gate types, Circles response types, and onboard API types in one file — domain soup that undercuts findability. It was kept shared in D1 only to avoid client-import churn.
- **Pros:** `farcaster/`-only types (`NeynarProfile`, `SpamSignals`, `NeynarViewerRelation`) and Circles types live with their code; root keeps just the client-imported surface.
- **Cons:** The client component imports from `@/lib/types`; splitting must keep client-shared types (`OnboardRequest`/`OnboardResponse`/`OnboardErrorCode`, `NameInfo`, `OnboardModules`) at root or client-safe, or the client bundle breaks.
- **Context:** Client import sites today: `components/onboard-app.tsx` imports `DebugMeResponse`, `NameInfo`, `NamesResponse`, `OnboardResponse`, `VerifiedAddressesResponse` from `@/lib/types`. Those (and their transitive types) must stay client-safe. Server-only types (`NeynarProfile.raw`, `SpamSignals`) can move into `farcaster/`. Surfaced by the Codex outside-voice pass during `/plan-eng-review` (2026-05-29).
- **Depends on / blocked by:** The findability refactor; deferred at decision D1.

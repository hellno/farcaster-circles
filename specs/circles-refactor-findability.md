# Circles Onboarding — Findability Refactor Spec

> Status: locked plan, ready to implement. Behavior-preserving refactor + one bug fix + first tests.
> Reviewed via `/plan-eng-review` (7 decisions) and hardened by an independent Codex outside-voice pass.
> Base commit: `03bf3c0`. Workflow: `/clear`, then implement T1–T6 from this file.

## Problem

Referral (Circles) account creation is tangled with Farcaster identity logic, so other devs and
agents cannot quickly find "the account-creation part" vs "the Farcaster part."

**Verified from code (not assumed):**
- The chain core is *already* Farcaster-agnostic. `lib/circles.ts` imports only `env`; `lib/safe.ts`
  imports `env` + `circles`. Neither touches Neynar, Quick Auth, or fids. `scripts/spike-onboard.ts`
  runs the **entire** account-creation flow with owners from an env var and zero Farcaster code.
- So this is **not** about creating decoupling. It is about making an existing seam **discoverable**.
- The real mixing lives in exactly two places: (1) `app/api/onboard/route.ts` — a 330-line handler
  interleaving auth, Neynar, gating, Safe deploy, and Circles invite; (2) the flat `lib/` directory
  (9 files, one folder) gives no signal of which domain each file belongs to.

**The seam:** the boundary between the two domains is the `owners: Address[]` array. Farcaster's job
ends at producing owners (+ a gate verdict); Circles' job starts at consuming them.

## Goal / success criteria

1. An agent asked "where is account creation?" opens `lib/circles/`. "Where is the Farcaster stuff?"
   opens `lib/farcaster/`. "Where is the flow?" opens `lib/onboarding/onboard-account.ts`.
2. `app/api/onboard/route.ts` is thin: auth + parse + call `onboardAccount` + map result → HTTP.
3. Behavior is preserved, **proven** by: `pnpm tsx scripts/spike-onboard.ts` green AND `pnpm test` green.
4. The `HOUSE_INVITER` vs `env.INVITER_SAFE_ADDRESS` divergence is fixed (single source of truth).
5. First test infrastructure exists (vitest) with the pure + security-critical paths covered.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Refactor scope | Group by domain into `lib/farcaster/` + `lib/circles/`; extract the flow into `lib/onboarding/`. (Rejected: typed service interface/DI, workspace package split, per-domain type split.) |
| D2 | Failure contract | `onboardAccount` returns a discriminated **result union** `OnboardOutcome`; the route owns the `code → HTTP status` map. Service has no `Response`/`NextResponse`. |
| D3 | `circles/` layout | Split into `config.ts` (addresses + ABI + `CirclesConfig` + clients) and `invite.ts` (reads + the on-chain write engine). |
| D4 | Test net | vitest + 5 core specs (pure + security seam), no chain, no live network. |
| D5 | Re-scope (post-Codex) | Keep the folder grouping but **drop barrels** — deep imports only (`@/lib/circles/invite`). Extract the route. Split the pure gate policy out of the server-only gating module. |
| D6 | Route ↔ service boundary | **Route owns auth + body parse** (route-level codes `unauthorized`/`invalid_request`); service owns the flow (service-level codes). A **shared `buildDebug` helper** is used by both, so debug logic is not duplicated. |
| D7 | `HOUSE_INVITER` bug | **Fix now**: single source of truth — `HOUSE_INVITER = env.INVITER_SAFE_ADDRESS` in `circles/config.ts`. |
| D8 | Next step | Write this spec; implement later from it. |

## Target architecture

```
lib/
  farcaster/                  [server-only · identity: fid -> owners + signals]
    auth.ts                   verifyQuickAuth
    neynar.ts                 verified addrs, profile          (server-only)
    gating-signals.ts         getSpamSignals, powerBadge, follow graph (server-only)
    gating-policy.ts          GatePolicy, evaluateGate    <- PURE, no server-only, testable
    constants.ts              hub / API URLs
  circles/                    [script-safe · account engine: owners -> Safe]
    config.ts                 addresses, HUB_ABI, getCirclesConfig, clients,
                              HOUSE_INVITER = env.INVITER_SAFE_ADDRESS   <- single source (D7)
    safe.ts                   normalizeOwners, predict / deploy / assertSafeReady
    invite.ts                 getHubStatus, getQuota, ensureInviterSetup, inviteSafe
  onboarding/
    onboard-account.ts        onboardAccount({fid, connectedAddress, additionalOwners, debug})
                              -> OnboardOutcome (service-level codes) · owns buildDebug
  names.ts                    [server · chain-neutral] ENS / basename  (NOT lumped w/ client types)
  env.ts  types.ts  utils.ts  [shared]

  NO index.ts barrels — deep imports only:  import { inviteSafe } from "@/lib/circles/invite"

  Invariant (what keeps it clean):
    farcaster/  NEVER imports  circles/     — identity knows nothing of chain
    circles/    NEVER imports  farcaster/   — chain core stays script-runnable (tsx), NEVER add server-only
    onboarding/ imports both; the cross-domain seam is owners: Address[]
    (onboarding additionally consumes fid + signals from farcaster — that is the orchestration layer,
     not the domain seam. The domain seam — what circles/ receives — is owners[] only.)
```

## Route <-> service boundary (D6)

```
route.ts (thin, HTTP-only)                  onboard-account.ts (server-only flow)
  verifyQuickAuth -> 401 unauthorized         resolve owners (re-validate additionalOwners
  zod parse       -> 400 invalid_request        against the fid's real verified set)
  buildDebug(partial) for those two           gate (gating-policy)        -> gated 403
  onboardAccount({fid, addr, ...})            predict + idempotent isHuman -> ok / alreadyRegistered
  return json(out, STATUS[out.code])          quota                       -> no_quota 503
                                              deploy                      -> deploy_failed 500
  STATUS: exported pure const,                assertSafeReady             -> safe_not_ready 500 (now WIRED)
  exhaustive over OnboardErrorCode            invite                      -> invite_failed 500
                                              poll isHuman                -> not_registered 502
                                              owns buildDebug (shared with route, no duplication)
```

### Error taxonomy
- **Route-level codes** (emitted by the route): `unauthorized` (401), `invalid_request` (400).
- **Service-level codes** (emitted by `onboardAccount`): `gated` (403), `no_quota` (503),
  `deploy_failed` (500), `safe_not_ready` (500), `invite_failed` (500), `not_registered` (502),
  `server_error` (500).
- One `OnboardErrorCode` union in `types.ts` for the response shape. `STATUS` map is exhaustive over
  it (TypeScript enforces every code is mapped) and exported as a pure const so it is unit-testable
  without importing the Next route handler.

## The bug fix (D7)

`getQuota` / `ensureInviterSetup` / `generateInvite` use the hardcoded `HOUSE_INVITER` constant
(circles.ts:473,524,568), but the Safe that actually **signs** the invite uses
`env.INVITER_SAFE_ADDRESS` (circles.ts:534,574). They default to the same address, so it is invisible
today — but setting `INVITER_SAFE_ADDRESS` makes the quota check / invite target one account while the
signer is another → wrong-inviter quota check or revert.

**Fix:** in `circles/config.ts`, `export const HOUSE_INVITER = env.INVITER_SAFE_ADDRESS as Address`
(env default already equals the current constant `0xC3CC…9598`). Every consumer reads this one value;
`Safe.init` uses the same. They cannot diverge. A test asserts `HOUSE_INVITER === env.INVITER_SAFE_ADDRESS`.

## Test plan (D4)

vitest, node env, `"test": "vitest run"`. No chain, no live network, no Next route-handler import.

| Spec | Asserts |
|---|---|
| `gating-policy.test.ts` | `evaluateGate` over all 5 policies × allow/block + operator/allowlist bypass (~14 cases). Imports the **pure** policy module (no server-only). |
| `safe.test.ts` | `normalizeOwners` (dedupe / checksum / sort / invalid-skip); `ENABLE_MODULES_DATA` byte-equality. |
| `onboard-account.test.ts` | owner re-validation (mock verified-set; assert non-verified `additionalOwners` are **rejected** — the security guard at route.ts:144-147); `gated` / `no_quota` / `already-human` outcomes with `circles`/`farcaster` layers mocked. |
| `route.test.ts` | `STATUS` map exhaustiveness + correct status per code (pure const, no handler import). |
| `config.test.ts` | `HOUSE_INVITER === env.INVITER_SAFE_ADDRESS` (single-source guard). |

Deferred (Codex option B, not this PR): mocked-fetch suites for `neynar` fallback + `getSpamSignals`,
and all 7 `onboardAccount` outcome branches with the chain layer stubbed.

## Implementation tasks

- [ ] **T1 (P1) circles/** — create `config.ts` (addresses, `HUB_ABI`, `getCirclesConfig`,
  `getInviteFarm`/`getInvitations`, `getPublicClient`, `HOUSE_INVITER = env.INVITER_SAFE_ADDRESS`),
  move `safe.ts`, create `invite.ts` (`getHubStatus`, `getQuota`, `execAsInviterSafe`,
  `ensureInviterSetup`, `inviteSafe`). Deep imports; **carry the no-`server-only` comment**. Repoint
  `safe.ts` → `@/lib/circles/config`. Verify: `pnpm tsx scripts/spike-onboard.ts`.
- [ ] **T2 (P1) farcaster/** — move `auth.ts`, `neynar.ts`, `constants.ts`; split `gating.ts` →
  `gating-signals.ts` (server-only fetchers) + `gating-policy.ts` (pure `GatePolicy` + `evaluateGate`,
  no server-only). Verify: `tsc --noEmit`.
- [ ] **T3 (P1) onboarding/onboard-account.ts** — `onboardAccount({fid, connectedAddress,
  additionalOwners, debug})` returning `OnboardOutcome`; owns the flow (resolve owners, gate, predict,
  idempotent, quota, deploy, assertSafeReady → **`safe_not_ready`**, invite, poll) and the shared
  `buildDebug`. Verify: T6.
- [ ] **T4 (P1) route.ts** — auth + zod parse (route-level codes via shared `buildDebug`) →
  `onboardAccount(parsed)` → exported exhaustive `STATUS` const. Verify: T6 + manual POST.
- [ ] **T5 (P2) imports** — update `app/api/debug/me`, `app/api/names`, `app/api/verified-addresses`
  routes + `scripts/spike-onboard.ts`, `scripts/smoke-readonly.ts`; tag `names.ts`
  `[server · chain-neutral]`. Verify: `tsc --noEmit` + both scripts run.
- [ ] **T6 (P1) tests** — vitest config + `test` script + the 5 specs above. Verify: `pnpm test`.

## What already exists (reuse, do not rebuild)
- Chain core (`circles.ts` + `safe.ts`) is already decoupled — proven by `spike-onboard.ts`. This
  relocates and splits it; it does not redesign it.
- The seam already exists implicitly as the `owners: Address[]` passed to `predictUserSafe`.
- `normalizeOwners`, `evaluateGate`, `buildAccountConfig` are already pure — they move as-is (and gain tests).
- `verifyQuickAuth`, the hub→Neynar fallback, the gate policy enum — all move verbatim; only paths change.

## NOT in scope (deferred, with reason)
- Typed `CirclesAccountService` interface / DI — single consumer; not worth the ceremony.
- Workspace package split — over-engineered for one miniapp.
- `index.ts` barrels — Codex correctly flagged they hurt the findability goal; deep imports instead.
- `env.ts` domain split — real findability gap but independent of this PR (see TODOS.md).
- `types.ts` per-domain split — deferred at D1; captured (see TODOS.md).
- Full mocked-fetch test suite for neynar/getSpamSignals — beyond the 5 core specs.
- `connectedAddress` is **not** re-verified against the fid (Quick Auth proves the FC user, not control
  of the submitted EVM address). Intentional for the spike (spec `circles-self-onboard.md` edge cases);
  flagged here as an explicit unstated assumption, not changed.
- Per-call viem client creation in `names.ts`/`circles.ts` — pre-existing perf nit, unrelated.
- M3 gasless path, profile-from-FC-context — untouched.

## Failure modes (new seam)
| New codepath | Realistic failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| owner re-validation | verified-set fetch throws → fall back to connected-wallet-only, NOT reject user | yes T6 | yes (try/catch preserved) | no (logged) |
| `code → HTTP status` map | new code added but unmapped | yes T6 | yes (exhaustive over union; tsc enforces) | no (compile error) |
| `HOUSE_INVITER` source | env diverges from signer | yes T6 (`config.test`) | yes (single source) | no |
| internal import of a sibling via a (nonexistent) barrel | import cycle | — | invariant: siblings import siblings directly; no barrels exist | no (build error) |

No critical gaps: every new path has a test or a compile-time guard, none fail silently.

## Worktree parallelization
| Lane | Modules | Depends on |
|---|---|---|
| A | `lib/circles/` (split + move safe + bug fix) | — |
| B | `lib/farcaster/` (move + gating split) | — |
| C | `lib/onboarding/` + thin `route.ts` | A, B |
| D | other 3 routes + 2 scripts (import updates) | A, B |
| E | `test/` + vitest | C |

`A ∥ B`, then `C ∥ D`, then `E`. Caveat (Codex): if `env.ts`/`types.ts` get touched, the lanes share
files and are no longer cleanly independent — this is sequencing-by-folder, so coordinate those two
shared files. Small enough to also do in one sequential pass.

## Outside-voice (Codex) findings and resolution
| Codex finding | Resolution |
|---|---|
| "service reusable by the script" is false (server-only) | Dropped the claim; the script reuses the chain core directly. |
| route/service boundary incoherent (debug + split enum) | D6: route owns auth/parse; **shared `buildDebug`**; documented route-level vs service-level codes. |
| `connectedAddress` not re-verified against fid | Documented as an explicit unstated assumption (NOT in scope). |
| "`owners[]` is always the seam" overstated | Clarified: domain seam (what circles/ gets) is `owners[]`; onboarding also consumes fid/signals. |
| `env.ts` is a cross-domain junk drawer | Captured as a TODO. |
| **`HOUSE_INVITER` vs `env.INVITER_SAFE_ADDRESS` can diverge** | D7: fixed — single source of truth. |
| `names.ts` "shared" contradiction | Tagged `[server · chain-neutral]`, kept distinct from client-safe types/utils. |
| `types.ts` domain soup | Captured as a TODO. |
| test infra bigger than admitted (server-only + Next routes) | Tests never import the route handler; pure modules + mocked deps only. |
| `evaluateGate` test drags in server-only | D5: pure `gating-policy.ts`. |
| `STATUS` map only testable if exported | Exported as a pure const. |
| `safe_not_ready` dead code | Wired: `assertSafeReady` failure → `safe_not_ready`. |
| barrels reduce findability | D5: dropped — deep imports. |
| Lane A/B "no shared files" optimistic | Caveat added re `env.ts`/`types.ts`. |
| route extraction is the real win, folders secondary | Accepted as the headline; folders kept because directory names are high-signal for the agents this targets. |

---
*This spec is the durable artifact. Before implementing: `/clear` to start with fresh context
containing only this spec. Gate: `scripts/spike-onboard.ts` green + `pnpm test` green.*

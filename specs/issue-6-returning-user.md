# Issue #6 — Returning-user entry point (set/update profile without re-running onboard)

Status: plan locked via `/plan-eng-review` + Codex outside voice (2026-06-03).
Implements GitHub issue #6. Pairs with `circles-self-onboard.md` (#5 profile feature).

## Goal

A returning user who already has a registered Circles Safe **lands on** a Manage
state (account + Set-profile action) instead of the "Create my account" CTA. No
gas, no quota spent for detection or for an already-registered account — including
users who picked a non-default signer set at onboard.

## Locked decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Index strategy | **Predict-on-demand, stateless** | No client store, no DB; money path hardened (D8) so statelessness is safe |
| D2 | Drift handling | **Bounded candidate-set enumeration** | Re-prediction drifts; enumerate realistic owner shapes, let the chain pick |
| D3 | Endpoint | **New `POST /api/account-status`** | Read-only detector out of the money path |
| D4 | Detect failure | **Fail-open, silent** → Create flow | Convenience must never gate onboarding (now safe because of D8) |
| D5 | Manage content | **Account summary; Set-only-when-unset; never "Update"** | Backend won't overwrite a digest (#5-deferred) |
| D6 | Client tests | **Thin component + E2E/QA** | Matches repo posture; logic lives in unit-tested helpers |
| D7 | Caching | **`unstable_cache`, positives only**, keyed by `safeAddress` | Correct pattern below; testable via injected wrapper |
| D8 | Money-path safety | **Harden onboard idempotency with the SAME enumeration** | Codex #2/#12: single-set idempotency lets a custom-set user create a 2nd Safe + burn quota |
| D9 | Detect trigger | **Automatic, non-blocking on load** | Codex #1: #6 says "land on Manage"; in-host `eth_requestAccounts` is silent |
| D10 | Module layer | **Split: `circles/` pure chain + `onboarding/` fid-derivation** | Codex #5/#11: `circles/*` is documented chain-only; don't conflate validation with candidate-building |

## Why this isn't "just predict once"

The predicted Safe is `normalizeOwners([connectedAddress, ...recommended])`.
`recommended` = the fid's verified addresses with an ENS/basename **at request
time** (`lib/names.ts:103`). That set drifts between sessions (name resolution
flips, verified set changes, or the user hand-toggled signers at onboard). A
single re-prediction → a different address → `isHuman` false → returning user told
"Create." So detection enumerates a bounded candidate set and lets the chain pick.

```
DETECTION + HARDENED ONBOARD share ONE pure-chain primitive
═══════════════════════════════════════════════════════════

  fid (Quick Auth)        connectedAddress (eth_requestAccounts, silent in-host)
       │                            │
       ▼  [lib/onboarding]          │
  buildCandidateOwnerSets(fid, connectedAddress):
     C1 = connected + recommended      ← default, common case
     C2 = connected only               ← drift: names dropped
     C3 = connected + all verified     ← drift: extra verified added
     (deduped; verified set CAPPED, see Codex #10)
       │
       ▼  [lib/circles]  ── PURE CHAIN, no Farcaster imports ──
  findRegisteredSafe(candidates): predict → isHuman, STOP at first hit
       │                          (early-exit: C1 hit = 1 predict + 1 read)
       ├─ hit  → { safeAddress }
       └─ none → null

  DETECTION adds:  digest read → profileSet (boolean|null on read failure)
                   + owner-check (connected wallet still an on-chain owner?)
  ONBOARD (D8) calls findRegisteredSafe BEFORE deploy/spend → short-circuit on
                   ANY existing candidate, not just the default set.
```

## Module layout (D10 — respects the chain-only boundary)

- **`lib/circles/account-status.ts`** (PURE CHAIN). Exports
  `findRegisteredSafe(candidates: Address[][]): Promise<{ safeAddress: Address } | null>`
  — predict each candidate (`predictUserSafe`) + `getHubStatus().isHuman`, sequential
  early-exit. No Farcaster imports. Imported by BOTH `onboard-safe.ts` (D8) and the
  detection layer. (Only `safe.ts` + `invite.ts` deps → no `server-only` entanglement,
  stays script-safe like `invite.ts`.)
- **`lib/onboarding/detect-account.ts`** (fid layer). `detectAccount(fid,
  connectedAddress)`: build candidate owner-sets (`fetchVerifiedEthAddresses` +
  `recommendedSigners` + `normalizeOwners`, capped) → `findRegisteredSafe` → on hit,
  read digest (`readMetadataDigest`) for `profileSet` and confirm the connected
  wallet is an on-chain owner. Returns `AccountStatus`.
- **Do NOT** force onboard's `additionalOwners` *validation* and detection's
  speculative *candidate-building* into one function (Codex #11). Share only
  `normalizeOwners` + `findRegisteredSafe`.

```ts
type AccountStatus =
  | { found: true; safeAddress: Address; profileSet: boolean | null; ownerMatch: boolean }
  | { found: false };
//          profileSet:null = isHuman true but digest read failed (Codex #6)
//          ownerMatch:false = detected Safe's on-chain owners no longer include
//                             the connected wallet → show info, hide Set CTA (Codex #7)
```

## D8 — Harden the onboard money path

`onboardSafeToCircles` today short-circuits only when the **default** owner set's
Safe is `isHuman` (`onboard-safe.ts:78`). A returning user with a custom/drifted
set who falls through to Create deploys a SECOND Safe and burns a quota unit.

Fix: before preflight/deploy, call `findRegisteredSafe(candidates)`; if any
candidate is already human, return `alreadyRegistered:true` for that address. The
route already needs the fid's candidate sets, so pass them in (or have
`onboardAccount` build them once and hand both onboard + the short-circuit the same
list). Keep the cost ordering: this is a read-only check, still before any spend.
Add a regression test for the custom-set short-circuit.

## D7 — Caching (corrected per Codex #8/#9)

The earlier "positives only" + `revalidate:60` framing was contradictory — a 60s
TTL caches negatives too. Pick ONE honest model:

**Chosen: positive-only memo via an injected cache wrapper.**
- A tiny indirection `humanCache = { get(safe): boolean; set(safe): void }` with a
  default impl backed by a module-level `Set<safeAddress>` (monotonic, write-on-true
  only, no TTL — a cached entry is always a confirmed human, never poison).
- `findRegisteredSafe` checks `humanCache.get(safe)` before the `isHuman` read and
  `humanCache.set(safe)` only on a `true` result.
- Negatives are NEVER cached. No `unstable_cache` wrapping the raw read (that would
  cache `false`). If cross-instance positives are ever needed, back the wrapper with
  `unstable_cache(readHuman, [safe], { revalidate: false })` guarded so only the
  positive path memoizes — but the in-memory Set is enough for v1.
- **Key on `safeAddress`, NEVER `fid`** (fid keying would cache the drift).
- **Testable (Codex #9):** the wrapper is injected, so tests pass a fake
  `humanCache` and assert positive-retained / negative-never-stored / key isolation
  without any `next/cache` shim.

> Honest note: D9 makes detection run on every app-open, so this cache now has a
> real (if modest) hit rate. The dominant latency is still `predict`/`Safe.init`,
> not the `isHuman` read — caching trims reads, not the predict cost.

## D9 — Automatic, non-blocking detection (client)

`components/onboard-app.tsx`:
- On load, once `sdk.ready && sdk.provider && sdk.isInMiniApp()`, silently
  `eth_requestAccounts` → `POST /api/account-status` in the background. **Render the
  Create screen immediately**; if detection returns `found && isHuman`, swap
  `phase` to `manage`. Guard on `isInMiniApp()` so a plain browser never triggers a
  wallet prompt. Any error → stay on Create (fail-open).
- New `Phase` value `manage`. Reuse the done-screen certificate + Gnosis links.
  Show the Set-profile CTA only when `profileSet === false`; when `true`, the
  "already set" panel; when `ownerMatch === false`, an info note (no Set button).
- Keep the handler dumb — branching lives in the helper. `handleSetProfile` reuses
  the detected `safeAddress`.

## `POST /api/account-status` route

```
runtime=nodejs, dynamic=force-dynamic, maxDuration~30
  body: { connectedAddress: 0x-20 }   (zod, same regex as onboard)
  auth: verifyQuickAuth → fid (401), 400 on bad body
  → try detectAccount(fid, connectedAddress)
       200 { found:true, safeAddress, profileSet, ownerMatch } | { found:false }
  → catch → LOG, return 200 { found:false }   (D4 fail-open, silent)
```

## Bounded work (Codex #10)

`buildCandidateOwnerSets` must cap the verified-address fan-out: if the fid has more
than N verified addresses (e.g. N=10), skip the C3 "all verified" candidate (or
truncate) and skip `resolveNames` on the overflow — C1/C2 still cover the common
cases. Per-candidate predict/read inherits the route's `maxDuration`; add a total
timeout so a slow RPC can't hang the request. Document N inline.

## Test plan

`test/account-status.test.ts` (new, `lib/circles` pure chain):
- `findRegisteredSafe`: C1 hit (skips C2/C3), C2 hit, C3 hit, none → null, RPC throws
  → propagates; positive-cache get/set via injected fake (retained, negatives never
  stored, key isolation).

`test/detect-account.test.ts` (new, `lib/onboarding`):
- candidate build: default/connected-only/all-verified shapes; dedup when no verified;
  **verified-set cap (Codex #10)**; verified-fetch failure → C2-only.
- `detectAccount`: found + profileSet true/false; **digest read fails → profileSet:null,
  still found:true (Codex #6)**; **owner-check: connected wallet not an on-chain owner
  → ownerMatch:false (Codex #7)**; none → found:false.

`test/account-status-route.test.ts` (new):
- 401, 400, 200 found:true (profileSet + ownerMatch variants), 200 found:false,
  **detect throws → 200 found:false + server log** (D4).

`test/onboard-safe.test.ts` / `onboard-account.test.ts` (REGRESSION — mandatory):
- **D8 custom-set short-circuit:** a candidate that is NOT the default set but IS
  isHuman → `alreadyRegistered:true`, NO deploy, NO quota spend.
- Owner-resolution unchanged for the normal onboard path (pin existing behavior).

E2E / `/qa` (7 flows): auto-detect default → Manage; auto-detect drifted set → Manage;
profile-already-set → "already set"; owner-changed Safe → info (no Set button);
truly new user → Create (no false-positive Manage, no flash hang); detection RPC fails
→ Create; custom-set returning user taps Create → short-circuits (no 2nd Safe).

## Failure modes (corrected)

| Codepath | Realistic prod failure | Test? | Error handling | User sees |
|---|---|---|---|---|
| `findRegisteredSafe` enum | public Gnosis RPC throttled | ✅ | route fail-opens | Create flow (self-heals) |
| candidate prediction | name drift → wrong C1 | ✅ (C2/C3 hit) | enumeration covers | Manage anyway |
| **fallback to Create** | **custom-set user → 2nd Safe + quota** | ✅ (D8 regression) | **D8 short-circuit** | **no duplicate (FIXED)** |
| digest read | isHuman true, digest throws | ✅ | profileSet:null | Manage, Set CTA hidden |
| owner change | connected wallet no longer owner | ✅ | ownerMatch:false | info note, no dead Set button |
| positive cache | cached entry | ✅ (fake) | monotonic, write-on-true | always correct |
| auto-detect on load | host prompts on eth_requestAccounts | manual/QA | isInMiniApp guard | no prompt outside host |

**Critical-gap check (corrected):** the double-account hole Codex #2 flagged was a
real critical gap in the prior draft — **closed by D8**. With D8, no failure mode is
(no test) AND (no handling) AND (silent + dangerous). **0 critical gaps.**

## NOT in scope

- **Profile update / re-sync** — backend won't overwrite a set digest (`route.ts:97`);
  deferred in #5/#6. Manage shows "already set," never "Update."
- **Cross-device / persistent fid→safe index** — D1 stateless. (Codex #4: the
  guarantee is therefore explicitly **best-effort** for exotic hand-customized owner
  subsets; D8 makes the *fallback* safe even when detection misses.)
- **Discovering Safes created outside this app** — #6 out-of-scope.
- **Full powerset of owner subsets** — only C1/C2/C3; exotic subsets remain a detect
  miss, but D8 prevents the duplicate-Safe consequence.
- **Cross-instance positive cache (`unstable_cache`)** — in-memory Set is enough for
  v1; documented upgrade path.
- **Private RPC swap** — env supports it; ops toggle, not this PR.

## Worktree parallelization

| Step | Modules | Depends on |
|---|---|---|
| S1 `circles/account-status.ts` (findRegisteredSafe + cache) + tests | `lib/circles/`, `test/` | — |
| S2 D8 onboard hardening + regression | `lib/circles/`, `lib/onboarding/`, `test/` | S1 |
| S3 `onboarding/detect-account.ts` + tests | `lib/onboarding/`, `test/` | S1 |
| S4 `/api/account-status` route + tests | `app/api/`, `test/` | S3 |
| S5 client auto-detect + `manage` + /qa | `components/` | S4 |

S2 and S3 both build on S1 but touch mostly different files → **can run in parallel**
after S1 (S2 in `onboard-safe`/`onboard-account`, S3 in new `detect-account`). S4→S5
sequential. Land S1 first.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2.5h / CC: ~25min)** — `lib/circles` — `findRegisteredSafe(candidates)` pure-chain enumeration (early-exit) + injected positive cache + unit tests.
  - Surfaced by: D2, D7, D10 (split)
  - Files: `lib/circles/account-status.ts`, `test/account-status.test.ts`
  - Verify: `pnpm test test/account-status.test.ts`
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** — `lib/circles`+`lib/onboarding` — D8: short-circuit onboard on ANY registered candidate before deploy/spend + regression test.
  - Surfaced by: Codex #2/#12 (T1 tension)
  - Files: `lib/circles/onboard-safe.ts`, `lib/onboarding/onboard-account.ts`, `test/onboard-safe.test.ts`
  - Verify: custom-set short-circuit test (no deploy, no quota)
- [ ] **T3 (P1, human: ~3h / CC: ~25min)** — `lib/onboarding` — `detect-account.ts`: capped candidate build + profileSet(null-safe) + owner-check + tests.
  - Surfaced by: D2, D10, Codex #6/#7/#10
  - Files: `lib/onboarding/detect-account.ts`, `test/detect-account.test.ts`
  - Verify: `pnpm test test/detect-account.test.ts`
- [ ] **T4 (P1, human: ~2h / CC: ~20min)** — `app/api` — `POST /api/account-status` (Quick Auth, zod, fail-open) + route tests.
  - Surfaced by: D3, D4
  - Files: `app/api/account-status/route.ts`, `test/account-status-route.test.ts`
  - Verify: `pnpm test test/account-status-route.test.ts`
- [ ] **T5 (P1, human: ~3h / CC: ~25min)** — `components` — automatic non-blocking detect on load + `manage` phase (Set-only-when-unset, ownerMatch handling).
  - Surfaced by: D5, D9
  - Files: `components/onboard-app.tsx`
  - Verify: `/qa` click-through of the 7 flows
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — docs — detection flow + module split + cache knob in `docs/architecture.md`.
  - Files: `docs/architecture.md`
  - Verify: manual read

Sequencing: T1 → (T2 ∥ T3) → T4 → T5 (T6 anytime).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (small enhancement) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 12 findings → 3 tensions (all accepted) + 5 folded in |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 18 issues, 0 unresolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (reuses existing UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** material improvements — closed a P1 double-account/quota-burn hole (D8),
  moved to automatic non-blocking detection (D9), fixed a chain-only layer violation
  (D10), plus `profileSet:null`, owner-check, honest cache model, and bounded work.
- **CROSS-MODEL:** Claude + Codex agree the prior "0 critical gaps / safe fallback"
  claim was wrong; single-set idempotency is not global. Resolved by D8.
- **UNRESOLVED:** 0 (all 10 decisions + 3 tensions answered).
- **VERDICT:** ENG CLEARED — architecture, tests, and failure modes locked. Ready to
  implement (T1 → T2∥T3 → T4 → T5). No design/CEO review required for this change.


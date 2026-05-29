# Circles Self-Onboard (Safe + InviteFarm) — Spike Spec

> Status: spec for a **lean validation spike**. Goal is to prove the mechanism works end-to-end, then make it tappable in-app. UX polish is explicitly later.
> Supersedes the v1 magic-link/DM flow (see "Scope → Replaces").

## Problem

**Who:** A Farcaster user who opens this mini-app and wants their *own* live Circles account, with zero blockchain knowledge and possibly no xDAI.

**Current behavior (verified from code):**
- The shipped app (`app/api/invites/assign/route.ts`, `components/inviter-app.tsx`) is a **magic-link / DM flow**: you invite your *mutuals* by minting a `/r/{shortcode}` and DM'ing them a `circles.gnosis.io/invitation/{code}` link. The app never touches chain. Onboarding finishes on Circles' hosted SPA.
- A **Phase A spike** (`scripts/spike-claim.ts`, `scripts/SPIKE-FINDINGS.md`, `components/passkey-probe.tsx`) tried the dispensed-key / `ReferralsModule.claimAccount` flow. It is **blocked**: `claimAccount` is passkey-only (WebAuthn P-256), and `navigator.credentials.create()` does **not work inside the Warpcast mobile webview** (`NotAllowedError`). Confirmed on-device 2026-05-22.

**Target behavior:** The connected user taps once and ends up with a **registered Circles human** — a Safe on Gnosis Chain (chainId 100) that they own (their Farcaster wallet + verified addresses are owners), with `Hub.isHuman(safe) === true`. No leaving the app. No passkey. No magic link.

**Why now:** Both prior paths fail the "stay in-app" bar — magic-link makes the user leave Warpcast for the Circles SPA; the passkey claim is hard-blocked in the mobile webview. A newer, verified mechanism (Safe-with-`InvitationModule` + `InviteFarm.generateInvites`) lets a quota-holding backend register the user's Safe **without any invitee signature**, so the whole flow can run in-app.

**How we know it's done:** see Success Criteria — on-chain `isHuman` + both modules enabled (mechanism), then the same flow tappable from Warpcast on a phone (UX).

## Success Criteria

1. **M1 mechanism (script):** `pnpm tsx scripts/spike-onboard.ts` deploys a Safe `S` on Gnosis and, after it returns, `Hub.isHuman(S) === true` **and** `Hub.avatars(S) !== 0x0` (read via RPC `eth_call`). Hub v2 = `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`.
2. **M1 both modules:** `S.isModuleEnabled(0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5) === true`, `S.isModuleEnabled(0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226) === true`, `S` fallback handler == `0x75cf…c226`, `threshold === 1`, owners ⊇ {connected wallet, …verified addrs}, Safe singleton version `1.4.1`.
3. **M1 no silent success:** the script asserts 1+2 and exits `0` only on full success; on any revert it exits non-zero printing the failing tx hash + decoded revert reason (e.g. `ModuleNotEnabled`, `InviteeAlreadyRegistered`, insufficient-flow).
4. **M2 in-app (API):** `POST /api/onboard` with a valid Quick Auth Bearer token + `{ connectedAddress }` returns `{ safeAddress, isHuman: true, modules: { invitation: true, erc4337: true }, txHashes }`; the page renders the Safe address and a working `app.aboutcircles.com` / Gnosisscan link.
5. **M2 final UX gate:** inside Warpcast on a phone, the connected user taps **"Create my Circles account"** once and — without leaving the app — sees their live account (Safe address + `isHuman ✅`).
6. **M3 stretch (gasless):** the Safe deploy is sponsored by a Pimlico paymaster (EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`); the user signs exactly one UserOp and spends no xDAI; no backend EOA pays the deploy gas.

❌ Not acceptable: "the onboarding works", "user gets a Circles account" without the on-chain `isHuman` + module assertions above.

## Quantified Impact

- **Replaces v1:** ~8 files removed/archived (`app/api/invites/*`, `app/api/candidates/*`, `app/r/*`, `components/inviter-app.tsx`, `components/candidate-*.tsx`, `components/invite-result-list.tsx`, `hooks/use-candidates.ts`, `hooks/use-assign-invites.ts`), ~5 new files added.
- **Cost:** `INVITATION_FEE = 96e18` (96 CRC) per onboarded user, debited from the house inviter (`0xC3CC…9598`) quota (~50 granted per SETUP.md). 1 farm-quota consumed per invite.
- **Gas:** M1/M2 — backend EOA pays Gnosis gas (Safe deploy ≈ 1 tx; invite = 2 txs). M3 — paymaster-sponsored.
- **UX:** from "leave app → blocked passkey / external SPA" → "1 tap, in-app".

## Scope

### In scope
- **Strategy A** (chosen): deploy a Safe **we own the config of** (owners = user's addresses) with both modules enabled at creation, via `@safe-global/protocol-kit`; then the house inviter calls `InviteFarm.generateInvites`.
- M1: standalone `scripts/spike-onboard.ts` proving the mechanism. **No mini-app/Neynar context in M1** — owners come from env (`SPIKE_OWNER_ADDRESS`, any EOA you control, e.g. a throwaway or the deployer's own address; optional comma-list for multiple). Neynar verified-address resolution lands in M2.
- M2: `app/page.tsx` → single onboarding screen + `app/api/onboard/route.ts` doing deploy+invite backend-side; testable in Warpcast on a phone.
- M3 (stretch, after M1+M2 green): user-signed **gasless** 4337 deploy via Pimlico, replacing the backend-EOA deploy.
- Owners = connected FC wallet **+** all Neynar-verified ETH addresses for the fid; threshold 1.

### Out of scope (locked)
- **The entire v1 invite-mutuals path** — magic link, `CIRCLES_MAGIC_LINK`, Neynar mutuals selection, KV shortcodes, DM compose, `/r/{shortcode}`. Remove/archive.
- **The Phase A dispensed-key / passkey / `ReferralsModule.claimAccount` path** (Strategy B) — abandoned; do not revive for this spike.
- **Production hardening** — rate limits, quota dashboards, abuse prevention, multi-tenant inviters, retry-at-scale.
- **Recovery / "user already has a different Circles account" / owner rotation** — the person driving the mini-app decides this for themselves; we don't detect or block it.
- **Profile *editing* UI** — out. (Setting a *default* profile from FC context **is in scope** — see "Default profile from FC context" below. Only a user-facing editor is deferred.)

### MVP cut (build order)
**M1 (script) → M2 (in-app, backend-driven deploy) → M3 (gasless, user-signed deploy).** Ship/verify each before the next. M1 is the fastest proof the on-chain mechanism is real.

### Replaces
This flow **replaces v1 entirely** as the app's main screen. Keep reusable infra (auth, Neynar client, env pattern, mini-app SDK hook, shadcn UI); archive the invite-mutuals UI + routes.

## Strategy decision (A vs B) — why A

| | Strategy A — protocol-kit deploy (CHOSEN) | Strategy B — ReferralsModule.createAccount |
|---|---|---|
| Who owns the Safe | **User's wallet + verified addrs** ✅ (the goal) | Passkey shared-signer / service signer ❌ |
| Invitee signs | Nothing (module self-registers) | WebAuthn passkey ❌ (blocked in webview) |
| Deploy | We build setup → modules enabled at creation | Circles service deploys pre-configured Safe |
| Fit for "user-owned Safe in-app" | **Yes** | No (this is the blocked Phase A path) |

Strategy A is the only one that yields a **user-owned** Safe with no passkey. Do **not** mix in `ReferralsModule`/`generateReferrals`.

## Technical Approach

### The mechanism (verified on-chain + from SDK source)

`InviteFarm` (in `@aboutcircles/sdk`, package `packages/invitations`) is a **class**, constructed with a `CirclesConfig`:

```ts
// @aboutcircles/sdk — packages/invitations/src/InviteFarm.ts
constructor(config: CirclesConfig) {
  this.referralsModuleAddress = config.referralsModuleAddress;
  this.invitations = new Invitations(config);
  this.invitationFarm = new InvitationFarmContractMinimal({
    address: config.invitationFarmAddress,
    rpcUrl: config.circlesRpcUrl,
  });
}
async generateInvites(inviter: Address, invitees: Address[]): Promise<GenerateInvitesResult>
//   GenerateInvitesResult = { invitees: Address[]; transactions: TransactionRequest[] }  // [claimTx, transferTx], UNSIGNED
async getQuota(inviter: Address): Promise<bigint>   // == InvitationFarm.inviterQuota(inviter)
```

`generateInvites(inviter, [invitee])` **builds** (does not send) two txs, executed **in order by the inviter**:
1. `claimTx` → `InvitationFarm.claimInvite()` — consumes 1 quota, yields a "bot" ERC-1155 token id.
2. `transferTx` → `HubV2.safeTransferFrom(from=inviter, to=InvitationModule, id=botId, value=96e18, data=abi.encode(address invitee))`.

On `transferTx`, the Hub calls `InvitationModule.onERC1155Received` (onlyHub), which makes the **invitee Safe self-call** `Hub.registerHuman(inviter, bytes32(0))` via `execTransactionFromModuleReturnData`, then trusts the invitee. **Net result: `isHuman(invitee) === true`.**

**Hard precondition (on-chain enforced):** `enforceHumanRegistered()` calls `validateModuleEnabled(invitee)` and reverts `ModuleNotEnabled(invitee)` if `InvitationModule` is not enabled on the invitee Safe. This is the load-bearing requirement — the invitee Safe **must** have `0x00738aca…40B5` enabled *before* the invite, and **must not** already be a registered avatar (`Hub.avatars(invitee) == 0`).

### Roles & terms (house inviter ≠ invite farm — they compose)

Circles requires an **existing human to invite a new one** and pay ~96 CRC. These are two layers of the *same* flow, not alternatives:
- **House inviter** = the single Circles *account* (`0xC3CC…9598`) that sponsors every self-onboarding user. It's the `inviter` arg to `generateInvites`. (The user can't invite themselves.)
- **Invite Farm** = the *contract* the house inviter uses to issue invites at scale via **prepaid quota**, routing registration through the **InvitationModule** so the new user **signs nothing**.

**The house inviter uses the invite farm.** The 96 CRC cost-per-invite exists in every Circles invite path; the farm just lets you prepay it as quota (SETUP.md: ~50 granted → `inviterQuota(0xC3CC…9598)` ≈ 50) and — via the module — register the invitee without their signature. That no-signature property is the entire reason this path beats Phase A's passkey/`registerHuman` paths (see "Strategy decision" + "Failed approaches").

### Actors

| Actor | Identity | Role | Key facts |
|---|---|---|---|
| **User** | connected FC wallet + verified ETH addrs | Owner(s) of the new Safe; signs nothing in M1/M2 | verified addrs resolved backend-side via Neynar (not in SDK context) |
| **Deployer** | backend xDAI EOA (`DEPLOYER_PK`) | Broadcasts the Safe deploy (M1/M2) | replaced by paymaster in M3 |
| **House inviter** | Safe `0xC3CCd9455b301D01d69DFB0b9Fc38Bee39829598` | Sends the 2 invite txs; holds **prepaid quota** (no live 96 CRC balance needed — `claimInvite` mints the invite token from quota) | **confirmed on-chain to be a Safe** (has proxy code) → invite txs must be executed *as the Safe* via owner-key `execTransaction` |

### Flow (M1 script; M2 = same logic behind `/api/onboard`)

```
1. owners = [connectedAddress, ...neynarVerifiedEthAddrs(fid)]   (dedupe, checksum, sort)
2. predict Safe (protocol-kit predictedSafe):
     safeAccountConfig = {
       owners, threshold: 1,
       to:   SAFE_MODULE_SETUP (0x2dd68b…),
       data: enableModules([INVITATION_MODULE (0x00738aca…), SAFE_4337_MODULE (0x75cf…)]),
       fallbackHandler: SAFE_4337_MODULE (0x75cf…),
     }
     safeDeploymentConfig = { safeVersion: '1.4.1', saltNonce }
     safeAddr = await kit.getAddress()
3. preflight: assert Hub.avatars(safeAddr) == 0; assert inviteFarm.getQuota(houseInviter) > 0
4. deploy:  tx = await kit.createSafeDeploymentTransaction(); broadcast from DEPLOYER_PK (xDAI)
5. assert deployed: isSafeDeployed(); isModuleEnabled(both); getFallbackHandler()==0x75cf…
6. invite:  { transactions:[claimTx, transferTx] } = await inviteFarm.generateInvites(houseInviter, [safeAddr])
            exec claimTx AS the inviter Safe (protocol-kit execTransaction, INVITER_OWNER_PK) → AWAIT receipt
            exec transferTx AS the inviter Safe → AWAIT receipt   (must be after claim is mined)
7. assert success: Hub.isHuman(safeAddr) === true && Hub.avatars(safeAddr) !== 0x0
8. on failure: decode + print revert reason; if registration fails on metadata, see Risk #1 fallback
```

**Executing as the inviter Safe (step 6):** `generateInvites` returns txs whose `from` is the inviter Safe. Wrap each via `Safe.init({ provider, signer: INVITER_OWNER_PK, safeAddress: INVITER_SAFE })` → `createTransaction({ transactions:[{to,value,data}] })` → `signTransaction` → `executeTransaction` (broadcasts from the owner EOA, which pays xDAI). Assumes inviter Safe threshold 1; if >1, multiple owner sigs are required (flag at setup).

### Code sketch (deploy, M1)

```ts
import Safe from '@safe-global/protocol-kit'
import { encodeFunctionData, keccak256, encodePacked } from 'viem'

const SAFE_MODULE_SETUP = '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47'
const INVITATION_MODULE = '0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5'
const SAFE_4337_MODULE  = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'

const enableModulesData = encodeFunctionData({
  abi: [{ type:'function', name:'enableModules', stateMutability:'nonpayable',
          inputs:[{ type:'address[]' }], outputs:[] }],
  functionName: 'enableModules',
  args: [[INVITATION_MODULE, SAFE_4337_MODULE]],
})

const kit = await Safe.init({
  provider: GNOSIS_RPC_URL, signer: DEPLOYER_PK,
  predictedSafe: {
    safeAccountConfig: { owners, threshold: 1,
      to: SAFE_MODULE_SETUP, data: enableModulesData, fallbackHandler: SAFE_4337_MODULE },
    safeDeploymentConfig: { safeVersion: '1.4.1', saltNonce },
  },
})
const safeAddr  = await kit.getAddress()                    // predict (NOT getSafeAddress)
const deployTx  = await kit.createSafeDeploymentTransaction() // { to, value, data }
// broadcast deployTx from DEPLOYER_PK …
```

### saltNonce design (the user flagged "just fid is bad")

Do **not** use `saltNonce = fid`. The Safe address is already a CREATE2 function of `(owners, threshold, setup)`; saltNonce is an extra disambiguator. Use a **namespaced constant** so re-running with the same owner set is idempotent and not fid-correlated:

```ts
const APP_NAMESPACE = 'farcaster-circles:onboard:v1'
const saltNonce = keccak256(encodePacked(['string'], [APP_NAMESPACE]))  // constant
```

Later (out of scope): enumerate the user's *existing* Safes, check whether any is already a valid Circles account, and let the user pick — instead of always deriving a fresh one.

### Default profile from FC context (in scope, M2/M3)

Registration always happens with an **empty digest (`bytes32(0)`)** — that is the standard path and `isHuman` becomes true regardless. The Circles **profile is a separate `NameRegistry` record set *after* registration**, so we default it from the mini-app context we already have:

- `name = ctx.user.displayName` (fallback `username`), `previewImageUrl/imageUrl = ctx.user.pfpUrl`.
- Backend builds + pins the profile JSON → gets a metadata `digest`.
- The **user's Safe** calls `NameRegistry.updateMetadataDigest(digest)` (NameRegistry address from `CirclesConfig.nameRegistryAddress` — resolve alongside the other config addresses in Risk #3; not independently verified on-chain here).

**Constraint:** that call must originate from the Safe, so it needs an owner signature/UserOp → it pairs with the **user-signs (M3)** path (batch it with/after the deploy UserOp). In pure-backend **M2** (user signs nothing) the profile stays default-blank until the user's first signed action. Profile *editing* UI is still out of scope.

### Contract address table (Gnosis Chain 100) — all confirmed to have code on-chain

| Name | Address | Notes |
|---|---|---|
| Hub v2 | `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8` | `isHuman`, `avatars`, `registerHuman`, `safeTransferFrom` |
| InvitationFarm | `0xd28b7C4f148B1F1E190840A1f7A796C5525D8902` | `claimInvite`, `inviterQuota` — **re-confirm via SDK `CirclesConfig.invitationFarmAddress`** |
| InvitationModule | `0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5` | enable on invitee Safe (mandatory) + on inviter Safe |
| Safe4337Module v0.3.0 | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | module **and** fallbackHandler; EntryPoint v0.7 |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | for M3 4337 |
| SafeModuleSetup v0.3.0 | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` | delegatecall target for `enableModules` at setup |
| FARM_DESTINATION | `0x9Eb51E6A39B3F17bB1883B80748b56170039ff1d` | where 96 CRC is sent to earn quota |
| House inviter Safe | `0xC3CCd9455b301D01d69DFB0b9Fc38Bee39829598` | confirmed Safe (proxy code) |
| ReferralsModule | `0x12105a9B291aF2ABb0591001155A75949b062CE5` | **Strategy B only — not used here** |

### File Reference Table

| File | Change |
|---|---|
| `scripts/spike-onboard.ts` | **New (M1).** End-to-end: predict → deploy → assert modules → `generateInvites` → exec 2 txs as inviter Safe → assert `isHuman`. Mirror `scripts/spike-claim.ts` style (branch logging, `required()`, gnosisscan links). |
| `lib/circles.ts` | **New.** Address constants + Gnosis `CirclesConfig` builder + `getInviteFarm()` + `inviteSafe(houseInviter, safe)` (runs generateInvites + sequential exec). Shared by script + API. |
| `lib/safe.ts` | **New.** `predictUserSafe(owners)`, `deployUserSafe(owners)`, `assertSafeReady(addr)` (modules + fallback + version). |
| `lib/neynar.ts` | **Modify.** Add `fetchVerifiedEthAddresses(fid): Promise<Address[]>` (`user.verified_addresses.eth_addresses` via `/v2/farcaster/user/bulk`). |
| `lib/env.ts` | **Modify.** Add `GNOSIS_RPC_URL`, `CIRCLES_RPC_URL`, `DEPLOYER_PK`, `INVITER_SAFE_ADDRESS`, `INVITER_OWNER_PK`, `PIMLICO_API_KEY`, `PIMLICO_SPONSORSHIP_POLICY_ID`. Drop `CIRCLES_MAGIC_LINK` requirement. |
| `app/api/onboard/route.ts` | **New (M2).** `POST`: verify Quick Auth (`lib/auth.ts`) → resolve owners → deploy → invite → poll `isHuman` → JSON result. `runtime = 'nodejs'`. |
| `components/onboard-app.tsx` | **New (M2).** One screen: connect → `eth_requestAccounts` → "Create my Circles account" → POST → result card (Safe addr, isHuman ✅, links). |
| `hooks/use-miniapp-sdk.ts` | **Modify.** Also expose the EIP-1193 provider (`sdk.wallet.getEthereumProvider()`) + `getChains()` result. |
| `app/page.tsx` | **Modify.** Render `<OnboardApp/>` instead of `<InviterApp/>`. |
| `package.json` | **Modify.** Add `@aboutcircles/sdk` (resolve exact npm name for the invitations package; pulls `@aboutcircles/sdk-types`, `@aboutcircles/sdk-utils`). Move `@safe-global/protocol-kit`, `@safe-global/relay-kit` (M3), `viem`, `ethers` from devDependencies → dependencies (used in server routes). |
| `app/api/invites/`, `app/api/candidates/`, `app/r/`, `components/inviter-app.tsx`, `components/candidate-*.tsx`, `components/invite-result-list.tsx`, `hooks/use-candidates.ts`, `hooks/use-assign-invites.ts`, `lib/kv.ts`, `lib/farcaster.ts` | **Archive/remove (out of scope, v1).** |

### Existing code to leverage
- `verifyQuickAuth(req)` — `lib/auth.ts:16`. Reuse verbatim for `/api/onboard` auth.
- `neynarFetch` + `/v2/farcaster/user/bulk` — `lib/neynar.ts:44,111`. Extend for verified addresses.
- `env` lazy-getter pattern — `lib/env.ts:7`. Follow it for new server secrets.
- `useMiniappSdk` (fid + quickAuth token + `ready()` timing) — `hooks/use-miniapp-sdk.ts`. Extend, don't rewrite.
- `scripts/spike-claim.ts` — copy its structure (viem public client, `preflight`, `assertRegistered`, gnosisscan helpers) for `spike-onboard.ts`.
- Pimlico Safe-4337 init reference — `scripts/spike-claim.ts:207` (`Safe4337Pack.init` with bundler+paymaster) for M3.

## Edge Cases
- **Invitee already registered** (`Hub.avatars(safe) != 0`): skip invite, return existing `{ safeAddress, isHuman: true }`. (Idempotent re-run.)
- **`ModuleNotEnabled` revert:** deploy didn't enable `InvitationModule` (bad setup `to`/`data`) — fail M1 loudly; assert module-enabled *before* inviting.
- **Inviter out of quota** (`getQuota == 0`): fail preflight with a clear "house inviter exhausted, request a new quota grant" message. (Quota is prepaid — see Risk #2 — so this is the only inviter-funding failure mode we expect.)
- **`claimTx` not yet mined when `transferTx` sent:** transfer reverts (no bot token). Always await `claimTx` receipt first.
- **User has no verified addresses:** owners = `[connectedAddress]` only; proceed.
- **`connectedAddress` mismatch vs auth fid:** the connected wallet is the custody/embedded wallet; trust it as an owner. (No cross-check required for the spike.)
- **Gnosis not in `sdk.getChains()`:** warn in UI but still proceed (backend does the chain work in M1/M2); only M3 hard-depends on user signing on chain 100.

## Root Cause (why prior paths failed)
- Magic-link: requires leaving Warpcast for the Circles SPA.
- Passkey claim: `ReferralsModule.claimAccount` is WebAuthn-only and the Warpcast mobile webview does not expose `navigator.credentials.create()`.
- **This spec's path avoids both:** registration is driven by the `InvitationModule` on the invitee Safe (no invitee signature, no passkey), and the user's only possible signature (M3) is a standard EIP-712 UserOp, not WebAuthn.

## Testing Pyramid

| Layer | What | Count |
|---|---|---|
| Script (M1) | `spike-onboard.ts` asserts deploy + both modules + `isHuman` against live Gnosis | 1 e2e run, ~5 assertions |
| Unit | `predictUserSafe` determinism (same owners → same addr); `enableModules` calldata equals expected bytes; owner dedupe/sort | +3 |
| Integration | `/api/onboard` with a stubbed Quick Auth token + a throwaway connected addr → returns `isHuman:true` (hits real Gnosis or a fork) | +1 |
| Manual E2E (M2) | Open in Warpcast on a phone → tap → see live account | gate #5 |
| Manual E2E (M3) | Gasless: user signs 1 UserOp, no xDAI spent | gate #6 |

Spike-grade: assertions live in the script, not a formal suite. Be honest about coverage.

## Effort Breakdown
- **M1 script:** ~6h — 2h `lib/circles.ts` + `lib/safe.ts` (config/addresses, deploy, invite-as-Safe), 1h resolve `@aboutcircles/sdk` install + CirclesConfig, 3h debug the live deploy+invite (Risk #1/#3 are where time goes).
- **M2 in-app:** ~4h — 2h `/api/onboard` (reuse auth + deploy/invite), 1h `onboard-app.tsx` + hook, 1h Warpcast device testing.
- **M3 gasless:** ~5h — Safe4337Pack/UserOp deploy + Pimlico paymaster wiring + user-sign-on-Gnosis verification.
- **Cleanup (v1 removal):** ~1h.

## Rollback Strategy
- Pure additive until `app/page.tsx` is switched; M1 is a script that touches no app code. Rollback = revert the PR.
- v1 removal is the only destructive step — do it in a **separate commit** so it can be reverted independently if the new flow regresses.
- No data migration (KV assignments from v1 are abandoned, not migrated).
- On-chain: deployed Safes + registrations are permanent; a bad spike just leaves orphan registered Safes (harmless, costs the inviter 96 CRC each — cap test runs).

## Failed Approaches (do not repeat)
- **Passkey / `ReferralsModule.claimAccount` in-app** — `navigator.credentials.create()` blocked in Warpcast mobile webview (`scripts/SPIKE-FINDINGS.md`, `CLAIM-PROBLEM.md`). Dead.
- **`@circles-sdk/sdk@0.29.2` for the invite** — has only legacy `avatar.inviteHuman` (inviter pays from own CRC, no farm/quota pooling); **no `generateInvites`**. Must add `@aboutcircles/sdk` instead.
- **`saltNonce = fid`** — user-rejected as too naive; use a namespaced constant (above).
- **Assuming the FC wallet broadcasts to Gnosis** — keep a `getChains()` guard; verify before relying on it in M3.

## Open Questions / Risks to validate (ranked)
1. **🟠 `bytes32(0)` registration of a non-Circles-deployed Safe** — registering with an empty digest is the *standard* path (profile is set separately afterward — see "Default profile from FC context"), so this is **likely fine**. The only residual unknown: a protocol-kit-deployed Safe never ran any Circles init — confirm the Hub/`InvitationModule` don't reject it. **Validate in M1** (the `isHuman` assertion catches it). Fallback if it does revert: a follow-up `NameRegistry.updateMetadataDigest` as the Safe. *(Downgraded from 🔴: the FC-profile-metadata plan resolves the "must set a digest" concern.)*
2. **🟢 Quota is prepaid — no live 96 CRC balance needed** (working model, per project knowledge + SDK read): the team's ~50-invite grant prepays the cost; `claimInvite()` mints the invite token from quota, and that token (not the inviter's personal CRC) is what the transfer spends. So the only check is `getQuota(houseInviter) > 0`, and M1's first real `generateInvites` confirms it definitively (a revert here would mean the quota wasn't actually funded — cheap to learn). Do **not** build a `personalMint`/top-up step unless M1 proves it's needed.
3. **🟠 Canonical `CirclesConfig` for chain 100** — `InviteFarm` reads `invitationFarmAddress`, `referralsModuleAddress`, `v2HubAddress`, `circlesRpcUrl` from config (not hardcoded). Resolve the production values from `@aboutcircles/sdk` chain config / Circles deployment registry; confirm `invitationFarmAddress === 0xd28b7C4f…` (we verified it has code) and what `circlesRpcUrl` should be (likely `https://rpc.aboutcircles.com`).
4. **🟠 FC wallet on Gnosis (M3)** — user says chainId 100 signing works; research (pre-2026 sources) said it might not be in the runtime chain list. Confirm via `sdk.getChains()` + a `eth_signTypedData_v4` test on chain 100 *before* building M3. Non-blocking for M1/M2.
5. **🟡 Inviter Safe threshold** — assumed 1 (single owner key signs `execTransaction`). If `0xC3CC…9598` threshold > 1, M1 needs multiple signatures or a pre-authorized module path.
6. **🟡 `@aboutcircles/sdk` exact npm package name + version** — repo's GitHub path is `packages/invitations`; resolve the published scope (`@aboutcircles/sdk` vs `@aboutcircles/invitations`) and whether it ships ESM compatible with Next 16 / Node runtime.
7. **🟡 ESM/server-bundling** — `@safe-global/*` + `@aboutcircles/sdk` in a Next.js `nodejs` route; watch for `next.config.mjs` `serverExternalPackages` needs.

---
*This spec is the durable artifact. If implementation gets messy, update this file and rerun clean. Before implementing: `/clear` to start with fresh context containing only this spec.*

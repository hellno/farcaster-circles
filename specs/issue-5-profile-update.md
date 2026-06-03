# Issue #5 (remaining) — Editable Circles profile: update name + bio + avatar

Status: spec'd via `/spec` (2026-06-02), decisions confirmed with the owner. Completes the
deferred scope of GitHub issue #5. Pairs with the issue-#6 Manage state
(`specs/issue-6-returning-user.md`, D5 + NOT-in-scope), which shipped "already set / never
Update" and now gets its Edit affordance.

## Context

Issue #5 v1 (set name + avatar once, post-onboard) is **already shipped on main**:
`lib/circles/profile.ts` ("Mechanism A (issue #5)"), `app/api/profile/route.ts`
(`prepare` + `relay`), the "Set your Circles profile" action in
`components/onboard-app.tsx`, and tests (`test/profile.test.ts`,
`test/profile-route.test.ts`). It is **one-shot and Farcaster-derived**: `prepare`
short-circuits with `alreadySet` once a digest exists (`route.ts:97-100`), and the profile
is built entirely from the fid's Farcaster identity — the user can't change anything.

What's missing (this spec): let a returning user **come back and edit** their Circles
profile — change the **name** and **bio** — overwriting what's on-chain. (The **avatar**
isn't separately editable; it refreshes from the current Farcaster pfp whenever a save
happens.) Manual only.

## Goal

From inside the app (both the post-onboard done screen and the issue-#6 **Manage** state), a
user with an already-set profile can open an **edit form pre-filled with their currently
saved profile**, change their name/bio, and save — overwriting the on-chain metadata via the
same gas-free "user signs once, operator relays" mechanism. **Save is only possible when
something actually changed.** No auto re-sync, no short name in this spec.

Single deliverable (one PR). No P1/P2 split. Short name and auto re-sync are explicitly
**future work** (see below).

## Locked decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Trigger | **Manual, user-initiated only** (no auto re-sync) | Auto re-sync needs a trigger/cron we don't have; rejected as too complex. |
| D2 | Editable fields | **name + bio.** Avatar refreshes from the current Farcaster pfp (read-only, no upload). | Bio is just `Profile.description`. Custom avatar upload = file picker + storage, out of scope now. |
| D3 | Prefill (read-back) | **Read back the saved profile and pre-fill the form with it.** Priority per field: saved value → Farcaster default → empty. | Avoids the overwrite footgun: without read-back, a partial edit would silently revert a previously customized name back to the Farcaster default. |
| D4 | Farcaster bio default | **Pull the Farcaster bio in as the default** when there's no saved bio. | Gives a useful starting point on first edit / first set. Requires surfacing `bio` on the Farcaster card. |
| D5 | Overwrite | **`prepare` drops the `alreadySet` short-circuit** when an explicit edit intent (`overwrite:true`) is present. | Overwriting the set digest is the whole point. |
| D6 | "Nothing changed" guard | **REQUIRED, two layers.** UI: Save is disabled until name/bio differ from the saved baseline. Backend: `prepare` rebuilds → computes digest → if it equals the current on-chain digest, returns `noChange` (no signature, no tx). | Owner: "if nothing changed the user shouldn't be able to save." Never spend operator gas on a no-op. |
| D7 | Mechanism | **Reuse Mechanism A** (user signs one EIP-712 Safe tx via `sdk.provider`; operator relays `execTransaction`). | Already built + tested; the metadata write is the same `updateMetadataDigest`. |
| D8 | Placement | **Both** the post-onboard done screen and the #6 Manage state; replace the static "already set" panel with an **"Edit profile"** entry. | #6 D5 / NOT-in-scope: Manage gets its Edit affordance. |
| D9 | Failure isolation | Post-onboard, optional, fully isolated from `/api/onboard` (never touches the onboard `phase`/`result`). | Matches the existing profile action. |

## Module changes

### `lib/farcaster/neynar.ts` — surface the Farcaster bio (D4, required)
`FarcasterCard` is `{ username, displayName, pfpUrl }` (type lives HERE, not `lib/types.ts`).
Add `bio?: string` and populate it in `fetchFarcasterCard` from the Neynar user
`profile.bio.text` (the keyless-hub fallback has no bio → leave undefined). Additive; existing
callers ignore it.

### `lib/circles/profile.ts` — edited fields, read-back, digest→CID
- `export const MAX_PROFILE_DESCRIPTION = 256;` (clamp, do NOT reject — mirrors how
  `MAX_PROFILE_NAME` clamps in `circlesProfileName`).
- Extend `buildCirclesProfile(card, overrides?)` to accept `{ name?: string; description?:
  string }` (clamp-not-reject):
  - `name = (override.name?.trim() || circlesProfileName(card))`, clamped to
    `MAX_PROFILE_NAME`. Return `null` only when there's no usable name (same as today).
  - `const d = override.description?.trim(); if (d) profile.description =
    d.slice(0, MAX_PROFILE_DESCRIPTION)`. Whitespace-only/empty → omit `description`.
  - Avatar still `makeAvatarThumbnail(card.pfpUrl)` (unchanged).
- **`digestToCidV0(digest: 0x${string}): string`** — reverse of `cidV0ToDigest`: prepend the
  `0x12 0x20` multihash prefix to the 32 bytes and **base58btc-encode** (add a `base58Encode`
  companion to the existing `base58Decode`; reuse `BASE58_ALPHABET`). Round-trips with
  `cidV0ToDigest` (assert in tests).
- **`fetchSavedProfile(safe: Address): Promise<Profile | null>`** — read the current digest
  (`readMetadataDigest`); if unset (`!isDigestSet`) return `null`; else `digestToCidV0` →
  `GET ${profileServiceUrl}get?cid=<cid>` (the upload uses POST `…/pin`; **verify the GET
  path** against the profile service — `get?cid=` is the expected shape; fall back to an IPFS
  gateway by CID if needed) → parse `{ name, description? }`. Best-effort: any failure returns
  `null` (caller falls back to Farcaster prefill).

### `app/api/profile/route.ts` — overwrite-aware prepare + read endpoint + no-op guard
- Extend the `prepare` body (zod only loose-guards length; the builder clamps the display caps):
  ```ts
  z.object({
    step: z.literal("prepare"),
    safeAddress: addr,
    name: z.string().max(4000).optional(),        // builder clamps to MAX_PROFILE_NAME
    description: z.string().max(8000).optional(),  // builder clamps to MAX_PROFILE_DESCRIPTION
    overwrite: z.boolean().optional(),
  })
  ```
- Behavior when `overwrite === true` (the edit form always sends it):
  - SKIP the `isDigestSet` short-circuit (lines 97-100).
  - Build via `buildCirclesProfile(card, { name, description })`. Empty/omitted `name` →
    falls back to the Farcaster-derived name; if that's also null → `no_profile` (422).
  - **No-op guard (D6):** upload, `digest = cidV0ToDigest(cid)`, then compare to the current
    on-chain digest (`readMetadataDigest(safe)`). If **equal**, return a `noChange` response
    and DO NOT return typed data (no signature prompt, no tx). Else return
    `ProfilePrepareNeedsSignature` (schema below). Note: the profile is pinned BEFORE the
    compare; an identical doc re-pins to the same CID (idempotent, no gas), so an upload on a
    no-op is acceptable — and the client's Save-disable means this path rarely fires anyway.
- **Legacy path unchanged:** `prepare` with NO `overwrite` keeps today's behavior (first-time
  set; still short-circuits on `alreadySet`).
- **New read step for prefill (D3):** add `{ step: "current", safeAddress }` →
  `fetchSavedProfile(safe)` → `{ name: string|null, description: string|null }` (both null
  when unset/unreadable). Used by the client to pre-fill. (Alternatively expose it as a GET;
  keep it on this route as a `step` for consistency with prepare/relay.)
- `relay` step **unchanged**.
- Preserve the `ProfileErrorCode` set + `STATUS` map.

Exact prepare responses:
```ts
// ProfilePrepareResponse =
//   | { alreadySet: true }                         // legacy first-time path only
//   | { noChange: true }                           // overwrite path, nothing changed (D6)
//   | { alreadySet: false;                         // overwrite path, has changes
//       name: string;
//       description?: string;
//       hasImage: boolean;
//       hasBio: boolean;                           // Boolean(description)
//       digest: `0x${string}`;
//       typedData: ProfileTypedData; }
// "current" step response:
//   | { name: string | null; description: string | null }
```

### `lib/types.ts`
- Add `description?: string` + `hasBio: boolean` to `ProfilePrepareNeedsSignature`; add a
  `ProfilePrepareNoChange = { noChange: true }` variant to `ProfilePrepareResponse`.
- Add the optional `name`/`description`/`overwrite` to the prepare request type, the new
  `current` request/response types.

### `components/onboard-app.tsx` — the edit form
- **`ProfilePhase`**: add `editing`; the save round-trip reuses `preparing → signing →
  relaying → done | error`. Transitions: open form `* → editing`; Save `editing → preparing →
  signing → relaying → done`; Cancel `editing → done` (no network); error `→ error`, retry
  returns to `editing` with entered values preserved.
- **Open Edit → prefill (D3/D4):** on opening, `POST { step:"current", safeAddress }` to read
  the saved profile. Pre-fill each field by priority: **saved value → Farcaster default →
  empty**. Name default = `sdk.user.displayName || username`; bio default = the Farcaster bio
  (D4); avatar preview = `sdk.user.pfpUrl` (read-only). The **saved values become the
  baseline** for the changed-check. If the `current` read fails, fall back to Farcaster
  prefill and show a subtle note ("couldn't load your saved profile — saving will set it from
  your Farcaster identity") so the user isn't surprised by an overwrite. Because the form is
  only opened for an **already-set** profile (Manage/done state), a `current` response with
  `name:null` means the read FAILED (not "no profile") → trigger this fallback + note.
- **Save gating (D6):** Save is **disabled** while the trimmed name+bio equal the **baseline**
  — where baseline = whatever pre-filled the form (the saved values when read-back succeeded,
  else the Farcaster fallback values). (Known v1 limitation: a pure avatar refresh — pfp
  changed but name/bio identical — isn't a distinct action; the backend `noChange` guard is
  the authoritative catch.)
- **Save handler:** `POST { step:"prepare", safeAddress, name, description, overwrite:true }`
  → on `noChange` show "Nothing changed" and return to the summary (no signature) →
  else `eth_signTypedData_v4` (reuse the signing block in `handleSetProfile`, lines ~433-510,
  reusing `result.safeAddress` / `lastConnectedAddress`) → `POST { step:"relay", ... }` →
  success "Profile updated ✓" with the gnosisscan tx link (reuse the existing done panel).
- **Placement (D8):** replace the static "already set" panel (done screen
  `profilePhase==="alreadySet"|"done"` and the #6 `manageAlreadySet`) with an **"Edit
  profile"** button that opens the form. Keep "Set your Circles profile" for the
  unset/first-time case (unchanged). The #6 Manage flags are on `main` (PR #7) — **branch off
  `main`**.
- Keep the handler dumb (branch via flags). Failure-isolated from onboarding.
- **Exact copy:** button "Edit profile"; success "Profile updated ✓"; no-op "Nothing
  changed"; errors reuse the existing `profileMsg` + "Tap to retry." Reuse existing panel
  styling; no new design work.

## Test plan

`test/profile.test.ts` (extend):
- `buildCirclesProfile` overrides: name override wins; description clamped to
  `MAX_PROFILE_DESCRIPTION`; whitespace-only description omitted; no-name → null.
- `digestToCidV0` round-trips with `cidV0ToDigest` (encode→decode and a known live CID).

`test/profile-route.test.ts` (extend; mock the boundaries like today):
- **overwrite path, changed:** `prepare overwrite:true` on a set Safe where the rebuilt digest
  DIFFERS from current → does NOT return `alreadySet`/`noChange`; uploads + returns typedData
  built from the submitted `name`/`description` (+ `hasBio`).
- **overwrite path, unchanged (D6):** rebuilt digest EQUALS current → `{ noChange:true }`, no
  typedData, `relayProfileTx`/`prepareProfileTx` not called.
- **legacy path unchanged:** `prepare` with no `overwrite` on a set digest → `alreadySet`.
- **name fallback:** `overwrite:true` with no `name` → uses Farcaster-derived name; none
  anywhere → `no_profile` (422).
- **clamp-not-reject:** over-long description → 200, clamped in the built profile (not 400).
- **`current` step:** set Safe → returns `{ name, description }` from `fetchSavedProfile`;
  unset/unreadable → `{ name:null, description:null }`.

E2E / `/qa` (manual, matching #6's D6 posture): returning user → Manage → **Edit profile**
(form shows saved name/bio) → change bio → Save → sign → "Profile updated ✓" + tx link → the
new bio renders on `https://app.gnosis.io/p/<safe>`. Re-open Edit → it shows the **new** saved
values (read-back). Open with nothing changed → Save is disabled.

## Failure modes

| Codepath | Failure | Handling | User sees |
|---|---|---|---|
| `current` read-back | profile service down / parse fails | best-effort → `null`, fall back to Farcaster prefill + subtle note | form pre-filled from Farcaster, with a heads-up note |
| `prepare` overwrite | upload fails | `upload_failed` (existing) | "couldn't save your profile right now" |
| no-op (D6) | nothing changed | `noChange`, no signature/tx | "Nothing changed" (Save was disabled anyway) |
| signature | user rejects | local `profilePhase=error` (isolated) | "tap to retry" (entered values kept) |
| `relay` | execTransaction reverts / digest didn't stick | `relay_failed` (existing) | "couldn't set your profile on-chain — retry" |

## Future work (deferred, NOT this spec)

- **Short name** (Circles `registerShortName`): a separate on-chain registration
  (`CrcV2_RegisterShortName`), not in our ABI or the bundled SDK. Deferred because of real
  unknowns — confirm before building: (1) exact `registerShortName` interface (caller-chosen
  vs assigned; nonce variant?), (2) format + collision rules and how "taken" surfaces,
  (3) preconditions, (4) mutability (changeable vs permanent). If collisions/format prove
  fiddly, stays deferred.
- **Auto re-sync** when the Farcaster profile later changes (needs a trigger/cron).

## NOT in scope

- **Custom avatar upload / image storage** — avatar stays the Farcaster pfp (read-only).
- **Short name** and **auto re-sync** (see Future work).
- **Profile `location` / `geoLocation` / `extensions`** fields.
- **Changing the onboard flow** — post-onboard, failure-isolated action only.

## Implementation tasks

Branch off `main` (the #6 Manage state is merged there). Sequence: T1 → T2 → T3 → T4 (one PR).

- [ ] **T1** `lib/farcaster/neynar.ts` — add `bio?` to `FarcasterCard` + populate from Neynar
  `profile.bio.text` (D4). Files: `lib/farcaster/neynar.ts`.
- [ ] **T2** `lib/circles/profile.ts` — `MAX_PROFILE_DESCRIPTION`,
  `buildCirclesProfile(card, overrides?)`, `base58Encode` + `digestToCidV0`,
  `fetchSavedProfile`. Files: `profile.ts`, `test/profile.test.ts`.
- [ ] **T3** `app/api/profile/route.ts` — overwrite-aware `prepare` (edited fields, name
  fallback, **no-op `noChange` guard**), new `current` read step, response/request types.
  Files: `route.ts`, `lib/types.ts`, `test/profile-route.test.ts`.
- [ ] **T4** `components/onboard-app.tsx` — Edit-profile form: read-back prefill (saved →
  Farcaster → empty), Save disabled until changed, no-op handling, replaces the "already set"
  panels (done screen + #6 Manage), wired to T3. Files: `onboard-app.tsx`. Verify: `/qa`.

## Files reference

| File | Change |
|------|--------|
| `lib/farcaster/neynar.ts` | `FarcasterCard.bio` + fetch it |
| `lib/circles/profile.ts` | `buildCirclesProfile` overrides + `MAX_PROFILE_DESCRIPTION` + `base58Encode`/`digestToCidV0` + `fetchSavedProfile` |
| `app/api/profile/route.ts` | overwrite-aware `prepare` + `noChange` guard + `current` read step |
| `lib/types.ts` | prepare req (`name`/`description`/`overwrite`) + resp (`description`/`hasBio`/`noChange`) + `current` types |
| `components/onboard-app.tsx` | Edit-profile form; read-back prefill; Save-when-changed; replace "already set" panels |

## Related
- Issue #5 (parent) — v1 shipped; this is its deferred scope.
- `specs/issue-6-returning-user.md` — Manage state (D5) that surfaces "Edit profile".
- `specs/circles-self-onboard.md` — original spike spec.

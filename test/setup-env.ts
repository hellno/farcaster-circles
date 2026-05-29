// Runs before any test module is imported (vitest setupFiles).
process.env.NEYNAR_API_KEY ??= "test-neynar-key";
process.env.FARCASTER_DOMAIN ??= "test.example.com";
process.env.DEPLOYER_PK ??=
  "0x0000000000000000000000000000000000000000000000000000000000000001";
// INVITER_SAFE_ADDRESS intentionally left UNSET so config.test.ts asserts the
// DEFAULT-equality branch (HOUSE_INVITER === env.INVITER_SAFE_ADDRESS default).
// (Optionally set it to assert override-equality; default is enough for the guard.)

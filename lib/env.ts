function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get NEYNAR_API_KEY(): string {
    return requireEnv("NEYNAR_API_KEY");
  },
  get FARCASTER_DOMAIN(): string {
    return requireEnv("FARCASTER_DOMAIN");
  },
  get KV_REST_API_URL(): string {
    return requireEnv("KV_REST_API_URL");
  },
  get KV_REST_API_TOKEN(): string {
    return requireEnv("KV_REST_API_TOKEN");
  },
  get CIRCLES_MAGIC_LINK(): string {
    const v = requireEnv("CIRCLES_MAGIC_LINK");
    if (!/^https:\/\/circles\.gnosis\.io\/invitation\/.+$/.test(v)) {
      throw new Error(
        `CIRCLES_MAGIC_LINK must be a https://circles.gnosis.io/invitation/... URL`,
      );
    }
    return v;
  },
  get KV_URL(): string | undefined {
    return process.env.KV_URL;
  },
  // Public, accessed both server- and client-side and at build time via
  // generateMetadata / OG images. Default to empty string so module load
  // never throws; downstream code must handle the empty case.
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "",
};

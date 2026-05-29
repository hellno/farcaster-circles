/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@aboutcircles/sdk-invitations",
    "@aboutcircles/sdk-types",
    "@aboutcircles/sdk-utils",
    "@aboutcircles/sdk-rpc",
    "@aboutcircles/sdk-core",
    "@aboutcircles/sdk-transfers",
    "@aboutcircles/sdk-abis",
    "@safe-global/protocol-kit",
    "@safe-global/relay-kit",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "imagedelivery.net" },
      { protocol: "https", hostname: "i.imgur.com" },
      { protocol: "https", hostname: "**.warpcast.com" },
      { protocol: "https", hostname: "**.farcaster.xyz" },
      { protocol: "https", hostname: "**.neynar.com" },
      { protocol: "https", hostname: "ipfs.decentralized-content.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/.well-known/farcaster.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Content-Type", value: "application/json" },
        ],
      },
    ];
  },
};

export default nextConfig;

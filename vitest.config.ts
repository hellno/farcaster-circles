import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-env.ts"],
  },
  resolve: {
    alias: {
      // mirror tsconfig path alias @/* -> ./*
      "@": new URL(".", import.meta.url).pathname,
      // `server-only` is a Next bundler guard, not a resolvable npm package;
      // stub it to a no-op so server modules load under the node test env.
      "server-only": new URL(
        "./test/stubs/server-only.ts",
        import.meta.url,
      ).pathname,
    },
  },
});

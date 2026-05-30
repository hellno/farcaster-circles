// No-op stub for the `server-only` package under the vitest node env.
//
// `server-only` is a Next.js build-time guard that throws if a module is pulled
// into a CLIENT bundle. It is provided by Next's bundler, not as a resolvable
// npm package, so vitest's vite resolver can't find it. In a Node test runner
// there is no client bundle to protect, so importing it is a harmless no-op.
// vitest.config.ts aliases `server-only` -> this file.
export {};

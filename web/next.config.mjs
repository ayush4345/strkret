/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Traces only what this app actually needs out of the pnpm workspace, so
  // the deployed image doesn't have to ship the whole monorepo's
  // node_modules (including devnet/testing-only deps that pull in `fs`,
  // `net`, `child_process`, and are excluded from the client bundle for the
  // same reason — see web/lib's comments).
  output: "standalone",
  // Traces the pnpm workspace root, not just web/ — the standalone build
  // otherwise misses the workspace: dependencies symlinked from ../packages
  // and ../agents.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
};

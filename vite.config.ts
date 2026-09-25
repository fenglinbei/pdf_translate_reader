import { realpathSync } from 'node:fs';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error devCert.mjs is a build-time script without type declarations.
import { generateSelfSignedCert } from "./scripts/devCert.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? "http://localhost:8787";
  const qaTarget = process.env.VITE_QA_API_PROXY_TARGET ?? env.VITE_QA_API_PROXY_TARGET;

  return {
    plugins: [react()],
    server: {
      // Linked development worktrees may resolve KaTeX fonts outside their root.
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(new URL('./node_modules/katex/dist/fonts', import.meta.url))] },
      https: generateSelfSignedCert(),
      port: 5173,
      proxy: {
        ...(qaTarget ? { "/api/qa/": { target: qaTarget, changeOrigin: true } } : {}),
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});

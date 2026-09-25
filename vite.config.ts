import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error devCert.mjs is a build-time script without type declarations.
import { generateSelfSignedCert } from "./scripts/devCert.mjs";

const licenseNotices: Plugin = {
  name: "project-license-notices",
  apply: "build",
  generateBundle() {
    for (const fileName of ["LICENSE", "NOTICE"]) {
      this.emitFile({
        type: "asset",
        fileName,
        source: readFileSync(new URL(`./${fileName}`, import.meta.url)),
      });
    }
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? "http://localhost:8787";
  const qaTarget = process.env.VITE_QA_API_PROXY_TARGET ?? env.VITE_QA_API_PROXY_TARGET;

  return {
    plugins: [react(), licenseNotices],
    server: {
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

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error devCert.mjs is a build-time script without type declarations.
import { generateSelfSignedCert } from "./scripts/devCert.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? "http://localhost:8787";

  return {
    plugins: [react()],
    server: {
      https: generateSelfSignedCert(),
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});

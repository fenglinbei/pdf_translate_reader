import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_VITE_KEYS = new Set([
  "VITE_API_BASE_URL",
  "VITE_API_PROXY_TARGET",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_URL",
]);
const TRANSLATION_PROVIDER_KEYS = [
  "DEEPSEEK_API_KEY",
  "GLM_API_KEY",
  "KIMI_API_KEY",
];
const envFile = process.argv[2];

if (!envFile) {
  throw new Error("Usage: node scripts/build-frontend-with-env.mjs <env-file>");
}

const resolvedEnvFile = resolve(envFile);
const parsedEnvironment = dotenv.parse(readFileSync(resolvedEnvFile, "utf8"));

if (!TRANSLATION_PROVIDER_KEYS.some((key) => isConfiguredValue(parsedEnvironment[key]))) {
  throw new Error(
    `${resolvedEnvFile} must contain at least one configured DEEPSEEK_API_KEY, GLM_API_KEY, or KIMI_API_KEY.`,
  );
}

for (const key of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
  if (!isConfiguredValue(parsedEnvironment[key])) {
    throw new Error(`${resolvedEnvFile} must contain a configured ${key} value.`);
  }
}

const viteEnvironment = Object.fromEntries(
  Object.entries(parsedEnvironment).filter(([key]) => PUBLIC_VITE_KEYS.has(key)),
);
const buildEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => (
    !key.startsWith("VITE_") || PUBLIC_VITE_KEYS.has(key)
  )),
);

process.stdout.write(
  `[pdf-translate-reader] Loading ${Object.keys(viteEnvironment).length} approved public VITE_* values from ${resolvedEnvFile}\n`,
);

const buildResult = spawnSync("npm", ["run", "build"], {
  cwd: APP_DIR,
  env: {
    ...buildEnvironment,
    ...viteEnvironment,
  },
  stdio: "inherit",
});

if (buildResult.error) {
  throw buildResult.error;
}

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

function isConfiguredValue(value) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";

  return Boolean(
    normalizedValue &&
    !normalizedValue.startsWith("replace_with_") &&
    !normalizedValue.includes("your-project.supabase.co"),
  );
}

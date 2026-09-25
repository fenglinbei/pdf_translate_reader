#!/usr/bin/env node
// Preflight for the QA test environment.
//
// The failure modes this catches are the ones that produce confusing symptoms
// rather than clear errors: a frontend signed into one project while the QA
// service validates against another (every request 401s), or the anon and
// service_role keys pasted into each other's slot. The second one is worse than
// it looks - a service_role key in a VITE_ variable is compiled into the browser
// bundle, and that key bypasses every RLS policy in the project.
//
//   npm run check:qa-env
import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const ENV_FILE = process.env.QA_ENV_FILE ?? ".env.qa.local";
const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEEPSEEK_API_KEY",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
];

try {
  readFileSync(ENV_FILE);
} catch {
  console.error(`Cannot read ${ENV_FILE}. Copy .env.qa.example to it first.`);
  process.exit(2);
}
loadDotenv({ path: ENV_FILE, override: true });
if (!['document-tools-v1', 'workspace-tools-v1', 'workspace-artifacts-v1'].includes(process.env.QA_AGENT_RUNTIME)) REQUIRED.push('VOYAGE_API_KEY');

function roleOf(value) {
  if (!value) return null;
  try {
    // Legacy Supabase keys are JWTs carrying a role claim; the newer
    // sb_publishable_ / sb_secret_ keys are opaque and yield null here.
    return JSON.parse(Buffer.from(String(value).split(".")[1], "base64url")).role ?? "no-role-claim";
  } catch {
    return null;
  }
}

const findings = [];
const bad = (key, message) => findings.push({ level: "BAD", key, message });

for (const key of REQUIRED) {
  if (!process.env[key]) findings.push({ level: "MISSING", key, message: "为空" });
}
if (process.env.SUPABASE_URL && !process.env.SUPABASE_URL.startsWith("https://")) {
  bad("SUPABASE_URL", "必须以 https:// 开头");
}
if (process.env.SUPABASE_URL !== process.env.VITE_SUPABASE_URL) {
  bad("URL 配对", "SUPABASE_URL 与 VITE_SUPABASE_URL 不一致 -> 前端与 QA 服务会全部 401");
}
if (process.env.SUPABASE_ANON_KEY !== process.env.VITE_SUPABASE_ANON_KEY) {
  bad("ANON 配对", "SUPABASE_ANON_KEY 与 VITE_SUPABASE_ANON_KEY 不一致 -> 会 401");
}

const anonRole = roleOf(process.env.SUPABASE_ANON_KEY);
const serviceRole = roleOf(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (anonRole && anonRole !== "anon") bad("SUPABASE_ANON_KEY", `角色是 "${anonRole}"，应为 anon（两个 key 填反了？）`);
if (serviceRole && serviceRole !== "service_role") bad("SUPABASE_SERVICE_ROLE_KEY", `角色是 "${serviceRole}"，应为 service_role（两个 key 填反了？）`);
if (roleOf(process.env.VITE_SUPABASE_ANON_KEY) === "service_role") {
  findings.push({
    level: "FATAL",
    key: "VITE_SUPABASE_ANON_KEY",
    message: "填成了 service_role！它会被打包进浏览器并绕过所有 RLS，立刻换掉",
  });
}
if (!anonRole && process.env.SUPABASE_ANON_KEY) {
  findings.push({
    level: "NOTE",
    key: "SUPABASE_ANON_KEY",
    message: "解析不出 JWT 角色（sb_publishable_ 新格式？）。可运行，但仓库锁定的 supabase-js 2.49.8 早于该格式",
  });
}

for (const { level, key, message } of findings) {
  console.log(`  ${level.padEnd(8)} ${key.padEnd(28)} ${message}`);
}
const blocking = findings.filter(({ level }) => level === "BAD" || level === "FATAL" || level === "MISSING");
if (blocking.length === 0) {
  console.log(`  ${ENV_FILE} 检查通过：${REQUIRED.length} 个必要配置已填，两对值与角色归属都正确。`);
  process.exit(0);
}
console.error(`\n${blocking.length} 项需要修正后再启动。`);
process.exit(1);

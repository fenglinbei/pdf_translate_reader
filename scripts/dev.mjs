import { spawn } from "node:child_process";

const processes = [];

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  processes.push(child);

  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }

    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

function shutdown(code = 0) {
  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", "node", ["server/index.mjs"], { PORT: process.env.PORT ?? "8787" });
start("web", "vite", ["--host", "0.0.0.0"]);

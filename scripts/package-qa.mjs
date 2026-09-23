import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { checkRelease } from "./check-release.mjs";

const { qa: version } = checkRelease();
const paths = ["server", "shared", "package.json", "package-lock.json", ".nvmrc"];
// Package committed input only; don't accidentally include credentials, PDFs,
// developer output, or unrelated working-tree documentation.
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...paths], { stdio: "pipe" });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const destination = resolve(process.argv[2] ?? "artifacts");
mkdirSync(destination, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "qa-package-"));
try {
  const archive = join(temp, "source.tar");
  const source = join(temp, "source");
  mkdirSync(source);
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD", ...paths]);
  execFileSync("tar", ["-xf", archive, "-C", source]);
  writeFileSync(join(source, "qa-release.json"), JSON.stringify({ service: "pdf-reader-qa", version, sha }, null, 2) + "\n");
  const name = `qa-${version}-${sha}.tar.gz`;
  const output = join(destination, name);
  execFileSync("tar", ["-czf", output, "-C", source, "."]);
  const checksum = createHash("sha256").update(readFileSync(output)).digest("hex");
  writeFileSync(`${output}.sha256`, `${checksum}  ${name}\n`);
  console.log(output);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

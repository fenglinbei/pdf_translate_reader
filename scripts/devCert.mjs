// Generates a self-signed TLS certificate for the Vite dev server using
// openssl (available on virtually all dev machines). This makes browser-only
// APIs that require a secure context — notably crypto.subtle (SHA-256 file
// fingerprinting) — work when accessing the dev server via an IP address or
// hostname other than plain localhost.
//
// The cert is generated fresh on every dev server start and not persisted.
// Browsers show a "not secure" warning that you accept once per session.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached = undefined;

export function generateSelfSignedCert() {
  if (cached) {
    return cached;
  }

  // Persist to a temp path so the same cert is reused across HMR restarts
  // within a session (avoids re-accepting the browser warning every reload).
  const certPath = join(tmpdir(), "pdf-translate-reader-dev.cert.pem");
  const keyPath = join(tmpdir(), "pdf-translate-reader-dev.key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    try {
      execSync(
        [
          "openssl req -x509 -newkey rsa:2048",
          `-keyout "${keyPath}"`,
          `-out "${certPath}"`,
          "-days 365 -nodes",
          '-subj "/CN=localhost"',
          '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
        ].join(" "),
        { stdio: "ignore", timeout: 5000 },
      );
    } catch {
      // openssl not available — return undefined so Vite stays on plain HTTP.
      // Access via http://localhost (still a secure context per the spec).
      return undefined;
    }
  }

  try {
    cached = {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  } catch {
    return undefined;
  }

  return cached;
}

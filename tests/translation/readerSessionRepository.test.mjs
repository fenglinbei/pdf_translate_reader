import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let repository;
let vite;

const values = new Map();
const localStorage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
};

before(async () => {
  globalThis.window = { localStorage };
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  repository = await vite.ssrLoadModule("/src/app/readerSessionRepository.ts");
});

after(async () => {
  await vite?.close();
  delete globalThis.window;
});

test("free-translation rendering preference is user-scoped and preserves false", () => {
  repository.updateReaderSession("user-rendered", {
    freeTranslationResultRendered: false,
  });

  assert.equal(
    repository.getReaderSession("user-rendered")?.freeTranslationResultRendered,
    false,
  );
  assert.equal(repository.getReaderSession("another-user"), undefined);
});

test("invalid rendering preferences are ignored for backward compatibility", () => {
  localStorage.setItem(
    "pdf-translate-reader-session-v1",
    JSON.stringify({
      freeTranslationResultRendered: "false",
      updatedAt: 123,
      userId: "legacy-user",
    }),
  );

  assert.equal(
    repository.getReaderSession("legacy-user")?.freeTranslationResultRendered,
    undefined,
  );
});

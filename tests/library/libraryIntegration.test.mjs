import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const readerShell = await readFile(
  new URL("../../src/app/ReaderShell.tsx", import.meta.url),
  "utf8",
);
const workbench = await readFile(
  new URL("../../src/library/LibraryWorkbench.tsx", import.meta.url),
  "utf8",
);
const workbenchCss = await readFile(
  new URL("../../src/library/libraryWorkbench.css", import.meta.url),
  "utf8",
);
const importDropzone = await readFile(
  new URL("../../src/pdf/PdfImportDropzone.tsx", import.meta.url),
  "utf8",
);

describe("literature library integration", () => {
  it("uses a shared activation token so stale imports and opens cannot win", () => {
    assert.match(
      readerShell,
      /const documentActivationRequestIdRef = useRef\(0\)/,
    );
    assert.match(
      readerShell,
      /handleImport[\s\S]+?activationRequestId === documentActivationRequestIdRef\.current/,
    );
    assert.match(
      readerShell,
      /handleOpenHistory[\s\S]+?activationRequestId !== documentActivationRequestIdRef\.current/,
    );
    assert.match(
      readerShell,
      /hydrateCloudDocumentState[\s\S]+?activeHydrationRequestIdRef\.current !== activationRequestId/,
    );
  });

  it("isolates the mounted reader and restores focus when the workbench closes", () => {
    assert.match(readerShell, /workspace\.setAttribute\("inert", ""\)/);
    assert.match(readerShell, /aria-hidden=\{isLibraryWorkbenchOpen\}/);
    assert.match(
      readerShell,
      /libraryWorkbenchTriggerRef\.current\?\.focus\(\)/,
    );
    assert.match(
      readerShell,
      /!isLibraryWorkbenchOpen && currentEntry \? renderMobileReaderSideDock\(\)/,
    );
  });

  it("keeps metadata editing keyboard reachable", () => {
    assert.match(workbench, /tabIndex=\{0\}/);
    assert.match(workbench, /aria-label=\{t\("library\.metadata"\)\}/);
    assert.match(workbench, /ref=\{inspectorRef\}/);
    assert.match(workbench, /searchInputRef\.current\?\.focus\(\)/);
    assert.match(workbench, /workbenchRef\.current\?\.focus\(\)/);
  });

  it("keeps compact import and year filters usable on narrow screens", () => {
    assert.match(workbenchCss, /\.pdf-dropzone--compact \.pdf-dropzone-trigger span/);
    assert.doesNotMatch(workbenchCss, /\.pdf-import-copy/);
    assert.doesNotMatch(
      workbenchCss,
      /@media \(max-width: 920px\)[\s\S]+?\.library-workbench__year-filter \{\s*display: none;/,
    );
    assert.match(
      workbenchCss,
      /@media \(max-width: 920px\)[\s\S]+?\.library-workbench__sidebar \{[\s\S]+?visibility: hidden;/,
    );
    assert.match(
      importDropzone,
      /Promise\.resolve\(onImport\(pdfFile\)\)\.catch/,
    );
  });
});

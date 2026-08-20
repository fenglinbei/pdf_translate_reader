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
const workspaceContainer = await readFile(
  new URL("../../src/library/LibraryWorkspaceContainer.tsx", import.meta.url),
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
      workbenchCss,
      /@media \(max-width: 920px\)[\s\S]+?\.library-workbench__sidebar-notice \{\s*display: flex;/,
    );
    assert.match(
      workbench,
      /className="library-workbench__notice library-workbench__notice--error library-workbench__sidebar-notice"[\s\S]+?role="alert"/,
    );
    assert.match(
      workbench,
      /\{mutationError \|\| error \? \([\s\S]+?\{mutationError \? \([\s\S]+?library\.retry/,
    );
    assert.match(
      workbench,
      /\{mutationError && !isSidebarOpen \? \(/,
    );
    assert.match(
      importDropzone,
      /Promise\.resolve\(onImport\(pdfFile\)\)\.catch/,
    );
  });

  it("wires collection and tag editing and deletion through the workspace", () => {
    for (const callback of [
      "onUpdateCollection",
      "onDeleteCollection",
      "onUpdateTag",
      "onDeleteTag",
    ]) {
      assert.match(workbench, new RegExp(`${callback}:`));
      assert.match(workspaceContainer, new RegExp(`${callback}=\\{handle`));
    }

    for (const repositoryMutation of [
      "updateLibraryCollection",
      "deleteLibraryCollection",
      "updateLibraryTag",
      "deleteLibraryTag",
    ]) {
      assert.match(workspaceContainer, new RegExp(repositoryMutation));
    }

    assert.match(
      workbench,
      /handleSaveCollection[\s\S]+?await onUpdateCollection\(collectionEditor\.collectionId/,
    );
    assert.match(
      workbench,
      /handleDeleteCollection[\s\S]+?deleteCollectionConfirm[\s\S]+?await onDeleteCollection\(collection\)/,
    );
    assert.match(
      workbench,
      /handleSaveTag[\s\S]+?await onUpdateTag\(tagEditor\.tagId/,
    );
    assert.match(
      workbench,
      /handleDeleteTag[\s\S]+?deleteTagConfirm[\s\S]+?await onDeleteTag\(tag\)/,
    );
  });

  it("makes collection placement explicit instead of inheriting the active scope", () => {
    assert.match(
      workbench,
      /const openCollectionEditor = \(parentId = ""\)[\s\S]+?mode: "create"[\s\S]+?parentId/,
    );
    assert.match(
      workbench,
      /aria-label=\{t\("library\.newCollection"\)\}[\s\S]+?onClick=\{\(\) => openCollectionEditor\(\)\}/,
    );
    assert.match(
      workbench,
      /onCreateChild=\{\(collection\) => openCollectionEditor\(collection\.id\)\}/,
    );
    assert.match(
      workbench,
      /<option value="">\{t\("library\.topLevelCollection"\)\}<\/option>/,
    );
    assert.match(
      workbench,
      /onCreateCollection\(\{[\s\S]+?parentId: collectionEditor\.parentId \|\| undefined/,
    );
    assert.doesNotMatch(workbench, /parentId:\s*scope\.type/);
  });

  it("prevents moving a collection below itself or one of its descendants", () => {
    assert.match(
      workbench,
      /getCollectionAndDescendantIds\(editor\.collectionId, collections\)/,
    );
    assert.match(
      workbench,
      /const parentOptions = flattenCollections\(collections\)\.filter\([\s\S]+?!unavailableParentIds\.has\(collection\.id\)/,
    );
    assert.match(
      workbench,
      /function getCollectionAndDescendantIds\([\s\S]+?unavailable\.add\(currentId\)[\s\S]+?grouped\.get\(currentId\)[\s\S]+?pending\.push\(child\.id\)/,
    );
  });

  it("blocks a lightweight parent deletion when promoted children would collide", () => {
    assert.match(
      workbench,
      /const topLevelNames = new Set\([\s\S]+?!candidate\.parentId[\s\S]+?normalizeOrganizationName\(candidate\.name\)/,
    );
    assert.match(
      workbench,
      /const conflictingChildren = collections\.filter\([\s\S]+?candidate\.parentId === collection\.id[\s\S]+?topLevelNames\.has\(normalizeOrganizationName\(candidate\.name\)\)/,
    );
    assert.match(
      workbench,
      /if \(conflictingChildren\.length > 0\)[\s\S]+?setMutationError\([\s\S]+?library\.deleteCollectionConflict[\s\S]+?return false/,
    );
  });

  it("keeps successful mutations successful when a follow-up refresh fails", () => {
    assert.match(
      workspaceContainer,
      /const settleWorkspaceRefresh = useCallback\([\s\S]+?Promise\.allSettled\(operations\)[\s\S]+?result\.status === "rejected"[\s\S]+?setError\(/,
    );
    assert.match(
      workspaceContainer,
      /const refreshAfterMutation = useCallback\([\s\S]+?await settleWorkspaceRefresh\(\[[\s\S]+?loadDocuments\(currentQuery\)[\s\S]+?loadOrganization\(\)/,
    );
    for (const mutation of [
      "createLibraryCollection",
      "createLibraryTag",
      "updateLibraryCollection",
      "deleteLibraryCollection",
      "updateLibraryTag",
      "deleteLibraryTag",
    ]) {
      assert.match(
        workspaceContainer,
        new RegExp(`await ${mutation}\\([\\s\\S]+?await (?:refreshAfterMutation|settleWorkspaceRefresh)\\(`),
      );
    }
  });

  it("keeps entity menus keyboard operable and restores focus only after deletion", () => {
    assert.match(
      workbench,
      /function EntityActionsMenu\([\s\S]+?event\.key === "Escape"[\s\S]+?details\.open = false[\s\S]+?querySelector\("summary"\)\?\.focus\(\)/,
    );
    assert.match(
      workbench,
      /\["ArrowDown", "ArrowUp", "Home", "End"\]\.includes\(event\.key\)[\s\S]+?menuItems\[nextIndex\]\?\.focus\(\)/,
    );
    assert.match(
      workbench,
      /onToggle=\{\(event\) => \{[\s\S]+?requestAnimationFrame[\s\S]+?details\.open && document\.activeElement === summary/,
    );
    assert.match(
      workbench,
      /if \(!window\.confirm\(t\("library\.deleteCollectionConfirm"[\s\S]+?return false/,
    );
    assert.match(
      workbench,
      /if \(!window\.confirm\(t\("library\.deleteTagConfirm"[\s\S]+?return false/,
    );
    assert.match(
      workbench,
      /if \(onDelete\(collection\)\) \{\s*closeParentMenu\(event\.currentTarget, true\)/,
    );
    assert.match(
      workbench,
      /if \(handleDeleteTag\(tag\)\) \{\s*closeParentMenu\(event\.currentTarget, true\)/,
    );
    assert.match(
      workbench,
      /function closeParentMenu\(target: HTMLElement, restoreFocus = false\)[\s\S]+?if \(restoreFocus\)[\s\S]+?querySelector\("summary"\)\?\.focus\(\)/,
    );
  });

  it("falls back from a deleted active collection or tag", () => {
    assert.match(
      workspaceContainer,
      /handleDeleteCollection[\s\S]+?currentScope\.type === "collection"[\s\S]+?collection\.parentId[\s\S]+?DEFAULT_SCOPE[\s\S]+?libraryScopeToQuery\(nextScope/,
    );
    assert.match(
      workspaceContainer,
      /handleDeleteTag[\s\S]+?currentScope\.type === "tag"[\s\S]+?libraryScopeToQuery\(DEFAULT_SCOPE/,
    );
    assert.match(
      workspaceContainer,
      /handleDeleteTag[\s\S]+?currentScope\.type === "tag"[\s\S]+?setScope\(DEFAULT_SCOPE\)/,
    );
  });
});

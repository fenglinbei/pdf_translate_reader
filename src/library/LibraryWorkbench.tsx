import {
  Archive,
  BookOpen,
  Check,
  Clock3,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { PdfImportDropzone } from "../pdf/PdfImportDropzone";
import type {
  LibraryCollection,
  LibraryCollectionCreateInput,
  LibraryCollectionUpdateInput,
  LibraryDocument,
  LibraryDocumentBatchUpdate,
  LibraryDocumentMetadataPatch,
  LibraryMetadataField,
  LibraryDocumentQuery,
  LibraryReadingStatus,
  LibraryTag,
  LibraryTagCreateInput,
  LibraryTagUpdateInput,
} from "../types/domain";
import "./libraryWorkbench.css";
import { MetadataRecognition, MetadataStatus } from "./MetadataRecognition";
import { parseMetadataAuthors } from "../../shared/pdfMetadata.mjs";

export type LibraryWorkbenchScope =
  | {
      type: "system";
      value:
        | "all"
        | "inbox"
        | "to-read"
        | "reading"
        | "finished"
        | "starred"
        | "recent"
        | "uncategorized"
        | "archived";
    }
  | { type: "collection"; id: string }
  | { type: "tag"; id: string };

export type LibraryDocumentSaveInput = {
  collectionIds: string[];
  metadata: LibraryDocumentMetadataPatch;
  tagIds: string[];
};

type LibraryWorkbenchProps = {
  metadataAiEnabled: boolean;
  onMetadataAiChange: (enabled: boolean) => Promise<void>;
  onRecognizeMetadata: (documentIds: string[]) => Promise<void>;
  onApplyMetadata: (document: LibraryDocument, fields: LibraryMetadataField[]) => Promise<void>;
  activeDocumentId?: string;
  collections: LibraryCollection[];
  documents: LibraryDocument[];
  error?: string;
  hasMore: boolean;
  isImporting: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  onBatchUpdate: (input: LibraryDocumentBatchUpdate) => Promise<void>;
  onClose: () => void;
  onCreateCollection: (input: LibraryCollectionCreateInput) => Promise<void>;
  onCreateTag: (input: LibraryTagCreateInput) => Promise<void>;
  onDeleteCollection: (collection: LibraryCollection) => Promise<void>;
  onDeleteTag: (tag: LibraryTag) => Promise<void>;
  onImport: (file: File) => Promise<void> | void;
  onLoadMore: () => Promise<void> | void;
  onOpenDocument: (document: LibraryDocument) => Promise<void> | void;
  onQueryChange: (query: LibraryDocumentQuery) => void;
  onRefresh: () => Promise<void> | void;
  onSaveDocument: (
    document: LibraryDocument,
    input: LibraryDocumentSaveInput,
  ) => Promise<void>;
  onScopeChange: (scope: LibraryWorkbenchScope) => void;
  onUpdateCollection: (
    collectionId: string,
    input: LibraryCollectionUpdateInput,
  ) => Promise<void>;
  onUpdateTag: (tagId: string, input: LibraryTagUpdateInput) => Promise<void>;
  query: LibraryDocumentQuery;
  scope: LibraryWorkbenchScope;
  tags: LibraryTag[];
  total: number;
};

type MetadataDraft = {
  abstract: string;
  arxivId: string;
  authors: string;
  collectionIds: string[];
  doi: string;
  publicationVenue: string;
  publicationYear: string;
  readingStatus: LibraryReadingStatus;
  tagIds: string[];
  title: string;
};

type CollectionEditorState = {
  collectionId?: string;
  mode: "create" | "edit";
  name: string;
  parentId: string;
};

type TagEditorState = {
  color: string;
  mode: "create" | "edit";
  name: string;
  tagId?: string;
};

const DEFAULT_TAG_COLOR = "#7891bb";

const STATUS_VALUES: LibraryReadingStatus[] = [
  "inbox",
  "to-read",
  "reading",
  "finished",
];

const SORT_VALUES: Array<NonNullable<LibraryDocumentQuery["sort"]>> = [
  "updated-desc",
  "opened-desc",
  "imported-desc",
  "title-asc",
  "title-desc",
];

export function LibraryWorkbench({
  metadataAiEnabled,
  onMetadataAiChange,
  onRecognizeMetadata,
  onApplyMetadata,
  activeDocumentId,
  collections,
  documents,
  error,
  hasMore,
  isImporting,
  isLoading,
  isLoadingMore,
  onBatchUpdate,
  onClose,
  onCreateCollection,
  onCreateTag,
  onDeleteCollection,
  onDeleteTag,
  onImport,
  onLoadMore,
  onOpenDocument,
  onQueryChange,
  onRefresh,
  onSaveDocument,
  onScopeChange,
  onUpdateCollection,
  onUpdateTag,
  query,
  scope,
  tags,
  total,
}: LibraryWorkbenchProps) {
  const { formatDate, formatNumber, t } = useI18n();
  const [focusedDocumentId, setFocusedDocumentId] = useState<string>();
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [searchValue, setSearchValue] = useState(query.query ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<CollectionEditorState>();
  const [tagEditor, setTagEditor] = useState<TagEditorState>();
  const [mutationError, setMutationError] = useState<string>();
  const [isMutating, setIsMutating] = useState(false);
  const [shouldFocusInspector, setShouldFocusInspector] = useState(false);
  const documentRowRefs = useRef(new Map<string, HTMLElement>());
  const inspectorRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);

  const focusedDocument = documents.find(
    (document) => document.cloudDocumentId === focusedDocumentId,
  );
  const [draft, setDraft] = useState<MetadataDraft>(() =>
    createMetadataDraft(focusedDocument),
  );

  useEffect(() => {
    if (window.matchMedia("(min-width: 921px)").matches) {
      searchInputRef.current?.focus();
    } else {
      workbenchRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    const visibleIds = new Set(documents.map((document) => document.cloudDocumentId));
    setSelectedDocumentIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return setsEqual(current, next) ? current : next;
    });
    setFocusedDocumentId((current) =>
      current && !visibleIds.has(current) ? undefined : current
    );
  }, [documents]);

  useEffect(() => {
    setDraft(createMetadataDraft(focusedDocument));
    setIsEditing(false);
  }, [focusedDocument?.cloudDocumentId]);

  useEffect(() => {
    if (!isEditing) setDraft(createMetadataDraft(focusedDocument));
  }, [focusedDocument?.libraryUpdatedAt, isEditing]);

  useEffect(() => {
    if (!focusedDocument || !shouldFocusInspector) {
      return;
    }

    inspectorRef.current?.focus();
    setShouldFocusInspector(false);
  }, [focusedDocument, shouldFocusInspector]);

  useEffect(() => {
    setSearchValue(query.query ?? "");
  }, [query.query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const normalized = searchValue.trim();

      if (normalized !== (query.query ?? "")) {
        onQueryChange({
          ...query,
          offset: 0,
          query: normalized || undefined,
        });
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [onQueryChange, query, searchValue]);

  const collectionChildren = useMemo(() => groupCollections(collections), [collections]);
  const allVisibleSelected =
    documents.length > 0
    && documents.every((document) => selectedDocumentIds.has(document.cloudDocumentId));
  const selectedCount = selectedDocumentIds.size;
  const selectedIds = Array.from(selectedDocumentIds);

  const runMutation = async (task: () => Promise<void>) => {
    setIsMutating(true);
    setMutationError(undefined);

    try {
      await task();
    } catch (caughtError) {
      setMutationError(
        caughtError instanceof Error ? caughtError.message : t("library.mutationFailed"),
      );
    } finally {
      setIsMutating(false);
    }
  };

  const handleBatchUpdate = (patch: Omit<LibraryDocumentBatchUpdate, "documentIds">) => {
    if (selectedIds.length === 0) {
      return;
    }

    void runMutation(async () => {
      await onBatchUpdate({ documentIds: selectedIds, ...patch });
      setSelectedDocumentIds(new Set());
    });
  };

  const handleSaveDocument = () => {
    if (!focusedDocument) {
      return;
    }

    void runMutation(async () => {
      await onSaveDocument({ ...focusedDocument, metadataRevision: draftRevision }, {
        collectionIds: draft.collectionIds,
        metadata: {
          abstract: draft.abstract || null,
          arxivId: draft.arxivId || null,
          authors: splitAuthors(draft.authors),
          doi: draft.doi || null,
          publicationVenue: draft.publicationVenue || null,
          publicationYear: parseYear(draft.publicationYear),
          readingStatus: draft.readingStatus,
          title: draft.title || null,
        },
        tagIds: draft.tagIds,
      });
      setIsEditing(false);
    });
  };

  const openCollectionEditor = (parentId = "") => {
    setTagEditor(undefined);
    setCollectionEditor({ mode: "create", name: "", parentId });
  };

  const openCollectionForEditing = (collection: LibraryCollection) => {
    setTagEditor(undefined);
    setCollectionEditor({
      collectionId: collection.id,
      mode: "edit",
      name: collection.name,
      parentId: collection.parentId ?? "",
    });
  };

  const handleSaveCollection = () => {
    const name = collectionEditor?.name.trim() ?? "";

    if (!collectionEditor || !name) {
      return;
    }

    void runMutation(async () => {
      if (collectionEditor.mode === "edit" && collectionEditor.collectionId) {
        await onUpdateCollection(collectionEditor.collectionId, {
          name,
          parentId: collectionEditor.parentId || null,
        });
      } else {
        await onCreateCollection({
          name,
          parentId: collectionEditor.parentId || undefined,
        });
      }
      setCollectionEditor(undefined);
    });
  };

  const handleDeleteCollection = (collection: LibraryCollection) => {
    const topLevelNames = new Set(
      collections
        .filter((candidate) => !candidate.parentId && candidate.id !== collection.id)
        .map((candidate) => normalizeOrganizationName(candidate.name)),
    );
    const conflictingChildren = collections.filter(
      (candidate) =>
        candidate.parentId === collection.id
        && topLevelNames.has(normalizeOrganizationName(candidate.name)),
    );

    if (conflictingChildren.length > 0) {
      setMutationError(
        t("library.deleteCollectionConflict", {
          names: conflictingChildren.map((candidate) => candidate.name).join(", "),
        }),
      );
      return false;
    }

    if (!window.confirm(t("library.deleteCollectionConfirm", { name: collection.name }))) {
      return false;
    }

    void runMutation(async () => {
      await onDeleteCollection(collection);
      setCollectionEditor((current) =>
        current?.collectionId === collection.id || current?.parentId === collection.id
          ? undefined
          : current
      );
    });
    return true;
  };

  const openTagEditor = (tag?: LibraryTag) => {
    setCollectionEditor(undefined);
    setTagEditor(
      tag
        ? {
            color: tag.color ?? DEFAULT_TAG_COLOR,
            mode: "edit",
            name: tag.name,
            tagId: tag.id,
          }
        : { color: DEFAULT_TAG_COLOR, mode: "create", name: "" },
    );
  };

  const handleSaveTag = () => {
    const name = tagEditor?.name.trim() ?? "";

    if (!tagEditor || !name) {
      return;
    }

    void runMutation(async () => {
      if (tagEditor.mode === "edit" && tagEditor.tagId) {
        await onUpdateTag(tagEditor.tagId, { color: tagEditor.color, name });
      } else {
        await onCreateTag({ color: tagEditor.color, name });
      }
      setTagEditor(undefined);
    });
  };

  const handleDeleteTag = (tag: LibraryTag) => {
    if (!window.confirm(t("library.deleteTagConfirm", { name: tag.name }))) {
      return false;
    }

    void runMutation(async () => {
      await onDeleteTag(tag);
      setTagEditor((current) => current?.tagId === tag.id ? undefined : current);
    });
    return true;
  };

  const closeInspector = () => {
    const closingDocumentId = focusedDocumentId;

    setFocusedDocumentId(undefined);
    setIsEditing(false);
    window.requestAnimationFrame(() => {
      const row = closingDocumentId
        ? documentRowRefs.current.get(closingDocumentId)
        : undefined;
      (row ?? workbenchRef.current)?.focus();
    });
  };

  return (
    <section
      aria-label={t("library.workbenchTitle")}
      className="library-workbench"
      ref={workbenchRef}
      tabIndex={-1}
    >
      <header className="library-workbench__header">
        <div className="library-workbench__title-block">
          <button
            aria-label={t("library.systemViews")}
            aria-expanded={isSidebarOpen}
            className="library-workbench__mobile-menu"
            onClick={() => setIsSidebarOpen((value) => !value)}
            title={t("library.systemViews")}
            type="button"
          >
            <Folder aria-hidden="true" size={18} />
          </button>
          <div>
            <h1>{t("library.workbenchTitle")}</h1>
            <p>{t("library.resultsCount", { count: formatNumber(total) })}</p>
          </div>
        </div>
        <div className="library-workbench__header-actions">
          <PdfImportDropzone
            isImporting={isImporting}
            onImport={onImport}
            variant="compact"
          />
          <button
            aria-label={t("library.refresh")}
            className="library-workbench__icon-button"
            disabled={isLoading}
            onClick={() => {
              void Promise.resolve(onRefresh()).catch(() => undefined);
            }}
            title={t("library.refresh")}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={t("library.closeWorkbench")}
            className="library-workbench__icon-button"
            onClick={onClose}
            title={t("library.closeWorkbench")}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
      </header>

      <div className="library-workbench__layout">
        <aside
          className={`library-workbench__sidebar ${
            isSidebarOpen ? "library-workbench__sidebar--open" : ""
          }`}
        >
          <nav aria-label={t("library.systemViews")}>
            <LibrarySidebarButton
              active={isSystemScope(scope, "all")}
              icon={<FileText aria-hidden="true" size={16} />}
              label={t("library.allDocuments")}
              onClick={() => selectScope({ type: "system", value: "all" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "inbox")}
              icon={<Inbox aria-hidden="true" size={16} />}
              label={t("library.status.inbox")}
              onClick={() => selectScope({ type: "system", value: "inbox" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "to-read")}
              icon={<BookOpen aria-hidden="true" size={16} />}
              label={t("library.status.toRead")}
              onClick={() => selectScope({ type: "system", value: "to-read" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "reading")}
              icon={<Clock3 aria-hidden="true" size={16} />}
              label={t("library.status.reading")}
              onClick={() => selectScope({ type: "system", value: "reading" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "finished")}
              icon={<Check aria-hidden="true" size={16} />}
              label={t("library.status.finished")}
              onClick={() => selectScope({ type: "system", value: "finished" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "starred")}
              icon={<Star aria-hidden="true" size={16} />}
              label={t("library.starred")}
              onClick={() => selectScope({ type: "system", value: "starred" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "recent")}
              icon={<Clock3 aria-hidden="true" size={16} />}
              label={t("library.recentlyOpened")}
              onClick={() => selectScope({ type: "system", value: "recent" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "uncategorized")}
              icon={<Folder aria-hidden="true" size={16} />}
              label={t("library.uncategorized")}
              onClick={() => selectScope({ type: "system", value: "uncategorized" }, onScopeChange, setIsSidebarOpen)}
            />
            <LibrarySidebarButton
              active={isSystemScope(scope, "archived")}
              icon={<Archive aria-hidden="true" size={16} />}
              label={t("library.archived")}
              onClick={() => selectScope({ type: "system", value: "archived" }, onScopeChange, setIsSidebarOpen)}
            />
          </nav>

          <div className="library-workbench__sidebar-section">
            <div className="library-workbench__sidebar-heading">
              <span>{t("library.collections")}</span>
              <button
                aria-label={t("library.newCollection")}
                onClick={() => openCollectionEditor()}
                title={t("library.newCollection")}
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {collectionEditor ? (
              <CollectionEditor
                collections={collections}
                disabled={isMutating}
                editor={collectionEditor}
                onCancel={() => setCollectionEditor(undefined)}
                onChange={setCollectionEditor}
                onSubmit={handleSaveCollection}
                t={t}
              />
            ) : null}
            <div className="library-workbench__collection-tree">
              <CollectionTree
                disabled={isMutating}
                grouped={collectionChildren}
                onCreateChild={(collection) => openCollectionEditor(collection.id)}
                onDelete={handleDeleteCollection}
                onEdit={openCollectionForEditing}
                onScopeChange={onScopeChange}
                scope={scope}
                setIsSidebarOpen={setIsSidebarOpen}
                t={t}
              />
              {collections.length === 0 && !collectionEditor ? (
                <p className="library-workbench__sidebar-empty">
                  {t("library.noCollections")}
                </p>
              ) : null}
            </div>
          </div>

          <div className="library-workbench__sidebar-section">
            <div className="library-workbench__sidebar-heading">
              <span>{t("library.tags")}</span>
              <button
                aria-label={t("library.newTag")}
                onClick={() => openTagEditor()}
                title={t("library.newTag")}
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {tagEditor ? (
              <TagEditor
                disabled={isMutating}
                editor={tagEditor}
                onCancel={() => setTagEditor(undefined)}
                onChange={setTagEditor}
                onSubmit={handleSaveTag}
                t={t}
              />
            ) : null}
            <div className="library-workbench__tag-list">
              {tags.map((tag) => (
                <div className="library-workbench__sidebar-row" key={tag.id}>
                  <button
                    className={
                      scope.type === "tag" && scope.id === tag.id
                        ? "library-workbench__sidebar-item library-workbench__sidebar-item--active"
                        : "library-workbench__sidebar-item"
                    }
                    onClick={() =>
                      selectScope({ type: "tag", id: tag.id }, onScopeChange, setIsSidebarOpen)
                    }
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="library-workbench__tag-dot"
                      style={{ backgroundColor: tag.color || undefined }}
                    />
                    <span>{tag.name}</span>
                  </button>
                  <EntityActionsMenu
                    disabled={isMutating}
                    label={t("library.moreActionsFor", { name: tag.name })}
                  >
                    <button
                      disabled={isMutating}
                      onClick={(event) => {
                        closeParentMenu(event.currentTarget);
                        openTagEditor(tag);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={13} />
                      {t("library.editTag")}
                    </button>
                    <button
                      className="library-workbench__menu-danger"
                      disabled={isMutating}
                      onClick={(event) => {
                        if (handleDeleteTag(tag)) {
                          closeParentMenu(event.currentTarget, true);
                        }
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                      {t("library.deleteTag")}
                    </button>
                  </EntityActionsMenu>
                </div>
              ))}
              {tags.length === 0 && !tagEditor ? (
                <p className="library-workbench__sidebar-empty">{t("library.noTags")}</p>
              ) : null}
            </div>
          </div>

          {mutationError || error ? (
            <div
              className="library-workbench__notice library-workbench__notice--error library-workbench__sidebar-notice"
              role="alert"
            >
              <span>{mutationError ?? error}</span>
              {mutationError ? (
                <button
                  aria-label={t("common.close")}
                  onClick={() => setMutationError(undefined)}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              ) : (
                <button
                  aria-label={t("library.retry")}
                  onClick={() => {
                    void Promise.resolve(onRefresh()).catch(() => undefined);
                  }}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={14} />
                </button>
              )}
            </div>
          ) : null}
        </aside>

        {isSidebarOpen ? (
          <button
            aria-label={t("common.close")}
            className="library-workbench__sidebar-backdrop"
            onClick={() => setIsSidebarOpen(false)}
            type="button"
          />
        ) : null}

        <main className="library-workbench__content">
          <label className="library-metadata-ai-toggle">
            <input type="checkbox" checked={metadataAiEnabled} disabled={isMutating}
              onChange={event => { const enabled = event.target.checked; void runMutation(() => onMetadataAiChange(enabled)); }} />
            <span>{t("library.recognition.aiToggle")}<small>{t("library.recognition.aiHint")}</small></span>
          </label>
          <div className="library-workbench__toolbar">
            <label className="library-workbench__search">
              <Search aria-hidden="true" size={17} />
              <span className="sr-only">{t("library.search")}</span>
              <input
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder={t("library.searchMetadataPlaceholder")}
                ref={searchInputRef}
                type="search"
                value={searchValue}
              />
            </label>
            <select
              aria-label={t("library.sort")}
              onChange={(event) =>
                onQueryChange({
                  ...query,
                  offset: 0,
                  sort: event.target.value as LibraryDocumentQuery["sort"],
                })
              }
              value={query.sort ?? "updated-desc"}
            >
              {SORT_VALUES.map((sort) => (
                <option key={sort} value={sort}>
                  {getSortLabel(sort, t)}
                </option>
              ))}
            </select>
            <label className="library-workbench__year-filter">
              <span>{t("library.yearFrom")}</span>
              <input
                max="3000"
                min="1"
                onChange={(event) =>
                  onQueryChange({
                    ...query,
                    offset: 0,
                    yearFrom: parseYear(event.target.value) ?? undefined,
                  })
                }
                placeholder="2020"
                type="number"
                value={query.yearFrom ?? ""}
              />
            </label>
            <label className="library-workbench__year-filter">
              <span>{t("library.yearTo")}</span>
              <input
                max="3000"
                min="1"
                onChange={(event) =>
                  onQueryChange({
                    ...query,
                    offset: 0,
                    yearTo: parseYear(event.target.value) ?? undefined,
                  })
                }
                placeholder="2026"
                type="number"
                value={query.yearTo ?? ""}
              />
            </label>
          </div>

          {selectedCount > 0 ? (
            <div className="library-workbench__batch-bar">
              <strong>
                {t("library.selectedCount", { count: formatNumber(selectedCount) })}
              </strong>
              <select
                aria-label={t("library.status")}
                defaultValue=""
                disabled={isMutating}
                onChange={(event) => {
                  const status = event.target.value as LibraryReadingStatus;
                  if (status) {
                    handleBatchUpdate({ readingStatus: status });
                    event.target.value = "";
                  }
                }}
              >
                <option disabled value="">{t("library.setStatus")}</option>
                {STATUS_VALUES.map((status) => (
                  <option key={status} value={status}>
                    {getStatusLabel(status, t)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("library.addToCollection")}
                defaultValue=""
                disabled={isMutating || collections.length === 0}
                onChange={(event) => {
                  if (event.target.value) {
                    handleBatchUpdate({ addCollectionIds: [event.target.value] });
                    event.target.value = "";
                  }
                }}
              >
                <option disabled value="">{t("library.addToCollection")}</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("library.removeFromCollection")}
                defaultValue=""
                disabled={isMutating || collections.length === 0}
                onChange={(event) => {
                  if (event.target.value) {
                    handleBatchUpdate({ removeCollectionIds: [event.target.value] });
                    event.target.value = "";
                  }
                }}
              >
                <option disabled value="">{t("library.removeFromCollection")}</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("library.addTag")}
                defaultValue=""
                disabled={isMutating || tags.length === 0}
                onChange={(event) => {
                  if (event.target.value) {
                    handleBatchUpdate({ addTagIds: [event.target.value] });
                    event.target.value = "";
                  }
                }}
              >
                <option disabled value="">{t("library.addTag")}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("library.removeTag")}
                defaultValue=""
                disabled={isMutating || tags.length === 0}
                onChange={(event) => {
                  if (event.target.value) {
                    handleBatchUpdate({ removeTagIds: [event.target.value] });
                    event.target.value = "";
                  }
                }}
              >
                <option disabled value="">{t("library.removeTag")}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <button
                disabled={isMutating}
                onClick={() => handleBatchUpdate({ starred: true })}
                type="button"
              >
                <Star aria-hidden="true" size={15} />
                {t("library.star")}
              </button>
              <button
                disabled={isMutating}
                onClick={() => handleBatchUpdate({ starred: false })}
                type="button"
              >
                <Star aria-hidden="true" size={15} />
                {t("library.unstar")}
              </button>
              <button
                disabled={isMutating}
                onClick={() =>
                  handleBatchUpdate({
                    archived: !isSystemScope(scope, "archived"),
                  })
                }
                type="button"
              >
                <Archive aria-hidden="true" size={15} />
                {isSystemScope(scope, "archived")
                  ? t("library.restore")
                  : t("library.archive")}
              </button>
              <button
                className="library-workbench__batch-clear"
                onClick={() => setSelectedDocumentIds(new Set())}
                type="button"
              >
                {t("library.clearSelection")}
              </button>
              <button type="button" disabled={isMutating || selectedCount > 100}
                onClick={() => void runMutation(() => onRecognizeMetadata(selectedIds))}>
                <Sparkles aria-hidden="true" size={15} />{t("library.recognition.batch")}
              </button>
            </div>
          ) : null}

          {mutationError && !isSidebarOpen ? (
            <div
              className="library-workbench__notice library-workbench__notice--error"
              role="alert"
            >
              <span>{mutationError}</span>
              <button
                aria-label={t("common.close")}
                onClick={() => setMutationError(undefined)}
                type="button"
              >
                <X aria-hidden="true" size={14} />
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="library-workbench__state">
              <p>{error}</p>
              <button
                onClick={() => {
                  void Promise.resolve(onRefresh()).catch(() => undefined);
                }}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={16} />
                {t("library.retry")}
              </button>
            </div>
          ) : isLoading ? (
            <div className="library-workbench__state">
              <LoaderCircle
                aria-hidden="true"
                className="library-workbench__spinner"
                size={24}
              />
              <p>{t("library.loading")}</p>
            </div>
          ) : documents.length === 0 ? (
            <div className="library-workbench__state">
              <FolderPlus aria-hidden="true" size={28} />
              <p>{t("library.emptyScope")}</p>
              <span>{t("library.emptyScopeHint")}</span>
            </div>
          ) : (
            <>
              <div className="library-workbench__table-header">
                <label>
                  <input
                    checked={allVisibleSelected}
                    onChange={() => {
                      if (allVisibleSelected) {
                        setSelectedDocumentIds(new Set());
                      } else {
                        setSelectedDocumentIds(
                          new Set(documents.map((document) => document.cloudDocumentId)),
                        );
                      }
                    }}
                    type="checkbox"
                  />
                  <span className="sr-only">{t("library.selectAllVisible")}</span>
                </label>
                <span>{t("library.paper")}</span>
                <span>{t("library.organization")}</span>
                <span>{t("library.status")}</span>
                <span className="sr-only">{t("library.actions")}</span>
              </div>
              <div className="library-workbench__document-list">
                {documents.map((document) => (
                  <LibraryDocumentRow
                    active={document.cloudDocumentId === activeDocumentId}
                    checked={selectedDocumentIds.has(document.cloudDocumentId)}
                    document={document}
                    focused={document.cloudDocumentId === focusedDocument?.cloudDocumentId}
                    formatDate={formatDate}
                    key={document.cloudDocumentId}
                    onArchive={() =>
                      void runMutation(() =>
                        onBatchUpdate({
                          archived: !Boolean(document.archivedAt),
                          documentIds: [document.cloudDocumentId],
                        }),
                      )
                    }
                    onCheck={() =>
                      setSelectedDocumentIds((current) =>
                        toggleSetValue(current, document.cloudDocumentId)
                      )
                    }
                    onFocus={() => setFocusedDocumentId(document.cloudDocumentId)}
                    onInspect={() => {
                      setFocusedDocumentId(document.cloudDocumentId);
                      setShouldFocusInspector(true);
                    }}
                    onOpen={() => void onOpenDocument(document)}
                    onStar={() =>
                      void runMutation(() =>
                        onBatchUpdate({
                          documentIds: [document.cloudDocumentId],
                          starred: !Boolean(document.starredAt),
                        }),
                      )
                    }
                    rowRef={(element) => {
                      if (element) {
                        documentRowRefs.current.set(document.cloudDocumentId, element);
                      } else {
                        documentRowRefs.current.delete(document.cloudDocumentId);
                      }
                    }}
                    t={t}
                  />
                ))}
              </div>
              {hasMore ? (
                <button
                  className="library-workbench__load-more"
                  disabled={isLoadingMore}
                  onClick={() => {
                    void Promise.resolve(onLoadMore()).catch(() => undefined);
                  }}
                  type="button"
                >
                  {isLoadingMore ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="library-workbench__spinner"
                      size={16}
                    />
                  ) : null}
                  {t("library.loadMore")}
                </button>
              ) : null}
            </>
          )}
        </main>

        <aside
          aria-label={t("library.metadata")}
          className={`library-workbench__inspector ${
            focusedDocument ? "library-workbench__inspector--open" : ""
          }`}
          ref={inspectorRef}
          tabIndex={-1}
        >
          {focusedDocument ? (
            <>
              <div className="library-workbench__inspector-heading">
                <div>
                  <span>{t("library.metadata")}</span>
                  <strong>
                    {focusedDocument.bibliographicMetadata.title || focusedDocument.fileName}
                  </strong>
                </div>
                <button
                  aria-label={t("common.close")}
                  className="library-workbench__inspector-close"
                  onClick={closeInspector}
                  title={t("common.close")}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </div>

              {isEditing ? (
                <MetadataEditor
                  collections={collections}
                  draft={draft}
                  disabled={isMutating}
                  onChange={setDraft}
                  tags={tags}
                  t={t}
                />
              ) : (
                <>
                  <MetadataRecognition document={focusedDocument} disabled={isMutating}
                    onRecognize={() => void runMutation(() => onRecognizeMetadata([focusedDocument.cloudDocumentId]))}
                    onApply={fields => void runMutation(() => onApplyMetadata(focusedDocument, fields))} />
                  <MetadataSummary document={focusedDocument} formatDate={formatDate} t={t} />
                </>
              )}

              <div className="library-workbench__inspector-actions">
                {isEditing ? (
                  <>
                    <button
                      className="library-workbench__primary-button"
                      disabled={isMutating}
                      onClick={handleSaveDocument}
                      type="button"
                    >
                      {isMutating ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="library-workbench__spinner"
                          size={15}
                        />
                      ) : (
                        <Check aria-hidden="true" size={15} />
                      )}
                      {t("common.save")}
                    </button>
                    <button
                      disabled={isMutating}
                      onClick={() => {
                        setDraft(createMetadataDraft(focusedDocument));
                        setIsEditing(false);
                      }}
                      type="button"
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="library-workbench__primary-button"
                      onClick={() => void onOpenDocument(focusedDocument)}
                      type="button"
                    >
                      <BookOpen aria-hidden="true" size={15} />
                      {t("library.openDocument")}
                    </button>
                    <button onClick={() => { setDraftRevision(focusedDocument.metadataRevision ?? 0); setIsEditing(true); }} type="button">
                      {t("library.editMetadata")}
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="library-workbench__state">
              <FileText aria-hidden="true" size={24} />
              <p>{t("library.selectPaper")}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function LibrarySidebarButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={
        active
          ? "library-workbench__sidebar-item library-workbench__sidebar-item--active"
          : "library-workbench__sidebar-item"
      }
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function CollectionEditor({
  collections,
  disabled,
  onCancel,
  onChange,
  onSubmit,
  editor,
  t,
}: {
  collections: LibraryCollection[];
  disabled: boolean;
  onCancel: () => void;
  onChange: (editor: CollectionEditorState) => void;
  onSubmit: () => void;
  editor: CollectionEditorState;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const unavailableParentIds = editor.collectionId
    ? getCollectionAndDescendantIds(editor.collectionId, collections)
    : new Set<string>();
  const parentOptions = flattenCollections(collections).filter(
    ({ collection }) => !unavailableParentIds.has(collection.id),
  );

  return (
    <form
      aria-label={
        editor.mode === "edit"
          ? t("library.editCollection")
          : t("library.newCollection")
      }
      className="library-workbench__organization-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="library-workbench__organization-editor-heading">
        <strong>
          {editor.mode === "edit"
            ? t("library.editCollection")
            : t("library.newCollection")}
        </strong>
        <button
          aria-label={t("common.cancel")}
          disabled={disabled}
          onClick={onCancel}
          title={t("common.cancel")}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      </div>
      <label>
        <span>{t("library.collectionName")}</span>
        <input
          autoFocus
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
          placeholder={t("library.collectionNamePlaceholder")}
          value={editor.name}
        />
      </label>
      <label>
        <span>{t("library.collectionLocation")}</span>
        <select
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, parentId: event.target.value })}
          value={editor.parentId}
        >
          <option value="">{t("library.topLevelCollection")}</option>
          {parentOptions.map(({ collection, path }) => (
            <option key={collection.id} value={collection.id}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <p>{t("library.collectionLocationHint")}</p>
      <div className="library-workbench__organization-editor-actions">
        <button disabled={disabled} onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button disabled={disabled || !editor.name.trim()} type="submit">
          {editor.mode === "edit" ? t("common.save") : t("common.confirm")}
        </button>
      </div>
    </form>
  );
}

function TagEditor({
  disabled,
  editor,
  onCancel,
  onChange,
  onSubmit,
  t,
}: {
  disabled: boolean;
  editor: TagEditorState;
  onCancel: () => void;
  onChange: (editor: TagEditorState) => void;
  onSubmit: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <form
      aria-label={editor.mode === "edit" ? t("library.editTag") : t("library.newTag")}
      className="library-workbench__organization-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="library-workbench__organization-editor-heading">
        <strong>
          {editor.mode === "edit" ? t("library.editTag") : t("library.newTag")}
        </strong>
        <button
          aria-label={t("common.cancel")}
          disabled={disabled}
          onClick={onCancel}
          title={t("common.cancel")}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      </div>
      <label>
        <span>{t("library.tagName")}</span>
        <input
          autoFocus
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
          placeholder={t("library.tagNamePlaceholder")}
          value={editor.name}
        />
      </label>
      <label className="library-workbench__color-field">
        <span>{t("library.tagColor")}</span>
        <input
          aria-label={t("library.tagColor")}
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, color: event.target.value })}
          type="color"
          value={editor.color}
        />
        <span>{editor.color}</span>
      </label>
      <div className="library-workbench__organization-editor-actions">
        <button disabled={disabled} onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button disabled={disabled || !editor.name.trim()} type="submit">
          {editor.mode === "edit" ? t("common.save") : t("common.confirm")}
        </button>
      </div>
    </form>
  );
}

function EntityActionsMenu({
  children,
  disabled,
  label,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  return (
    <details
      className="library-workbench__entity-menu"
      onBlur={(event) => {
        const details = event.currentTarget;
        if (!details.contains(event.relatedTarget)) {
          details.open = false;
        }
      }}
      onKeyDown={(event) => {
        const details = detailsRef.current;
        if (event.key === "Escape" && details?.open) {
          event.preventDefault();
          details.open = false;
          details.querySelector("summary")?.focus();
          return;
        }

        if (
          details
          && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          details.open = true;
          const menuItems = Array.from(
            details.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ),
          );
          if (menuItems.length === 0) {
            return;
          }

          const currentIndex = menuItems.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          let nextIndex = 0;
          if (event.key === "End") {
            nextIndex = menuItems.length - 1;
          } else if (event.key === "ArrowUp") {
            nextIndex = currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
          } else if (event.key === "ArrowDown" && currentIndex >= 0) {
            nextIndex = (currentIndex + 1) % menuItems.length;
          }
          menuItems[nextIndex]?.focus();
        }
      }}
      onToggle={(event) => {
        const details = event.currentTarget;
        if (details.open) {
          const summary = details.querySelector("summary");
          window.requestAnimationFrame(() => {
            if (details.open && document.activeElement === summary) {
              details
                .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
                ?.focus();
            }
          });
        }
      }}
      ref={detailsRef}
    >
      <summary
        aria-disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
        tabIndex={disabled ? -1 : 0}
        title={label}
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </summary>
      <div aria-label={label} className="library-workbench__entity-menu-popover" role="menu">
        {children}
      </div>
    </details>
  );
}

function LibraryDocumentRow({
  active,
  checked,
  document,
  focused,
  formatDate,
  onArchive,
  onCheck,
  onFocus,
  onInspect,
  onOpen,
  onStar,
  rowRef,
  t,
}: {
  active: boolean;
  checked: boolean;
  document: LibraryDocument;
  focused: boolean;
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  onArchive: () => void;
  onCheck: () => void;
  onFocus: () => void;
  onInspect: () => void;
  onOpen: () => void;
  onStar: () => void;
  rowRef: (element: HTMLElement | null) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const metadata = document.bibliographicMetadata;

  return (
    <article
      aria-label={`${metadata.title || document.fileName}. ${t("library.selectPaper")}`}
      className={`library-workbench__document-row ${
        focused ? "library-workbench__document-row--focused" : ""
      } ${active ? "library-workbench__document-row--active" : ""}`}
      onClick={onFocus}
      onDoubleClick={onOpen}
      onFocus={(event) => {
        if (event.currentTarget === event.target) {
          onFocus();
        }
      }}
      ref={rowRef}
      tabIndex={0}
    >
      <label onClick={(event) => event.stopPropagation()}>
        <input checked={checked} onChange={onCheck} type="checkbox" />
        <span className="sr-only">{t("library.selectPaper")}</span>
      </label>
      <div className="library-workbench__document-main">
        <MetadataStatus state={document.metadataState} />
        <div className="library-workbench__document-title-line">
          <strong>{metadata.title || document.fileName}</strong>
          {active ? <span>{t("library.openNow")}</span> : null}
        </div>
        <p>
          {metadata.authors.join(", ") || t("library.unknownAuthor")}
          {metadata.publicationYear ? ` · ${metadata.publicationYear}` : ""}
          {metadata.publicationVenue ? ` · ${metadata.publicationVenue}` : ""}
        </p>
        <small>
          {t("library.lastOpened", {
            date: formatDate(document.lastOpenedAt, {
              month: "short",
              day: "numeric",
              year: "numeric",
            }),
          })}
        </small>
      </div>
      <div className="library-workbench__document-organization">
        <div>
          {document.collections.slice(0, 2).map((collection) => (
            <span className="library-workbench__chip" key={collection.id}>
              <Folder aria-hidden="true" size={11} />
              {collection.name}
            </span>
          ))}
          {document.collections.length === 0 ? (
            <span className="library-workbench__muted">{t("library.uncategorized")}</span>
          ) : null}
        </div>
        <div>
          {document.tags.slice(0, 3).map((tag) => (
            <span className="library-workbench__chip library-workbench__chip--tag" key={tag.id}>
              {tag.name}
            </span>
          ))}
        </div>
      </div>
      <span className={`library-workbench__status library-workbench__status--${document.readingStatus}`}>
        {getStatusLabel(document.readingStatus, t)}
      </span>
      <div
        className="library-workbench__row-actions"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          aria-label={document.starredAt ? t("library.unstar") : t("library.star")}
          className={document.starredAt ? "library-workbench__star--active" : ""}
          onClick={onStar}
          title={document.starredAt ? t("library.unstar") : t("library.star")}
          type="button"
        >
          <Star aria-hidden="true" fill={document.starredAt ? "currentColor" : "none"} size={16} />
        </button>
        <button
          aria-label={document.archivedAt ? t("library.restore") : t("library.archive")}
          onClick={onArchive}
          title={document.archivedAt ? t("library.restore") : t("library.archive")}
          type="button"
        >
          <Archive aria-hidden="true" size={16} />
        </button>
        <button
          aria-label={t("library.metadata")}
          onClick={onInspect}
          title={t("library.metadata")}
          type="button"
        >
          <FileText aria-hidden="true" size={15} />
        </button>
        <button
          aria-label={t("library.openDocument")}
          onClick={onOpen}
          title={t("library.openDocument")}
          type="button"
        >
          <BookOpen aria-hidden="true" size={16} />
        </button>
      </div>
    </article>
  );
}

function MetadataSummary({
  document,
  formatDate,
  t,
}: {
  document: LibraryDocument;
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const metadata = document.bibliographicMetadata;

  return (
    <div className="library-workbench__metadata-summary">
      <MetadataValue label={t("library.metadata.authors")}>
        {metadata.authors.join(", ") || t("library.notSet")}
      </MetadataValue>
      <div className="library-workbench__metadata-grid">
        <MetadataValue label={t("library.metadata.year")}>
          {metadata.publicationYear || t("library.notSet")}
        </MetadataValue>
        <MetadataValue label={t("library.metadata.venue")}>
          {metadata.publicationVenue || t("library.notSet")}
        </MetadataValue>
      </div>
      <MetadataValue label={t("library.metadata.doi")}>
        {metadata.doi || t("library.notSet")}
      </MetadataValue>
      <MetadataValue label={t("library.metadata.arxiv")}>
        {metadata.arxivId || t("library.notSet")}
      </MetadataValue>
      <MetadataValue label={t("library.status")}>
        {getStatusLabel(document.readingStatus, t)}
      </MetadataValue>
      <MetadataValue label={t("library.collections")}>
        {document.collections.length > 0
          ? document.collections.map((collection) => collection.name).join(", ")
          : t("library.notSet")}
      </MetadataValue>
      <MetadataValue label={t("library.tags")}>
        {document.tags.length > 0
          ? document.tags.map((tag) => tag.name).join(", ")
          : t("library.notSet")}
      </MetadataValue>
      <MetadataValue label={t("library.metadata.abstract")}>
        <p>{metadata.abstract || t("library.notSet")}</p>
      </MetadataValue>
      <MetadataValue label={t("library.importedAt")}>
        {formatDate(document.importedAt, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
      </MetadataValue>
      <small className="library-workbench__file-name">{document.fileName}</small>
    </div>
  );
}

function MetadataValue({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="library-workbench__metadata-value">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function MetadataEditor({
  collections,
  disabled,
  draft,
  onChange,
  tags,
  t,
}: {
  collections: LibraryCollection[];
  disabled: boolean;
  draft: MetadataDraft;
  onChange: (draft: MetadataDraft) => void;
  tags: LibraryTag[];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const update = <Key extends keyof MetadataDraft>(
    key: Key,
    value: MetadataDraft[Key],
  ) => onChange({ ...draft, [key]: value });

  return (
    <div className="library-workbench__metadata-form">
      <label>
        <span>{t("library.metadata.title")}</span>
        <input
          disabled={disabled}
          onChange={(event) => update("title", event.target.value)}
          value={draft.title}
        />
      </label>
      <label>
        <span>{t("library.metadata.authors")}</span>
        <textarea
          disabled={disabled}
          onChange={(event) => update("authors", event.target.value)}
          placeholder={t("library.authorsPlaceholder")}
          rows={3}
          value={draft.authors}
        />
      </label>
      <div className="library-workbench__metadata-grid">
        <label>
          <span>{t("library.metadata.year")}</span>
          <input
            disabled={disabled}
            max="3000"
            min="1"
            onChange={(event) => update("publicationYear", event.target.value)}
            type="number"
            value={draft.publicationYear}
          />
        </label>
        <label>
          <span>{t("library.metadata.venue")}</span>
          <input
            disabled={disabled}
            onChange={(event) => update("publicationVenue", event.target.value)}
            value={draft.publicationVenue}
          />
        </label>
      </div>
      <div className="library-workbench__metadata-grid">
        <label>
          <span>{t("library.metadata.doi")}</span>
          <input
            disabled={disabled}
            onChange={(event) => update("doi", event.target.value)}
            value={draft.doi}
          />
        </label>
        <label>
          <span>{t("library.metadata.arxiv")}</span>
          <input
            disabled={disabled}
            onChange={(event) => update("arxivId", event.target.value)}
            value={draft.arxivId}
          />
        </label>
      </div>
      <label>
        <span>{t("library.status")}</span>
        <select
          disabled={disabled}
          onChange={(event) =>
            update("readingStatus", event.target.value as LibraryReadingStatus)
          }
          value={draft.readingStatus}
        >
          {STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {getStatusLabel(status, t)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("library.metadata.abstract")}</span>
        <textarea
          disabled={disabled}
          onChange={(event) => update("abstract", event.target.value)}
          rows={7}
          value={draft.abstract}
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>{t("library.collections")}</legend>
        <div className="library-workbench__check-list">
          {collections.map((collection) => (
            <label key={collection.id}>
              <input
                checked={draft.collectionIds.includes(collection.id)}
                onChange={() =>
                  update(
                    "collectionIds",
                    toggleArrayValue(draft.collectionIds, collection.id),
                  )
                }
                type="checkbox"
              />
              <span>{collection.name}</span>
            </label>
          ))}
          {collections.length === 0 ? <span>{t("library.noCollections")}</span> : null}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>{t("library.tags")}</legend>
        <div className="library-workbench__check-list">
          {tags.map((tag) => (
            <label key={tag.id}>
              <input
                checked={draft.tagIds.includes(tag.id)}
                onChange={() => update("tagIds", toggleArrayValue(draft.tagIds, tag.id))}
                type="checkbox"
              />
              <span>{tag.name}</span>
            </label>
          ))}
          {tags.length === 0 ? <span>{t("library.noTags")}</span> : null}
        </div>
      </fieldset>
    </div>
  );
}

export function libraryScopeToQuery(
  scope: LibraryWorkbenchScope,
  current: LibraryDocumentQuery = {},
): LibraryDocumentQuery {
  const base: LibraryDocumentQuery = {
    limit: current.limit ?? 50,
    offset: 0,
    query: current.query,
    sort: current.sort ?? "updated-desc",
    yearFrom: current.yearFrom,
    yearTo: current.yearTo,
  };

  if (scope.type === "collection") {
    return { ...base, archiveMode: "active", collectionIds: [scope.id] };
  }

  if (scope.type === "tag") {
    return { ...base, archiveMode: "active", tagIds: [scope.id] };
  }

  switch (scope.value) {
    case "inbox":
    case "to-read":
    case "reading":
    case "finished":
      return {
        ...base,
        archiveMode: "active",
        readingStatuses: [scope.value],
      };
    case "starred":
      return { ...base, archiveMode: "active", starred: true };
    case "recent":
      return { ...base, archiveMode: "active", sort: "opened-desc" };
    case "uncategorized":
      return { ...base, archiveMode: "active", uncategorized: true };
    case "archived":
      return { ...base, archiveMode: "archived" };
    default:
      return { ...base, archiveMode: "active" };
  }
}

function CollectionTree({
  depth = 0,
  disabled,
  grouped,
  onCreateChild,
  onDelete,
  onEdit,
  onScopeChange,
  parentId,
  scope,
  setIsSidebarOpen,
  t,
}: {
  depth?: number;
  disabled: boolean;
  grouped: Map<string, LibraryCollection[]>;
  onCreateChild: (collection: LibraryCollection) => void;
  onDelete: (collection: LibraryCollection) => boolean;
  onEdit: (collection: LibraryCollection) => void;
  onScopeChange: (scope: LibraryWorkbenchScope) => void;
  parentId?: string;
  scope: LibraryWorkbenchScope;
  setIsSidebarOpen: (value: boolean) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const key = parentId ?? "";

  return (
    <>
      {(grouped.get(key) ?? []).map((collection) => (
        <div key={collection.id}>
          <div className="library-workbench__sidebar-row">
            <button
              className={
                scope.type === "collection" && scope.id === collection.id
                  ? "library-workbench__sidebar-item library-workbench__sidebar-item--active"
                  : "library-workbench__sidebar-item"
              }
              onClick={() =>
                selectScope(
                  { type: "collection", id: collection.id },
                  onScopeChange,
                  setIsSidebarOpen,
                )
              }
              style={{ paddingInlineStart: `${12 + depth * 14}px` }}
              type="button"
            >
              <Folder aria-hidden="true" size={15} />
              <span>{collection.name}</span>
            </button>
            <EntityActionsMenu
              disabled={disabled}
              label={t("library.moreActionsFor", { name: collection.name })}
            >
              <button
                disabled={disabled}
                onClick={(event) => {
                  closeParentMenu(event.currentTarget);
                  onCreateChild(collection);
                }}
                role="menuitem"
                type="button"
              >
                <FolderPlus aria-hidden="true" size={13} />
                {t("library.newSubcollection")}
              </button>
              <button
                disabled={disabled}
                onClick={(event) => {
                  closeParentMenu(event.currentTarget);
                  onEdit(collection);
                }}
                role="menuitem"
                type="button"
              >
                <Pencil aria-hidden="true" size={13} />
                {t("library.editCollection")}
              </button>
              <button
                className="library-workbench__menu-danger"
                disabled={disabled}
                onClick={(event) => {
                  if (onDelete(collection)) {
                    closeParentMenu(event.currentTarget, true);
                  }
                }}
                role="menuitem"
                type="button"
              >
                <Trash2 aria-hidden="true" size={13} />
                {t("library.deleteCollection")}
              </button>
            </EntityActionsMenu>
          </div>
          <CollectionTree
            depth={depth + 1}
            disabled={disabled}
            grouped={grouped}
            onCreateChild={onCreateChild}
            onDelete={onDelete}
            onEdit={onEdit}
            onScopeChange={onScopeChange}
            parentId={collection.id}
            scope={scope}
            setIsSidebarOpen={setIsSidebarOpen}
            t={t}
          />
        </div>
      ))}
    </>
  );
}

function groupCollections(collections: LibraryCollection[]) {
  const grouped = new Map<string, LibraryCollection[]>();

  for (const collection of collections) {
    const key = collection.parentId ?? "";
    const siblings = grouped.get(key) ?? [];
    siblings.push(collection);
    grouped.set(key, siblings);
  }

  for (const siblings of grouped.values()) {
    siblings.sort(
      (left, right) =>
        left.sortOrder - right.sortOrder
        || left.name.localeCompare(right.name),
    );
  }

  return grouped;
}

function flattenCollections(collections: LibraryCollection[]) {
  const grouped = groupCollections(collections);
  const flattened: Array<{
    collection: LibraryCollection;
    depth: number;
    path: string;
  }> = [];
  const visited = new Set<string>();

  const visit = (
    parentId: string | undefined,
    depth: number,
    parentPath: string[],
  ) => {
    for (const collection of grouped.get(parentId ?? "") ?? []) {
      if (visited.has(collection.id)) {
        continue;
      }
      visited.add(collection.id);
      const path = [...parentPath, collection.name];
      flattened.push({ collection, depth, path: path.join(" / ") });
      visit(collection.id, depth + 1, path);
    }
  };

  visit(undefined, 0, []);
  for (const collection of collections) {
    if (!visited.has(collection.id)) {
      visited.add(collection.id);
      flattened.push({ collection, depth: 0, path: collection.name });
      visit(collection.id, 1, [collection.name]);
    }
  }

  return flattened;
}

function getCollectionAndDescendantIds(
  collectionId: string,
  collections: LibraryCollection[],
) {
  const grouped = groupCollections(collections);
  const unavailable = new Set<string>();
  const pending = [collectionId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || unavailable.has(currentId)) {
      continue;
    }
    unavailable.add(currentId);
    for (const child of grouped.get(currentId) ?? []) {
      pending.push(child.id);
    }
  }

  return unavailable;
}

function closeParentMenu(target: HTMLElement, restoreFocus = false) {
  const details = target.closest("details");
  details?.removeAttribute("open");
  if (restoreFocus) {
    details?.querySelector("summary")?.focus();
  }
}

function normalizeOrganizationName(name: string) {
  return name.trim().toLowerCase();
}

function selectScope(
  scope: LibraryWorkbenchScope,
  onScopeChange: (scope: LibraryWorkbenchScope) => void,
  setIsSidebarOpen: (value: boolean) => void,
) {
  onScopeChange(scope);
  setIsSidebarOpen(false);
}

function isSystemScope(
  scope: LibraryWorkbenchScope,
  value: Extract<LibraryWorkbenchScope, { type: "system" }>["value"],
) {
  return scope.type === "system" && scope.value === value;
}

function createMetadataDraft(document?: LibraryDocument): MetadataDraft {
  return {
    abstract: document?.bibliographicMetadata.abstract ?? "",
    arxivId: document?.bibliographicMetadata.arxivId ?? "",
    authors: document?.bibliographicMetadata.authors.join("\n") ?? "",
    collectionIds: document?.collections.map((collection) => collection.id) ?? [],
    doi: document?.bibliographicMetadata.doi ?? "",
    publicationVenue: document?.bibliographicMetadata.publicationVenue ?? "",
    publicationYear: document?.bibliographicMetadata.publicationYear?.toString() ?? "",
    readingStatus: document?.readingStatus ?? "inbox",
    tagIds: document?.tags.map((tag) => tag.id) ?? [],
    title: document?.bibliographicMetadata.title ?? "",
  };
}

function splitAuthors(value: string) {
  return parseMetadataAuthors(value);
}

function parseYear(value: string) {
  if (!value.trim()) {
    return null;
  }

  const year = Number.parseInt(value, 10);
  return Number.isFinite(year) && year >= 1 && year <= 3000 ? year : null;
}

function toggleArrayValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function toggleSetValue(values: Set<string>, value: string) {
  const next = new Set(values);

  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }

  return next;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function getStatusLabel(
  status: LibraryReadingStatus,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (status) {
    case "to-read":
      return t("library.status.toRead");
    case "reading":
      return t("library.status.reading");
    case "finished":
      return t("library.status.finished");
    default:
      return t("library.status.inbox");
  }
}

function getSortLabel(
  sort: NonNullable<LibraryDocumentQuery["sort"]>,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (sort) {
    case "title-asc":
      return t("library.sort.titleAsc");
    case "title-desc":
      return t("library.sort.titleDesc");
    case "imported-desc":
      return t("library.sort.importedDesc");
    case "opened-desc":
      return t("library.sort.openedDesc");
    default:
      return t("library.sort.updatedDesc");
  }
}

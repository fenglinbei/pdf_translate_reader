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
  Plus,
  RefreshCw,
  Search,
  Star,
  Tag,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { PdfImportDropzone } from "../pdf/PdfImportDropzone";
import type {
  LibraryCollection,
  LibraryCollectionCreateInput,
  LibraryDocument,
  LibraryDocumentBatchUpdate,
  LibraryDocumentMetadataPatch,
  LibraryDocumentQuery,
  LibraryReadingStatus,
  LibraryTag,
  LibraryTagCreateInput,
} from "../types/domain";
import "./libraryWorkbench.css";

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
  onImport,
  onLoadMore,
  onOpenDocument,
  onQueryChange,
  onRefresh,
  onSaveDocument,
  onScopeChange,
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAddingCollection, setIsAddingCollection] = useState(false);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newTagName, setNewTagName] = useState("");
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
  }, [focusedDocument?.cloudDocumentId, focusedDocument?.libraryUpdatedAt]);

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
      await onSaveDocument(focusedDocument, {
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

  const handleCreateCollection = () => {
    const name = newCollectionName.trim();

    if (!name) {
      return;
    }

    void runMutation(async () => {
      await onCreateCollection({
        name,
        parentId: scope.type === "collection" ? scope.id : undefined,
      });
      setNewCollectionName("");
      setIsAddingCollection(false);
    });
  };

  const handleCreateTag = () => {
    const name = newTagName.trim();

    if (!name) {
      return;
    }

    void runMutation(async () => {
      await onCreateTag({ name });
      setNewTagName("");
      setIsAddingTag(false);
    });
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
                onClick={() => setIsAddingCollection(true)}
                title={t("library.newCollection")}
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {isAddingCollection ? (
              <InlineCreateForm
                ariaLabel={t("library.newCollection")}
                cancelLabel={t("common.cancel")}
                disabled={isMutating}
                onCancel={() => {
                  setIsAddingCollection(false);
                  setNewCollectionName("");
                }}
                onChange={setNewCollectionName}
                onSubmit={handleCreateCollection}
                placeholder={t("library.collectionNamePlaceholder")}
                submitLabel={t("common.confirm")}
                value={newCollectionName}
              />
            ) : null}
            <div className="library-workbench__collection-tree">
              {renderCollectionTree(
                collectionChildren,
                undefined,
                scope,
                onScopeChange,
                setIsSidebarOpen,
              )}
              {collections.length === 0 && !isAddingCollection ? (
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
                onClick={() => setIsAddingTag(true)}
                title={t("library.newTag")}
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
            </div>
            {isAddingTag ? (
              <InlineCreateForm
                ariaLabel={t("library.newTag")}
                cancelLabel={t("common.cancel")}
                disabled={isMutating}
                onCancel={() => {
                  setIsAddingTag(false);
                  setNewTagName("");
                }}
                onChange={setNewTagName}
                onSubmit={handleCreateTag}
                placeholder={t("library.tagNamePlaceholder")}
                submitLabel={t("common.confirm")}
                value={newTagName}
              />
            ) : null}
            <div className="library-workbench__tag-list">
              {tags.map((tag) => (
                <button
                  className={
                    scope.type === "tag" && scope.id === tag.id
                      ? "library-workbench__sidebar-item library-workbench__sidebar-item--active"
                      : "library-workbench__sidebar-item"
                  }
                  key={tag.id}
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
              ))}
              {tags.length === 0 && !isAddingTag ? (
                <p className="library-workbench__sidebar-empty">{t("library.noTags")}</p>
              ) : null}
            </div>
          </div>
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
            </div>
          ) : null}

          {mutationError ? (
            <div className="library-workbench__notice library-workbench__notice--error">
              <span>{mutationError}</span>
              <button onClick={() => setMutationError(undefined)} type="button">
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
                <MetadataSummary
                  document={focusedDocument}
                  formatDate={formatDate}
                  t={t}
                />
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
                    <button onClick={() => setIsEditing(true)} type="button">
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

function InlineCreateForm({
  ariaLabel,
  cancelLabel,
  disabled,
  onCancel,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  value,
}: {
  ariaLabel: string;
  cancelLabel: string;
  disabled: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  value: string;
}) {
  return (
    <form
      aria-label={ariaLabel}
      className="library-workbench__inline-create"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        autoFocus
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <button
        aria-label={submitLabel}
        disabled={disabled || !value.trim()}
        title={submitLabel}
        type="submit"
      >
        <Check aria-hidden="true" size={13} />
      </button>
      <button
        aria-label={cancelLabel}
        disabled={disabled}
        onClick={onCancel}
        title={cancelLabel}
        type="button"
      >
        <X aria-hidden="true" size={13} />
      </button>
    </form>
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

function renderCollectionTree(
  grouped: Map<string, LibraryCollection[]>,
  parentId: string | undefined,
  scope: LibraryWorkbenchScope,
  onScopeChange: (scope: LibraryWorkbenchScope) => void,
  setIsSidebarOpen: (value: boolean) => void,
  depth = 0,
): React.ReactNode {
  const key = parentId ?? "";

  return (grouped.get(key) ?? []).map((collection) => (
    <div key={collection.id}>
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
      {renderCollectionTree(
        grouped,
        collection.id,
        scope,
        onScopeChange,
        setIsSidebarOpen,
        depth + 1,
      )}
    </div>
  ));
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
  return value
    .split(/[\n;,]+/)
    .map((author) => author.trim())
    .filter(Boolean);
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

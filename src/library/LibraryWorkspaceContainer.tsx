import { useCallback, useEffect, useRef, useState } from "react";
import {
  batchUpdateLibraryDocuments,
  createLibraryCollection,
  createLibraryTag,
  deleteLibraryCollection,
  deleteLibraryTag,
  listLibraryCollections,
  listLibraryDocuments,
  listLibraryTags,
  saveLibraryDocument,
  updateLibraryCollection,
  updateLibraryTag,
} from "../cloud/pdfCloudRepository";
import type {
  LibraryCollection,
  LibraryCollectionCreateInput,
  LibraryCollectionUpdateInput,
  LibraryDocument,
  LibraryDocumentBatchUpdate,
  LibraryDocumentQuery,
  LibraryTag,
  LibraryTagCreateInput,
  LibraryTagUpdateInput,
} from "../types/domain";
import { useI18n } from "../i18n/I18nProvider";
import {
  LibraryWorkbench,
  libraryScopeToQuery,
  type LibraryDocumentSaveInput,
  type LibraryWorkbenchScope,
} from "./LibraryWorkbench";

type LibraryWorkspaceContainerProps = {
  activeDocumentId?: string;
  isImporting: boolean;
  onClose: () => void;
  onImport: (file: File) => Promise<boolean | void> | boolean | void;
  onLibraryChanged?: (updatedDocument?: LibraryDocument) => Promise<void> | void;
  onOpenDocument: (document: LibraryDocument) => Promise<boolean | void> | boolean | void;
};

const DEFAULT_SCOPE: LibraryWorkbenchScope = { type: "system", value: "all" };
const DEFAULT_QUERY = libraryScopeToQuery(DEFAULT_SCOPE, {
  archiveMode: "active",
  limit: 50,
  sort: "updated-desc",
});

export function LibraryWorkspaceContainer({
  activeDocumentId,
  isImporting,
  onClose,
  onImport,
  onLibraryChanged,
  onOpenDocument,
}: LibraryWorkspaceContainerProps) {
  const { t } = useI18n();
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [tags, setTags] = useState<LibraryTag[]>([]);
  const [query, setQuery] = useState<LibraryDocumentQuery>(DEFAULT_QUERY);
  const [scope, setScope] = useState<LibraryWorkbenchScope>(DEFAULT_SCOPE);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);
  const queryRef = useRef(query);
  const scopeRef = useRef(scope);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const loadDocuments = useCallback(
    async (nextQuery: LibraryDocumentQuery, append = false) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(undefined);

      try {
        const page = await listLibraryDocuments(nextQuery);

        if (requestId !== requestIdRef.current) {
          return;
        }

        setDocuments((current) =>
          append
            ? mergeLibraryDocuments(current, page.items)
            : page.items
        );
        setTotal(page.total);
      } catch (caughtError) {
        if (requestId === requestIdRef.current) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : t("library.loadFailed"),
          );
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [t],
  );

  const loadOrganization = useCallback(async () => {
    const [nextCollections, nextTags] = await Promise.all([
      listLibraryCollections(),
      listLibraryTags(),
    ]);

    setCollections(nextCollections);
    setTags(nextTags);
  }, []);

  const settleWorkspaceRefresh = useCallback(
    async (operations: Promise<unknown>[]) => {
      const results = await Promise.allSettled(operations);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );

      if (rejected) {
        setError(
          rejected.reason instanceof Error
            ? rejected.reason.message
            : t("library.loadFailed"),
        );
      }
    },
    [t],
  );

  const refreshWorkspace = useCallback(async () => {
    const currentQuery = { ...queryRef.current, offset: 0 };
    setQuery(currentQuery);
    queryRef.current = currentQuery;

    try {
      await Promise.all([
        loadDocuments(currentQuery),
        loadOrganization(),
      ]);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("library.loadFailed"),
      );
    }
  }, [loadDocuments, loadOrganization, t]);

  useEffect(() => {
    void refreshWorkspace().catch(() => undefined);

    return () => {
      requestIdRef.current += 1;
    };
  }, [refreshWorkspace]);

  const refreshAfterMutation = useCallback(
    async (updatedDocument?: LibraryDocument, refreshOrganization = false) => {
      const currentQuery = { ...queryRef.current, offset: 0 };
      setQuery(currentQuery);
      queryRef.current = currentQuery;

      await settleWorkspaceRefresh([
        loadDocuments(currentQuery),
        refreshOrganization ? loadOrganization() : Promise.resolve(),
        Promise.resolve().then(() => onLibraryChanged?.(updatedDocument)),
      ]);
    },
    [loadDocuments, loadOrganization, onLibraryChanged, settleWorkspaceRefresh],
  );

  const handleQueryChange = useCallback(
    (nextQuery: LibraryDocumentQuery) => {
      const normalizedQuery = {
        ...nextQuery,
        limit: nextQuery.limit ?? 50,
        offset: 0,
      };
      setQuery(normalizedQuery);
      queryRef.current = normalizedQuery;
      void loadDocuments(normalizedQuery).catch(() => undefined);
    },
    [loadDocuments],
  );

  const handleScopeChange = useCallback(
    (nextScope: LibraryWorkbenchScope) => {
      const nextQuery = libraryScopeToQuery(nextScope, queryRef.current);
      setScope(nextScope);
      scopeRef.current = nextScope;
      setQuery(nextQuery);
      queryRef.current = nextQuery;
      void loadDocuments(nextQuery).catch(() => undefined);
    },
    [loadDocuments],
  );

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || documents.length >= total) {
      return;
    }

    await loadDocuments(
      {
        ...queryRef.current,
        offset: documents.length,
      },
      true,
    );
  }, [documents.length, isLoadingMore, loadDocuments, total]);

  const handleBatchUpdate = useCallback(
    async (input: LibraryDocumentBatchUpdate) => {
      const updatedDocuments = await batchUpdateLibraryDocuments(input);
      const activeUpdatedDocument = updatedDocuments.find(
        (document) => document.cloudDocumentId === activeDocumentId,
      );

      await refreshAfterMutation(activeUpdatedDocument);
    },
    [activeDocumentId, refreshAfterMutation],
  );

  const handleSaveDocument = useCallback(
    async (document: LibraryDocument, input: LibraryDocumentSaveInput) => {
      const refreshedDocument = await saveLibraryDocument(
        document.cloudDocumentId,
        input.metadata,
        {
          collectionIds: input.collectionIds,
          tagIds: input.tagIds,
        },
      );

      await refreshAfterMutation(
        refreshedDocument?.cloudDocumentId === activeDocumentId
          ? refreshedDocument
          : undefined,
      );
    },
    [activeDocumentId, refreshAfterMutation],
  );

  const handleCreateCollection = useCallback(
    async (input: LibraryCollectionCreateInput) => {
      await createLibraryCollection(input);
      await refreshAfterMutation(undefined, true);
    },
    [refreshAfterMutation],
  );

  const handleCreateTag = useCallback(
    async (input: LibraryTagCreateInput) => {
      await createLibraryTag(input);
      await refreshAfterMutation(undefined, true);
    },
    [refreshAfterMutation],
  );

  const handleUpdateCollection = useCallback(
    async (collectionId: string, input: LibraryCollectionUpdateInput) => {
      await updateLibraryCollection(collectionId, input);
      await refreshAfterMutation(undefined, true);
    },
    [refreshAfterMutation],
  );

  const handleDeleteCollection = useCallback(
    async (collection: LibraryCollection) => {
      await deleteLibraryCollection(collection.id);

      const currentScope = scopeRef.current;
      if (currentScope.type === "collection" && currentScope.id === collection.id) {
        const parentExists = Boolean(
          collection.parentId
          && collections.some((candidate) => candidate.id === collection.parentId),
        );
        const nextScope: LibraryWorkbenchScope = parentExists && collection.parentId
          ? { type: "collection", id: collection.parentId }
          : DEFAULT_SCOPE;
        const nextQuery = libraryScopeToQuery(nextScope, queryRef.current);

        setScope(nextScope);
        scopeRef.current = nextScope;
        setQuery(nextQuery);
        queryRef.current = nextQuery;

        await settleWorkspaceRefresh([
          loadDocuments(nextQuery),
          loadOrganization(),
          Promise.resolve().then(() => onLibraryChanged?.()),
        ]);
        return;
      }

      await refreshAfterMutation(undefined, true);
    },
    [
      collections,
      loadDocuments,
      loadOrganization,
      onLibraryChanged,
      refreshAfterMutation,
      settleWorkspaceRefresh,
    ],
  );

  const handleUpdateTag = useCallback(
    async (tagId: string, input: LibraryTagUpdateInput) => {
      await updateLibraryTag(tagId, input);
      await refreshAfterMutation(undefined, true);
    },
    [refreshAfterMutation],
  );

  const handleDeleteTag = useCallback(
    async (tag: LibraryTag) => {
      await deleteLibraryTag(tag.id);

      const currentScope = scopeRef.current;
      if (currentScope.type === "tag" && currentScope.id === tag.id) {
        const nextQuery = libraryScopeToQuery(DEFAULT_SCOPE, queryRef.current);

        setScope(DEFAULT_SCOPE);
        scopeRef.current = DEFAULT_SCOPE;
        setQuery(nextQuery);
        queryRef.current = nextQuery;

        await settleWorkspaceRefresh([
          loadDocuments(nextQuery),
          loadOrganization(),
          Promise.resolve().then(() => onLibraryChanged?.()),
        ]);
        return;
      }

      await refreshAfterMutation(undefined, true);
    },
    [
      loadDocuments,
      loadOrganization,
      onLibraryChanged,
      refreshAfterMutation,
      settleWorkspaceRefresh,
    ],
  );

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const imported = await onImport(file);

        if (imported === false) {
          setError(t("library.importFailed"));
          return;
        }

        await refreshWorkspace();
        await onLibraryChanged?.();
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : t("library.importFailed"),
        );
      }
    },
    [onImport, onLibraryChanged, refreshWorkspace, t],
  );

  const handleOpenDocument = useCallback(
    async (document: LibraryDocument) => {
      const opened = await onOpenDocument(document);

      if (opened !== false) {
        onClose();
      }
    },
    [onClose, onOpenDocument],
  );

  return (
    <LibraryWorkbench
      activeDocumentId={activeDocumentId}
      collections={collections}
      documents={documents}
      error={error}
      hasMore={documents.length < total}
      isImporting={isImporting}
      isLoading={isLoading}
      isLoadingMore={isLoadingMore}
      onBatchUpdate={handleBatchUpdate}
      onClose={onClose}
      onCreateCollection={handleCreateCollection}
      onCreateTag={handleCreateTag}
      onDeleteCollection={handleDeleteCollection}
      onDeleteTag={handleDeleteTag}
      onImport={handleImport}
      onLoadMore={handleLoadMore}
      onOpenDocument={handleOpenDocument}
      onQueryChange={handleQueryChange}
      onRefresh={refreshWorkspace}
      onSaveDocument={handleSaveDocument}
      onScopeChange={handleScopeChange}
      onUpdateCollection={handleUpdateCollection}
      onUpdateTag={handleUpdateTag}
      query={query}
      scope={scope}
      tags={tags}
      total={total}
    />
  );
}

function mergeLibraryDocuments(
  current: LibraryDocument[],
  incoming: LibraryDocument[],
) {
  const documentsById = new Map(
    current.map((document) => [document.cloudDocumentId, document]),
  );

  for (const document of incoming) {
    documentsById.set(document.cloudDocumentId, document);
  }

  return Array.from(documentsById.values());
}

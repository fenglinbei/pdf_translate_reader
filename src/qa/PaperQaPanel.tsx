import { remarkCitations } from './remarkCitations';
import { AgentActivity } from './AgentActivity';
import { prefetchArtifactSources } from './documentArtifacts/locationClient';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  FileText,
  History,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useI18n } from "../i18n/I18nProvider";
import { PROJECT_CONFIG } from "../config/projectConfig";
import { getAvailableModelIds, getModelLabel, MODEL_DEFAULTS } from "../../shared/modelRegistry.mjs";
import type {
  QaAnswerLanguage,
  QaAgentStep,
  QaChatModel,
  QaCitation,
  QaIndexJob,
  QaMessage,
  QaReasoningEffort,
  QaRetrievedEvidence,
  QaRetrievalSnapshot,
  QaThread,
  QaToolCall,
  TokenUsage,
} from "../types/domain";
import {
  deleteQaMessage,
  deleteQaThread,
  getQaThreadMessages,
  getQaDocumentReadiness,
  type QaDocumentReadiness,
  getQaThreads,
  streamQaAnswer,
  type QaVerifierPayload,
  getQaCapabilities,
  type QaCapabilities,
} from "./qaClient";
import { qaSourceKey, sameQaSource } from "./sourceIdentity";
import { QaCitationSource } from "./QaCitationSource";
import type { MessageKey } from "../i18n/messages";

export type QaSessionState = { threadId?: string; streaming: boolean; title?: string };
type PaperQaPanelProps = {
  managedSession?: { key: string; initialThreadId?: string };
  sessionTitle?: string;
  headerLeading?: ReactNode;
  visible?: boolean;
  onSessionState?: (key: string, state: QaSessionState) => void;
  onHistoryChanged?: () => void;
  onNewSession?: () => void;
  workspace?: boolean;
  activeDocumentId?: string;
  isFullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onReadinessChange?: (readiness?: QaDocumentReadiness) => void;
  qaIndexJob?: QaIndexJob;
  onCitationClick: (citation: QaCitation, pageNumber?: number) => void;
  onEvidenceClick: (evidence: QaRetrievedEvidence) => void;
};

type LocalQaMessage = {
  agentSteps?: QaAgentStep[];
  citations: QaCitation[];
  content: string;
  createdAt?: number;
  errorMessage?: string;
  id: string;
  model?: QaChatModel;
  reasoningText?: string;
  retrievalSnapshot?: QaRetrievalSnapshot;
  role: "user" | "assistant";
  status: "streaming" | "success" | "error" | "aborted";
  usage?: TokenUsage;
};

type SelectedEvidenceRef = {
  sourceKey?: string;
  evidenceId?: string;
  messageId: string;
};

const QA_MODELS = getAvailableModelIds("qa");
const QA_REASONING_EFFORTS: QaReasoningEffort[] = ["auto", "quick", "standard", "deep"];

export function PaperQaPanel({
  managedSession, sessionTitle, headerLeading, visible = true, onSessionState, onHistoryChanged, onNewSession,
  workspace = false,
  activeDocumentId,
  isFullscreen: isFullscreenProp,
  onCitationClick,
  onEvidenceClick,
  onFullscreenChange,
  onReadinessChange,
  qaIndexJob,
}: PaperQaPanelProps) {
  const { t } = useI18n();
  const [answerLanguage] = useState<QaAnswerLanguage>("auto");
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  const [draftQuestion, setDraftQuestion] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input?.offsetWidth) return;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, []);
  useLayoutEffect(resizeInput, [draftQuestion, visible, resizeInput]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resizeInput();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizeInput]);
  const [isFullscreenInternal, setIsFullscreenInternal] = useState(false);
  const isFullscreen = onFullscreenChange ? Boolean(isFullscreenProp) : isFullscreenInternal;
  const setFullscreen = useCallback((next: boolean) => {
    if (onFullscreenChange) {
      onFullscreenChange(next);
    } else {
      setIsFullscreenInternal(next);
    }
  }, [onFullscreenChange]);
  const [operatingMessageId, setOperatingMessageId] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<LocalQaMessage[]>([]);
  const [model, setModel] = useState<QaChatModel>(MODEL_DEFAULTS.qa);
  const [reasoningEffort, setReasoningEffort] = useState<QaReasoningEffort>("auto");
  // Scope binds history and permissions. The agent chooses whether this
  // individual question needs document tools within the same conversation.
  const scope = workspace ? 'workspace' : activeDocumentId ? 'current' : 'general';
  const conversationDocumentId = scope === 'current' ? activeDocumentId : undefined;
  const scopeKey = `${scope}:${conversationDocumentId ?? ''}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const [capabilities, setCapabilities] = useState<QaCapabilities>();
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const [capabilitiesError, setCapabilitiesError] = useState<string>();
  const [retrievalWarnings, setRetrievalWarnings] = useState<string[]>([]);
  const [selectedEvidenceRef, setSelectedEvidenceRef] = useState<SelectedEvidenceRef>();
  const [threadId, setThreadId] = useState<string | undefined>(managedSession?.initialThreadId);
  const [threads, setThreads] = useState<QaThread[]>([]);
  const [hasMoreThreads, setHasMoreThreads] = useState(false);
  const [verifierWarnings, setVerifierWarnings] = useState<string[]>([]);
  const [highlightedEvidenceId, setHighlightedEvidenceId] = useState<string>();
  const abortControllerRef = useRef<AbortController>();
  const historyRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const highlightTimerRef = useRef<number>();
  // Set right after a stream finishes so the threadId effect can skip refetching
  // the messages we already have from onDone.
  const justFinishedStreamRef = useRef(false);
  const [readiness, setReadiness] = useState<QaDocumentReadiness>();
  const [readinessLoading, setReadinessLoading] = useState(true);
  const [readinessError, setReadinessError] = useState<string>();
  const nativeRuntime = workspace || capabilities?.runtime === "document-tools-v1" || readiness?.documentId === activeDocumentId && readiness?.runtime === "document-tools-v1";
  const enabledModels = scope !== 'current' ? capabilities?.models : readiness?.models ?? capabilities?.models;
  const availableModels = nativeRuntime ? QA_MODELS.filter((id) => enabledModels?.includes(id)) : QA_MODELS;
  const historyEnabled = scope !== 'current' ? Boolean(capabilities?.generalChat) : Boolean(conversationDocumentId);
  const isReady = scope !== 'current'
    ? Boolean(!capabilitiesLoading && !capabilitiesError && capabilities?.generalChat && availableModels.includes(model))
    : Boolean(conversationDocumentId && !readinessLoading && !readinessError && (nativeRuntime
    ? availableModels.includes(model)
    : qaIndexJob?.status === "ready" && qaIndexJob?.chunkerVersion === PROJECT_CONFIG.qa.chunkerVersion));

  const sessionQuestion = messages.find(message => message.role === 'user')?.content || draftQuestion;
  useEffect(() => {
    if (managedSession) onSessionState?.(managedSession.key, { threadId, streaming: isStreaming, title: sessionQuestion?.slice(0, 100) });
  }, [managedSession?.key, threadId, isStreaming, sessionQuestion, onSessionState]);
  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);

  useEffect(() => {
    if (!visible && capabilities) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await getQaCapabilities();
        if (disposed) return;
        setCapabilities(next); setCapabilitiesError(undefined);
        if (next && ['document-tools-v1', 'workspace-tools-v1'].includes(next.runtime)) {
          const enabled = QA_MODELS.filter(id => next.models.includes(id));
          setModel(current => enabled.includes(current) ? current : enabled[0] ?? current);
        }
      } catch (error) {
        if (!disposed) setCapabilitiesError(error instanceof Error ? error.message : t('ask.answerFailed'));
      } finally {
        if (!disposed) { setCapabilitiesLoading(false); timer = window.setTimeout(refresh, 15000); }
      }
    };
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [t, visible]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    setReadiness(undefined); setReadinessError(undefined); setReadinessLoading(true);
    onReadinessChange?.(undefined);
    if (!activeDocumentId || workspace) { setReadinessLoading(false); return; }
    const refresh = async () => {
      try {
        const next = await getQaDocumentReadiness(activeDocumentId);
        if (disposed) return;
        setReadiness(next); setReadinessError(undefined);
        onReadinessChange?.(next);
        if (next?.runtime === "document-tools-v1") {
          const enabled = QA_MODELS.filter((id) => next.models.includes(id));
          setModel((current) => enabled.includes(current) ? current : enabled[0] ?? current);
        }
      } catch (error) {
        if (!disposed) {
          setReadinessError(error instanceof Error ? error.message : t("ask.readinessFailed"));
          onReadinessChange?.(undefined);
        }
      }
      finally { if (!disposed) { setReadinessLoading(false); timer = window.setTimeout(refresh, 15000); } }
    };
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [activeDocumentId, workspace, t, onReadinessChange]);

  const warnings = useMemo(
    () => uniqueStrings([
      ...(scope === 'current' && readinessError ? [readinessError] : []),
      ...(scope !== 'current' && capabilitiesError ? [capabilitiesError] : []),
      ...retrievalWarnings,
      ...verifierWarnings,
      ...(historyError ? [historyError] : []),
    ]),
    [scope, capabilitiesError, historyError, readinessError, retrievalWarnings, verifierWarnings],
  );

  const refreshThreads = useCallback(async (options: { selectLatest?: boolean; silent?: boolean } = {}) => {
    if (managedSession) { onHistoryChanged?.(); return []; }
    if (!historyEnabled) {
      setThreads([]);
      return [];
    }

    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    if (!options.silent) {
      setIsLoadingThreads(true);
    }
    setHistoryError(undefined);

    try {
      const nextThreads = await getQaThreads(conversationDocumentId, scope);

      if (historyRequestRef.current !== requestId) {
        return nextThreads;
      }

      setThreads(nextThreads);
      setHasMoreThreads(workspace && nextThreads.length === 30);

      if (options.selectLatest) {
        const latestThread = nextThreads[0];
        setThreadId(latestThread?.id);
        setMessages(latestThread ? [] : []);
      }

      return nextThreads;
    } catch (error) {
      if (historyRequestRef.current === requestId) {
        setHistoryError(error instanceof Error ? error.message : t("ask.historyFailed"));
        setThreads([]);
      }

      return [];
    } finally {
      if (historyRequestRef.current === requestId && !options.silent) {
        setIsLoadingThreads(false);
      }
    }
  }, [conversationDocumentId, scope, historyEnabled, workspace, t, managedSession, onHistoryChanged]);

  const loadMoreThreads = useCallback(async () => {
    if (isLoadingThreads || !hasMoreThreads) return;
    const request = ++historyRequestRef.current;
    setIsLoadingThreads(true);
    try {
      const next = await getQaThreads(conversationDocumentId, scope, threads.length);
      if (request !== historyRequestRef.current) return;
      setThreads(current => [...current, ...next.filter(thread => !current.some(item => item.id === thread.id))]);
      setHasMoreThreads(next.length === 30);
    } catch (error) {
      if (request === historyRequestRef.current) setHistoryError(error instanceof Error ? error.message : t("ask.historyFailed"));
    } finally {
      if (request === historyRequestRef.current) setIsLoadingThreads(false);
    }
  }, [conversationDocumentId, scope, threads.length, isLoadingThreads, hasMoreThreads, t]);

  useEffect(() => {
    if (managedSession) return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    historyRequestRef.current += 1;
    messagesRequestRef.current += 1;
    justFinishedStreamRef.current = false;
    setDraftQuestion("");
    setHistoryError(undefined);
    setIsLoadingMessages(false);
    setIsLoadingThreads(false);
    setIsStreaming(false);
    setMessages([]);
    setRetrievalWarnings([]);
    setSelectedEvidenceRef(undefined);
    setThreadId(undefined);
    setThreads([]);
    setVerifierWarnings([]);

    if (historyEnabled) {
      void refreshThreads({ selectLatest: true });
    }
  }, [conversationDocumentId, scope, historyEnabled, refreshThreads, managedSession]);

  useEffect(() => {
    if (!isFullscreen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    if (!threadId || isStreaming) {
      return;
    }

    // A stream just finished: onDone already wrote the final messages locally,
    // so skip the refetch that would otherwise flash the loading placeholder.
    if (justFinishedStreamRef.current) {
      justFinishedStreamRef.current = false;
      return;
    }

    const requestId = messagesRequestRef.current + 1;
    messagesRequestRef.current = requestId;
    setIsLoadingMessages(true);
    setHistoryError(undefined);
    setRetrievalWarnings([]);
    setVerifierWarnings([]);
    setSelectedEvidenceRef(undefined);

    void getQaThreadMessages(threadId)
      .then((nextMessages) => {
        if (messagesRequestRef.current !== requestId) {
          return;
        }

        setMessages(nextMessages.map(qaMessageToLocal));
      })
      .catch((error) => {
        if (messagesRequestRef.current === requestId) {
          setHistoryError(error instanceof Error ? error.message : t("ask.messagesFailed"));
          setMessages([]);
        }
      })
      .finally(() => {
        if (messagesRequestRef.current === requestId) {
          setIsLoadingMessages(false);
        }
      });
  }, [isStreaming, t, threadId]);

  const updateAssistantMessage = useCallback((
    messageId: string,
    updater: (message: LocalQaMessage) => LocalQaMessage,
  ) => {
    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === messageId ? updater(message) : message
      )
    );
  }, []);

  const handleNewThread = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    messagesRequestRef.current += 1;
    setDraftQuestion("");
    setHistoryError(undefined);
    setIsLoadingMessages(false);
    setIsStreaming(false);
    setMessages([]);
    setRetrievalWarnings([]);
    setSelectedEvidenceRef(undefined);
    setThreadId(undefined);
    setVerifierWarnings([]);
  }, []);

  const handleThreadSelect = useCallback((nextThreadId: string) => {
    if (isStreaming || nextThreadId === threadId) {
      return;
    }

    messagesRequestRef.current += 1;
    setMessages([]);
    setSelectedEvidenceRef(undefined);
    setThreadId(nextThreadId);
  }, [isStreaming, threadId]);

  const handleThreadDelete = useCallback(async (thread: QaThread) => {
    if (isStreaming || deletingThreadId) {
      return;
    }

    const title = thread.title || t("ask.untitledThread");

    if (!window.confirm(t("ask.deleteThreadConfirm", { title }))) {
      return;
    }

    setDeletingThreadId(thread.id);
    setHistoryError(undefined);

    try {
      await deleteQaThread(thread.id);

      const remainingThreads = threads.filter((item) => item.id !== thread.id);

      setThreads(remainingThreads);

      if (threadId === thread.id) {
        messagesRequestRef.current += 1;
        setMessages([]);
        setRetrievalWarnings([]);
        setSelectedEvidenceRef(undefined);
        setVerifierWarnings([]);
        setThreadId(remainingThreads[0]?.id);
      }

      void refreshThreads();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : t("ask.deleteThreadFailed"));
    } finally {
      setDeletingThreadId(undefined);
    }
  }, [
    deletingThreadId,
    isStreaming,
    refreshThreads,
    t,
    threadId,
    threads,
  ]);

  const handleCopyMessage = useCallback(async (message: LocalQaMessage) => {
    if (!message.content) {
      return;
    }

    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) => (current === message.id ? undefined : current));
      }, 2000);
    } catch {
      setHistoryError(t("ask.copyFailed"));
    }
  }, [t]);

  const handleMessageDelete = useCallback(async (message: LocalQaMessage) => {
    if (isStreaming || operatingMessageId) {
      return;
    }

    if (!window.confirm(t("ask.deleteAnswerConfirm"))) {
      return;
    }

    setOperatingMessageId(message.id);
    setHistoryError(undefined);

    try {
      await deleteQaMessage(message.id);

      // Optimistically remove the assistant message and its preceding user turn.
      setMessages((currentMessages) => {
        const index = currentMessages.findIndex((item) => item.id === message.id);
        if (index < 0) {
          return currentMessages;
        }

        const nextMessages = [...currentMessages];
        // Remove the assistant message.
        nextMessages.splice(index, 1);
        // If the immediately preceding message is the matching user turn, remove it too.
        if (index > 0 && nextMessages[index - 1].role === "user") {
          nextMessages.splice(index - 1, 1);
        }

        return nextMessages;
      });

      void refreshThreads({ silent: true });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : t("ask.deleteAnswerFailed"));
    } finally {
      setOperatingMessageId(undefined);
    }
  }, [isStreaming, operatingMessageId, refreshThreads, t]);

  const handleRegenerateMessage = useCallback(async (message: LocalQaMessage) => {
    if (!isReady || isStreaming || operatingMessageId || !threadId) {
      return;
    }

    // Find the user question that produced this assistant message.
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) {
      return;
    }

    const userMessage = [...messages.slice(0, index)].reverse().find((item) => item.role === "user");
    const question = userMessage?.content ?? "";

    if (!question) {
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setOperatingMessageId(message.id);
    setHistoryError(undefined);
    setRetrievalWarnings([]);
    setSelectedEvidenceRef(undefined);
    setVerifierWarnings([]);

    // Reset the assistant message to a streaming placeholder so the UI shows
    // a fresh generation in place.
    setMessages((currentMessages) => currentMessages.map((item) => (
      item.id === message.id
        ? {
          ...item,
          agentSteps: [],
          citations: [],
          content: "",
          reasoningText: undefined,
          retrievalSnapshot: undefined,
          status: "streaming",
        }
        : item
    )));

    try {
      setIsStreaming(true);
      await streamQaAnswer(
        {
          activeDocumentId: workspace ? activeDocumentId : conversationDocumentId,
          answerLanguage,
          executionMode: "agentic",
          model,
          question,
          reasoningEffort,
          regenerateMessageId: message.id,
          scope,
          threadId,
        },
        {
          onAgentStep: (step) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              agentSteps: mergeAgentStep(current.agentSteps ?? [], step),
            }));
          },
          onCitation: (citations) => {
            prefetchArtifactSources(citations);
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              citations,
            }));
          },
          onDelta: (text) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              content: `${current.content}${text}`,
            }));
          },
          onAnswerReset: () => {
            updateAssistantMessage(message.id, (current) => ({ ...current, content: "", citations: [], retrievalSnapshot: undefined }));
          },
          onAnswerUpdate: (content, citations) => {
            prefetchArtifactSources(citations);
            updateAssistantMessage(message.id, (current) => ({ ...current, content, citations }));
          },
          onDone: (payload) => {
            if (scopeKeyRef.current !== scopeKey || abortController.signal.aborted) return;
            const assistantMessage = payload.assistantMessage;

            if (assistantMessage) {
              updateAssistantMessage(message.id, (current) => ({
                ...qaMessageToLocal({
                  ...assistantMessage,
                  citations: payload.citations ?? assistantMessage.citations ?? [],
                }),
                content: current.content || assistantMessage.content,
                id: assistantMessage.id,
                reasoningText: current.reasoningText,
              }));
            } else {
              updateAssistantMessage(message.id, (current) => ({
                ...current,
                status: "success",
              }));
            }

            justFinishedStreamRef.current = true;
            void refreshThreads({ silent: true });
          },
          onGapCheck: (step) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              agentSteps: mergeAgentStep(current.agentSteps ?? [], step),
            }));
          },
          onMeta: (metadata) => {
            if (scopeKeyRef.current !== scopeKey || abortController.signal.aborted) return;
            setThreadId(metadata.threadId);
          },
          onObservation: (step) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              agentSteps: mergeAgentStep(current.agentSteps ?? [], step),
            }));
          },
          onRetrieval: (retrievalPayload) => {
            setRetrievalWarnings(retrievalPayload.warnings ?? []);
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              retrievalSnapshot: retrievalPayload.snapshot,
            }));
          },
          onThinking: (text) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              reasoningText: `${current.reasoningText ?? ""}${text}`,
            }));
          },
          onToolCall: ({ step, toolCall }) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              agentSteps: mergeAgentStep(current.agentSteps ?? [], {
                ...step,
                toolCall: toolCall ?? step.toolCall,
              }),
            }));
          },
          onUsage: (usage) => {
            updateAssistantMessage(message.id, (current) => ({
              ...current,
              usage,
            }));
          },
          onVerifier: (verifierPayload: QaVerifierPayload) => {
            setVerifierWarnings(verifierPayload.warnings ?? []);
          },
        },
        abortController.signal,
      );
    } catch (error) {
      updateAssistantMessage(message.id, (current) => ({
        ...current,
        agentSteps: (current.agentSteps ?? []).map(step => step.status === "running" ? { ...step, status: "error" } : step),
        errorMessage: abortController.signal.aborted
          ? t("ask.stopped")
          : error instanceof Error
            ? error.message
            : t("ask.answerFailed"),
        status: abortController.signal.aborted ? "aborted" : "error",
      }));
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = undefined;
        setIsStreaming(false);
        setOperatingMessageId(undefined);
      }
    }
  }, [
    conversationDocumentId,
    activeDocumentId,
    workspace,
    scope,
    scopeKey,
    answerLanguage,
    isReady,
    isStreaming,
    messages,
    model,
    operatingMessageId,
    reasoningEffort,
    t,
    threadId,
    updateAssistantMessage,
  ]);

  const flashEvidence = useCallback((evidenceId: string) => {
    setHighlightedEvidenceId(evidenceId);
    window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedEvidenceId((current) => (current === evidenceId ? undefined : current));
    }, 1800);
  }, []);

  const handleCitationChipClick = useCallback((
    message: LocalQaMessage,
    citation: QaCitation,
    pageNumber?: number,
  ) => {
    const linkedEvidence = messageEvidence(message)
      .find((item) => sameQaSource(item, citation));
    onCitationClick(citation, pageNumber);
    setSelectedEvidenceRef({
      sourceKey: qaSourceKey(citation),
      messageId: message.id,
    });
    if (linkedEvidence) {
      flashEvidence(linkedEvidence.evidenceId);
    }
  }, [flashEvidence, onCitationClick]);

  const handleEvidenceOpen = useCallback((
    message: LocalQaMessage,
    evidence: QaRetrievedEvidence,
  ) => {
    onEvidenceClick(evidence);
    flashEvidence(evidence.evidenceId);
  }, [flashEvidence, onEvidenceClick]);

  const handleCitationTokenClick = useCallback((
    message: LocalQaMessage,
    evidenceId: string,
  ) => {
    const evidenceList = messageEvidence(message);
    const evidence = evidenceList.find((item) => item.evidenceId === evidenceId);

    setSelectedEvidenceRef({
      sourceKey: evidence ? qaSourceKey(evidence) : undefined,
      evidenceId,
      messageId: message.id,
    });

    if (evidence) {
      flashEvidence(evidence.evidenceId);

      const citation = message.citations.find((item) => sameQaSource(item, evidence));

      if (citation && (workspace || citation.cloudDocumentId === activeDocumentId)) {
        onCitationClick(citation);
      }
    }
  }, [activeDocumentId, workspace, flashEvidence, onCitationClick]);

  const handleSubmit = useCallback(async () => {
    const question = draftQuestion.trim();

    if (!question || !isReady || isStreaming || isLoadingMessages) {
      return;
    }

    const requestStartedAt = Date.now();
    const localUserMessageId = `local-user-${requestStartedAt}`;
    const localAssistantMessageId = `local-assistant-${requestStartedAt}`;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setDraftQuestion("");
    setHistoryError(undefined);
    setIsStreaming(true);
    setRetrievalWarnings([]);
    setSelectedEvidenceRef(undefined);
    setVerifierWarnings([]);
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        citations: [],
        content: question,
        createdAt: requestStartedAt,
        id: localUserMessageId,
        role: "user",
        status: "success",
      },
      {
        agentSteps: [],
        citations: [],
        content: "",
        createdAt: requestStartedAt + 1,
        id: localAssistantMessageId,
        model,
        role: "assistant",
        status: "streaming",
      },
    ]);

    try {
      await streamQaAnswer(
        {
          activeDocumentId: workspace ? activeDocumentId : conversationDocumentId,
          answerLanguage,
          executionMode: "agentic",
          model,
          question,
          reasoningEffort,
          scope,
          threadId,
        },
        {
          onAgentStep: (step) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              agentSteps: mergeAgentStep(message.agentSteps ?? [], step),
            }));
          },
          onCitation: (citations) => {
            prefetchArtifactSources(citations);
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              citations,
            }));
          },
          onDelta: (text) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              content: `${message.content}${text}`,
            }));
          },
          onAnswerReset: () => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({ ...message, content: "", citations: [], retrievalSnapshot: undefined }));
          },
          onAnswerUpdate: (content, citations) => {
            prefetchArtifactSources(citations);
            updateAssistantMessage(localAssistantMessageId, (message) => ({ ...message, content, citations }));
          },
          onDone: (payload) => {
            if (scopeKeyRef.current !== scopeKey || abortController.signal.aborted) return;
            setThreadId(payload.threadId);
            const assistantMessage = payload.assistantMessage;

            if (assistantMessage) {
              updateAssistantMessage(localAssistantMessageId, (message) => ({
                ...qaMessageToLocal({
                  ...assistantMessage,
                  citations: payload.citations ?? assistantMessage.citations ?? [],
                }),
                // Keep the locally streamed content to avoid a visual flash when the
                // server version (which should be identical) replaces it.
                content: message.content || assistantMessage.content,
                id: assistantMessage.id,
                // Preserve the streaming reasoning trace; it is not persisted server-side.
                reasoningText: message.reasoningText,
              }));
            } else {
              updateAssistantMessage(localAssistantMessageId, (message) => ({
                ...message,
                status: "success",
              }));
            }

            // Signal the threadId effect to skip refetching — we already have
            // the final messages from onDone.
            justFinishedStreamRef.current = true;
            // Silently sync the thread list without toggling the loading spinner.
            void refreshThreads({ silent: true });
          },
          onGapCheck: (step) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              agentSteps: mergeAgentStep(message.agentSteps ?? [], step),
            }));
          },
          onMeta: (metadata) => {
            if (scopeKeyRef.current !== scopeKey || abortController.signal.aborted) return;
            setThreadId(metadata.threadId);
          },
          onObservation: (step) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              agentSteps: mergeAgentStep(message.agentSteps ?? [], step),
            }));
          },
          onRetrieval: (payload) => {
            setRetrievalWarnings(payload.warnings ?? []);
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              retrievalSnapshot: payload.snapshot,
            }));
          },
          onThinking: (text) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              reasoningText: `${message.reasoningText ?? ""}${text}`,
            }));
          },
          onUsage: (usage) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              usage,
            }));
          },
          onToolCall: ({ step, toolCall }) => {
            updateAssistantMessage(localAssistantMessageId, (message) => ({
              ...message,
              agentSteps: mergeAgentStep(message.agentSteps ?? [], {
                ...step,
                toolCall: toolCall ?? step.toolCall,
              }),
            }));
          },
          onVerifier: (payload: QaVerifierPayload) => {
            setVerifierWarnings(payload.warnings ?? []);
          },
        },
        abortController.signal,
      );
    } catch (error) {
      updateAssistantMessage(localAssistantMessageId, (message) => ({
        ...message,
        agentSteps: (message.agentSteps ?? []).map(step => step.status === "running" ? { ...step, status: "error" } : step),
        errorMessage: abortController.signal.aborted
          ? t("ask.stopped")
          : error instanceof Error
            ? error.message
            : t("ask.answerFailed"),
        status: abortController.signal.aborted ? "aborted" : "error",
      }));
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = undefined;
        setIsStreaming(false);
      }
    }
  }, [
    conversationDocumentId,
    activeDocumentId,
    workspace,
    scope,
    scopeKey,
    answerLanguage,
    draftQuestion,
    isLoadingMessages,
    isReady,
    isStreaming,
    model,
    reasoningEffort,
    refreshThreads,
    t,
    threadId,
    updateAssistantMessage,
  ]);

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return (
    <>
      <section
        aria-label={t(workspace ? "ask.workspaceTitle" : nativeRuntime ? 'ask.autoChat' : scope !== 'current' ? 'ask.generalChat' : "ask.chatSection")}
        className={`ask-workbench ${isFullscreen ? "ask-workbench--fullscreen" : ""}`}
      >
      <header className="ask-workbench-header">
        {headerLeading}
        <div className="ask-workbench-title-block">
          <div className="ask-workbench-title">{sessionTitle || t(workspace ? "ask.workspaceTitle" : nativeRuntime ? 'ask.autoChat' : scope !== 'current' ? 'ask.generalChat' : "ask.chatTitle")}</div>
          <div className="ask-workbench-status">
            {workspace ? t("ask.workspaceReady") : scope !== 'current' ? t(isReady ? 'ask.generalReady' : capabilitiesLoading ? 'ask.connecting' : 'ask.generalUnavailable')
              : isReady ? t(nativeRuntime ? readiness?.state === 'readable' ? 'ask.autoReady' : 'ask.autoNeedsParsing' : "ask.chatReady")
                : nativeRuntime ? t('ask.connecting') : t("ask.chatWaitingForIndex")}
            {isStreaming ? <span>{t("ask.streaming")}</span> : null}
          </div>
        </div>
        <div className="ask-workbench-actions">
          {isLoadingThreads ? (
            <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={16} strokeWidth={2.2} />
          ) : null}
          <button
            className="ask-icon-button"
            disabled={!managedSession && isStreaming}
            onClick={onNewSession ?? handleNewThread}
            title={t("ask.newThread")}
            type="button"
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.2} />
          </button>
          {!managedSession ? <button
            className="ask-icon-button"
            onClick={() => setFullscreen(!isFullscreen)}
            title={isFullscreen ? t("ask.exitFullscreen") : t("ask.enterFullscreen")}
            type="button"
          >
            {isFullscreen
              ? <Minimize2 aria-hidden="true" size={15} strokeWidth={2.2} />
              : <Maximize2 aria-hidden="true" size={15} strokeWidth={2.2} />}
          </button> : null}
        </div>
      </header>

      {warnings.length > 0 ? (
        <div className="ask-warning-stack">
          {warnings.map((warning) => (
            <div className="ask-warning" key={warning}>
              <AlertTriangle aria-hidden="true" size={14} strokeWidth={2.2} />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {!managedSession ? <ThreadHistory
        activeThreadId={threadId}
        deletingThreadId={deletingThreadId}
        disabled={isStreaming}
        isLoading={isLoadingThreads}
        onDelete={handleThreadDelete}
        onSelect={handleThreadSelect}
        threads={workspace ? threads : threads.slice(0, 6)}
        onMore={hasMoreThreads ? loadMoreThreads : undefined}
      /> : null}

      <div className="ask-message-stream" aria-busy={isLoadingMessages} aria-live="polite">
        {isLoadingMessages ? (
          <div className="ask-chat-empty">
            <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={16} strokeWidth={2.2} />
            <span>{t("ask.loadingMessages")}</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="ask-chat-empty">
            <Search aria-hidden="true" size={18} strokeWidth={2} />
            <span>{t(workspace ? 'ask.workspaceEmpty' : scope !== 'current' ? 'ask.generalEmpty' : nativeRuntime ? 'ask.autoEmpty' : "ask.emptyChat")}</span>
          </div>
        ) : messages.map((message) => (
          <QaMessageBubble
            activeDocumentId={activeDocumentId}
            workspace={workspace}
            copiedMessageId={copiedMessageId}
            isStreaming={isStreaming}
            key={message.id}
            message={message}
            onCitationClick={handleCitationChipClick}
            onCitationToken={handleCitationTokenClick}
            onCopy={handleCopyMessage}
            onDelete={handleMessageDelete}
            onEvidenceOpen={handleEvidenceOpen}
            onRegenerate={handleRegenerateMessage}
            operatingMessageId={operatingMessageId}
          />
        ))}
      </div>

      <form
        className="ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <textarea
          ref={inputRef}
          className="ask-input"
          aria-label={t("ask.question")}
          disabled={!isReady || isStreaming || isLoadingMessages}
          onChange={(event) => setDraftQuestion(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={nativeRuntime && isReady ? t('ask.generalPlaceholder') : scope !== 'current' ? t(isReady ? 'ask.generalPlaceholder' : 'ask.generalUnavailable')
            : isReady ? t("ask.placeholder") : nativeRuntime ? t("ask.waitingForParsing") : t("ask.disabledPlaceholder")}
          rows={2}
          value={draftQuestion}
        />
        <div className="ask-composer-toolbar">
          <div className="ask-composer-options">
            <label className="ask-model-menu">
              <Sparkles aria-hidden="true" size={14} />
              <select
                aria-label={t("ask.model")}
                disabled={isStreaming}
                onChange={(event) => setModel(event.currentTarget.value as QaChatModel)}
                value={model}
              >
                {availableModels.map((option) => (
                  <option key={option} value={option}>{getQaModelLabel(option)}</option>
                ))}
              </select>
            </label>
            <label className="ask-reasoning-menu">
              <select
                aria-label={t("ask.reasoningEffort")}
                disabled={isStreaming}
                onChange={(event) => setReasoningEffort(event.currentTarget.value as QaReasoningEffort)}
                value={reasoningEffort}
              >
                {QA_REASONING_EFFORTS.map((option) => (
                  <option key={option} value={option}>{t(getReasoningEffortLabelKey(option))}</option>
                ))}
              </select>
            </label>
          </div>
          {isStreaming ? (
            <button className="ask-send-button" onClick={handleStop} type="button" aria-label={t("ask.stop")} title={t("ask.stop")}>
              <Square aria-hidden="true" size={16} strokeWidth={2.2} />
            </button>
          ) : (
            <button
              className="ask-send-button"
              disabled={!isReady || isLoadingMessages || !draftQuestion.trim()}
              type="submit"
              aria-label={t("ask.send")}
              title={`${t("ask.send")} · Ctrl / ⌘ + Enter`}
            >
              <ArrowUp aria-hidden="true" size={19} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </form>
    </section>
    </>
  );
}

function ThreadHistory({
  onMore,
  activeThreadId,
  deletingThreadId,
  disabled,
  isLoading,
  onDelete,
  onSelect,
  threads,
}: {
  activeThreadId?: string;
  deletingThreadId?: string;
  disabled: boolean;
  isLoading: boolean;
  onMore?: () => void;
  onDelete: (thread: QaThread) => void;
  onSelect: (threadId: string) => void;
  threads: QaThread[];
}) {
  const { t } = useI18n();

  if (threads.length === 0 && !isLoading) {
    return null;
  }

  return (
    <div className="ask-history" aria-label={t("ask.recentThreads")}>
      <div className="ask-history-heading">
        <History aria-hidden="true" size={14} strokeWidth={2.1} />
        <span>{t("ask.recentThreads")}</span>
        {onMore ? <button className="ask-icon-button" disabled={disabled || isLoading} type="button" onClick={onMore}>{t("ask.moreThreads")}</button> : null}
      </div>
      <div className="ask-history-list">
        {threads.map((thread) => (
          <div
            aria-current={thread.id === activeThreadId ? "true" : undefined}
            className="ask-history-item"
            key={thread.id}
          >
            <button
              className="ask-history-select"
              disabled={disabled}
              onClick={() => onSelect(thread.id)}
              type="button"
            >
              <span>{thread.title || t("ask.untitledThread")}</span>
              <small>{formatThreadTime(thread.updatedAt)}</small>
            </button>
            <button
              className="ask-history-delete"
              disabled={disabled || deletingThreadId === thread.id}
              onClick={() => onDelete(thread)}
              title={t("ask.deleteThread")}
              type="button"
            >
              {deletingThreadId === thread.id ? (
                <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={13} strokeWidth={2.2} />
              ) : (
                <Trash2 aria-hidden="true" size={13} strokeWidth={2.1} />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function QaMessageBubble({
  workspace,
  activeDocumentId,
  copiedMessageId,
  isStreaming,
  message,
  onCitationClick,
  onCitationToken,
  onCopy,
  onDelete,
  onEvidenceOpen,
  onRegenerate,
  operatingMessageId,
}: {
  workspace?: boolean;
  activeDocumentId?: string;
  copiedMessageId?: string;
  isStreaming: boolean;
  message: LocalQaMessage;
  onCitationClick: (message: LocalQaMessage, citation: QaCitation, pageNumber?: number) => void;
  onCitationToken: (message: LocalQaMessage, evidenceId: string) => void;
  onCopy: (message: LocalQaMessage) => void;
  onDelete: (message: LocalQaMessage) => void;
  onEvidenceOpen: (message: LocalQaMessage, evidence: QaRetrievedEvidence) => void;
  onRegenerate: (message: LocalQaMessage) => void;
  operatingMessageId?: string;
}) {
  const { t } = useI18n();
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const isAssistant = message.role === "assistant";
  useEffect(() => { prefetchArtifactSources(message.citations); }, [message.citations]);
  const evidence = messageEvidence(message);
  const handleCitationToken = isAssistant
    ? (evidenceId: string) => onCitationToken(message, evidenceId)
    : undefined;

  return (
    <article className={`ask-message ask-message--${message.role}`}>
      <div className="ask-message-avatar" aria-hidden="true">
        {isAssistant ? <Sparkles size={15} strokeWidth={2.1} /> : <User size={15} strokeWidth={2.1} />}
      </div>
      <div className="ask-message-body">
        <div className="ask-message-role">
          {isAssistant ? t("ask.assistant") : t("ask.you")}
        </div>
        {isAssistant && message.agentSteps?.length ? <AgentActivity steps={message.agentSteps} streaming={message.status === "streaming"} /> : null}
        <div className="ask-message-content">
          {isAssistant && message.reasoningText ? (
            <ReasoningPanel
              text={message.reasoningText}
              isStreaming={message.status === "streaming" && !message.content}
            />
          ) : null}
          {message.content
            ? <QaMarkdown content={message.content} onCitationToken={handleCitationToken} citationIds={evidence.filter((item) => message.citations.some((citation) => sameQaSource(citation, item))).map((item) => item.evidenceId)} />
            : message.status === "streaming" && !message.reasoningText
              ? <span className="ask-thinking" role="status">{message.agentSteps?.some(step => step.kind === 'tool_call' && step.status === 'running') ? null : t(message.agentSteps?.some(step => step.kind === 'tool_call') ? "ask.preparingAnswer" : "ask.thinking")}</span>
              : null}
        </div>
        {isAssistant && message.agentSteps?.length && !workspace ? (
          <AgentStepsPanel steps={message.agentSteps} />
        ) : null}
        {message.errorMessage ? (
          <div className="ask-detail ask-detail--error">{message.errorMessage}</div>
        ) : null}
        {message.citations.length > 0 ? (
          <div className="ask-sources" aria-label={t("ask.citations")}>
            <div className="ask-sources-heading"><FileText size={14} aria-hidden="true" />{t("ask.sourcesCount", { count: message.citations.length })}</div>
            <div className="ask-citation-list">
              {(sourcesExpanded ? message.citations : message.citations.slice(0, 3)).map((citation) => (
                <QaCitationSource
                  key={qaSourceKey(citation) ?? citation.id}
                  citation={citation}
                  evidenceId={evidence.find((item) => sameQaSource(item, citation))?.evidenceId}
                  canOpen={workspace || citation.cloudDocumentId === activeDocumentId}
                  onSelect={(pageNumber) => onCitationClick(message, citation, pageNumber)}
                />
              ))}
            </div>
            {message.citations.length > 3 ? <button className="ask-sources-toggle" type="button" aria-expanded={sourcesExpanded}
              onClick={() => setSourcesExpanded(value => !value)}>{t(sourcesExpanded ? 'ask.collapseSources' : 'ask.expandSources', { count: message.citations.length - 3 })}</button> : null}
          </div>
        ) : null}
        {isAssistant && evidence.length > 0 && !message.citations.length ? (
          <div className="ask-evidence-link-row" aria-label={t("ask.evidence")}>
            {evidence.slice(0, 4).map((item) => (
              <button
                className="ask-evidence-mini"
                key={item.evidenceId}
                onClick={() => onEvidenceOpen(message, item)}
                type="button"
              >
                <FileText aria-hidden="true" size={13} strokeWidth={2.1} />
                <span>{item.evidenceId}</span>
              </button>
            ))}
            {evidence.length > 4 ? (
              <span className="ask-evidence-overflow">+{evidence.length - 4}</span>
            ) : null}
          </div>
        ) : null}
        {isAssistant ? <MessageMeta message={message} /> : null}
        {isAssistant && message.status !== "streaming" ? (
          <MessageActions
            copied={copiedMessageId === message.id}
            disabled={isStreaming}
            message={message}
            onCopy={onCopy}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
            operating={operatingMessageId === message.id}
          />
        ) : null}
      </div>
    </article>
  );
}

function MessageMeta({ message }: { message: LocalQaMessage }) {
  const { t } = useI18n();
  const parts = [
    message.model ? getQaModelLabel(message.model) : undefined,
    message.usage?.totalTokens ? t("ask.tokenCount", { count: message.usage.totalTokens }) : undefined,
    message.retrievalSnapshot?.rerankerVersion
      ? t("ask.rerankedBy", { model: message.retrievalSnapshot.rerankerVersion })
      : undefined,
  ].filter(Boolean);

  if (parts.length === 0 && message.status !== "streaming") {
    return null;
  }

  return (
    <div className="ask-message-usage">
      {message.status === "streaming" ? t("ask.streaming") : parts.join(" · ")}
    </div>
  );
}

function MessageActions({
  copied,
  disabled,
  message,
  onCopy,
  onDelete,
  onRegenerate,
  operating,
}: {
  copied: boolean;
  disabled: boolean;
  message: LocalQaMessage;
  onCopy: (message: LocalQaMessage) => void;
  onDelete: (message: LocalQaMessage) => void;
  onRegenerate: (message: LocalQaMessage) => void;
  operating: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="ask-message-actions">
      <button
        className="ask-message-action"
        disabled={operating}
        onClick={() => onCopy(message)}
        title={copied ? t("ask.copied") : t("ask.copyAnswer")}
        type="button"
      >
        {copied
          ? <Check aria-hidden="true" size={13} strokeWidth={2.2} />
          : <Copy aria-hidden="true" size={13} strokeWidth={2.1} />}
      </button>
      <button
        className="ask-message-action"
        disabled={disabled || operating}
        onClick={() => onRegenerate(message)}
        title={t("ask.regenerate")}
        type="button"
      >
        {operating
          ? <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={13} strokeWidth={2.2} />
          : <RefreshCw aria-hidden="true" size={13} strokeWidth={2.1} />}
      </button>
      <button
        className="ask-message-action ask-message-action--danger"
        disabled={operating}
        onClick={() => onDelete(message)}
        title={t("ask.deleteAnswer")}
        type="button"
      >
        <Trash2 aria-hidden="true" size={13} strokeWidth={2.1} />
      </button>
    </div>
  );
}

function ReasoningPanel({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const { t } = useI18n();
  // Auto-expand while the model is still thinking (no answer yet), collapse once
  // the answer starts streaming. Users can still toggle manually afterwards.
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!isStreaming) {
      setExpanded(false);
    }
  }, [isStreaming]);

  return (
    <div className="ask-reasoning-panel">
      <button
        aria-expanded={expanded}
        className="ask-reasoning-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="ask-reasoning-toggle-icon" size={14} strokeWidth={2.2} />
        <span>{t("ask.reasoningPanel")}</span>
        {isStreaming ? <small>{t("ask.reasoningThinking")}</small> : null}
      </button>
      {expanded ? (
        <div className="ask-reasoning-text">{text}</div>
      ) : null}
    </div>
  );
}

function AgentStepsPanel({ steps }: { steps: QaAgentStep[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const sortedSteps = useMemo(
    () => [...steps].sort((left, right) => left.stepIndex - right.stepIndex),
    [steps],
  );
  const latestStep = sortedSteps[sortedSteps.length - 1];

  return (
    <div className="ask-thinking-panel">
      <button
        aria-expanded={expanded}
        className="ask-thinking-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="ask-thinking-toggle-icon" size={14} strokeWidth={2.2} />
        <span>{t("ask.thinkingPanel")}</span>
        <strong>{t("ask.thinkingStepCount", { count: sortedSteps.length })}</strong>
      </button>
      {latestStep ? (
        <div className="ask-thinking-latest">
          {t("ask.thinkingLatest", { summary: latestStep.summary })}
        </div>
      ) : null}
      {expanded ? (
        <ol className="ask-thinking-step-list">
          {sortedSteps.map((step) => (
            <li className={`ask-thinking-step ask-thinking-step--${step.status}`} key={step.id}>
              <div className="ask-thinking-step-header">
                <span>{t(getAgentStepLabelKey(step.kind))}</span>
                <small>{t(getAgentStatusLabelKey(step.status))}</small>
              </div>
              <p>{step.summary}</p>
              {step.evidenceIds.length > 0 ? (
                <div className="ask-thinking-evidence-list" aria-label={t("ask.thinkingEvidence")}>
                  {step.evidenceIds.slice(0, 8).map((evidenceId) => (
                    <span key={evidenceId}>{evidenceId}</span>
                  ))}
                  {step.evidenceIds.length > 8 ? (
                    <span>+{step.evidenceIds.length - 8}</span>
                  ) : null}
                </div>
              ) : null}
              {step.toolName || step.toolCall ? (
                <ToolCallSummary step={step} toolCall={step.toolCall} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ToolCallSummary({
  step,
  toolCall,
}: {
  step: QaAgentStep;
  toolCall?: QaToolCall;
}) {
  const { t } = useI18n();
  const evidenceIds = toolCall?.resultEvidenceIds ?? step.evidenceIds;

  return (
    <div className="ask-thinking-tool-call">
      <span>{t("ask.toolCall", { tool: getAgentToolNameLabel(step.toolName ?? toolCall?.toolName) })}</span>
      {toolCall?.outputSummary ? <small>{toolCall.outputSummary}</small> : null}
      {toolCall?.errorMessage ? <small>{toolCall.errorMessage}</small> : null}
      {evidenceIds.length > 0 ? (
        <small>{t("ask.toolCallEvidence", { evidenceIds: evidenceIds.join(", ") })}</small>
      ) : null}
    </div>
  );
}

function EvidenceDrawer({
  evidence,
  highlighted,
  message,
  onClose,
  onEvidenceClick,
  relatedCitation,
}: {
  evidence?: QaRetrievedEvidence;
  highlighted?: boolean;
  message?: LocalQaMessage;
  onClose: () => void;
  onEvidenceClick: (evidence: QaRetrievedEvidence) => void;
  relatedCitation?: QaCitation;
}) {
  const { t } = useI18n();

  if (!evidence || !message) {
    return null;
  }

  return (
    <aside className="ask-evidence-drawer" aria-label={t("ask.evidenceDrawer")}>
      <div className="ask-evidence-drawer-header">
        <div>
          <div className="ask-evidence-title">
            {evidence.evidenceId}
            <span>{evidence.pageStart ? t("ask.citationPage", { page: evidence.pageStart }) : t("ask.sourceUnlocated")}</span>
          </div>
          <div className="ask-evidence-subtitle">
            {evidence.sectionPath?.length ? evidence.sectionPath.join(" / ") : evidence.documentTitle}
          </div>
        </div>
        <button className="ask-icon-button" onClick={onClose} title={t("common.close")} type="button">
          <X aria-hidden="true" size={15} strokeWidth={2.1} />
        </button>
      </div>

      <button
        className="ask-evidence-open-page"
        onClick={() => onEvidenceClick(evidence)}
        type="button"
      >
        <PanelRightOpen aria-hidden="true" size={15} strokeWidth={2.1} />
        <span>{t("ask.openEvidencePage")}</span>
        <ChevronRight aria-hidden="true" size={14} strokeWidth={2.1} />
      </button>

      <div className="ask-evidence-score-grid">
        <ScoreReadout label={t("ask.scoreHybrid")} value={evidence.score} />
        <ScoreReadout label={t("ask.scoreVector")} value={evidence.scoreBreakdown?.vector} />
        <ScoreReadout label={t("ask.scoreFullText")} value={evidence.scoreBreakdown?.fullText} />
        <ScoreReadout label={t("ask.scoreMetadata")} value={evidence.scoreBreakdown?.metadataBoost} />
        <ScoreReadout label={t("ask.scoreRerank")} value={evidence.scoreBreakdown?.rerank} />
        <ScoreReadout
          label={t("ask.verification")}
          value={relatedCitation ? t(getConfidenceLabelKey(relatedCitation.confidence)) : undefined}
          variant="text"
        />
      </div>

      <div className={`ask-evidence-text ${highlighted ? "ask-evidence-text--flash" : ""}`}>{evidence.textPreview}</div>
    </aside>
  );
}

function ScoreReadout({
  label,
  value,
  variant,
}: {
  label: string;
  value?: number | string;
  variant?: "number" | "text";
}) {
  const formattedValue = typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(3)
    : typeof value === "string" && value
      ? value
      : "-";

  return (
    <div className="ask-score-readout">
      <span>{label}</span>
      <strong className={variant === "text" ? "ask-score-readout-text" : undefined}>
        {formattedValue}
      </strong>
    </div>
  );
}

function qaMessageToLocal(message: QaMessage): LocalQaMessage {
  return {
    agentSteps: message.agentSteps ?? [],
    citations: message.citations ?? [],
    content: message.content,
    createdAt: message.createdAt,
    errorMessage: message.errorMessage,
    id: message.id,
    model: message.model,
    retrievalSnapshot: message.retrievalSnapshot,
    role: message.role,
    status: message.status,
    usage: message.usage,
  };
}

function findSelectedEvidence(
  messages: LocalQaMessage[],
  selectedRef?: SelectedEvidenceRef,
) {
  if (!selectedRef) {
    return undefined;
  }

  const message = messages.find((item) => item.id === selectedRef.messageId);

  if (!message) {
    return undefined;
  }

  const evidence = messageEvidence(message).find((item) =>
    selectedRef.evidenceId
      ? item.evidenceId === selectedRef.evidenceId
      : Boolean(selectedRef.sourceKey && qaSourceKey(item) === selectedRef.sourceKey)
  );

  if (!evidence) {
    return undefined;
  }

  return {
    citation: message.citations.find((citation) => sameQaSource(citation, evidence)),
    evidence,
    message,
  };
}

function renderMessageText(content: string, onCitationToken?: (evidenceId: string) => void) {
  return <QaMarkdown content={content} onCitationToken={onCitationToken} />;
}

function QaMarkdown({ content, onCitationToken, citationIds = [] }: {
  content: string; onCitationToken?: (evidenceId: string) => void; citationIds?: string[];
}) {
  const citationContext = useRef({ onCitationToken, citationIds });
  citationContext.current = { onCitationToken, citationIds };
  const components = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const { onCitationToken, citationIds } = citationContext.current;
      const ref = /^#qa-citation-(C[1-9][0-9]*)$/.exec(href ?? '')?.[1];
      if (ref && citationIds.includes(ref) && onCitationToken) return <button className="ask-citation-inline" type="button" onClick={() => onCitationToken(ref)}>{children}</button>;
      return <a href={href} rel="noreferrer" target="_blank">{children}</a>;
    },
  }), []);
  return <div className="ask-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath, [remarkCitations, { ids: citationIds }]]}
    rehypePlugins={[rehypeKatex]} components={components as never}>{content}</ReactMarkdown></div>;
}

function messageEvidence(message: LocalQaMessage): QaRetrievedEvidence[] {
  const direct = message.citations.filter(c => c.sourceKind === 'document_artifact' && c.evidenceId)
    .map(c => ({ ...c, evidenceId: c.evidenceId!, textPreview: c.quotedText }));
  return direct.length ? direct : message.retrievalSnapshot?.evidence ?? [];
}

function mergeAgentStep(currentSteps: QaAgentStep[], nextStep: QaAgentStep) {
  const mergedSteps = currentSteps.filter((step) =>
    step.id !== nextStep.id && step.stepIndex !== nextStep.stepIndex
  );

  return [...mergedSteps, nextStep].sort((left, right) => left.stepIndex - right.stepIndex);
}

function getAgentStepLabelKey(kind: QaAgentStep["kind"]): MessageKey {
  if (kind === "commentary") return "ask.agentStep.commentary";
  if (kind === "plan") {
    return "ask.agentStep.plan";
  }

  if (kind === "tool_call") {
    return "ask.agentStep.toolCall";
  }

  if (kind === "observation") {
    return "ask.agentStep.observation";
  }

  if (kind === "gap_check") {
    return "ask.agentStep.gapCheck";
  }

  if (kind === "answer_outline") {
    return "ask.agentStep.answerOutline";
  }

  return "ask.agentStep.fallback";
}

function getAgentStatusLabelKey(status: QaAgentStep["status"]): MessageKey {
  if (status === "running") return "ask.agentStatus.running";
  if (status === "error") {
    return "ask.agentStatus.error";
  }

  if (status === "skipped") {
    return "ask.agentStatus.skipped";
  }

  return "ask.agentStatus.success";
}

function getAgentToolNameLabel(toolName?: QaAgentStep["toolName"]) {
  if (toolName && ["get_document_outline", "search_document_text", "read_document", "finish_reading", "unknown_tool", "discover_documents", "document_outline", "search_document", "cite_sources"].includes(toolName)) return toolName;
  if (toolName === "search_current_paper") {
    return "search_current_paper";
  }

  if (toolName === "open_chunk") {
    return "open_chunk";
  }

  if (toolName === "verify_citation") {
    return "verify_citation";
  }

  if (toolName === "compose_answer") {
    return "compose_answer";
  }

  return "-";
}

function getReasoningEffortLabelKey(effort: QaReasoningEffort): MessageKey {
  if (effort === "quick") {
    return "ask.reasoning.quick";
  }

  if (effort === "standard") {
    return "ask.reasoning.standard";
  }

  if (effort === "deep") {
    return "ask.reasoning.deep";
  }

  return "ask.reasoning.auto";
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatThreadTime(value?: number) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function getQaModelLabel(model: QaChatModel) {
  return getModelLabel(model);
}

function getConfidenceLabelKey(confidence: QaCitation["confidence"]) {
  if (confidence === "weak") {
    return "ask.confidence.weak";
  }

  if (confidence === "rejected") {
    return "ask.confidence.rejected";
  }

  return "ask.confidence.verified";
}

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
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
  Send,
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
  getQaThreads,
  streamQaAnswer,
  type QaVerifierPayload,
} from "./qaClient";
import type { MessageKey } from "../i18n/messages";

type PaperQaPanelProps = {
  activeDocumentId?: string;
  qaIndexJob?: QaIndexJob;
  onCitationClick: (citation: QaCitation) => void;
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
  chunkId?: string;
  evidenceId?: string;
  messageId: string;
};

const QA_MODELS: QaChatModel[] = ["deepseek-v4-pro", "glm-5.2"];
const QA_REASONING_EFFORTS: QaReasoningEffort[] = ["auto", "quick", "standard", "deep"];

export function PaperQaPanel({
  activeDocumentId,
  onCitationClick,
  onEvidenceClick,
  qaIndexJob,
}: PaperQaPanelProps) {
  const { t } = useI18n();
  const [answerLanguage] = useState<QaAnswerLanguage>("auto");
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  const [draftQuestion, setDraftQuestion] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [operatingMessageId, setOperatingMessageId] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<LocalQaMessage[]>([]);
  const [model, setModel] = useState<QaChatModel>("deepseek-v4-pro");
  const [reasoningEffort, setReasoningEffort] = useState<QaReasoningEffort>("auto");
  const [retrievalWarnings, setRetrievalWarnings] = useState<string[]>([]);
  const [selectedEvidenceRef, setSelectedEvidenceRef] = useState<SelectedEvidenceRef>();
  const [threadId, setThreadId] = useState<string>();
  const [threads, setThreads] = useState<QaThread[]>([]);
  const [verifierWarnings, setVerifierWarnings] = useState<string[]>([]);
  const [highlightedEvidenceId, setHighlightedEvidenceId] = useState<string>();
  const abortControllerRef = useRef<AbortController>();
  const historyRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const highlightTimerRef = useRef<number>();
  // Set right after a stream finishes so the threadId effect can skip refetching
  // the messages we already have from onDone.
  const justFinishedStreamRef = useRef(false);
  const isReady = Boolean(
    activeDocumentId
    && qaIndexJob?.status === "ready"
    && qaIndexJob?.chunkerVersion === PROJECT_CONFIG.qa.chunkerVersion,
  );

  const warnings = useMemo(
    () => uniqueStrings([
      ...retrievalWarnings,
      ...verifierWarnings,
      ...(historyError ? [historyError] : []),
    ]),
    [historyError, retrievalWarnings, verifierWarnings],
  );
  const selectedEvidence = useMemo(
    () => findSelectedEvidence(messages, selectedEvidenceRef),
    [messages, selectedEvidenceRef],
  );

  const refreshThreads = useCallback(async (options: { selectLatest?: boolean; silent?: boolean } = {}) => {
    if (!activeDocumentId) {
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
      const nextThreads = await getQaThreads(activeDocumentId);

      if (historyRequestRef.current !== requestId) {
        return nextThreads;
      }

      setThreads(nextThreads);

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
  }, [activeDocumentId, t]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    historyRequestRef.current += 1;
    messagesRequestRef.current += 1;
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

    if (activeDocumentId) {
      void refreshThreads({ selectLatest: true });
    }
  }, [activeDocumentId, refreshThreads]);

  useEffect(() => {
    if (!isFullscreen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsFullscreen(false);
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
    if (!activeDocumentId || !isReady || isStreaming || operatingMessageId || !threadId) {
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
          activeDocumentId,
          answerLanguage,
          executionMode: "agentic",
          model,
          question,
          reasoningEffort,
          regenerateMessageId: message.id,
          scope: "current",
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
          onDone: (payload) => {
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
      }

      setIsStreaming(false);
      setOperatingMessageId(undefined);
    }
  }, [
    activeDocumentId,
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
  ) => {
    const linkedEvidence = (message.retrievalSnapshot?.evidence ?? [])
      .find((item) => item.chunkId === citation.chunkId);
    onCitationClick(citation);
    setSelectedEvidenceRef({
      chunkId: citation.chunkId,
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
    setSelectedEvidenceRef({
      evidenceId: evidence.evidenceId,
      messageId: message.id,
    });
    flashEvidence(evidence.evidenceId);
  }, [flashEvidence]);

  const handleCitationTokenClick = useCallback((
    message: LocalQaMessage,
    evidenceId: string,
  ) => {
    const evidenceList = message.retrievalSnapshot?.evidence ?? [];
    const evidence = evidenceList.find((item) => item.evidenceId === evidenceId);

    setSelectedEvidenceRef({
      chunkId: evidence?.chunkId,
      evidenceId,
      messageId: message.id,
    });

    if (evidence) {
      flashEvidence(evidence.evidenceId);

      const citation = message.citations.find((item) => item.chunkId === evidence.chunkId);

      if (citation && citation.cloudDocumentId === activeDocumentId) {
        onCitationClick(citation);
      }
    }
  }, [activeDocumentId, flashEvidence, onCitationClick]);

  const handleSubmit = useCallback(async () => {
    const question = draftQuestion.trim();

    if (!question || !activeDocumentId || !isReady || isStreaming) {
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
          activeDocumentId,
          answerLanguage,
          executionMode: "agentic",
          model,
          question,
          reasoningEffort,
          scope: "current",
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
          onDone: (payload) => {
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
      }

      setIsStreaming(false);
    }
  }, [
    activeDocumentId,
    answerLanguage,
    draftQuestion,
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
        aria-label={t("ask.chatSection")}
        className={`ask-workbench ${isFullscreen ? "ask-workbench--fullscreen" : ""}`}
      >
      <header className="ask-workbench-header">
        <div className="ask-workbench-title-block">
          <div className="ask-workbench-title">{t("ask.chatTitle")}</div>
          <div className="ask-workbench-status">
            {isReady ? t("ask.chatReady") : t("ask.chatWaitingForIndex")}
            {isStreaming ? <span>{t("ask.streaming")}</span> : null}
          </div>
        </div>
        <div className="ask-workbench-actions">
          {isLoadingThreads ? (
            <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={16} strokeWidth={2.2} />
          ) : null}
          <button
            className="ask-icon-button"
            disabled={isStreaming}
            onClick={handleNewThread}
            title={t("ask.newThread")}
            type="button"
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.2} />
          </button>
          <button
            className="ask-icon-button"
            onClick={() => setIsFullscreen((current) => !current)}
            title={isFullscreen ? t("ask.exitFullscreen") : t("ask.enterFullscreen")}
            type="button"
          >
            {isFullscreen
              ? <Minimize2 aria-hidden="true" size={15} strokeWidth={2.2} />
              : <Maximize2 aria-hidden="true" size={15} strokeWidth={2.2} />}
          </button>
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

      <ThreadHistory
        activeThreadId={threadId}
        deletingThreadId={deletingThreadId}
        disabled={isStreaming}
        isLoading={isLoadingThreads}
        onDelete={handleThreadDelete}
        onSelect={handleThreadSelect}
        threads={threads}
      />

      <div className="ask-message-stream" aria-busy={isLoadingMessages} aria-live="polite">
        {isLoadingMessages ? (
          <div className="ask-chat-empty">
            <LoaderCircle aria-hidden="true" className="ask-spin-icon" size={16} strokeWidth={2.2} />
            <span>{t("ask.loadingMessages")}</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="ask-chat-empty">
            <Search aria-hidden="true" size={18} strokeWidth={2} />
            <span>{t("ask.emptyChat")}</span>
          </div>
        ) : messages.map((message) => (
          <QaMessageBubble
            activeDocumentId={activeDocumentId}
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

      <EvidenceDrawer
        evidence={selectedEvidence?.evidence}
        highlighted={Boolean(selectedEvidence?.evidence && highlightedEvidenceId === selectedEvidence.evidence.evidenceId)}
        message={selectedEvidence?.message}
        onClose={() => setSelectedEvidenceRef(undefined)}
        onEvidenceClick={onEvidenceClick}
        relatedCitation={selectedEvidence?.citation}
      />

      <form
        className="ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="ask-composer-toolbar">
          <label className="ask-reasoning-menu">
            <span>{t("ask.reasoningEffort")}</span>
            <select
              disabled={isStreaming}
              onChange={(event) => setReasoningEffort(event.currentTarget.value as QaReasoningEffort)}
              value={reasoningEffort}
            >
              {QA_REASONING_EFFORTS.map((option) => (
                <option key={option} value={option}>{t(getReasoningEffortLabelKey(option))}</option>
              ))}
            </select>
          </label>
          <label className="ask-model-menu">
            <span>{t("ask.model")}</span>
            <select
              disabled={isStreaming}
              onChange={(event) => setModel(event.currentTarget.value as QaChatModel)}
              value={model}
            >
              {QA_MODELS.map((option) => (
                <option key={option} value={option}>{getQaModelLabel(option)}</option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          className="ask-input"
          disabled={!isReady || isStreaming}
          onChange={(event) => setDraftQuestion(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={isReady ? t("ask.placeholder") : t("ask.disabledPlaceholder")}
          rows={3}
          value={draftQuestion}
        />
        <div className="ask-composer-actions">
          {isStreaming ? (
            <button className="ask-action-button ask-action-button--secondary" onClick={handleStop} type="button">
              <Square aria-hidden="true" size={15} strokeWidth={2.2} />
              <span>{t("ask.stop")}</span>
            </button>
          ) : (
            <button
              className="ask-action-button"
              disabled={!isReady || !draftQuestion.trim()}
              type="submit"
            >
              <Send aria-hidden="true" size={15} strokeWidth={2.2} />
              <span>{t("ask.send")}</span>
            </button>
          )}
        </div>
      </form>
    </section>
    </>
  );
}

function ThreadHistory({
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
      </div>
      <div className="ask-history-list">
        {threads.slice(0, 6).map((thread) => (
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
  activeDocumentId?: string;
  copiedMessageId?: string;
  isStreaming: boolean;
  message: LocalQaMessage;
  onCitationClick: (message: LocalQaMessage, citation: QaCitation) => void;
  onCitationToken: (message: LocalQaMessage, evidenceId: string) => void;
  onCopy: (message: LocalQaMessage) => void;
  onDelete: (message: LocalQaMessage) => void;
  onEvidenceOpen: (message: LocalQaMessage, evidence: QaRetrievedEvidence) => void;
  onRegenerate: (message: LocalQaMessage) => void;
  operatingMessageId?: string;
}) {
  const { t } = useI18n();
  const isAssistant = message.role === "assistant";
  const evidence = message.retrievalSnapshot?.evidence ?? [];
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
        <div className="ask-message-content">
          {isAssistant && message.reasoningText ? (
            <ReasoningPanel
              text={message.reasoningText}
              isStreaming={message.status === "streaming" && !message.content}
            />
          ) : null}
          {message.content
            ? <QaMarkdown content={message.content} onCitationToken={handleCitationToken} />
            : message.status === "streaming" && !message.reasoningText
              ? <span className="ask-thinking">{t("ask.thinking")}</span>
              : null}
        </div>
        {isAssistant && message.agentSteps?.length ? (
          <AgentStepsPanel steps={message.agentSteps} />
        ) : null}
        {message.errorMessage ? (
          <div className="ask-detail ask-detail--error">{message.errorMessage}</div>
        ) : null}
        {message.citations.length > 0 ? (
          <div className="ask-citation-list" aria-label={t("ask.citations")}>
            {message.citations.map((citation) => {
              const linkedEvidence = evidence.find((item) => item.chunkId === citation.chunkId);
              const canOpen = citation.cloudDocumentId === activeDocumentId;
              const label = linkedEvidence
                ? t("ask.citationEvidencePage", {
                    evidenceId: linkedEvidence.evidenceId,
                    page: citation.pageStart,
                  })
                : t("ask.citationPage", { page: citation.pageStart });

              return (
                <button
                  className="ask-citation-chip"
                  disabled={!canOpen}
                  key={citation.id}
                  onClick={() => onCitationClick(message, citation)}
                  title={canOpen ? t("ask.openCitation") : t("ask.citationUnavailable")}
                  type="button"
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        {isAssistant && evidence.length > 0 ? (
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
            <span>{t("ask.citationPage", { page: evidence.pageStart })}</span>
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
        <ScoreReadout label={t("ask.scoreVector")} value={evidence.scoreBreakdown.vector} />
        <ScoreReadout label={t("ask.scoreFullText")} value={evidence.scoreBreakdown.fullText} />
        <ScoreReadout label={t("ask.scoreMetadata")} value={evidence.scoreBreakdown.metadataBoost} />
        <ScoreReadout label={t("ask.scoreRerank")} value={evidence.scoreBreakdown.rerank} />
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

  const evidence = (message.retrievalSnapshot?.evidence ?? []).find((item) =>
    selectedRef.evidenceId
      ? item.evidenceId === selectedRef.evidenceId
      : item.chunkId === selectedRef.chunkId
  );

  if (!evidence) {
    return undefined;
  }

  return {
    citation: message.citations.find((citation) => citation.chunkId === evidence.chunkId),
    evidence,
    message,
  };
}

function renderMessageText(content: string, onCitationToken?: (evidenceId: string) => void) {
  return <QaMarkdown content={content} onCitationToken={onCitationToken} />;
}

const CITATION_TOKEN_PATTERN = /\[C(\d+)\]/g;

function QaMarkdown({
  content,
  onCitationToken,
}: {
  content: string;
  onCitationToken?: (evidenceId: string) => void;
}) {
  const components = useMemo(
    () => ({
      p: ({ children }: { children?: ReactNode }) => (
        <p>{splitCitationTokens(children, onCitationToken)}</p>
      ),
      li: ({ children }: { children?: ReactNode }) => (
        <li>{splitCitationTokens(children, onCitationToken)}</li>
      ),
      td: ({ children }: { children?: ReactNode }) => (
        <td>{splitCitationTokens(children, onCitationToken)}</td>
      ),
      th: ({ children }: { children?: ReactNode }) => (
        <th>{splitCitationTokens(children, onCitationToken)}</th>
      ),
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      ),
    }),
    [onCitationToken],
  );

  return (
    <div className="ask-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components as never}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function splitCitationTokens(node: ReactNode, onCitationToken?: (evidenceId: string) => void): ReactNode {
  if (!onCitationToken || node === null || node === undefined || typeof node === "boolean") {
    return node;
  }

  if (Array.isArray(node)) {
    let touched = false;
    const next = node.map((child, index) => {
      const processed = splitCitationTokens(child, onCitationToken);

      if (processed !== child) {
        touched = true;
      }

      return processed;
    });

    return touched ? next : node;
  }

  if (typeof node !== "string") {
    return node;
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of node.matchAll(CITATION_TOKEN_PATTERN)) {
    const start = match.index ?? 0;

    if (start > lastIndex) {
      segments.push(node.slice(lastIndex, start));
    }

    const raw = match[0];
    const evidenceId = `C${match[1]}`;

    segments.push(
      <button
        className="ask-citation-inline"
        key={`citation-${matchIndex}-${start}`}
        onClick={() => onCitationToken(evidenceId)}
        type="button"
      >
        {raw}
      </button>,
    );
    matchIndex += 1;
    lastIndex = start + raw.length;
  }

  if (matchIndex === 0) {
    return node;
  }

  if (lastIndex < node.length) {
    segments.push(node.slice(lastIndex));
  }

  return segments;
}

function mergeAgentStep(currentSteps: QaAgentStep[], nextStep: QaAgentStep) {
  const mergedSteps = currentSteps.filter((step) =>
    step.id !== nextStep.id && step.stepIndex !== nextStep.stepIndex
  );

  return [...mergedSteps, nextStep].sort((left, right) => left.stepIndex - right.stepIndex);
}

function getAgentStepLabelKey(kind: QaAgentStep["kind"]): MessageKey {
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
  if (status === "error") {
    return "ask.agentStatus.error";
  }

  if (status === "skipped") {
    return "ask.agentStatus.skipped";
  }

  return "ask.agentStatus.success";
}

function getAgentToolNameLabel(toolName?: QaAgentStep["toolName"]) {
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
  if (model === "glm-5.2") {
    return "GLM 5.2";
  }

  return "DeepSeek V4 Pro";
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

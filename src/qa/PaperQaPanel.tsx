import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  History,
  LoaderCircle,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type {
  QaAnswerLanguage,
  QaAgentStep,
  QaChatModel,
  QaCitation,
  QaExecutionMode,
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

type MarkdownBlock =
  | { type: "blockquote"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "ordered-list"; items: string[] }
  | { type: "paragraph"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "unordered-list"; items: string[] };

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
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  const [draftQuestion, setDraftQuestion] = useState("");
  const [executionMode, setExecutionMode] = useState<QaExecutionMode>("agentic");
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
  const abortControllerRef = useRef<AbortController>();
  const historyRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const isReady = Boolean(
    activeDocumentId &&
    (qaIndexJob?.status === "ready" || qaIndexJob?.status === "ready_degraded"),
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

  const refreshThreads = useCallback(async (options: { selectLatest?: boolean } = {}) => {
    if (!activeDocumentId) {
      setThreads([]);
      return [];
    }

    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    setIsLoadingThreads(true);
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
      if (historyRequestRef.current === requestId) {
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
    if (!threadId || isStreaming) {
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

  const handleCitationChipClick = useCallback((
    message: LocalQaMessage,
    citation: QaCitation,
  ) => {
    onCitationClick(citation);
    setSelectedEvidenceRef({
      chunkId: citation.chunkId,
      messageId: message.id,
    });
  }, [onCitationClick]);

  const handleEvidenceOpen = useCallback((
    message: LocalQaMessage,
    evidence: QaRetrievedEvidence,
  ) => {
    setSelectedEvidenceRef({
      evidenceId: evidence.evidenceId,
      messageId: message.id,
    });
  }, []);

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
          executionMode,
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
              updateAssistantMessage(localAssistantMessageId, () => ({
                ...qaMessageToLocal({
                  ...assistantMessage,
                  citations: payload.citations ?? assistantMessage.citations ?? [],
                }),
                id: assistantMessage.id,
              }));
            } else {
              updateAssistantMessage(localAssistantMessageId, (message) => ({
                ...message,
                status: "success",
              }));
            }

            void refreshThreads();
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
    executionMode,
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
    <section className="ask-workbench" aria-label={t("ask.chatSection")}>
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
            key={message.id}
            message={message}
            onCitationClick={handleCitationChipClick}
            onEvidenceOpen={handleEvidenceOpen}
          />
        ))}
      </div>

      <EvidenceDrawer
        evidence={selectedEvidence?.evidence}
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
          <div className="ask-mode-control" aria-label={t("ask.executionMode")}>
            <span>{t("ask.executionMode")}</span>
            <div className="ask-segmented-control">
              {(["agentic", "rag"] as QaExecutionMode[]).map((option) => (
                <button
                  aria-pressed={executionMode === option}
                  className={executionMode === option ? "is-active" : undefined}
                  disabled={isStreaming}
                  key={option}
                  onClick={() => setExecutionMode(option)}
                  type="button"
                >
                  {t(option === "agentic" ? "ask.mode.agentic" : "ask.mode.rag")}
                </button>
              ))}
            </div>
          </div>
          <label className="ask-reasoning-menu">
            <span>{t("ask.reasoningEffort")}</span>
            <select
              disabled={isStreaming || executionMode !== "agentic"}
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
  message,
  onCitationClick,
  onEvidenceOpen,
}: {
  activeDocumentId?: string;
  message: LocalQaMessage;
  onCitationClick: (message: LocalQaMessage, citation: QaCitation) => void;
  onEvidenceOpen: (message: LocalQaMessage, evidence: QaRetrievedEvidence) => void;
}) {
  const { t } = useI18n();
  const isAssistant = message.role === "assistant";
  const evidence = message.retrievalSnapshot?.evidence ?? [];

  return (
    <article className={`ask-message ask-message--${message.role}`}>
      <div className="ask-message-role">
        {isAssistant ? t("ask.assistant") : t("ask.you")}
      </div>
      <div className="ask-message-content">
        {message.content
          ? renderMessageText(message.content)
          : message.status === "streaming"
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
  message,
  onClose,
  onEvidenceClick,
  relatedCitation,
}: {
  evidence?: QaRetrievedEvidence;
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

      <div className="ask-evidence-text">{evidence.textPreview}</div>
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

function renderMessageText(content: string) {
  const blocks = parseMarkdownBlocks(content);

  if (blocks.length === 0) {
    return null;
  }

  return blocks.map((block, index) => renderMarkdownBlock(block, index));
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^\s*```([A-Za-z0-9_-]+)?\s*$/);

    if (codeFence) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        code: codeLines.join("\n"),
        language: codeFence[1],
        type: "code",
      });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);

    if (heading) {
      blocks.push({
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
        type: "heading",
      });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = parseTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && parseTableRow(lines[index]).length > 0) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }

      blocks.push({
        headers,
        rows,
        type: "table",
      });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, "").trim());
        index += 1;
      }

      blocks.push({
        text: quoteLines.join("\n").trim(),
        type: "blockquote",
      });
      continue;
    }

    const unorderedItem = line.match(/^\s*[-*+]\s+(.+)$/);

    if (unorderedItem) {
      const items: string[] = [];

      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);

        if (!item) {
          break;
        }

        items.push(item[1].trim());
        index += 1;
      }

      blocks.push({
        items,
        type: "unordered-list",
      });
      continue;
    }

    const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (orderedItem) {
      const items: string[] = [];

      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);

        if (!item) {
          break;
        }

        items.push(item[1].trim());
        index += 1;
      }

      blocks.push({
        items,
        type: "ordered-list",
      });
      continue;
    }

    const paragraphLines: string[] = [];

    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    if (paragraphLines.length > 0) {
      blocks.push({
        text: paragraphLines.join(" "),
        type: "paragraph",
      });
      continue;
    }

    index += 1;
  }

  return blocks;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number) {
  const key = `${block.type}-${index}`;

  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(block.level + 2, 6)}` as keyof JSX.IntrinsicElements;

    return (
      <HeadingTag className="ask-markdown-heading" key={key}>
        {renderInlineMarkdown(block.text, key)}
      </HeadingTag>
    );
  }

  if (block.type === "unordered-list" || block.type === "ordered-list") {
    const ListTag = block.type === "ordered-list" ? "ol" : "ul";

    return (
      <ListTag className="ask-markdown-list" key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>
            {renderInlineMarkdown(item, `${key}-${itemIndex}`)}
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "blockquote") {
    return (
      <blockquote className="ask-markdown-quote" key={key}>
        {block.text.split("\n").map((line, lineIndex) => (
          <p key={`${key}-${lineIndex}`}>{renderInlineMarkdown(line, `${key}-${lineIndex}`)}</p>
        ))}
      </blockquote>
    );
  }

  if (block.type === "code") {
    return (
      <pre className="ask-markdown-code-block" key={key}>
        {block.language ? <span className="ask-markdown-code-language">{block.language}</span> : null}
        <code>{block.code}</code>
      </pre>
    );
  }

  if (block.type === "table") {
    return (
      <div className="ask-markdown-table-scroll" key={key}>
        <table className="ask-markdown-table">
          <thead>
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th key={`${key}-head-${cellIndex}`}>
                  {renderInlineMarkdown(header, `${key}-head-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {normalizeTableRow(row, block.headers.length).map((cell, cellIndex) => (
                  <td key={`${key}-row-${rowIndex}-${cellIndex}`}>
                    {renderInlineMarkdown(cell, `${key}-row-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\))/g;
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    nodes.push(renderInlineMarkdownToken(raw, `${keyPrefix}-inline-${matchIndex}`));
    matchIndex += 1;
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderInlineMarkdownToken(raw: string, key: string): ReactNode {
  if (raw.startsWith("`") && raw.endsWith("`")) {
    return <code className="ask-markdown-inline-code" key={key}>{raw.slice(1, -1)}</code>;
  }

  if (raw.startsWith("**") && raw.endsWith("**")) {
    return <strong key={key}>{renderInlineMarkdown(raw.slice(2, -2), `${key}-strong`)}</strong>;
  }

  if (raw.startsWith("*") && raw.endsWith("*")) {
    return <em key={key}>{renderInlineMarkdown(raw.slice(1, -1), `${key}-em`)}</em>;
  }

  const link = raw.match(/^\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/);

  if (link) {
    return (
      <a href={link[2]} key={key} rel="noreferrer" target="_blank">
        {link[1]}
      </a>
    );
  }

  return raw;
}

function isMarkdownBlockStart(lines: string[], index: number) {
  const line = lines[index];

  return (
    /^\s*```/.test(line) ||
    /^(#{1,4})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    isTableStart(lines, index)
  );
}

function isTableStart(lines: string[], index: number) {
  return parseTableRow(lines[index]).length > 0 && isTableSeparator(lines[index + 1]);
}

function parseTableRow(line?: string) {
  if (!line || !line.includes("|")) {
    return [];
  }

  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");

  if (!trimmed.includes("|")) {
    return [];
  }

  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line?: string) {
  const cells = parseTableRow(line);

  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeTableRow(row: string[], cellCount: number) {
  if (row.length === cellCount) {
    return row;
  }

  if (row.length > cellCount) {
    return row.slice(0, cellCount);
  }

  return [...row, ...Array.from({ length: cellCount - row.length }, () => "")];
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

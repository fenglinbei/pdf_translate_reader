import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PaperContextRecord, PaperContextTerm, PdfLibraryEntry } from "../types/domain";
import type { PaperContextDraft } from "../translation/paperContext";

type PaperContextEditorProps = {
  currentEntry?: PdfLibraryEntry;
  onSave: (draft: PaperContextDraft) => Promise<void> | void;
  paperContext?: PaperContextRecord;
};

type TermDraft = Pick<PaperContextTerm, "source" | "target"> & {
  id: string;
};

export function PaperContextEditor({
  currentEntry,
  onSave,
  paperContext,
}: PaperContextEditorProps) {
  const [abstract, setAbstract] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [terms, setTerms] = useState<TermDraft[]>([]);
  const [title, setTitle] = useState("");
  const editorKey = `${currentEntry?.fingerprint ?? "none"}:${paperContext?.contextHash ?? "empty"}`;
  const canSave = Boolean(currentEntry);
  const contextSummary = useMemo(() => {
    if (!paperContext) {
      return "No paper context stored";
    }

    return `${paperContext.terminology.length} terms · ${paperContext.contextHash}`;
  }, [paperContext]);

  useEffect(() => {
    setAbstract(paperContext?.abstract ?? "");
    setSaveStatus("idle");
    setTerms(
      (paperContext?.terminology ?? []).map((term, index) => ({
        id: `${term.source}-${term.updatedAt}-${index}`,
        source: term.source,
        target: term.target,
      })),
    );
    setTitle(paperContext?.title ?? currentEntry?.pdfMetadata?.title ?? "");
  }, [currentEntry?.fileName, currentEntry?.pdfMetadata?.title, editorKey, paperContext]);

  async function handleSave() {
    if (!canSave) {
      return;
    }

    setSaveStatus("saving");

    try {
      const now = Date.now();

      await onSave({
        abstract,
        terminology: terms.map((term, index) => ({
          confidence: "user",
          source: term.source,
          target: term.target,
          updatedAt: now + index,
        })),
        title,
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  function updateTerm(termId: string, patch: Partial<TermDraft>) {
    setTerms((currentTerms) =>
      currentTerms.map((term) =>
        term.id === termId
          ? {
              ...term,
              ...patch,
            }
          : term,
      ),
    );
    setSaveStatus("idle");
  }

  return (
    <div className="paper-context-editor">
      <div className="paper-context-summary">{contextSummary}</div>
      <label className="settings-field">
        <span>Title</span>
        <input
          disabled={!currentEntry}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setSaveStatus("idle");
          }}
          value={title}
        />
      </label>
      <label className="settings-field">
        <span>Abstract</span>
        <textarea
          disabled={!currentEntry}
          onChange={(event) => {
            setAbstract(event.currentTarget.value);
            setSaveStatus("idle");
          }}
          rows={4}
          value={abstract}
        />
      </label>
      <div className="paper-context-terms">
        <div className="paper-context-terms-header">
          <span>Terminology</span>
          <button
            className="icon-button icon-button--small"
            disabled={!currentEntry}
            onClick={() => {
              setTerms((currentTerms) => [
                ...currentTerms,
                {
                  id: `term-${Date.now()}-${currentTerms.length}`,
                  source: "",
                  target: "",
                },
              ]);
              setSaveStatus("idle");
            }}
            title="Add term"
            type="button"
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
        {terms.length > 0 ? (
          <div className="paper-context-term-list">
            {terms.map((term) => (
              <div className="paper-context-term-row" key={term.id}>
                <input
                  disabled={!currentEntry}
                  onChange={(event) => updateTerm(term.id, { source: event.currentTarget.value })}
                  placeholder="Source"
                  value={term.source}
                />
                <input
                  disabled={!currentEntry}
                  onChange={(event) => updateTerm(term.id, { target: event.currentTarget.value })}
                  placeholder="Target"
                  value={term.target}
                />
                <button
                  className="icon-button icon-button--small"
                  disabled={!currentEntry}
                  onClick={() => {
                    setTerms((currentTerms) => currentTerms.filter((currentTerm) => currentTerm.id !== term.id));
                    setSaveStatus("idle");
                  }}
                  title="Remove term"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty-row">No terms yet</div>
        )}
      </div>
      <div className="paper-context-save-row">
        <span>{formatSaveStatus(saveStatus)}</span>
        <button
          className="icon-button icon-button--small"
          disabled={!canSave || saveStatus === "saving"}
          onClick={() => void handleSave()}
          title="Save paper context"
          type="button"
        >
          <Save aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function formatSaveStatus(saveStatus: "idle" | "saving" | "saved" | "error") {
  if (saveStatus === "saving") {
    return "Saving...";
  }

  if (saveStatus === "saved") {
    return "Saved";
  }

  if (saveStatus === "error") {
    return "Could not save";
  }

  return "Manual terms only";
}

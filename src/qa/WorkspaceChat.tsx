import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, MessageSquareText, Pencil, Pin, Plus, Search, Trash2, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { QaCitation, QaRetrievedEvidence, QaThread } from '../types/domain';
import { PaperQaPanel, type QaSessionState } from './PaperQaPanel';
import { getQaThreads, updateWorkspaceThread } from './qaClient';

type Session = { key: string; initialThreadId?: string } & QaSessionState;
export function WorkspaceChat({ navigation, visible, headerLeading, activeDocumentId, onSelect, onCitationClick, onEvidenceClick }: {
  navigation: HTMLElement | null; visible: boolean; activeDocumentId?: string; onSelect: () => void;
  headerLeading?: ReactNode;
  onCitationClick: (source: QaCitation, page?: number) => void; onEvidenceClick: (source: QaRetrievedEvidence) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [threads, setThreads] = useState<QaThread[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string>();
  const [titleDraft, setTitleDraft] = useState('');
  const [busy, setBusy] = useState<string>();
  const [deleted, setDeleted] = useState<QaThread>();
  const request = useRef(0);
  const initialized = useRef(false);
  const active = sessions.find(session => session.key === activeKey);
  const activeRef = useRef(activeKey); activeRef.current = activeKey;
  const newSession = useCallback(() => {
    const key = crypto.randomUUID();
    setSessions(current => [...current, { key, streaming: false }]); setActiveKey(key); onSelect();
  }, [onSelect]);
  const select = (thread: QaThread) => {
    const current = sessions.find(session => session.threadId === thread.id);
    if (current) setActiveKey(current.key);
    else {
      const session = { key: thread.id, initialThreadId: thread.id, threadId: thread.id, streaming: false, title: thread.title };
      setSessions(value => [...value, session]); setActiveKey(session.key);
    }
    onSelect();
  };
  const refresh = useCallback(async () => {
    const id = ++request.current; setLoading(true);
    try {
      const rows = await getQaThreads(undefined, 'workspace', 0, query);
      if (id !== request.current) return;
      setThreads(rows); setHasMore(rows.length === 30); setError('');
      if (!initialized.current) {
        initialized.current = true;
        // A click on New while history loads must never be overridden.
        if (!activeRef.current) {
          const thread = rows[0]; const key = thread?.id ?? crypto.randomUUID();
          setSessions([{ key, initialThreadId: thread?.id, threadId: thread?.id, title: thread?.title, streaming: false }]);
          setActiveKey(key);
        }
      }
    } catch (failure) { if (id === request.current) setError(failure instanceof Error ? failure.message : t('ask.historyFailed')); }
    finally { if (id === request.current) setLoading(false); }
  }, [query, t]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const historyChanged = useCallback(() => { void refreshRef.current(); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  const more = async () => {
    if (loading) return;
    const id = ++request.current; setLoading(true);
    try {
      const rows = await getQaThreads(undefined, 'workspace', threads.length, query);
      if (id !== request.current) return;
      setThreads(current => [...current, ...rows.filter(row => !current.some(item => item.id === row.id))]); setHasMore(rows.length === 30);
    } catch (failure) { if (id === request.current) setError(String(failure)); }
    finally { if (id === request.current) setLoading(false); }
  };
  const updateState = useCallback((key: string, state: QaSessionState) => {
    setSessions(current => current.map(session => session.key === key ? { ...session, ...state } : session));
  }, []);
  const change = async (thread: QaThread, patch: { title?: string; pinned?: boolean; deleted?: boolean }) => {
    if (busy) return false;
    setBusy(thread.id); setError('');
    try {
      const saved = await updateWorkspaceThread(thread.id, patch);
      if (patch.deleted) {
        setDeleted(thread);
        setSessions(current => current.filter(session => session.threadId !== thread.id));
        if (activeRef.current === sessions.find(session => session.threadId === thread.id)?.key) newSession();
      } else if (patch.deleted === false) setDeleted(undefined);
      setThreads(current => patch.deleted ? current.filter(item => item.id !== thread.id) : current.map(item => item.id === thread.id ? saved : item));
      setEditing(undefined); void refresh(); return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('ask.historyFailed')); return false; }
    finally { setBusy(undefined); }
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const groups = [
    { name: t('ask.pinnedThreads'), rows: threads.filter(thread => thread.pinnedAt) },
    { name: t('ask.todayThreads'), rows: threads.filter(thread => !thread.pinnedAt && thread.updatedAt >= today.getTime()) },
    { name: t('ask.earlierThreads'), rows: threads.filter(thread => !thread.pinnedAt && thread.updatedAt < today.getTime()) },
  ];
  return <>
    {navigation ? createPortal(<div className="workspace-history">
      <button type="button" className="workspace-new-chat" onClick={newSession}><Plus size={16} />{t('ask.newThread')}</button>
      <label className="workspace-history-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('ask.searchThreads')} aria-label={t('ask.searchThreads')} /></label>
      <div className="workspace-history-list" aria-busy={loading}>
        {sessions.some(session => !session.threadId) ? <section><h3>{t('ask.draftThreads')}</h3>{sessions.filter(session => !session.threadId).map(session =>
          <div className="workspace-history-row" key={session.key} aria-current={session.key === activeKey ? 'true' : undefined}>
            <button className="workspace-history-select" type="button" onClick={() => { setActiveKey(session.key); onSelect(); }}><MessageSquareText size={15} /><span><strong>{session.title || t('ask.newThread')}</strong></span></button>
          </div>)}</section> : null}
        {groups.filter(group => group.rows.length).map(group => <section key={group.name}><h3>{group.name}</h3>{group.rows.map(thread => {
          const streaming = sessions.some(session => session.threadId === thread.id && session.streaming);
          return <div className="workspace-history-row" key={thread.id} aria-current={thread.id === active?.threadId ? 'true' : undefined}>
            {editing === thread.id ? <form className="workspace-rename" onSubmit={event => { event.preventDefault(); if (titleDraft.trim()) void change(thread, { title: titleDraft.trim() }); }}>
              <input aria-label={t('ask.renameThread')} value={titleDraft} maxLength={200} autoFocus onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditing(undefined); }} />
              <button type="submit" disabled={Boolean(busy) || !titleDraft.trim()} aria-label={t('common.confirm')}><Check size={14} /></button>
              <button type="button" onClick={() => setEditing(undefined)} aria-label={t('common.cancel')}><X size={14} /></button>
            </form> : <>
              <button type="button" className="workspace-history-select" aria-label={thread.title || t('ask.untitledThread')} onClick={() => select(thread)}>
                {streaming ? <LoaderCircle className="ask-spin-icon" size={15} /> : <MessageSquareText size={15} />}
                <span><strong>{thread.title || t('ask.untitledThread')}</strong><small>{new Date(thread.updatedAt).toLocaleDateString()}</small></span>
              </button>
              <div className="workspace-thread-actions">
                <button type="button" disabled={Boolean(busy)} aria-label={t(thread.pinnedAt ? 'ask.unpinThread' : 'ask.pinThread')} title={t(thread.pinnedAt ? 'ask.unpinThread' : 'ask.pinThread')} onClick={() => void change(thread, { pinned: !thread.pinnedAt })}><Pin size={13} fill={thread.pinnedAt ? 'currentColor' : 'none'} /></button>
                <button type="button" disabled={Boolean(busy)} aria-label={t('ask.renameThread')} title={t('ask.renameThread')} onClick={() => { setEditing(thread.id); setTitleDraft(thread.title); }}><Pencil size={13} /></button>
                <button type="button" disabled={Boolean(busy) || streaming} aria-label={t('ask.deleteThread')} title={t('ask.deleteThread')} onClick={() => void change(thread, { deleted: true })}><Trash2 size={13} /></button>
              </div>
            </>}
          </div>;
        })}</section>)}
        {!threads.length && !loading && !sessions.some(session => !session.threadId) ? <p className="workspace-history-empty">{t(query ? 'ask.noMatchingThreads' : 'ask.noThreads')}</p> : null}
        {loading ? <LoaderCircle className="ask-spin-icon" size={18} aria-label={t('ask.loadingMessages')} /> : null}
        {hasMore ? <button type="button" className="ask-sources-toggle" disabled={loading} onClick={() => void more()}>{t('ask.moreThreads')}</button> : null}
      </div>
      {deleted ? <div className="workspace-history-undo" role="status">{t('ask.threadDeleted')}<button type="button" disabled={Boolean(busy)} onClick={() => void change(deleted, { deleted: false })}>{t('ask.undoDelete')}</button></div> : null}
      {error ? <div role="alert" className="ask-detail--error">{error}<button type="button" onClick={() => void refresh()}>{t('ask.retry')}</button></div> : null}
    </div>, navigation) : null}
    {!sessions.length ? <header className="workspace-chat-loading-header">{headerLeading}<span>{t('ask.workspaceTitle')}</span></header> : null}
    {sessions.map(session => <div className="workspace-chat-session" key={session.key} hidden={session.key !== activeKey}>
      <PaperQaPanel workspace managedSession={session} visible={visible && session.key === activeKey} activeDocumentId={activeDocumentId}
        headerLeading={session.key === activeKey ? headerLeading : undefined}
        sessionTitle={threads.find(thread => thread.id === session.threadId)?.title || session.title || t('ask.newThread')}
        onSessionState={updateState} onHistoryChanged={historyChanged} onNewSession={newSession}
        onCitationClick={onCitationClick} onEvidenceClick={onEvidenceClick} />
    </div>)}
  </>;
}

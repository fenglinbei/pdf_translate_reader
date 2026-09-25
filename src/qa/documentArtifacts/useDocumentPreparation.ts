import { useEffect, useState } from 'react';
import { ensureClientDocumentPrepared } from './preparationApi';
import { clearPreparedCandidates } from './preparationClient';

export function useDocumentPreparation({ enabled, userId, documentId, sourceGeneration }: {
  enabled: boolean; userId?: string; documentId?: string; sourceGeneration: string;
}) {
  const [state, setState] = useState<'idle' | 'preparing' | 'ready' | 'unavailable' | 'failed'>('idle');
  useEffect(() => {
    if (!enabled || !userId || !documentId) { setState('idle'); return; }
    const controller = new AbortController(); setState('preparing');
    void ensureClientDocumentPrepared({ userId, documentId }, controller.signal).then(result => {
      if (!controller.signal.aborted) setState(result.state === 'ready' ? 'ready' : result.state === 'unavailable' ? 'unavailable' : 'preparing');
    }).catch(() => { if (!controller.signal.aborted) setState('failed'); });
    return () => controller.abort();
  }, [enabled, userId, documentId, sourceGeneration]);
  useEffect(() => () => { if (userId) void clearPreparedCandidates(userId).catch(() => {}); }, [userId]);
  return state;
}

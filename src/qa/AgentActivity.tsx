import { useId, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, FileText, LoaderCircle } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { QaAgentStep } from '../types/domain';

type ReadingLocation = { documentId?: string; title: string; pageStart?: number; pageEnd?: number; sectionPath?: string[]; current?: boolean };
type ReadingActivity = { version: number; query?: string; resultCount?: number; hasMore?: boolean; locations: ReadingLocation[] };
function activityOf(step?: QaAgentStep) {
  const activity = (step?.payload as { activity?: ReadingActivity } | undefined)?.activity;
  return activity?.version === 1 ? activity : undefined;
}
function pageLabel(location: ReadingLocation) {
  return location.pageStart ? `p.${location.pageStart}${location.pageEnd && location.pageEnd !== location.pageStart ? `–${location.pageEnd}` : ''}` : '';
}

export function AgentActivity({ steps, streaming }: { steps: QaAgentStep[]; streaming: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const visible = [...steps].sort((a, b) => a.stepIndex - b.stepIndex).filter(step => step.kind === 'commentary' || step.kind === 'tool_call');
  if (!visible.length) return null;
  const tools = visible.filter(step => step.kind === 'tool_call');
  const latest = tools.at(-1);
  const recentRead = [...tools].reverse().find(step => step.status === 'success' && activityOf(step)?.locations?.length);
  const locations = [...new Map((activityOf(recentRead)?.locations ?? []).map(location =>
    [JSON.stringify([location.documentId ?? location.title, location.pageStart, location.pageEnd, location.sectionPath]), location])).values()];
  const running = streaming && latest?.status === 'running';
  const commentary = streaming ? [...visible].reverse().find(step => step.kind === 'commentary') : undefined;
  const oneDocument = new Set(locations.map(location => location.documentId ?? location.title)).size === 1;
  return <div className={`ask-agent-activity${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label={t('ask.activity')}>
    <button className="ask-activity-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={13} aria-hidden="true" />
      {running ? <LoaderCircle className="ask-spin-icon" size={13} aria-hidden="true" /> : null}
      <span>{running ? latest.summary : t('ask.activitySummary', { count: visible.length })}</span>
      <small>{t(expanded ? 'ask.activityHide' : 'ask.activityDetails')}</small>
    </button>
    {!expanded ? <div id={detailsId} className="ask-activity-preview">
      {commentary ? <p className="ask-activity-commentary" title={commentary.summary}>{commentary.summary}</p> : null}
      {oneDocument ? <div className="ask-activity-document" title={locations[0].title}>{locations[0].title}</div> : null}
      {locations.slice(0, 2).map((location, index) => <div className="ask-activity-location" key={index}
        title={[location.title, pageLabel(location), ...(location.sectionPath ?? [])].filter(Boolean).join(' · ')}>
        <FileText size={12} aria-hidden="true" />
        <span>{!oneDocument && location.sectionPath?.length ? `${location.title} · ` : ''}{location.sectionPath?.at(-1) || location.title}</span>
        <small>{pageLabel(location)}</small>
      </div>)}
      {locations.length > 2 ? <small className="ask-activity-more">{t('ask.activityOtherLocations', { count: locations.length - 2 })}</small> : null}
    </div> : <div id={detailsId} className="ask-activity-details">
      {visible.map(step => {
        if (step.kind === 'commentary') return <p className="ask-agent-commentary" key={step.stepIndex}>{step.summary}</p>;
        const activity = activityOf(step);
        return <div className={`ask-reading-step ask-agent-tool--${step.status}`} key={step.stepIndex}>
          <div className="ask-reading-step-label">
            {step.status === 'running' ? <LoaderCircle className="ask-spin-icon" size={14} aria-hidden="true" />
              : step.status === 'error' ? <AlertTriangle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            <span>{step.summary}</span>
          </div>
          {activity?.query ? <div className="ask-reading-query">“{activity.query}”</div> : null}
          {activity?.resultCount !== undefined ? <small>{t(activity.resultCount ? 'ask.activityDocuments' : 'ask.activityNoMatches', { count: activity.resultCount })}</small> : null}
          {activity?.locations?.map((location, index) => <div className="ask-reading-location" key={index}>
            <FileText size={13} aria-hidden="true" /><span><strong>{location.title}</strong>
              {location.pageStart ? <small>{pageLabel(location)}</small> : null}
              {location.sectionPath?.length ? <small>{location.sectionPath.join(' / ')}</small> : null}
              {location.current ? <small>{t('ask.currentDocument')}</small> : null}</span>
          </div>)}
          {activity?.hasMore ? <small>{t('ask.activityRemaining')}</small> : null}
        </div>;
      })}
    </div>}
  </div>;
}

import { type ReactNode, useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

// React always renders into the same portal container. Moving that container
// between page and reader slots preserves drafts, history and in-flight streams.
export function WorkspaceQaHost({ pageOpen, narrow, mobileOpen, sideOpen, children }: {
  pageOpen: boolean; narrow: boolean; mobileOpen: boolean; sideOpen: boolean; children: ReactNode;
}) {
  const [container] = useState(() => {
    const element = document.createElement('div'); element.className = 'workspace-qa-container'; return element;
  });
  const pageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = !pageOpen && (narrow ? mobileOpen : sideOpen)
      ? document.querySelector(narrow ? '.mobile-panel .workspace-qa-slot' : '.translation-pane .workspace-qa-slot') : null;
    const parent = slot ?? pageRef.current;
    if (parent && container.parentElement !== parent) parent.appendChild(container);
  });
  useLayoutEffect(() => () => container.remove(), [container]);
  return <><div className="workspace-qa-page" hidden={!pageOpen} ref={pageRef} />{createPortal(children, container)}</>;
}

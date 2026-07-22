export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard API access can be denied in non-secure contexts and embedded browsers.
      // Keep the user gesture path alive by falling back to the legacy copy command.
    }
  }

  copyTextWithFallback(text);
}

function copyTextWithFallback(text: string) {
  const textarea = document.createElement("textarea");
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;

  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("readonly", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("Copy failed.");
    }
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

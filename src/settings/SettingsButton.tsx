import { Settings } from "lucide-react";

export function SettingsButton() {
  return (
    <button className="icon-button" type="button" aria-label="Open settings" title="Settings">
      <Settings aria-hidden="true" size={18} strokeWidth={2} />
    </button>
  );
}

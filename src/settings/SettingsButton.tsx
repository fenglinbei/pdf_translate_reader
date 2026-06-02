import { Settings } from "lucide-react";

type SettingsButtonProps = {
  isOpen: boolean;
  onClick: () => void;
};

export function SettingsButton({ isOpen, onClick }: SettingsButtonProps) {
  return (
    <button
      aria-label="Open settings"
      aria-pressed={isOpen}
      className="icon-button"
      onClick={onClick}
      title="Settings"
      type="button"
    >
      <Settings aria-hidden="true" size={18} strokeWidth={2} />
    </button>
  );
}

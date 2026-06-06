import { Settings } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";

type SettingsButtonProps = {
  isOpen: boolean;
  onClick: () => void;
};

export function SettingsButton({ isOpen, onClick }: SettingsButtonProps) {
  const { t } = useI18n();

  return (
    <button
      aria-label={t("settingsButton.open")}
      aria-pressed={isOpen}
      className="icon-button"
      onClick={onClick}
      title={t("settings.title")}
      type="button"
    >
      <Settings aria-hidden="true" size={18} strokeWidth={2} />
    </button>
  );
}

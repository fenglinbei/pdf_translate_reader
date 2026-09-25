import { useState } from "react";
import { Check, ChevronRight, Copy, Heart, MessagesSquare } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import { copyTextToClipboard } from "../utils/clipboard";
import appreciationQr from "../assets/wechat-appreciation.jpg";
import "./supportAndCommunity.css";

const QQ_GROUP = "1124931244";

export function SupportAndCommunity() {
  const { t } = useI18n();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyGroupNumber() {
    try {
      await copyTextToClipboard(QQ_GROUP);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <section className="settings-section settings-support" aria-label={t("support.title")}>
      <div className="settings-section-heading">{t("support.title")}</div>
      <div className="settings-support-card">
        <div className="settings-support-group">
          <span className="settings-support-icon"><MessagesSquare size={17} aria-hidden="true" /></span>
          <div className="settings-support-group-info">
            <span>{t("support.qqGroup")}</span>
            <strong className="settings-support-number">{QQ_GROUP}</strong>
          </div>
          <button className="settings-support-copy" type="button" onClick={() => void copyGroupNumber()}
            aria-label={t("support.copyGroup")}>
            {copyStatus === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span aria-live="polite">{copyStatus === "copied" ? t("pdf.copied") : t("support.copy")}</span>
          </button>
        </div>
        {copyStatus === "failed" ? <p className="settings-support-copy-error" role="status">{t("support.copyFailed")}</p> : null}
        <details className="settings-support-appreciation">
          <summary>
            <span className="settings-support-icon settings-support-icon--heart"><Heart size={17} aria-hidden="true" /></span>
            <span>{t("support.appreciation")}</span>
            <ChevronRight className="settings-support-chevron" size={16} aria-hidden="true" />
          </summary>
          <figure className="settings-support-figure">
            <div className="settings-support-qr">
              <img src={appreciationQr} alt={t("support.qrAlt")} width={828} height={1124} loading="lazy" draggable={false} />
            </div>
            <figcaption>{t("support.qrCaption")}</figcaption>
          </figure>
        </details>
      </div>
    </section>
  );
}

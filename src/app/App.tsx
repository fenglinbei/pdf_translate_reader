import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { AuthScreen } from "../auth/AuthScreen";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import { detectBrowserUiLocale } from "../i18n/uiLocales";
import { ReaderShell } from "./ReaderShell";

export function App() {
  return (
    <I18nProvider locale={detectBrowserUiLocale()}>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </I18nProvider>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  const { t } = useI18n();

  if (auth.status === "checking") {
    return (
      <main className="auth-screen">
        <section className="auth-panel" aria-label={t("auth.loadingAccount")}>
          <div className="auth-brand">
            <span className="brand-mark">P</span>
            <span className="brand-text">{t("app.name")}</span>
          </div>
          <div className="auth-loading">{t("auth.checkingAccount")}</div>
        </section>
      </main>
    );
  }

  if (auth.status !== "signedIn") {
    return <AuthScreen />;
  }

  return <ReaderShell />;
}

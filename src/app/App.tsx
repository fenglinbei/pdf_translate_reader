import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { AuthScreen } from "../auth/AuthScreen";
import { ReaderShell } from "./ReaderShell";

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();

  if (auth.status === "checking") {
    return (
      <main className="auth-screen">
        <section className="auth-panel" aria-label="Loading account">
          <div className="auth-brand">
            <span className="brand-mark">P</span>
            <span className="brand-text">PDF Translate Reader</span>
          </div>
          <div className="auth-loading">Checking account...</div>
        </section>
      </main>
    );
  }

  if (auth.status !== "signedIn") {
    return <AuthScreen />;
  }

  return <ReaderShell />;
}

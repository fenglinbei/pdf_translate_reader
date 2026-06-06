import { LogIn } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAuth } from "./AuthProvider";
import { createInviteTicket } from "./inviteTicketClient";

type AuthMode = "sign-in" | "sign-up";

export function AuthScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [inviteCode, setInviteCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [password, setPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState<string>();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(undefined);
    setStatusMessage(undefined);
    setIsSubmitting(true);

    try {
      if (mode === "sign-in") {
        await auth.signIn(email.trim(), password);
      } else {
        const trimmedEmail = email.trim();
        const inviteTicket = await createInviteTicket(trimmedEmail, inviteCode);

        await auth.signUp(trimmedEmail, password, inviteTicket);
        setStatusMessage("Account created. Check your email if confirmation is enabled.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (auth.status === "misconfigured") {
    return (
      <main className="auth-screen">
        <section className="auth-panel" aria-label="Supabase setup required">
          <div className="auth-brand">
            <span className="brand-mark">P</span>
            <span className="brand-text">PDF Translate Reader</span>
          </div>
          <h1>Supabase setup required</h1>
          <p className="auth-copy">
            Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before using the reader.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-label="Sign in">
        <div className="auth-brand">
          <span className="brand-mark">P</span>
          <span className="brand-text">PDF Translate Reader</span>
        </div>
        <h1>{mode === "sign-in" ? "Sign in" : "Create account"}</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={6}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {mode === "sign-up" ? (
            <label className="auth-field">
              <span>Invite code</span>
              <input
                autoComplete="one-time-code"
                onChange={(event) => setInviteCode(event.currentTarget.value)}
                required
                type="text"
                value={inviteCode}
              />
            </label>
          ) : null}
          {errorMessage ? <div className="auth-status auth-status--error">{errorMessage}</div> : null}
          {statusMessage ? <div className="auth-status">{statusMessage}</div> : null}
          <button className="auth-submit" disabled={isSubmitting} type="submit">
            <LogIn aria-hidden="true" size={17} strokeWidth={2} />
            <span>
              {isSubmitting
                ? "Working..."
                : mode === "sign-in"
                  ? "Sign in"
                  : "Create account"}
            </span>
          </button>
        </form>
        <button
          className="auth-mode-button"
          onClick={() => {
            setErrorMessage(undefined);
            setStatusMessage(undefined);
            setMode((currentMode) => currentMode === "sign-in" ? "sign-up" : "sign-in");
          }}
          type="button"
        >
          {mode === "sign-in" ? "Create a new account" : "Use an existing account"}
        </button>
      </section>
    </main>
  );
}

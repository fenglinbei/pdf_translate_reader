import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  clearAuthSessionSnapshot,
  restoreAuthSessionFromSnapshot,
  saveAuthSessionSnapshot,
} from "./authSessionSnapshot";
import { isSupabaseConfigured, requireSupabaseClient, supabase } from "./supabaseClient";

type AuthStatus = "checking" | "misconfigured" | "signedIn" | "signedOut";

type AuthContextValue = {
  session?: Session;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signUp: (email: string, password: string, inviteTicket: string) => Promise<void>;
  status: AuthStatus;
  user?: User;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? "checking" : "misconfigured",
  );

  const applySession = useCallback((nextSession: Session | null) => {
    setSession(nextSession ?? undefined);
    setStatus(nextSession ? "signedIn" : "signedOut");
  }, []);

  useEffect(() => {
    if (!supabase) {
      setStatus("misconfigured");
      return undefined;
    }

    const client = requireSupabaseClient();
    let cancelled = false;
    let authSubscription: { unsubscribe: () => void } | undefined;

    async function bootstrapAuth() {
      try {
        const { data, error } = await client.auth.getSession();

        if (error) {
          throw error;
        }

        const restoredSession =
          data.session ?? await restoreAuthSessionFromSnapshot(client);

        if (!cancelled) {
          if (restoredSession) {
            saveAuthSessionSnapshot(restoredSession);
          }

          applySession(restoredSession);
        }

        const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
          if (cancelled) {
            return;
          }

          if (nextSession) {
            saveAuthSessionSnapshot(nextSession);
            applySession(nextSession);
            return;
          }

          if (event === "SIGNED_OUT") {
            clearAuthSessionSnapshot();
            applySession(null);
          }
        });

        if (cancelled) {
          listener.subscription.unsubscribe();
          return;
        }

        authSubscription = listener.subscription;
      } catch {
        if (!cancelled) {
          clearAuthSessionSnapshot();
          applySession(null);
        }
      }
    }

    void bootstrapAuth();

    return () => {
      cancelled = true;
      authSubscription?.unsubscribe();
    };
  }, [applySession]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    signIn: async (email: string, password: string) => {
      const client = requireSupabaseClient();
      const { data, error } = await client.auth.signInWithPassword({ email, password });

      if (error) {
        throw error;
      }

      saveAuthSessionSnapshot(data.session);
      applySession(data.session);
    },
    signOut: async () => {
      const client = requireSupabaseClient();
      const { error } = await client.auth.signOut();

      if (error) {
        await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      }

      clearAuthSessionSnapshot();
      applySession(null);
    },
    signUp: async (email: string, password: string, inviteTicket: string) => {
      const client = requireSupabaseClient();
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: {
            invite_ticket: inviteTicket,
          },
        },
      });

      if (error) {
        throw error;
      }

      if (data.session) {
        saveAuthSessionSnapshot(data.session);
        applySession(data.session);
      }
    },
    status,
    user: session?.user,
  }), [applySession, session, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return value;
}

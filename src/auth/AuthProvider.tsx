import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, requireSupabaseClient, supabase } from "./supabaseClient";

type AuthStatus = "checking" | "misconfigured" | "signedIn" | "signedOut";

type AuthContextValue = {
  session?: Session;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  status: AuthStatus;
  user?: User;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? "checking" : "misconfigured",
  );

  useEffect(() => {
    if (!supabase) {
      setStatus("misconfigured");
      return undefined;
    }

    let cancelled = false;

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (cancelled) {
          return;
        }

        if (error) {
          setSession(undefined);
          setStatus("signedOut");
          return;
        }

        setSession(data.session ?? undefined);
        setStatus(data.session ? "signedIn" : "signedOut");
      })
      .catch(() => {
        if (!cancelled) {
          setSession(undefined);
          setStatus("signedOut");
        }
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? undefined);
      setStatus(nextSession ? "signedIn" : "signedOut");
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    signIn: async (email: string, password: string) => {
      const client = requireSupabaseClient();
      const { error } = await client.auth.signInWithPassword({ email, password });

      if (error) {
        throw error;
      }
    },
    signOut: async () => {
      const client = requireSupabaseClient();
      const { error } = await client.auth.signOut();

      if (error) {
        throw error;
      }
    },
    signUp: async (email: string, password: string) => {
      const client = requireSupabaseClient();
      const { error } = await client.auth.signUp({ email, password });

      if (error) {
        throw error;
      }
    },
    status,
    user: session?.user,
  }), [session, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return value;
}

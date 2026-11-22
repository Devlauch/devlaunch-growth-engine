import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, clearTokens, getAccessToken, setTokens } from "../api/client";
import type { Membership, User } from "../api/types";

interface AuthState {
  user: User | null;
  memberships: Membership[];
  loading: boolean;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMembershipsList: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface MeResponse {
  user: User;
  memberships: Membership[];
}

interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!getAccessToken()) {
      setUser(null);
      setMemberships([]);
      return;
    }
    try {
      const me = await api.get<MeResponse>("/auth/me");
      setUser(me.user);
      setMemberships(me.memberships);
    } catch {
      clearTokens();
      setUser(null);
      setMemberships([]);
    }
  }, []);

  useEffect(() => {
    loadMe().finally(() => setLoading(false));
  }, [loadMe]);

  const register = useCallback(async (email: string, password: string, fullName?: string) => {
    const res = await api.post<AuthResponse>("/auth/register", { email, password, fullName });
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
    setMemberships([]);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<AuthResponse>("/auth/login", { email, password });
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
    setMemberships([]);
  }, []);

  const value = useMemo(
    () => ({ user, memberships, loading, register, login, logout, refreshMembershipsList: loadMe }),
    [user, memberships, loading, register, login, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

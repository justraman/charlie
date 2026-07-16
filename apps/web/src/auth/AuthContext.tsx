// Auth context: loads the current user once, exposes logout + a capability
// check. The UI uses `role`/`can` only to hide affordances; the Worker is the
// real authorization gate on every request.

import type { Capability, Role } from '@shared/roles'
import { roleHasCapability } from '@shared/roles'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { ApiError, api } from '@/lib/api'

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
}

interface MeResponse {
  actorKind: 'user' | 'api_key'
  user?: CurrentUser
}

interface AuthState {
  user: CurrentUser | null
  loaded: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
  can: (capability: Capability) => boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>('/api/auth/me')
      setUser(me.user ?? null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null)
      else throw err
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout')
    } finally {
      setUser(null)
    }
  }, [])

  const can = useCallback(
    (capability: Capability) => (user ? roleHasCapability(user.role, capability) : false),
    [user],
  )

  return (
    <AuthContext.Provider value={{ user, loaded, refresh, logout, can }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

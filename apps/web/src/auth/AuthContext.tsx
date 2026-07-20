// Auth context: derives the current user from the Auth.js session, and exposes
// logout + a capability check. The UI uses `role`/`can` only to hide
// affordances; the Worker is the real authorization gate on every request.
//
// The `{ user, loaded, refresh, logout, can }` shape is kept stable so every
// consumer (route guards, sidebar, views) is unaffected by the Auth.js swap.

import { authConfigManager, signOut as authSignOut, useSession } from '@hono/auth-js/react'
import type { Capability, Role } from '@shared/roles'
import { roleHasCapability } from '@shared/roles'
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react'

// The Auth.js client talks to the Worker under /api/auth.
authConfigManager.setConfig({ basePath: '/api/auth' })

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
}

interface AuthState {
  user: CurrentUser | null
  loaded: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
  can: (capability: Capability) => boolean
}

const AuthContext = createContext<AuthState | null>(null)

/** Map the Auth.js session to Charlie's CurrentUser. `id`/`role` are injected by
 *  the Worker's session callback; without them we treat the session as absent. */
function toCurrentUser(session: unknown): CurrentUser | null {
  const user = (session as { user?: Record<string, unknown> } | null)?.user
  const email = typeof user?.email === 'string' ? user.email : null
  const role = typeof user?.role === 'string' ? (user.role as Role) : null
  if (!email || !role) return null
  return {
    id: typeof user?.id === 'string' ? user.id : '',
    email,
    name: typeof user?.name === 'string' ? user.name : null,
    avatarUrl: typeof user?.image === 'string' ? user.image : null,
    role,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, status, update } = useSession()
  const user = useMemo(() => toCurrentUser(session), [session])
  const loaded = status !== 'loading'

  const refresh = useCallback(async () => {
    await update()
  }, [update])

  const logout = useCallback(async () => {
    // redirect:false — the caller (sidebar) navigates to /login itself.
    await authSignOut({ redirect: false })
    await update()
  }, [update])

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

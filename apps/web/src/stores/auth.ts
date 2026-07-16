// Minimal reactive auth store (no Pinia needed for this surface). The UI uses
// `role` only to hide affordances; the Worker is the real authorization gate.

import type { Capability, Role } from '@shared/roles'
import { roleHasCapability } from '@shared/roles'
import { computed, reactive, readonly } from 'vue'
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

const state = reactive({
  user: null as CurrentUser | null,
  loaded: false,
})

async function fetchMe(): Promise<void> {
  try {
    const me = await api.get<MeResponse>('/api/auth/me')
    state.user = me.user ?? null
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.user = null
    } else {
      throw err
    }
  } finally {
    state.loaded = true
  }
}

async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout')
  } finally {
    state.user = null
  }
}

function can(capability: Capability): boolean {
  return state.user ? roleHasCapability(state.user.role, capability) : false
}

export function useAuth() {
  return {
    state: readonly(state),
    isAuthenticated: computed(() => state.user !== null),
    fetchMe,
    logout,
    can,
  }
}

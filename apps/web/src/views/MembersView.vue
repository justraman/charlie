<script setup lang="ts">
import { ROLES, type Role } from '@shared/roles'
import { onMounted, ref } from 'vue'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/stores/auth'

const auth = useAuth()

interface Member {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
  lastLoginAt: string | null
  createdAt: string
  active: boolean
}

interface ApiKey {
  id: string
  name: string
  scopes: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  keyPrefix: string
}

const members = ref<Member[]>([])
const apiKeys = ref<ApiKey[]>([])
const error = ref<string | null>(null)
const busy = ref(false)

// --- new API key form ---
const showKeyForm = ref(false)
const newKeyName = ref('')
const newKeyScopes = ref<string[]>(['runs:read'])
const ALL_SCOPES = ['runs:write', 'runs:read', 'reports:read', 'flows:read']
const createdToken = ref<string | null>(null)

async function load() {
  error.value = null
  try {
    const [m, k] = await Promise.all([
      api.get<{ members: Member[] }>('/api/members'),
      api.get<{ apiKeys: ApiKey[] }>('/api/api-keys'),
    ])
    members.value = m.members
    apiKeys.value = k.apiKeys
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err)
  }
}

async function changeRole(member: Member, role: Role) {
  if (role === member.role) return
  busy.value = true
  error.value = null
  try {
    await api.patch(`/api/members/${member.id}`, { role })
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err)
    await load()
  } finally {
    busy.value = false
  }
}

async function deactivate(member: Member) {
  if (!confirm(`Deactivate ${member.email}? Their sessions will be revoked.`)) return
  busy.value = true
  error.value = null
  try {
    await api.delete(`/api/members/${member.id}`)
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function toggleScope(scope: string) {
  const i = newKeyScopes.value.indexOf(scope)
  if (i === -1) newKeyScopes.value.push(scope)
  else newKeyScopes.value.splice(i, 1)
}

async function createKey() {
  busy.value = true
  error.value = null
  createdToken.value = null
  try {
    const res = await api.post<{ token: string }>('/api/api-keys', {
      name: newKeyName.value.trim(),
      scopes: newKeyScopes.value,
    })
    createdToken.value = res.token
    newKeyName.value = ''
    newKeyScopes.value = ['runs:read']
    showKeyForm.value = false
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function revokeKey(key: ApiKey) {
  if (!confirm(`Revoke API key "${key.name}"? This cannot be undone.`)) return
  busy.value = true
  try {
    await api.delete(`/api/api-keys/${key.id}`)
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—'
}

onMounted(load)
</script>

<template>
  <div class="container">
    <h1>Members</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Last login</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.id">
            <td>
              <div class="member">
                <strong>{{ m.name || m.email }}</strong>
                <span class="muted">{{ m.email }}</span>
              </div>
            </td>
            <td>
              <select
                :value="m.role"
                :disabled="busy || m.id === auth.state.user?.id"
                @change="changeRole(m, ($event.target as HTMLSelectElement).value as Role)"
              >
                <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
              </select>
            </td>
            <td class="muted">{{ fmtDate(m.lastLoginAt) }}</td>
            <td>
              <span class="badge" :class="{ owner: m.active }">{{
                m.active ? 'active' : 'inactive'
              }}</span>
            </td>
            <td style="text-align: right">
              <button
                v-if="m.active && m.id !== auth.state.user?.id && m.role !== 'owner'"
                class="btn btn-danger"
                :disabled="busy"
                @click="deactivate(m)"
              >
                Deactivate
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-head">
      <h2>API keys</h2>
      <button class="btn" @click="showKeyForm = !showKeyForm">
        {{ showKeyForm ? 'Cancel' : 'New key' }}
      </button>
    </div>

    <div v-if="createdToken" class="card token-reveal">
      <p><strong>Copy this key now — it will not be shown again:</strong></p>
      <code class="token">{{ createdToken }}</code>
      <button class="btn" @click="createdToken = null">Dismiss</button>
    </div>

    <div v-if="showKeyForm" class="card">
      <label class="field">
        Name
        <input v-model="newKeyName" placeholder="CI pipeline" />
      </label>
      <div class="field">
        Scopes
        <div class="scopes">
          <label v-for="s in ALL_SCOPES" :key="s" class="scope">
            <input
              type="checkbox"
              :checked="newKeyScopes.includes(s)"
              @change="toggleScope(s)"
            />
            {{ s }}
          </label>
        </div>
      </div>
      <button
        class="btn btn-primary"
        :disabled="busy || !newKeyName.trim() || newKeyScopes.length === 0"
        @click="createKey"
      >
        Create key
      </button>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Scopes</th>
            <th>Last used</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="apiKeys.length === 0">
            <td colspan="5" class="muted">No API keys yet.</td>
          </tr>
          <tr v-for="k in apiKeys" :key="k.id">
            <td>
              <strong>{{ k.name }}</strong>
              <div class="muted">{{ k.keyPrefix }}</div>
            </td>
            <td>
              <span v-for="s in k.scopes" :key="s" class="badge scope-badge">{{ s }}</span>
            </td>
            <td class="muted">{{ fmtDate(k.lastUsedAt) }}</td>
            <td>
              <span class="badge" :class="{ owner: !k.revokedAt }">{{
                k.revokedAt ? 'revoked' : 'active'
              }}</span>
            </td>
            <td style="text-align: right">
              <button v-if="!k.revokedAt" class="btn btn-danger" :disabled="busy" @click="revokeKey(k)">
                Revoke
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 1.5rem;
}
.member {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 2rem 0 0.5rem;
}
.section-head h2 {
  margin: 0;
}
.field {
  display: block;
  margin-bottom: 1rem;
}
.field input[type='text'],
.field input:not([type]) {
  display: block;
  width: 100%;
  max-width: 320px;
  margin-top: 0.35rem;
  padding: 0.45rem 0.6rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font: inherit;
}
.scopes {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 0.4rem;
}
.scope {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.scope-badge {
  margin-right: 0.3rem;
}
.token-reveal {
  border-color: var(--accent);
}
.token {
  display: block;
  word-break: break-all;
  background: var(--surface-2);
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  margin: 0.5rem 0;
  font-family: ui-monospace, monospace;
}
</style>

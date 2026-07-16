<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/stores/auth'

const auth = useAuth()
const router = useRouter()

const user = computed(() => auth.state.user)
const initials = computed(() => {
  const u = user.value
  if (!u) return '?'
  const base = u.name || u.email
  return base.slice(0, 1).toUpperCase()
})

async function onLogout() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <router-link to="/" class="brand">🅲 Charlie</router-link>
      <nav class="nav">
        <router-link to="/">Dashboard</router-link>
        <router-link v-if="auth.can('members.manage')" to="/members">Members</router-link>
      </nav>
      <div v-if="user" class="who">
        <span class="avatar" :title="user.email">{{ initials }}</span>
        <span class="who-meta">
          <span class="who-name">{{ user.name || user.email }}</span>
          <span class="badge" :class="{ owner: user.role === 'owner' }">{{ user.role }}</span>
        </span>
        <button class="btn" @click="onLogout">Sign out</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.header-inner {
  max-width: 1000px;
  margin: 0 auto;
  padding: 0.75rem 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
}
.brand {
  font-weight: 700;
  color: var(--text);
}
.nav {
  display: flex;
  gap: 1rem;
  flex: 1;
}
.nav a {
  color: var(--text-dim);
}
.nav a.router-link-active {
  color: var(--text);
}
.who {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
  display: grid;
  place-items: center;
  font-weight: 600;
}
.who-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.who-name {
  font-size: 13px;
}
</style>

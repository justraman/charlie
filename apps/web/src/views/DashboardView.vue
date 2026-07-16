<script setup lang="ts">
import { computed } from 'vue'
import { useAuth } from '@/stores/auth'

const auth = useAuth()
const user = computed(() => auth.state.user)
</script>

<template>
  <div class="container">
    <h1>Welcome{{ user?.name ? `, ${user.name}` : '' }}</h1>
    <p class="muted">
      You are signed in as <strong>{{ user?.email }}</strong> with the
      <span class="badge" :class="{ owner: user?.role === 'owner' }">{{ user?.role }}</span> role.
    </p>

    <div class="card" style="margin-top: 1.5rem">
      <h2 style="margin-top: 0">Getting started</h2>
      <p class="muted">
        The auth, roles, and audit foundation is in place. Projects, flows, and test runs arrive in
        later phases.
      </p>
      <ul class="muted">
        <li v-if="auth.can('members.manage')">
          Manage who can access this instance in <router-link to="/members">Members</router-link>.
        </li>
        <li v-if="auth.can('runs.trigger')">You can trigger runs and author flows.</li>
        <li v-else>You have read-only (viewer) access. Ask an admin to promote you.</li>
      </ul>
    </div>
  </div>
</template>

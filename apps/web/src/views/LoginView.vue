<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: 'Your email domain is not permitted to access this Charlie instance.',
  email_unverified: 'Your Google email address is not verified.',
  access_denied: 'Sign-in was cancelled.',
}

const errorMessage = computed(() => {
  const code = route.query.error
  if (typeof code !== 'string') return null
  return ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.'
})

const startUrl = computed(() => {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return `/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`
})
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="logo">🅲</div>
      <h1>Charlie</h1>
      <p class="muted">End-to-end and load testing for any web application.</p>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

      <a class="btn btn-primary google" :href="startUrl">
        Continue with Google
      </a>

      <p class="muted fine">Access is restricted to allowed email domains.</p>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}
.login-card {
  width: 360px;
  max-width: 100%;
  text-align: center;
  padding: 2.5rem 2rem;
}
.logo {
  font-size: 2.5rem;
}
h1 {
  margin: 0.5rem 0 0.25rem;
}
.google {
  display: block;
  margin-top: 1.5rem;
  text-align: center;
}
.google:hover {
  text-decoration: none;
}
.fine {
  margin-top: 1rem;
  font-size: 12px;
}
</style>

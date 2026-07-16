<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()
const chromeless = computed(() => route.meta.public === true)
</script>

<template>
  <AppHeader v-if="!chromeless" />
  <main>
    <router-view />
  </main>
</template>

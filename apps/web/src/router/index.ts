import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuth } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
  },
  {
    path: '/members',
    name: 'members',
    component: () => import('@/views/MembersView.vue'),
    meta: { capability: 'members.manage' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuth()
  if (!auth.state.loaded) await auth.fetchMe()

  if (to.meta.public) {
    // Already signed in → skip the login screen.
    if (to.name === 'login' && auth.isAuthenticated.value) return { name: 'dashboard' }
    return true
  }

  if (!auth.isAuthenticated.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  // Capability-gated routes: bounce to dashboard if the role lacks it.
  const cap = to.meta.capability as import('@shared/roles').Capability | undefined
  if (cap && !auth.can(cap)) return { name: 'dashboard' }

  return true
})

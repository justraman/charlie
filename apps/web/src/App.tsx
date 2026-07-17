import type { Capability } from '@shared/roles'
import type { ReactElement } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { AppSidebar } from '@/components/app-sidebar'
import { ModeToggle } from '@/components/mode-toggle'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { DashboardView } from '@/views/DashboardView'
import { FlowEditorView } from '@/views/FlowEditorView'
import { FlowHistoryView } from '@/views/FlowHistoryView'
import { IntegrationsView } from '@/views/IntegrationsView'
import { LoginView } from '@/views/LoginView'
import { MembersView } from '@/views/MembersView'
import { ProjectDetailView } from '@/views/ProjectDetailView'
import { ProjectsView } from '@/views/ProjectsView'
import { RunDetailView } from '@/views/RunDetailView'
import { RunsView } from '@/views/RunsView'

// The login screen is chromeless; everything else gets the sidebar shell.
function Layout() {
  const { pathname } = useLocation()
  if (pathname === '/login') {
    return <Outlet />
  }
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-5" />
          <div className="flex-1" />
          <ModeToggle />
        </header>
        <main className="flex-1 overflow-x-hidden">
          <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function RequireAuth({ cap, children }: { cap?: Capability; children: ReactElement }) {
  const { user, loaded, can } = useAuth()
  const loc = useLocation()
  if (!loaded) return null
  if (!user) {
    const redirect = encodeURIComponent(loc.pathname + loc.search)
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }
  if (cap && !can(cap)) return <Navigate to="/" replace />
  return children
}

function LoginRoute() {
  const { user, loaded } = useAuth()
  if (!loaded) return null
  if (user) return <Navigate to="/" replace />
  return <LoginView />
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/login" element={<LoginRoute />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardView />
            </RequireAuth>
          }
        />
        <Route
          path="/members"
          element={
            <RequireAuth cap="members.manage">
              <MembersView />
            </RequireAuth>
          }
        />
        <Route
          path="/integrations"
          element={
            <RequireAuth cap="integrations.manage">
              <IntegrationsView />
            </RequireAuth>
          }
        />
        <Route
          path="/projects"
          element={
            <RequireAuth cap="projects.view">
              <ProjectsView />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <RequireAuth cap="projects.view">
              <ProjectDetailView />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/flows/new"
          element={
            <RequireAuth cap="flows.write">
              <FlowEditorView />
            </RequireAuth>
          }
        />
        <Route
          path="/flows/:id/edit"
          element={
            <RequireAuth cap="flows.write">
              <FlowEditorView />
            </RequireAuth>
          }
        />
        <Route
          path="/flows/:id/history"
          element={
            <RequireAuth cap="projects.view">
              <FlowHistoryView />
            </RequireAuth>
          }
        />
        <Route
          path="/runs"
          element={
            <RequireAuth cap="projects.view">
              <RunsView />
            </RequireAuth>
          }
        />
        <Route
          path="/runs/:id"
          element={
            <RequireAuth cap="projects.view">
              <RunDetailView />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

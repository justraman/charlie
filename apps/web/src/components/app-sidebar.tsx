import type { Capability } from '@shared/roles'
import {
  ChevronsUpDownIcon,
  FolderKanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlayCircleIcon,
  PlugIcon,
  UsersIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  cap?: Capability
  end?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboardIcon, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanbanIcon, cap: 'projects.view' },
  { to: '/runs', label: 'Runs', icon: PlayCircleIcon, cap: 'projects.view' },
  { to: '/members', label: 'Members', icon: UsersIcon, cap: 'members.manage' },
  { to: '/integrations', label: 'Integrations', icon: PlugIcon, cap: 'integrations.manage' },
]

export function AppSidebar() {
  const { user, logout, can } = useAuth()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()

  const initials = (user?.name || user?.email || '?').slice(0, 1).toUpperCase()

  async function onLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg font-semibold">
                  C
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Charlie</span>
                  <span className="text-muted-foreground truncate text-xs">Testing platform</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.filter((item) => !item.cap || can(item.cap)).map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild tooltip={item.label}>
                    <NavLink to={item.to} end={item.end}>
                      {({ isActive }) => (
                        <>
                          <item.icon
                            className={isActive ? 'text-sidebar-accent-foreground' : undefined}
                          />
                          <span>{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {user && (
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{user.name || user.email}</span>
                      <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                    </div>
                    <ChevronsUpDownIcon className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                  side={isMobile ? 'bottom' : 'right'}
                  align="end"
                >
                  <DropdownMenuLabel className="flex items-center gap-2 font-normal">
                    <span className="truncate">{user.email}</span>
                    <Badge variant={user.role === 'owner' ? 'default' : 'secondary'}>
                      {user.role}
                    </Badge>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onLogout}>
                    <LogOutIcon /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

import { ArrowRightIcon, FolderKanbanIcon, PlayCircleIcon, UsersIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export function DashboardView() {
  const { user, can } = useAuth()

  const cards = [
    {
      to: '/projects',
      icon: FolderKanbanIcon,
      title: 'Projects',
      description: 'Browse and author projects, environments, and flows.',
      show: can('projects.view'),
    },
    {
      to: '/runs',
      icon: PlayCircleIcon,
      title: 'Runs',
      description: 'Inspect run history, reports, and live progress.',
      show: can('projects.view'),
    },
    {
      to: '/members',
      icon: UsersIcon,
      title: 'Members',
      description: 'Manage who can access this instance and their roles.',
      show: can('members.manage'),
    },
  ].filter((c) => c.show)

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome${user?.name ? `, ${user.name}` : ''}`}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            Signed in as <strong className="text-foreground">{user?.email}</strong>
            <Badge variant={user?.role === 'owner' ? 'default' : 'secondary'}>{user?.role}</Badge>
          </span>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.to} className="transition-colors hover:border-ring/60">
            <CardHeader>
              <c.icon className="text-muted-foreground size-5" />
              <CardTitle className="mt-2">{c.title}</CardTitle>
              <CardDescription>{c.description}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button asChild variant="ghost" size="sm" className="px-0 hover:bg-transparent">
                <Link to={c.to}>
                  Open <ArrowRightIcon />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>
            The auth, roles, audit, and project/flow foundation is in place.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>
            {can('runs.trigger')
              ? 'You can trigger runs and author flows.'
              : 'You have read-only (viewer) access. Ask an admin to promote you.'}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

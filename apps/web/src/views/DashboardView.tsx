import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'

export function DashboardView() {
  const { user, can } = useAuth()

  return (
    <div className="container">
      <h1>Welcome{user?.name ? `, ${user.name}` : ''}</h1>
      <p className="muted">
        You are signed in as <strong>{user?.email}</strong> with the{' '}
        <span className={`badge ${user?.role === 'owner' ? 'owner' : ''}`}>{user?.role}</span> role.
      </p>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Getting started</h2>
        <p className="muted">
          The auth, roles, audit, and project/flow foundation is in place. The execution plane
          (running flows on GitHub Actions) arrives in a later phase.
        </p>
        <ul className="muted">
          <li>
            Browse and author <Link to="/projects">Projects</Link>, environments, and flows.
          </li>
          {can('members.manage') && (
            <li>
              Manage who can access this instance in <Link to="/members">Members</Link>.
            </li>
          )}
          {can('runs.trigger') ? (
            <li>You can trigger runs and author flows.</li>
          ) : (
            <li>You have read-only (viewer) access. Ask an admin to promote you.</li>
          )}
        </ul>
      </div>
    </div>
  )
}

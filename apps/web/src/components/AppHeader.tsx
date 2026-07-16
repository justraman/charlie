import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import styles from './AppHeader.module.css'

export function AppHeader() {
  const { user, logout, can } = useAuth()
  const navigate = useNavigate()

  const initials = (user?.name || user?.email || '?').slice(0, 1).toUpperCase()

  async function onLogout() {
    await logout()
    navigate('/login')
  }

  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? styles.active : undefined)

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link to="/" className={styles.brand}>
          🅲 Charlie
        </Link>
        <nav className={styles.nav}>
          <NavLink to="/" end className={navClass}>
            Dashboard
          </NavLink>
          {can('projects.view') && (
            <NavLink to="/projects" className={navClass}>
              Projects
            </NavLink>
          )}
          {can('members.manage') && (
            <NavLink to="/members" className={navClass}>
              Members
            </NavLink>
          )}
        </nav>
        {user && (
          <div className={styles.who}>
            <span className={styles.avatar} title={user.email}>
              {initials}
            </span>
            <span className={styles.meta}>
              <span className={styles.name}>{user.name || user.email}</span>
              <span className={`badge ${user.role === 'owner' ? 'owner' : ''}`}>{user.role}</span>
            </span>
            <button type="button" className="btn" onClick={onLogout}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

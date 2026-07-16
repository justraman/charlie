import { useSearchParams } from 'react-router-dom'
import styles from './LoginView.module.css'

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: 'Your email domain is not permitted to access this Charlie instance.',
  email_unverified: 'Your Google email address is not verified.',
  access_denied: 'Sign-in was cancelled.',
}

export function LoginView() {
  const [params] = useSearchParams()
  const errorCode = params.get('error')
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? 'Sign-in failed. Please try again.')
    : null

  const redirect = params.get('redirect') ?? '/'
  const startUrl = `/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`

  return (
    <div className={styles.wrap}>
      <div className={`card ${styles.card}`}>
        <div className={styles.logo}>🅲</div>
        <h1 className={styles.title}>Charlie</h1>
        <p className="muted">End-to-end and load testing for any web application.</p>

        {errorMessage && <p className="error">{errorMessage}</p>}

        <a className={`btn btn-primary ${styles.google}`} href={startUrl}>
          Continue with Google
        </a>

        <p className={`muted ${styles.fine}`}>Access is restricted to allowed email domains.</p>
      </div>
    </div>
  )
}

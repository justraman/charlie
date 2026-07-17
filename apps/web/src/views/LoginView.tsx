import { AlertCircleIcon } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

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

  // Local dev only: offer the DEV_LOGIN_EMAIL shortcut. The button just links to
  // the route; the backend enforces the actual guard (it 404s if unconfigured).
  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  const devUrl = `/api/auth/dev?redirect=${encodeURIComponent(redirect)}`

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="bg-primary text-primary-foreground mx-auto mb-2 flex size-12 items-center justify-center rounded-xl text-2xl font-semibold">
            C
          </div>
          <CardTitle className="text-2xl">Charlie</CardTitle>
          <CardDescription>End-to-end and load testing for any web application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {errorMessage && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <Button asChild className="w-full">
            <a href={startUrl}>Continue with Google</a>
          </Button>

          {isLocal && (
            <Button asChild variant="outline" className="w-full">
              <a href={devUrl}>Dev login (local)</a>
            </Button>
          )}

          <p className="text-muted-foreground text-center text-xs">
            Access is restricted to allowed email domains.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

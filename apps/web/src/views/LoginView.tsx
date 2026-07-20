import { signIn } from '@hono/auth-js/react'
import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

// Auth.js error codes surfaced via ?error= on the sign-in/error page.
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: 'Your email domain is not permitted to access this Charlie instance.',
  Verification: 'That sign-in link is invalid or has expired. Request a new one.',
  OAuthAccountNotLinked: 'That email is already registered with a different sign-in method.',
  Configuration: 'Sign-in is misconfigured. Contact your administrator.',
  default: 'Sign-in failed. Please try again.',
}

export function LoginView() {
  const [params] = useSearchParams()
  const redirect = params.get('redirect') ?? '/'
  const errorCode = params.get('error')
  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.default) : null
  const checkEmail = params.get('verify') === 'email'

  const [email, setEmail] = useState('')

  // Local dev only: the "dev" Credentials provider is registered by the Worker
  // when DEV_LOGIN_EMAIL is set (never in a Secure/production deployment).
  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

  function onEmailSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email) return
    // Redirects to the verify-request page (/login?verify=email) after sending.
    void signIn('resend', { email, callbackUrl: redirect })
  }

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
        <CardContent className="space-y-4">
          {errorMessage && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {checkEmail ? (
            <Alert>
              <CheckCircle2Icon />
              <AlertDescription>
                Check your email for a sign-in link. You can close this tab.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Button
                className="w-full"
                onClick={() => signIn('google', { callbackUrl: redirect })}
              >
                Continue with Google
              </Button>

              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-muted-foreground text-xs">or</span>
                <Separator className="flex-1" />
              </div>

              <form className="space-y-2" onSubmit={onEmailSubmit}>
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button type="submit" variant="outline" className="w-full">
                  Email me a sign-in link
                </Button>
              </form>

              {isLocal && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => signIn('dev', { callbackUrl: redirect })}
                >
                  Dev login (local)
                </Button>
              )}
            </>
          )}

          <p className="text-muted-foreground text-center text-xs">
            Access is restricted to allowed email domains.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

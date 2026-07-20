import { SessionProvider } from '@hono/auth-js/react'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { AuthProvider } from './auth/AuthContext'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <BrowserRouter>
        <SessionProvider>
          <AuthProvider>
            <TooltipProvider delayDuration={200}>
              <App />
              <Toaster richColors position="top-right" />
            </TooltipProvider>
          </AuthProvider>
        </SessionProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)

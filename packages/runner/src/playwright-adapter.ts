// Playwright implementation of the flow-core EngineAdapter. The shared executor
// drives it; this class only translates each adapter method into Playwright
// calls and captures artifacts on failure.

import type {
  ArtifactRefs,
  AssertSpec,
  EngineAdapter,
  ExtractSpec,
  WaitTarget,
} from '@charlie/flow-core'
import type { BrowserContext, Page } from 'playwright-core'

export type ArtifactUploader = (
  name: string,
  bytes: Uint8Array,
  contentType: string,
) => Promise<string>

export class PlaywrightAdapter implements EngineAdapter {
  private headers: Record<string, string> = {}

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly baseUrl: string,
    private readonly upload: ArtifactUploader,
    initialHeaders: Record<string, string> = {},
  ) {
    this.headers = { ...initialHeaders }
  }

  private resolve(url: string): string {
    return new URL(url, this.baseUrl).toString()
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(this.resolve(url), { waitUntil: 'load' })
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector)
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value)
  }

  async waitFor(target: WaitTarget): Promise<void> {
    if (typeof target.ms === 'number') {
      await this.page.waitForTimeout(target.ms)
    } else if (target.selector) {
      await this.page.waitForSelector(target.selector)
    }
  }

  async assert(check: AssertSpec): Promise<{ ok: boolean; detail?: string }> {
    try {
      if (check.selector && check.state) {
        await this.page
          .locator(check.selector)
          .first()
          .waitFor({ state: check.state as 'visible' | 'hidden' | 'attached' | 'detached' })
        return { ok: true }
      }
      if (check.text) {
        const content = await this.page.content()
        if (content.includes(check.text)) return { ok: true }
        return { ok: false, detail: `text not found: ${check.text}` }
      }
      return { ok: false, detail: 'assert had no selector/state or text' }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  async extract(spec: ExtractSpec): Promise<string> {
    if (spec.selector) {
      const el = this.page.locator(spec.selector).first()
      const value = await el.inputValue().catch(() => null)
      if (value !== null) return value
      return (await el.textContent()) ?? ''
    }
    if (spec.regex) {
      const content = await this.page.content()
      const m = new RegExp(spec.regex).exec(content)
      return m?.[1] ?? m?.[0] ?? ''
    }
    return ''
  }

  async submit(selector: string): Promise<void> {
    await this.page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const form = el as unknown as { requestSubmit?: () => void; submit?: () => void }
        if (typeof form.requestSubmit === 'function') form.requestSubmit()
        else if (typeof form.submit === 'function') form.submit()
      })
  }

  async setHeader(name: string, value: string): Promise<void> {
    this.headers[name] = value
    await this.context.setExtraHTTPHeaders(this.headers)
  }

  async captureArtifacts(reason: string): Promise<ArtifactRefs> {
    const refs: ArtifactRefs = {}
    try {
      const shot = await this.page.screenshot({ fullPage: true })
      refs.screenshot = await this.upload('screenshot.png', shot, 'image/png')
    } catch {
      /* screenshot best-effort */
    }
    refs.reason = reason
    return refs
  }
}

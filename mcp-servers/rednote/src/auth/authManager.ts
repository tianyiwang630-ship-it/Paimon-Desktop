import { Browser, BrowserContext, chromium, Cookie, Page } from 'playwright'
import { CookieManager } from './cookieManager'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import logger from '../utils/logger'

dotenv.config()

export class AuthManager {
  private browser: Browser | null
  private context: BrowserContext | null
  private page: Page | null
  private cookieManager: CookieManager

  constructor(cookiePath?: string) {
    logger.info('Initializing AuthManager')
    this.browser = null
    this.context = null
    this.page = null

    // Default cookie path: ~/.mcp/rednote/cookies.json
    if (!cookiePath) {
      const homeDir = os.homedir()
      const mcpDir = path.join(homeDir, '.mcp')
      const rednoteDir = path.join(mcpDir, 'rednote')

      if (!fs.existsSync(mcpDir)) {
        logger.info(`Creating directory: ${mcpDir}`)
        fs.mkdirSync(mcpDir)
      }
      if (!fs.existsSync(rednoteDir)) {
        logger.info(`Creating directory: ${rednoteDir}`)
        fs.mkdirSync(rednoteDir)
      }

      cookiePath = path.join(rednoteDir, 'cookies.json')
    }

    logger.info(`Using cookie path: ${cookiePath}`)
    this.cookieManager = new CookieManager(cookiePath)
  }

  async getBrowser(): Promise<Browser> {
    logger.info('Launching browser with stealth settings')
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--lang=zh-CN,zh',
      ],
    })
    return this.browser
  }

  async getCookies(): Promise<Cookie[]> {
    logger.info('Loading cookies')
    return await this.cookieManager.loadCookies()
  }

  private async isLoggedIn(): Promise<boolean> {
    if (!this.page || !this.context) {
      return false
    }

    const cookies = await this.context
      .cookies('https://www.xiaohongshu.com')
      .catch(() => [])

    const hasAuthCookie = cookies.some(
      (cookie) =>
        ['web_session', 'a1', 'webId', 'xsecappid'].includes(cookie.name) &&
        Boolean(cookie.value),
    )

    const pageSignals = await this.page
      .evaluate(() => {
        const hasLoginPrompt = Boolean(
          document.querySelector(
            '.login-container, .login-mask, .qrcode-img, [class*="login-container"], [class*="login-panel"]',
          ),
        )
        const hasUserEntry = Boolean(
          document.querySelector(
            '.user.side-bar-component .channel, a[href*="/user/profile"], [class*="avatar"], [class*="user-info"]',
          ),
        )

        return { hasLoginPrompt, hasUserEntry }
      })
      .catch(() => ({ hasLoginPrompt: false, hasUserEntry: false }))

    return !pageSignals.hasLoginPrompt && (hasAuthCookie || pageSignals.hasUserEntry)
  }

  async login(options?: { timeout?: number }): Promise<void> {
    const timeoutSeconds = options?.timeout || 10
    logger.info(`Starting login process with timeout: ${timeoutSeconds}s`)
    const timeoutMs = timeoutSeconds * 1000

    this.browser = await chromium.launch({
      headless: false,
      timeout: timeoutMs,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--lang=zh-CN,zh',
      ],
    })

    if (!this.browser) {
      logger.error('Failed to launch browser')
      throw new Error('Failed to launch browser')
    }

    let retryCount = 0
    const maxRetries = 3

    while (retryCount < maxRetries) {
      try {
        logger.info(`Login attempt ${retryCount + 1}/${maxRetries}`)
        this.context = await this.browser.newContext()
        this.page = await this.context.newPage()

        // Load existing cookies if available.
        const cookies = await this.cookieManager.loadCookies()
        if (cookies && cookies.length > 0) {
          logger.info(`Loaded ${cookies.length} existing cookies`)
          await this.context.addCookies(cookies)
        }

        logger.info('Navigating to explore page')
        await this.page.goto('https://www.xiaohongshu.com/explore', {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        })

        // Already logged in.
        if (await this.isLoggedIn()) {
          logger.info('Already logged in')
          const newCookies = await this.context.cookies()
          await this.cookieManager.saveCookies(newCookies)
          return
        }

        // Login may require QR interaction. Wait for login completion signal.
        logger.info('Waiting for user to complete login')
        await this.page
          .waitForFunction(() => {
            const hasLoginPrompt = Boolean(
              document.querySelector(
                '.login-container, .login-mask, .qrcode-img, [class*="login-container"], [class*="login-panel"]',
              ),
            )
            const hasUserEntry = Boolean(
              document.querySelector(
                '.user.side-bar-component .channel, a[href*="/user/profile"], [class*="avatar"], [class*="user-info"]',
              ),
            )
            return !hasLoginPrompt && hasUserEntry
          }, { timeout: timeoutMs * 6 })
          .catch(() => {
            logger.info('Login completion signal timeout; verifying via cookies and page signals')
          })

        const isLoggedIn = await this.isLoggedIn()
        if (!isLoggedIn) {
          logger.error('Login verification failed')
          throw new Error('Login verification failed')
        }

        logger.info('Login successful, saving cookies')
        const newCookies = await this.context.cookies()
        await this.cookieManager.saveCookies(newCookies)
        return
      } catch (error) {
        logger.error(`Login attempt ${retryCount + 1} failed:`, error)

        if (this.page) {
          await this.page.close().catch(() => {})
        }
        if (this.context) {
          await this.context.close().catch(() => {})
        }
        this.page = null
        this.context = null

        retryCount++
        if (retryCount < maxRetries) {
          logger.info(`Retrying login in 2 seconds (${retryCount}/${maxRetries})`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        } else {
          logger.error('Login failed after maximum retries')
          throw new Error('Login failed after maximum retries')
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up browser resources')
    if (this.page) {
      await this.page.close().catch(() => {})
    }
    if (this.context) {
      await this.context.close().catch(() => {})
    }
    if (this.browser) {
      await this.browser.close().catch(() => {})
    }
    this.page = null
    this.context = null
    this.browser = null
  }
}

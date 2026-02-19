import { AuthManager } from '../auth/authManager'
import { Browser, Page } from 'playwright'
import logger from '../utils/logger'

// 浏览器单例管理
let sharedBrowser: Browser | null = null
let sharedPage: Page | null = null
let firstUseInteractiveLoginDone = false

// 互斥锁：保证同一时刻只有一个工具调用在操作页面
let pageLock: Promise<void> = Promise.resolve()

function acquireLock(): { promise: Promise<void>; release: () => void } {
  let release: () => void
  const newLock = new Promise<void>((resolve) => { release = resolve })
  const waitForPrev = pageLock
  pageLock = newLock
  return { promise: waitForPrev, release: release! }
}

export class RedNoteTools {
  private authManager: AuthManager

  constructor() {
    logger.info('Initializing RedNoteTools')
    this.authManager = new AuthManager()
  }

  // ========== 浏览器生命周期管理（保持不变） ==========

  /**
   * 获取或复用浏览器实例（单例模式）
   */
  async initialize(autoLoginAttempted: boolean = false): Promise<void> {
    logger.info('Initializing browser and page')

    if (sharedBrowser && sharedPage) {
      try {
        await sharedPage.evaluate(() => document.readyState)
        logger.info('Reusing existing browser session')
        return
      } catch {
        logger.info('Previous browser session is dead, creating new one')
        await this.forceCleanup()
      }
    }

    const forceInteractiveLoginOnFirstUse =
      (process.env.REDNOTE_FORCE_INTERACTIVE_LOGIN_ON_FIRST_USE || '1') !== '0'
    if (forceInteractiveLoginOnFirstUse && !firstUseInteractiveLoginDone && !autoLoginAttempted) {
      const parsed = Number(process.env.REDNOTE_LOGIN_TIMEOUT_SECONDS || '120')
      const timeoutSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 120
      logger.info(`Forcing interactive rednote login on first tool use (timeout=${timeoutSeconds}s)`)
      try {
        await this.authManager.login({ timeout: timeoutSeconds })
        await this.authManager.cleanup()
        firstUseInteractiveLoginDone = true
        logger.info('First-use interactive login completed')
      } catch (error) {
        await this.authManager.cleanup().catch(() => {})
        throw error
      }
    }

    sharedBrowser = await this.authManager.getBrowser()
    if (!sharedBrowser) {
      throw new Error('Failed to initialize browser')
    }

    try {
      sharedPage = await sharedBrowser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      })

      // 反检测
      await sharedPage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        })
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en'],
        })
        const originalQuery = window.navigator.permissions.query
        // @ts-ignore
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters)
      })

      // 加载 cookies
      const cookies = await this.authManager.getCookies()
      if (cookies.length > 0) {
        logger.info(`Loading ${cookies.length} cookies`)
        await sharedPage.context().addCookies(cookies)
      }      // Verify login status using structural signals + auth cookies.
      logger.info('Checking login status')
      await sharedPage.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded' })

      const contextCookies = await sharedPage.context().cookies('https://www.xiaohongshu.com').catch(() => [])
      const hasAuthCookie = contextCookies.some(
        (cookie) => ['web_session', 'a1', 'webId', 'xsecappid'].includes(cookie.name) && Boolean(cookie.value),
      )

      const pageSignals = await sharedPage
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

      const isLoggedIn = !pageSignals.hasLoginPrompt && (hasAuthCookie || pageSignals.hasUserEntry)

      if (!isLoggedIn) {
        logger.warn('Not logged in')
        await this.forceCleanup()

        if (!autoLoginAttempted) {
          const parsed = Number(process.env.REDNOTE_LOGIN_TIMEOUT_SECONDS || '120')
          const timeoutSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 120
          logger.info(`Starting interactive rednote login flow (timeout=${timeoutSeconds}s)`)

          await this.authManager.login({ timeout: timeoutSeconds })
          await this.authManager.cleanup()

          logger.info('Interactive login completed, retrying browser initialization')
          await this.initialize(true)
          return
        }

        throw new Error('Not logged in after interactive login attempt')
      }

      logger.info('Login status verified')
    } catch (error) {
      await this.forceCleanup()
      throw error
    }
  }

  async forceCleanup(): Promise<void> {
    logger.info('Force cleaning up browser resources')
    try {
      if (sharedPage) {
        await sharedPage.close().catch(err => logger.error('Error closing page:', err))
      }
      if (sharedBrowser) {
        await sharedBrowser.close().catch(err => logger.error('Error closing browser:', err))
      }
    } catch (error) {
      logger.error('Error during cleanup:', error)
    } finally {
      sharedPage = null
      sharedBrowser = null
    }
  }

  async cleanup(): Promise<void> {
    logger.info('Cleanup called (keeping browser alive for reuse)')
  }

  private get page(): Page {
    if (!sharedPage) throw new Error('Page not initialized')
    return sharedPage
  }

  private async ensurePageHealthy(): Promise<void> {
    try {
      const url = this.page.url()
      const isErrorPage = url.includes('/404') || url.includes('error_code=')
      if (isErrorPage) {
        logger.info(`Page is on error page (${url}), forcing browser restart`)
        await this.forceCleanup()
        return
      }
      await this.page.evaluate(() => document.readyState)
    } catch {
      logger.info('Page is unhealthy, forcing browser restart')
      await this.forceCleanup()
    }
  }

  private async randomDelay(min: number, max: number): Promise<void> {
    const delay = Math.random() * (max - min) + min
    logger.debug(`Adding random delay of ${delay.toFixed(2)} seconds`)
    await new Promise((resolve) => setTimeout(resolve, delay * 1000))
  }

  // ========== 页面快照（核心方法） ==========

  /**
   * 获取当前页面的结构化快照
   *
   * 不依赖任何具体 CSS 选择器提取数据——通过通用 DOM 遍历
   * 提取所有可见的文本内容和可交互元素（链接+URL、按钮、输入框）
   *
   * 页面结构变化时不需要修改此方法
   */
  private async getSnapshot(): Promise<string> {
    const url = this.page.url()
    const title = await this.page.title()

    const data = await this.page.evaluate(() => {
      const links: Array<{ text: string; href: string }> = []
      const buttons: Array<{ text: string }> = []
      const inputs: Array<{ placeholder: string; value: string; type: string }> = []

      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }

      // 提取所有可见的链接
      document.querySelectorAll('a[href]').forEach(el => {
        if (!isVisible(el)) return
        const a = el as HTMLAnchorElement
        const text = a.textContent?.trim()?.substring(0, 100) || ''
        if (!text || text.length < 1) return
        links.push({ text, href: a.href })
      })

      // 提取所有可见的按钮
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        if (!isVisible(el)) return
        if (el.tagName === 'A') return // 已在 links 中
        const text = el.textContent?.trim()?.substring(0, 60) || ''
        if (!text) return
        buttons.push({ text })
      })

      // 提取所有可见的输入框
      document.querySelectorAll('input, textarea').forEach(el => {
        if (!isVisible(el)) return
        const input = el as HTMLInputElement
        inputs.push({
          placeholder: input.placeholder || '',
          value: input.value || '',
          type: input.type || 'text'
        })
      })

      // 提取页面可见文本（innerText 自动跳过隐藏元素）
      const pageText = document.body.innerText || ''

      return { links, buttons, inputs, pageText }
    })

    // 构建输出
    let output = `URL: ${url}\nTitle: ${title}\n\n`

    // 可交互元素
    if (data.links.length > 0) {
      output += `--- Links (${data.links.length}) ---\n`
      data.links.forEach((l, i) => {
        output += `[${i + 1}] ${l.text}  →  ${l.href}\n`
      })
      output += '\n'
    }

    if (data.buttons.length > 0) {
      output += `--- Buttons ---\n`
      data.buttons.forEach((b, i) => {
        output += `<button> ${b.text}\n`
      })
      output += '\n'
    }

    if (data.inputs.length > 0) {
      output += `--- Inputs ---\n`
      data.inputs.forEach(inp => {
        output += `<input type="${inp.type}"${inp.placeholder ? ` placeholder="${inp.placeholder}"` : ''}${inp.value ? ` value="${inp.value}"` : ''}>\n`
      })
      output += '\n'
    }

    // 页面文本内容（截断控制）
    output += `--- Page Content ---\n`
    const maxTextLen = 8000
    if (data.pageText.length > maxTextLen) {
      output += data.pageText.substring(0, maxTextLen) + '\n\n... (内容已截断，可使用 scroll 工具查看更多)\n'
    } else {
      output += data.pageText + '\n'
    }

    return output
  }

  // ========== 通用浏览器操作工具 ==========

  /**
   * 导航到任意 URL，返回页面快照
   */
  async browse(url: string): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`browse: ${url}`)
    try {
      await this.initialize()
      await this.page.goto(url, { waitUntil: 'domcontentloaded' })
      await this.randomDelay(0.3, 0.8)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in browse:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 小红书搜索快捷方式
   * type: "note"（默认）, "user"
   *
   * 搜索结果是异步加载的，需要等待内容渲染完成再取快照
   */
  async search(keyword: string, type: string = 'note'): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`search: ${keyword} type=${type}`)
    try {
      await this.initialize()
      const typeParam = type === 'user' ? '&type=user' : ''
      const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}${typeParam}`
      await this.page.goto(url, { waitUntil: 'domcontentloaded' })

      // 等待搜索结果加载（通用方式：等待页面上的链接数量增加，表明内容已渲染）
      await this.page.waitForFunction(
        () => document.querySelectorAll('a[href*="/explore/"], a[href*="/user/profile/"]').length > 0,
        { timeout: 5000 }
      ).catch(() => {
        logger.info('Search results did not appear within timeout, taking snapshot anyway')
      })

      await this.randomDelay(0.2, 0.6)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in search:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 点击页面上的元素，返回新页面快照
   *
   * target 支持三种模式（自动检测）：
   * 1. 文本匹配 — 传入元素的可见文本（如笔记标题、按钮文字）
   * 2. URL 匹配 — 传入链接 URL 或其片段（如 noteId），点击对应的 <a>
   * 3. 坐标匹配 — 传入 "x,y" 格式的坐标
   *
   * 始终使用 Playwright trusted click（非 JS click），确保触发完整事件链（包括 xsec_token 等动态参数）
   */
  async click(target: string): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`click: ${target}`)
    try {
      await this.initialize()

      let clicked = false

      // 模式1: 坐标 "x,y"
      const coordMatch = target.match(/^(\d+)\s*,\s*(\d+)$/)
      if (coordMatch) {
        const x = parseInt(coordMatch[1])
        const y = parseInt(coordMatch[2])
        logger.info(`Clicking at coordinates (${x}, ${y})`)
        await this.page.mouse.click(x, y)
        clicked = true
      }

      // 模式2: URL / noteId — 通过 href 匹配 <a> 并点击
      if (!clicked) {
        const isUrl = target.startsWith('http') || target.startsWith('/')
        const isNoteId = /^[a-f0-9]{24}$/.test(target)

        if (isUrl || isNoteId) {
          const hrefPattern = isNoteId ? target : target
          logger.info(`Clicking link by href pattern: ${hrefPattern}`)

          // 先滚动到目标元素
          const found = await this.page.evaluate((pattern: string) => {
            const links = document.querySelectorAll('a[href]')
            for (const link of Array.from(links)) {
              if ((link as HTMLAnchorElement).href.includes(pattern)) {
                const parent = link.closest('[class*="note"]') || link.parentElement
                if (parent) parent.scrollIntoView({ block: 'center', behavior: 'instant' })
                return true
              }
            }
            return false
          }, hrefPattern)

          if (found) {
            await this.randomDelay(0.1, 0.2)
            const link = this.page.locator(`a[href*="${hrefPattern}"]`).first()
            await link.click({ timeout: 5000, force: true })
            clicked = true
          }
        }
      }

      // 模式3: 文本匹配 — 先精确匹配，再模糊匹配
      if (!clicked) {
        logger.info(`Clicking by text: ${target}`)

        // 滚动目标元素到视口
        await this.page.evaluate((text: string) => {
          const clickables = document.querySelectorAll('a, button, [role="button"], [role="tab"], [role="menuitem"]')
          for (const el of Array.from(clickables)) {
            const elText = el.textContent?.trim() || ''
            if (elText === text) {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              return true
            }
          }
          // 部分匹配
          for (const el of Array.from(clickables)) {
            const elText = el.textContent?.trim() || ''
            if (elText.includes(text) || text.includes(elText)) {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              return true
            }
          }
          return false
        }, target)

        await this.randomDelay(0.1, 0.2)

        // 用 Playwright locator 发起 trusted click
        // 按优先级尝试不同 locator 策略
        const strategies = [
          // Exact matches first.
          () => this.page.getByRole('link', { name: target, exact: true }).first(),
          () => this.page.getByRole('button', { name: target, exact: true }).first(),
          () => this.page.getByRole('tab', { name: target, exact: true }).first(),
          () => this.page.getByText(target, { exact: true }).first(),
          // Then fall back to partial text match.
          () => this.page.getByText(target, { exact: false }).first(),
        ]

        for (const getLocator of strategies) {
          try {
            const locator = getLocator()
            await locator.click({ timeout: 1500 })
            clicked = true
            break
          } catch {
            // 下一个策略
          }
        }
      }

      if (!clicked) {
        return `Error: 未找到可点击的元素 "${target}"。请使用 snapshot 查看当前页面上的可用元素。`
      }

      await this.randomDelay(0.3, 0.8)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in click:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 滚动页面，返回新快照
   */
  async scroll(direction: 'down' | 'up' = 'down', amount: number = 500): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`scroll: ${direction} ${amount}px`)
    try {
      await this.initialize()
      const pixels = direction === 'down' ? amount : -amount
      await this.page.evaluate((px: number) => window.scrollBy(0, px), pixels)
      await this.randomDelay(0.5, 1)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in scroll:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 获取当前页面快照（不导航）
   */
  async snapshot(): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info('snapshot')
    try {
      await this.initialize()
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in snapshot:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 浏览器后退，返回新快照
   */
  async goBack(): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info('goBack')
    try {
      await this.initialize()
      await this.page.goBack({ waitUntil: 'domcontentloaded' })
      await this.randomDelay(1, 2)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in goBack:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 在输入框中输入文本
   * selector: CSS选择器或 "search" 快捷方式（自动定位搜索框）
   */
  async typeText(text: string, pressEnter: boolean = false): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`typeText: "${text}" pressEnter=${pressEnter}`)
    try {
      await this.initialize()

      // 查找当前聚焦的输入框，或者页面上第一个可见的输入框
      const hasActiveInput = await this.page.evaluate(() => {
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          return true
        }
        // 尝试聚焦第一个可见的输入框
        const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea')
        for (const input of Array.from(inputs)) {
          const rect = input.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            (input as HTMLElement).focus()
            return true
          }
        }
        return false
      })

      if (!hasActiveInput) {
        return 'Error: 没有找到可输入的文本框。请先 click 一个输入框。'
      }

      // 清空现有内容并输入新文本
      await this.page.keyboard.press('Control+a')
      await this.page.keyboard.type(text, { delay: 50 })

      if (pressEnter) {
        await this.randomDelay(0.3, 0.5)
        await this.page.keyboard.press('Enter')
        await this.randomDelay(0.3, 0.8)
      } else {
        await this.randomDelay(0.5, 1)
      }

      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in typeText:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }

  /**
   * 按键盘快捷键（如 Escape, Enter, Tab 等）
   */
  async pressKey(key: string): Promise<string> {
    const lock = acquireLock()
    await lock.promise
    logger.info(`pressKey: ${key}`)
    try {
      await this.initialize()
      await this.page.keyboard.press(key)
      await this.randomDelay(0.5, 1)
      return await this.getSnapshot()
    } catch (error) {
      logger.error('Error in pressKey:', error)
      await this.ensurePageHealthy()
      throw error
    } finally {
      lock.release()
    }
  }
}

// 进程退出时清理浏览器
process.on('exit', () => {
  if (sharedBrowser) {
    sharedBrowser.close().catch(() => {})
  }
})

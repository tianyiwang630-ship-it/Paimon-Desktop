#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AuthManager } from './auth/authManager'
import { RedNoteTools } from './tools/rednoteTools'
import logger, { LOGS_DIR, packLogs } from './utils/logger'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createStdioLogger } from './utils/stdioLogger'

const execAsync = promisify(exec)

const name = 'rednote'
const description =
  '小红书浏览器自动化工具。提供通用的页面浏览、搜索、点击、滚动等操作，返回页面快照供 AI 分析和决策。'
const version = '0.3.0'

// Create server instance
const server = new McpServer({
  name,
  version,
  protocolVersion: '2024-11-05',
  capabilities: {
    tools: true,
    sampling: {},
    roots: {
      listChanged: true
    }
  }
})

// 共享工具实例（浏览器单例复用）
const tools = new RedNoteTools()

// ========== 注册工具 ==========

server.tool(
  'browse',
  '导航到指定 URL 并返回页面快照（包含所有可见文本、链接URL、按钮、输入框）。适用于访问用户主页、笔记详情、收藏页等任意小红书页面。',
  {
    url: z.string().describe('要访问的完整 URL')
  },
  async ({ url }: { url: string }) => {
    logger.info(`browse: ${url}`)
    try {
      const snapshot = await tools.browse(url)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in browse:', error)
      throw error
    }
  }
)

server.tool(
  'search',
  '在小红书搜索关键词，返回搜索结果页的快照。type 参数可选 "note"（搜索笔记，默认）或 "user"（搜索用户）。',
  {
    keyword: z.string().describe('搜索关键词'),
    type: z.enum(['note', 'user']).optional().describe('搜索类型：note=笔记（默认）, user=用户')
  },
  async ({ keyword, type = 'note' }: { keyword: string; type?: string }) => {
    logger.info(`search: ${keyword} type=${type}`)
    try {
      const snapshot = await tools.search(keyword, type)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in search:', error)
      throw error
    }
  }
)

server.tool(
  'click',
  '点击页面上的元素并返回新页面快照。支持三种模式：1) 传入元素的可见文本（如笔记标题、按钮文字）；2) 传入链接 URL 或 noteId（24位十六进制）；3) 传入 "x,y" 坐标。重要：点击笔记链接时会自动携带 xsec_token，比直接 browse URL 更可靠。',
  {
    target: z.string().describe('要点击的目标：元素文本、URL/noteId、或 "x,y" 坐标')
  },
  async ({ target }: { target: string }) => {
    logger.info(`click: ${target}`)
    try {
      const snapshot = await tools.click(target)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in click:', error)
      throw error
    }
  }
)

server.tool(
  'scroll',
  '滚动页面并返回新快照。用于加载更多内容（如更多笔记、评论等）。',
  {
    direction: z.enum(['down', 'up']).optional().describe('滚动方向，默认 down'),
    amount: z.number().optional().describe('滚动像素数，默认 500')
  },
  async ({ direction = 'down', amount = 500 }: { direction?: 'down' | 'up'; amount?: number }) => {
    logger.info(`scroll: ${direction} ${amount}px`)
    try {
      const snapshot = await tools.scroll(direction, amount)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in scroll:', error)
      throw error
    }
  }
)

server.tool(
  'snapshot',
  '获取当前页面的快照（不进行导航或操作）。返回页面上所有可见文本、链接、按钮和输入框。',
  {},
  async () => {
    logger.info('snapshot')
    try {
      const snapshot = await tools.snapshot()
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in snapshot:', error)
      throw error
    }
  }
)

server.tool(
  'go_back',
  '浏览器后退按钮，返回上一页并给出快照。',
  {},
  async () => {
    logger.info('go_back')
    try {
      const snapshot = await tools.goBack()
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in go_back:', error)
      throw error
    }
  }
)

server.tool(
  'type_text',
  '在当前聚焦的输入框（或页面上第一个可见输入框）中输入文本。可选择输入后按回车。',
  {
    text: z.string().describe('要输入的文本'),
    press_enter: z.boolean().optional().describe('输入后是否按回车，默认 false')
  },
  async ({ text, press_enter = false }: { text: string; press_enter?: boolean }) => {
    logger.info(`type_text: "${text}" press_enter=${press_enter}`)
    try {
      const snapshot = await tools.typeText(text, press_enter)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in type_text:', error)
      throw error
    }
  }
)

server.tool(
  'press_key',
  '按下键盘按键（如 Escape 关闭弹窗、Enter 提交、Tab 切换焦点等）。',
  {
    key: z.string().describe('按键名称，如 Escape, Enter, Tab, ArrowDown 等')
  },
  async ({ key }: { key: string }) => {
    logger.info(`press_key: ${key}`)
    try {
      const snapshot = await tools.pressKey(key)
      return { content: [{ type: 'text', text: snapshot }] }
    } catch (error) {
      logger.error('Error in press_key:', error)
      throw error
    }
  }
)

// Login tool
server.tool('login', '登录小红书账号（会打开浏览器显示二维码）', {}, async () => {
  logger.info('Starting login process')
  const authManager = new AuthManager()
  try {
    await authManager.login()
    logger.info('Login successful')
    await authManager.cleanup()
    logger.info('Login browser closed')
    await tools.forceCleanup()
    logger.info('Shared browser reset, new cookies will be loaded on next call')
    return {
      content: [{ type: 'text', text: '登录成功！Cookie 已保存，浏览器已刷新。' }]
    }
  } catch (error) {
    logger.error('Login failed:', error)
    await authManager.cleanup().catch(() => {})
    throw error
  }
})

// Start the server
async function main() {
  logger.info('Starting RedNote MCP Server')

  const stopLogging = createStdioLogger(`${LOGS_DIR}/stdio.log`)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('RedNote MCP Server running on stdio')

  process.on('exit', () => {
    stopLogging()
  })
}

// 检查是否在 stdio 模式下运行
if (process.argv.includes('--stdio')) {
  main().catch((error) => {
    logger.error('Fatal error in main():', error)
    process.exit(1)
  })
} else {
  const { Command } = require('commander')
  const program = new Command()

  program.name(name).description(description).version(version)

  program
    .command('init [timeout]')
    .description('Initialize and login to RedNote')
    .argument('[timeout]', 'Login timeout in seconds', (value: string) => parseInt(value, 10), 10)
    .usage('[options] [timeout]')
    .addHelpText('after', `
Examples:
  $ rednote-mcp init           # Login with default 10 seconds timeout
  $ rednote-mcp init 30        # Login with 30 seconds timeout`)
    .action(async (timeout: number) => {
      logger.info(`Starting initialization process with timeout: ${timeout}s`)
      try {
        const authManager = new AuthManager()
        await authManager.login({ timeout })
        await authManager.cleanup()
        logger.info('Initialization successful')
        console.log('Login successful! Cookie has been saved.')
        process.exit(0)
      } catch (error) {
        logger.error('Error during initialization:', error)
        console.error('Error during initialization:', error)
        process.exit(1)
      }
    })

  program
    .command('pack-logs')
    .description('Pack all log files into a zip file')
    .action(async () => {
      try {
        const zipPath = await packLogs()
        console.log(`日志已打包到: ${zipPath}`)
        process.exit(0)
      } catch (error) {
        console.error('打包日志失败:', error)
        process.exit(1)
      }
    })

  program
    .command('open-logs')
    .description('Open the logs directory in file explorer')
    .action(async () => {
      try {
        let command
        switch (process.platform) {
          case 'darwin':
            command = `open "${LOGS_DIR}"`
            break
          case 'win32':
            command = `explorer "${LOGS_DIR}"`
            break
          case 'linux':
            command = `xdg-open "${LOGS_DIR}"`
            break
          default:
            throw new Error(`Unsupported platform: ${process.platform}`)
        }
        await execAsync(command)
        console.log(`日志目录已打开: ${LOGS_DIR}`)
        process.exit(0)
      } catch (error) {
        console.error('打开日志目录失败:', error)
        process.exit(1)
      }
    })

  program.parse(process.argv)
}

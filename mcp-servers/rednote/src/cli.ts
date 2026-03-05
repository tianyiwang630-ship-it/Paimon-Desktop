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
  'RedNote (Xiaohongshu) browser automation tools. Provides generic page browsing, search, click, scroll, and related actions, and returns page snapshots for AI analysis and decision-making.'
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

// Shared tools instance for browser reuse
const tools = new RedNoteTools()

// Register tools

server.tool(
  'browse',
  'Open a specific URL and return a page snapshot, including visible text, link URLs, buttons, and input fields. Use this for any RedNote/Xiaohongshu page such as user profiles, note details, or collection pages.',
  {
    url: z.string().describe('The full URL to open.')
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
  'Search RedNote/Xiaohongshu for a keyword and return a snapshot of the results page. The optional type parameter supports "note" for note search (default) or "user" for user search.',
  {
    keyword: z.string().describe('The keyword to search for.'),
    type: z.enum(['note', 'user']).optional().describe('Search type: note = notes (default), user = users.')
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
  'Click an element on the page and return a new page snapshot. Supported targets: 1) visible element text such as a note title or button label, 2) a link URL or noteId (24-character hexadecimal), or 3) coordinates in "x,y" format. Clicking note links automatically preserves xsec_token and is more reliable than browsing the note URL directly.',
  {
    target: z.string().describe('The click target: visible text, a URL/noteId, or coordinates in "x,y" format.')
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
  'Scroll the page and return a new snapshot. Use this to load more content such as additional notes or comments.',
  {
    direction: z.enum(['down', 'up']).optional().describe('Scroll direction. Defaults to down.'),
    amount: z.number().optional().describe('Scroll distance in pixels. Defaults to 500.')
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
  'Capture a snapshot of the current page without navigating or performing any action. Returns visible text, links, buttons, and input fields on the page.',
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
  'Go back to the previous page in the browser and return a new snapshot.',
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
  'Type text into the currently focused input field, or into the first visible input field on the page. Optionally press Enter after typing.',
  {
    text: z.string().describe('The text to type.'),
    press_enter: z.boolean().optional().describe('Whether to press Enter after typing. Defaults to false.')
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
  'Press a keyboard key such as Escape to close a dialog, Enter to submit, or Tab to change focus.',
  {
    key: z.string().describe('The key name, such as Escape, Enter, Tab, or ArrowDown.')
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

server.tool(
  'login',
  'Log in to RedNote/Xiaohongshu. This opens a browser window and shows a QR code for sign-in.',
  {},
  async () => {
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
        content: [
          {
            type: 'text',
            text: 'Login successful. Cookies have been saved and the browser session has been refreshed.'
          }
        ]
      }
    } catch (error) {
      logger.error('Login failed:', error)
      await authManager.cleanup().catch(() => {})
      throw error
    }
  }
)

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

// Check whether the process is running in stdio mode
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
    .description('Initialize and log in to RedNote')
    .argument('[timeout]', 'Login timeout in seconds', (value: string) => parseInt(value, 10), 10)
    .usage('[options] [timeout]')
    .addHelpText('after', `
Examples:
  $ rednote-mcp init           # Log in with the default 10-second timeout
  $ rednote-mcp init 30        # Log in with a 30-second timeout`)
    .action(async (timeout: number) => {
      logger.info(`Starting initialization process with timeout: ${timeout}s`)
      try {
        const authManager = new AuthManager()
        await authManager.login({ timeout })
        await authManager.cleanup()
        logger.info('Initialization successful')
        console.log('Login successful! Cookies have been saved.')
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
        console.log(`Logs packed to: ${zipPath}`)
        process.exit(0)
      } catch (error) {
        console.error('Failed to pack logs:', error)
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
        console.log(`Opened logs directory: ${LOGS_DIR}`)
        process.exit(0)
      } catch (error) {
        console.error('Failed to open logs directory:', error)
        process.exit(1)
      }
    })

  program.parse(process.argv)
}

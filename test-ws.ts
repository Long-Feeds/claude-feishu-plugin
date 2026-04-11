#!/usr/bin/env bun
/**
 * Minimal test: just connect WSClient and log incoming messages.
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const ENV_FILE = join(homedir(), '.claude', 'channels', 'feishu', '.env')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const APP_ID = process.env.FEISHU_APP_ID!
const APP_SECRET = process.env.FEISHU_APP_SECRET!

console.error(`Starting with APP_ID: ${APP_ID}`)

const eventDispatcher = new lark.EventDispatcher({})
eventDispatcher.register({
  'im.message.receive_v1': async (data: any) => {
    console.error('=== MESSAGE RECEIVED ===')
    console.error(JSON.stringify(data, null, 2))
    console.error('========================')
  },
})

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.debug,
})

await wsClient.start({ eventDispatcher })
console.error('WebSocket connected, waiting for messages...')

// Keep alive
setInterval(() => {}, 10000)

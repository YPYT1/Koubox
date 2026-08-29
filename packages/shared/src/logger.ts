import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

let projectRoot = ''
let minLevel: LogLevel = 'info'
let verbose = false
let logFilePath = ''
let logStream: WriteStream | undefined

export type LoggerInitOptions = {
  defaultLevel?: LogLevel
  defaultVerbose?: boolean
}

function parseLevel(value: string | undefined): LogLevel {
  const level = (value ?? 'info').toLowerCase()
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') return level
  return 'info'
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function todayDir(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function loadEnvFile(root: string): Record<string, string> {
  const path = join(root, '.env')
  if (!existsSync(path)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function formatLine(level: LogLevel, component: string, message: string, detail?: unknown): string {
  const timestamp = new Date().toISOString()
  let line = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}`
  if (detail !== undefined && (verbose || level === 'error' || level === 'warn')) {
    line += `\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`
  }
  return line
}

function writeLog(level: LogLevel, component: string, message: string, detail?: unknown): void {
  if (!shouldLog(level)) return
  const line = formatLine(level, component, message, detail)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  logStream?.write(`${line}\n`)
}

export function initLogger(root: string, options: LoggerInitOptions = {}): void {
  projectRoot = root
  const envFile = loadEnvFile(root)
  minLevel = parseLevel(process.env.KOUBOX_LOG_LEVEL ?? envFile.KOUBOX_LOG_LEVEL ?? options.defaultLevel)
  const configuredVerbose = process.env.KOUBOX_LOG_VERBOSE ?? envFile.KOUBOX_LOG_VERBOSE
  verbose = configuredVerbose === undefined
    ? minLevel === 'debug' || Boolean(options.defaultVerbose)
    : parseBool(configuredVerbose)
  const logDir = join(root, 'logs', todayDir())
  mkdirSync(logDir, { recursive: true })
  logFilePath = join(logDir, 'koubox.log')
  logStream?.end()
  logStream = createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' })
  logStream.on('error', (error) => {
    console.error(`[logger] 写入日志文件失败: ${error.message}`)
  })
  const startupMsg = `日志系统已初始化 | 级别: ${minLevel} | 详细: ${verbose} | 文件: ${logFilePath}`
  writeLog('info', 'logger', startupMsg)
  // 记录环境信息
  writeLog('info', 'logger', `平台: ${process.platform} | Node: ${process.version} | 架构: ${process.arch}`)
}

export function closeLogger(): Promise<void> {
  const stream = logStream
  logStream = undefined
  if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve()
  return new Promise((resolve) => stream.end(resolve))
}

export function getLoggerEnv(): Record<string, string> {
  const logDir = join(projectRoot, 'logs', todayDir())
  mkdirSync(logDir, { recursive: true })
  return {
    KOUBOX_LOG_DIR: logDir,
    KOUBOX_LOG_LEVEL: minLevel,
    KOUBOX_LOG_VERBOSE: verbose ? '1' : '0'
  }
}

export type Logger = {
  debug(message: string, detail?: unknown): void
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export function createLogger(component: string): Logger {
  return {
    debug: (message, detail) => writeLog('debug', component, message, detail),
    info: (message, detail) => writeLog('info', component, message, detail),
    warn: (message, detail) => writeLog('warn', component, message, detail),
    error: (message, detail) => writeLog('error', component, message, detail)
  }
}

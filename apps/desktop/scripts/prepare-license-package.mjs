import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const REMOTE_LICENSE_API_URL = 'https://koubox-license.ypyt147.workers.dev'

function assertRemoteLicenseApiUrl(apiUrl) {
  const trimmed = apiUrl.trim()
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`授权服务地址无效：${apiUrl}`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`授权服务必须使用 HTTPS 远端地址，当前为：${trimmed}`)
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    throw new Error(`授权服务禁止使用本地地址，当前为：${trimmed}`)
  }
  return trimmed.replace(/\/$/, '')
}

const value = {
  apiUrl: assertRemoteLicenseApiUrl(process.env.KOUBOX_LICENSE_API_URL?.trim() || REMOTE_LICENSE_API_URL),
  token: process.env.KOUBOX_LICENSE_TOKEN?.trim(),
  apiKey: process.env.KOUBOX_LICENSE_API_KEY?.trim(),
  packageCredentialVersion: Number(process.env.KOUBOX_LICENSE_CREDENTIAL_VERSION)
}

if (!value.token || !value.apiKey || !Number.isInteger(value.packageCredentialVersion) || value.packageCredentialVersion < 1) {
  throw new Error('打包前请设置 KOUBOX_LICENSE_TOKEN、KOUBOX_LICENSE_API_KEY 与正整数 KOUBOX_LICENSE_CREDENTIAL_VERSION。')
}

const target = resolve(import.meta.dirname, '../../../.pack/license/license-package.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

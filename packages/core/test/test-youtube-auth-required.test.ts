/**
 * YouTube 登录态强制要求测试
 *
 * 验证 YouTube 下载必须配置登录，并给出正确的错误提示
 */
import { describe, expect, it } from 'vitest'
import { defaultPlatformAuth } from '@koubox/shared'
import { downloadVideo, type VideoDownloadRequest } from '../src/video-download'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const PROXY = 'http://127.0.0.1:7897'

describe('YouTube 登录态强制要求测试', () => {
  it('未配置登录态时应提示配置登录', async () => {
    const request: VideoDownloadRequest = {
      url: YOUTUBE_URL,
      directory: tmpdir(),
      fileStem: 'test-youtube',
      vendor: {
        ytdlpExecutable: 'yt-dlp',
        ffmpegExecutable: 'ffmpeg',
        denoExecutable: 'deno'
      },
      config: {
        ytdlpProxy: PROXY,
        ytdlpMaxHeight: 1080,
        ytdlpExtraArgs: '',
        ytdlpPlatformAuth: defaultPlatformAuth()
      },
      updateProgress: () => {},
      runCommand: async () => {},
      // 关键：不提供 resolveAuthenticatedCookies
      resolveAuthenticatedCookies: undefined
    }

    await expect(downloadVideo(request)).rejects.toThrow(
      'YouTube 视频需要登录后才能下载。请在【全局设置】→【平台登录配置】中配置 YouTube 登录状态。'
    )
  })

  it('配置了登录态但返回 undefined 时应提示配置登录', async () => {
    const request: VideoDownloadRequest = {
      url: YOUTUBE_URL,
      directory: tmpdir(),
      fileStem: 'test-youtube',
      vendor: {
        ytdlpExecutable: 'yt-dlp',
        ffmpegExecutable: 'ffmpeg',
        denoExecutable: 'deno'
      },
      config: {
        ytdlpProxy: PROXY,
        ytdlpMaxHeight: 1080,
        ytdlpExtraArgs: '',
        ytdlpPlatformAuth: defaultPlatformAuth()
      },
      updateProgress: () => {},
      runCommand: async () => {},
      // 返回 undefined 表示未配置有效的登录态
      resolveAuthenticatedCookies: async () => undefined
    }

    await expect(downloadVideo(request)).rejects.toThrow(
      'YouTube 视频需要登录后才能下载。请在【全局设置】→【平台登录配置】中配置 YouTube 登录状态。'
    )
  })
})

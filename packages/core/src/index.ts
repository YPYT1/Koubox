export { assertValidTranscript, formatSrtTime, transcriptToSrt } from './srt.js'
export { startLocalApi } from './server.js'
export { TaskManager } from './tasks.js'
export {
  createYtdlpUpdateManager,
  inspectYtdlpRuntime,
  BUNDLED_YTDLP_VERSION,
  BUNDLED_YTDLP_SHA256,
  BUNDLED_DENO_VERSION,
  BUNDLED_DENO_SHA256
} from './ytdlp-update.js'
export { createTemporaryPlatformCookieFile } from './platform-auth.js'
export { extractFacebookMedia, extractFacebookVideoId, isFacebookShareUrl, resolveFacebookPublicMedia, resolveFacebookShareUrl } from './facebook.js'
export {
  describeParsedPlatformUrl,
  parsePlatformUrl,
  parsePlatformUrlOrThrow,
  type ParsedPlatformUrl,
  type ParsedPlatformUrlKind
} from '@koubox/shared'
export { prepareDownloadUrl, type PreparedDownloadUrl } from './download-url.js'
export { normalizeTikTokVideoUrl } from './public-video.js'
export type { PublicMediaResolution } from './public-video.js'
export {
  downloadVideo,
  verifyDownloadedMedia,
  VIDEO_DOWNLOAD_PIPELINE_PATH,
  VIDEO_MATERIALS_PIPELINE_PATH
} from './video-download.js'
export type {
  VideoDownloadRequest,
  VideoDownloadResult,
  VideoDownloadStrategy,
  AuthenticatedCookieFile,
  VerifiedMedia
} from './video-download.js'

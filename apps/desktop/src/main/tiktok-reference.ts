import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'

type ReferenceResult = { ok: boolean; path?: string; output?: string; returncode?: number }

/** Runs the TikTok downloader copied from D:/downloder/video_downloader. */
export function downloadTikTokWithReference(options: {
  url: string
  directory: string
  fileStem: string
  pythonExecutable: string
  pythonSourceDirectory: string
  ffmpegDirectory: string
  onLine?: (line: string) => void
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-m', 'koubox_runtime.reference_tiktok.runner',
      '--url', options.url,
      '--output-dir', options.directory,
      '--file-stem', options.fileStem
    ]
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONPATH: options.pythonSourceDirectory,
      PATH: `${options.ffmpegDirectory}${delimiter}${process.env.PATH ?? ''}`
    }
    const child = spawn(options.pythonExecutable, args, { windowsHide: true, env })
    let output = ''
    const consume = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) if (line) options.onLine?.(line)
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', reject)
    child.once('close', (code) => {
      const resultLine = output.split(/\r?\n/).reverse().find((line) => line.startsWith('RESULT_JSON='))
      let result: ReferenceResult | undefined
      try {
        if (resultLine) result = JSON.parse(resultLine.slice('RESULT_JSON='.length)) as ReferenceResult
      } catch {
        result = undefined
      }
      if (code === 0 && result?.ok && result.path) return resolvePromise(result.path)
      reject(new Error(result?.output || output.trim() || `参考 TikTok 下载器退出码：${code ?? 'unknown'}`))
    })
  })
}

/**
 * 深度测试：对比有文案和无文案模式
 * 运行：$env:KOUBOX_REAL_ASR='1'; node test-srt-deep.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultPlatformAuth } from '@koubox/shared'
import { resolveAsrExecutionPlan } from './packages/core/dist/asr-execution.js'
import { detectGpu } from './packages/core/dist/runtime.js'
import { TaskManager } from './packages/core/dist/tasks.js'

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))
const OUTPUT_DIR = join(REPO_ROOT, 'test-outputs')

const testCases = [
  {
    name: '文案_02_先端パッケージ_语速1.1',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_02_先端パッケージ（语速1.1-声调2-音量1.3）.wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_02_先端パッケージ.txt'
  },
  {
    name: '文案_05_高信頼性材料_语速1.4',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料（语速1.4-声调2-音量1.6）.wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料.txt'
  },
  {
    name: '文案_08_車載センシング_语速1.7',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_08_車載センシング(语速1.7-音调-2-音量1.9).wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_08_車載センシング.txt'
  }
]

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })

const gpu = await detectGpu()
const config = {
  modelsDirectory: 'C:\\Users\\Administrator\\.subtitle-tool\\models',
  asrComputeType: 'auto',
  asrSelectedModel: 'faster-whisper-large-v3-turbo',
  translationModelDirectory: '',
  translationMaxNewTokens: 512,
  translationTopP: 0.95,
  ytdlpExecutablePath: '',
  ytdlpMaxHeight: 2160,
  biliUpHost: 'api.bilibili.com',
  platformAuth: defaultPlatformAuth()
}

const modelPaths = {
  asrPlan: await resolveAsrExecutionPlan(config, gpu),
  translation: config.translationModelDirectory
}

console.log('模型配置:', {
  primary: modelPaths.asrPlan.primary.id,
  fallback: modelPaths.asrPlan.fallback?.id
})

for (const testCase of testCases) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`测试: ${testCase.name}`)
  console.log('='.repeat(60))
  
  if (!existsSync(testCase.audio)) {
    console.log(`⚠ 音频文件不存在: ${testCase.audio}`)
    continue
  }
  
  const sourceText = existsSync(testCase.text) 
    ? readFileSync(testCase.text, 'utf-8').trim() 
    : ''
  
  // 测试有文案模式
  if (sourceText) {
    console.log('\n【有文案模式】')
    try {
      const manager = new TaskManager(config, gpu)
      const queued = await manager.startRequirementTwo(
        testCase.audio,
        sourceText,
        OUTPUT_DIR,
        modelPaths,
        'ja',
        'off'
      )
      
      const waitTask = (manager, taskId, timeout) => {
        const start = Date.now()
        return new Promise((resolve, reject) => {
          const check = () => {
            const task = manager.tasks.get(taskId)
            if (!task) return reject(new Error('Task not found'))
            if (task.status === 'complete' || task.status === 'error') {
              return resolve({ task, elapsedMs: Date.now() - start })
            }
            if (Date.now() - start > timeout) {
              return reject(new Error('Timeout'))
            }
            setTimeout(check, 500)
          }
          check()
        })
      }
      
      const { task, elapsedMs } = await waitTask(manager, queued.taskId, 5 * 60 * 1000)
      
      if (task.status === 'complete' && task.artifacts?.srt) {
        const srt = readFileSync(task.artifacts.srt, 'utf-8')
        const segments = srt.split(/\n\n/).filter(Boolean).length
        const outputPath = join(OUTPUT_DIR, `${testCase.name}_有文案.srt`)
        writeFileSync(outputPath, srt, 'utf-8')
        
        console.log(`✓ 成功`)
        console.log(`  文件: ${outputPath}`)
        console.log(`  片段数: ${segments}`)
        console.log(`  用时: ${(elapsedMs / 1000).toFixed(1)}s`)
        console.log(`  模型: ${task.asrExecution?.effectiveModel}`)
        console.log(`  fallback: ${task.asrExecution?.fallbackUsed ? '是' : '否'}`)
        if (task.asrExecution?.fallbackReason) {
          console.log(`  切换原因: ${task.asrExecution.fallbackReason}`)
        }
      } else {
        console.log(`✗ 失败: ${task.error?.message || task.message}`)
      }
    } catch (err) {
      console.log(`✗ 异常: ${err.message}`)
    }
  }
  
  // 测试无文案模式
  console.log('\n【无文案模式】')
  try {
    const manager = new TaskManager(config, gpu)
    const queued = await manager.startRequirementTwo(
      testCase.audio,
      '',
      OUTPUT_DIR,
      modelPaths,
      'ja',
      'off'
    )
    
    const waitTask = (manager, taskId, timeout) => {
      const start = Date.now()
      return new Promise((resolve, reject) => {
        const check = () => {
          const task = manager.tasks.get(taskId)
          if (!task) return reject(new Error('Task not found'))
          if (task.status === 'complete' || task.status === 'error') {
            return resolve({ task, elapsedMs: Date.now() - start })
          }
          if (Date.now() - start > timeout) {
            return reject(new Error('Timeout'))
          }
          setTimeout(check, 500)
        }
        check()
      })
    }
    
    const { task, elapsedMs } = await waitTask(manager, queued.taskId, 5 * 60 * 1000)
    
    if (task.status === 'complete' && task.artifacts?.srt) {
      const srt = readFileSync(task.artifacts.srt, 'utf-8')
      const segments = srt.split(/\n\n/).filter(Boolean).length
      const outputPath = join(OUTPUT_DIR, `${testCase.name}_无文案.srt`)
      writeFileSync(outputPath, srt, 'utf-8')
      
      console.log(`✓ 成功`)
      console.log(`  文件: ${outputPath}`)
      console.log(`  片段数: ${segments}`)
      console.log(`  用时: ${(elapsedMs / 1000).toFixed(1)}s`)
      console.log(`  模型: ${task.asrExecution?.effectiveModel}`)
      console.log(`  fallback: ${task.asrExecution?.fallbackUsed ? '是' : '否'}`)
      if (task.asrExecution?.fallbackReason) {
        console.log(`  切换原因: ${task.asrExecution.fallbackReason}`)
      }
    } else {
      console.log(`✗ 失败: ${task.error?.message || task.message}`)
    }
  } catch (err) {
    console.log(`✗ 异常: ${err.message}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`测试完成！所有输出在: ${OUTPUT_DIR}`)
console.log('='.repeat(60))

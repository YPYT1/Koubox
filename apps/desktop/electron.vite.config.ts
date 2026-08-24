import { resolve } from 'node:path'
import { copyFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const aliases = {
  '@koubox/core': resolve(__dirname, '../../packages/core/src'),
  '@koubox/shared': resolve(__dirname, '../../packages/shared/src'),
  '@koubox/shared/logger': resolve(__dirname, '../../packages/shared/src/logger.ts')
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@koubox/core', '@koubox/shared'] },
      rollupOptions: {
        plugins: [
          {
            name: 'copy-login-window-html',
            writeBundle() {
              copyFileSync(
                resolve(__dirname, 'src/main/login-window.html'),
                resolve(__dirname, 'out/main/login-window.html')
              )
            }
          }
        ]
      }
    },
    resolve: { alias: aliases }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'login-preload': resolve(__dirname, 'src/preload/login-preload.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: { resolve: { alias: aliases }, plugins: [react()] }
})

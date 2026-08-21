import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const aliases = {
  '@koubox/core': resolve(__dirname, '../../packages/core/src'),
  '@koubox/shared': resolve(__dirname, '../../packages/shared/src')
}

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: ['@koubox/core', '@koubox/shared'] } },
    resolve: { alias: aliases }
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: { resolve: { alias: aliases }, plugins: [react()] }
})

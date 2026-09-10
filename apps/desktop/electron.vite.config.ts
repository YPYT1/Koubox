import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const aliases = {
  '@': resolve(__dirname, 'src/renderer/src'),
  '@koubox/core': resolve(__dirname, '../../packages/core/src'),
  '@koubox/license-client/types': resolve(__dirname, '../../packages/license-client/src/types.ts'),
  '@koubox/license-client': resolve(__dirname, '../../packages/license-client/src'),
  '@koubox/shared': resolve(__dirname, '../../packages/shared/src'),
  '@koubox/shared/logger': resolve(__dirname, '../../packages/shared/src/logger.ts')
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@koubox/core', '@koubox/license-client', '@koubox/shared'], include: ['sql.js', 'selfsigned'] },
      rollupOptions: {}
    },
    resolve: { alias: aliases }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: { alias: aliases },
    plugins: [react(), tailwindcss()]
  }
})

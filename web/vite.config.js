import { defineConfig } from 'vite'
export default defineConfig({ base: './', build: { outDir: 'dist', chunkSizeWarningLimit: 4000, target: 'es2020' }, publicDir: 'public' })

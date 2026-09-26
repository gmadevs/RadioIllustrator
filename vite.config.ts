import { defineConfig } from 'vite'

// Relative base so the build also works from a subfolder (GitHub Pages) or file server.
export default defineConfig({
  base: './',
})

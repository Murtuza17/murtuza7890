import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/domain/**/*.test.ts'],
    coverage: { include: ['src/domain/**/*.ts'], exclude: ['src/domain/**/*.test.ts'] },
  },
})

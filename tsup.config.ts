import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stores/redis.ts', 'src/stores/upstash.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['ai', '@ai-sdk/provider', 'ioredis', '@upstash/redis'],
});

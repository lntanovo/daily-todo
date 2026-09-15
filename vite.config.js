import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // CloudBase Web SDK v3 是组合 SDK；当前压缩后约 203 kB，属于预期范围。
    chunkSizeWarningLimit: 850
  }
});

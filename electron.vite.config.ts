import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { REQUIRED_CAPABILITIES } from './src/shared/cloud-capabilities'

// 阶段 2 能力版本协议(方案 §6.2 v2):构建期把「本产物所需的线上能力」连同构建身份
// 快照进 out/build-manifest.json——release.mjs 门禁读 manifest 而非工作树,
// 防「先 dist 后改声明」导致的产物与需求错位(codex 终审第 7 条)。
const buildManifestPlugin = () => ({
  name: 'build-manifest',
  closeBundle() {
    const manifest = {
      generatedAt: new Date().toISOString(),
      gitSha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      version: JSON.parse(readFileSync('package.json', 'utf8')).version,
      requiredCapabilities: REQUIRED_CAPABILITIES
    }
    writeFileSync(resolve('out/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), buildManifestPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // 三入口:主界面 + 独立只读阅读器窗口(2026-11-06 md 阅读器)+ 独立图片查看器窗口(2026-11-06 图片查看器);
      // 产物 out/renderer/{index,md-reader,img-viewer}.html,dev 下 vite 自动服全部页面
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'md-reader': resolve('src/renderer/md-reader.html'),
          'img-viewer': resolve('src/renderer/img-viewer.html')
        }
      }
    }
  }
})

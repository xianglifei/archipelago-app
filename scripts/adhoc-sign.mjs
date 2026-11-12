#!/usr/bin/env node
// electron-builder afterPack 钩子:无正式签名身份时的 ad-hoc 兜底。
//
// electron-builder 的签名+公证发生在 afterPack 之后:钥匙串里有 Developer ID
// Application 身份时本钩子必须让路,这里的 codesign --force 会把正式签名覆盖
// 回 ad-hoc。仅在找不到正式身份的裸机应急构建时,才对产物补 ad-hoc 签名使
// codesign --verify 通过;Gatekeeper 仍会提示「无法验证开发者」,由用户在
// 系统设置里「仍要打开」放行,属无证书分发的预期行为。
import { spawnSync } from 'node:child_process'

export default async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  if (/Developer ID Application/.test(identities.stdout || '')) {
    console.log('  • ad-hoc skipped        reason=Developer ID identity present, electron-builder signs')
    return
  }
  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`
  const res = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  if (res.status !== 0) {
    throw new Error(`ad-hoc 签名失败(exit ${res.status})`)
  }
  console.log(`  • ad-hoc signed        path=${appPath}`)
}

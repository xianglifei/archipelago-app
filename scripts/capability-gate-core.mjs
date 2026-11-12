// 能力版本门禁 · 纯逻辑核心(阶段 2 协议,方案=doc/方案 - 仓库拆分 - 2026-11-12.md §6.2 v2)。
// 与 scripts/verify-schema-core.mjs 同一模式:纯函数核心 + CLI/流程薄壳 + 单测
// (tests/unit/capability-gate.test.ts);release.mjs 第 1.6 步是本 core 的薄壳。
//
// 失败分级(2026-11-12 codex 终审第 8 条):
//   pass          —— 线上满足全部需求
//   incompatible  —— 端点正常应答但缺能力 = 「已知不兼容」,唯一允许 --cloud-pending-ok 豁免的类别
//   blocked       —— 端点不可达 / HTTP 错误 / 响应畸形(含回落静态页的合法 HTTP)——硬拦,逃生口不适用
// deploy 身份在客户端侧只展示不校验(客户端无法预知服务端正确值);unknown 给 warning 行,
// 服务端侧的真实性由 cloud-deploy-state.mjs postflight(deploy==HEAD)把关。

/**
 * 解析 /meta/capabilities 的 HTTP 应答为 { verdict, online } | { verdict, reason, detail }。
 * @param {number} httpStatus curl -w %{http_code} 的结果(000 = 不可达/超时)
 * @param {string} bodyText 响应体原文
 */
export function evaluateCapabilitiesResponse(httpStatus, bodyText) {
  if (!httpStatus || httpStatus === 0) return { verdict: 'blocked', reason: 'endpoint-unreachable', detail: '拿不到 HTTP 响应(超时/DNS/代理)' }
  if (httpStatus >= 500) return { verdict: 'blocked', reason: 'endpoint-error', detail: `sea HTTP ${httpStatus}(服务端错误)` }
  if (httpStatus !== 200) return { verdict: 'blocked', reason: 'endpoint-error', detail: `sea HTTP ${httpStatus}(非预期状态)` }
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { verdict: 'blocked', reason: 'malformed', detail: '响应体不是合法 JSON(可能回落静态资产页)' }
  }
  if (parsed?.ok !== true) return { verdict: 'blocked', reason: 'malformed', detail: `ok 字段缺失或非 true(线上应答异常)` }
  const online = parsed && typeof parsed === 'object' ? parsed.data : null
  if (!online || typeof online !== 'object') return { verdict: 'blocked', reason: 'malformed', detail: 'JSON 里没有 data 载荷' }
  if (typeof online.protocolVersion !== 'number' || !Number.isInteger(online.protocolVersion) || online.protocolVersion < 1) return { verdict: 'blocked', reason: 'malformed', detail: 'protocolVersion 缺失/非正整数' }
  if (online.service !== 'archipelago-sea') return { verdict: 'blocked', reason: 'malformed', detail: `service 应为 archipelago-sea,实际 ${JSON.stringify(online.service)}` }
  if (!online.capabilities || typeof online.capabilities !== 'object') return { verdict: 'blocked', reason: 'malformed', detail: 'capabilities 缺失或非对象' }
  const capsOk = Object.entries(online.capabilities).every(([, v]) => Number.isInteger(v) && v > 0)
  if (!capsOk) return { verdict: 'blocked', reason: 'malformed', detail: 'capabilities 存在非正整数项' }
  return { verdict: 'ok', online }
}

/**
 * 需求比对:required 逐项 ≤ 线上值。
 * @returns {{ verdict:'ok' }} | {{ verdict:'missing', missing:Array<{name,required,online}> }}
 */
export function compareCapabilities(required, onlineCaps) {
  const missing = []
  for (const [name, need] of Object.entries(required)) {
    const have = onlineCaps?.[name]
    if (!(Number.isFinite(have) && have >= need)) missing.push({ name, required: need, online: have ?? null })
  }
  return missing.length ? { verdict: 'missing', missing } : { verdict: 'ok' }
}

/**
 * 门禁汇总:HTTP/形状 → 比对,得出三分级结论。
 */
export function evaluateGate({ httpStatus, bodyText, required }) {
  const res = evaluateCapabilitiesResponse(httpStatus, bodyText)
  if (res.verdict === 'blocked') return res
  const cmp = compareCapabilities(required, res.online.capabilities)
  if (cmp.verdict === 'missing') return { verdict: 'incompatible', missing: cmp.missing, online: res.online }
  return { verdict: 'pass', online: res.online }
}

// W5(2026-11-04):run_command 输出收集管道从 per-chunk buf.toString('utf8') 改为
// stdout/stderr 各自的 StringDecoder 流式解码(shell.ts),本测试锁定该管道的解码语义——
// 多字节中文跨 chunk 边界不再产生 U+FFFD 替换字符(全平台存量 bug),两路解码状态互不串扰。
// 直接验证生产同款解码器用法;中文 Windows PS 5.1 的 GBK 编码策略属真机确认项,不在本测试范围。
import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'

describe('W5: 流式 UTF-8 解码管道语义', () => {
  it('中文多字节字符被任意切点拆开后重组无损', () => {
    const text = '你好,群岛居民 Momo'
    const full = Buffer.from(text, 'utf8')
    // 人为在每个字节边界都切一刀:最极端的跨 chunk 拆分
    for (let cut = 1; cut < full.length; cut++) {
      const dec = new StringDecoder('utf8')
      const out = dec.write(full.subarray(0, cut)) + dec.write(full.subarray(cut)) + dec.end()
      expect(out, `cut=${cut}`).toBe(text)
    }
  })

  it('三段不均拆分 + 收尾 flush', () => {
    const text = '命令输出:第 1 行'
    const full = Buffer.from(text, 'utf8')
    const dec = new StringDecoder('utf8')
    const out =
      dec.write(full.subarray(0, 2)) + dec.write(full.subarray(2, 7)) + dec.write(full.subarray(7)) + dec.end()
    expect(out).toBe(text)
  })

  it('stdout/stderr 两路解码状态互不串扰', () => {
    // stdout 停在半个「你」字上,期间 stderr 正常解码;随后 stdout 补齐
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    const ni = Buffer.from('你', 'utf8') // 3 字节
    expect(out.write(ni.subarray(0, 2))).toBe('') // 半字符被流内缓冲,不吐替换字符
    expect(err.write(Buffer.from('stderr: fine', 'utf8'))).toBe('stderr: fine')
    expect(out.write(ni.subarray(2)) + out.end()).toBe('你')
    expect(err.end()).toBe('')
  })
})

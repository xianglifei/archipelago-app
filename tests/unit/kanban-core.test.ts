// 看板纯逻辑(2026-11-19 需求 - 看板:卡片与任务会话联动):
// statusOf 四列推导全矩阵(优先级)+ 展示标题兜底 + CARDS_DDL 源码契约
// (幂等建表/线程索引/**状态不落列**——读时推导是设计契约,DDL 出现 status 列即漂移)。
import { describe, expect, it } from 'vitest'
import { bodyFirstLine, CARDS_DDL, displayTitleOf, statusOf } from '../../src/main/kanban-core'

/** 基线卡:全部持久事实为空(未指派未执行) */
const base = {
  done_at: null,
  thread_id: null,
  last_run_started_at: null,
  finishing_since: null,
  error: null
}
const idle = { threadActive: false, pendingApprovals: 0 }

describe('statusOf:四列推导矩阵', () => {
  it('未执行(无线程)= 待办,与是否指派无关', () => {
    expect(statusOf(base, idle)).toBe('todo')
  })

  it('done 优先于一切:完成卡即便线程又在跑也显示已完成', () => {
    expect(statusOf({ ...base, done_at: '2026-11-19T10:00:00Z', thread_id: 't1' }, { threadActive: true, pendingApprovals: 2 })).toBe('done')
  })

  it('从未跑起来的失败(准备链断)回待过目,不当「准备中」吊着', () => {
    expect(statusOf({ ...base, thread_id: 't1', error: '工作目录绑定没有通过' }, idle)).toBe('review')
  })

  it('线程已建、首条未发 = 进行中·准备中(典型=绑定授权卡等待批准)', () => {
    expect(statusOf({ ...base, thread_id: 't1' }, idle)).toBe('running')
  })

  it('收尾中(两段式完成)归进行中列', () => {
    expect(statusOf({ ...base, thread_id: 't1', last_run_started_at: '2026-11-19T09:00:00Z', finishing_since: '2026-11-19T10:00:00Z' }, idle)).toBe('running')
  })

  it('回合在跑 = 进行中', () => {
    expect(statusOf({ ...base, thread_id: 't1', last_run_started_at: '2026-11-19T09:00:00Z' }, { threadActive: true, pendingApprovals: 0 })).toBe('running')
  })

  it('执行过、回合空闲、未完成 = 待审阅(执行后的历史 error 不改变列归属,只做角标)', () => {
    expect(statusOf({ ...base, thread_id: 't1', last_run_started_at: '2026-11-19T09:00:00Z', error: '这一轮没有跑成' }, idle)).toBe('review')
  })

  it('重启自洽:内存注册表清空后,进行中卡天然回落待过目(无需 reconcile)', () => {
    const running = { ...base, thread_id: 't1', last_run_started_at: '2026-11-19T09:00:00Z' }
    expect(statusOf(running, { threadActive: true, pendingApprovals: 0 })).toBe('running')
    expect(statusOf(running, idle)).toBe('review')
  })
})

describe('展示标题兜底', () => {
  it('手写标题优先(带空白会被 trim)', () => {
    expect(displayTitleOf('  周报素材  ', '正文')).toBe('周报素材')
  })

  it('标题为空取正文首行(多行只取第一行并 trim)', () => {
    expect(displayTitleOf('', '  整理本周照片\n第二行\n第三行 ')).toBe('整理本周照片')
  })

  it('全空返回空串(渲染端显示「未命名卡片」)', () => {
    expect(displayTitleOf('', '')).toBe('')
    expect(displayTitleOf('   ', '\n  \n')).toBe('')
  })

  it('bodyFirstLine 对纯空白行安全', () => {
    expect(bodyFirstLine('\n\n')).toBe('')
  })
})

describe('CARDS_DDL 源码契约(防漂移)', () => {
  it('幂等建表 + 线程索引(回合落定按 thread_id 反查卡片)', () => {
    expect(CARDS_DDL).toContain('CREATE TABLE IF NOT EXISTS cards')
    expect(CARDS_DDL).toContain('CREATE INDEX IF NOT EXISTS idx_cards_thread ON cards(thread_id)')
  })

  it('四列归属不落列:DDL 里不得出现 status 列(读时推导是设计契约,见需求 §5.1)', () => {
    expect(CARDS_DDL).not.toMatch(/\bstatus\s+TEXT/i)
    // 时间戳族与错误列在场(推导的事实来源)
    for (const col of ['last_run_started_at', 'last_run_ended_at', 'finishing_since', 'done_at', 'error']) {
      expect(CARDS_DDL).toContain(col)
    }
  })
})

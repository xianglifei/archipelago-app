import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Megaphone, Share2, UsersRound } from 'lucide-react'
import type { GroupInfo, GroupMessage, GroupThinkingState, MessageAttachment } from '@shared/types'
import { api, onGroupDelta, onGroupDone, onGroupError, onGroupStep, onGroupTurnStart, onGroupUserAdded } from '../api'
import { Markdown, WorkspaceBaseContext } from './markdown/Markdown'
import { MessageActions } from './markdown/MessageActions'
import ResidentAvatar, { GroupAvatarStack } from './ResidentAvatar'
import Composer, { UserAttachments, filesFromDataTransfer, useAttachmentIntake } from './Composer'
import { QuoteSelection } from './quote/QuoteSelection'
import { QuoteCards } from './quote/QuoteCards'
import { groupQuoteKey, makeChatQuote, quoteStore } from './quote/quoteStore'
import { ChatSelectionBar, ExportStatusNote } from './ChatSelectionBar'
import { useMessageExport } from '../utils/useMessageExport'
import { useTranslation } from '../i18n'
import { chatErrorText } from '../chat-error'

// 群聊(M5):值守管理员默认应答,@点名传棒;多条消息排队依次处理
// 三轮评审:顶部只留群名(值守/成员副标题行取消),右上角进群管理右侧栏
// 左下角思考指示(2026-10-30):回合一开跑(TurnStart)就亮「X 正在想」三点——群聊用户消息到
// 首段正文之间原本零事件;正文流出让位给实时气泡,结束随 Done/Error 清场,不展示思考内容
export default function GroupView({
  group,
  onOpenProfile
}: {
  group: GroupInfo
  onOpenProfile?: () => void
}) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<GroupMessage[]>([])
  const [stream, setStream] = useState<{ botId: string; botName: string; text: string } | null>(null)
  // 当前正在发言的居民(思考指示/busy 真态):主进程 TurnStart 置入,挂载时由 groupHistory 恢复
  const [turn, setTurn] = useState<GroupThinkingState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  // 随本条消息发送的附件(2026-10-29 输入框升级):共享 Composer 承载三入口与附件签
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  // 拖放区=整个聊天视图(体验反馈 2026-10-30):与单聊同款,拖到消息区松手即挂上
  const { intakeFiles } = useAttachmentIntake({ mode: 'chat', attachments, onAttachmentsChange: setAttachments })
  const bodyRef = useRef<HTMLDivElement>(null)
  // 吸底才跟随滚动(2026-11-06 codex 审查修复:此前每帧流式输出都 scrollIntoView,
  // 用户向上翻阅会被不断拽回底部);与单聊 ChatView 同款口径
  const pinnedRef = useRef(true)
  // 回合事件序号(2026-11-06 codex 审查修复):历史快照在回合起止事件后落地时,
  // 快照里的 thinking 真态已过期,不该回写(详见挂载拉取处)
  const turnSeqRef = useRef(0)
  // 聊天视图根(选区引用 2026-11-02):选区须落在它内部才弹「引用/复制」浮窗
  const rootRef = useRef<HTMLDivElement>(null)
  // 选区引用:按群分桶;群聊引用居民发言时带名字(data-quote-bot → 「XX 说」)
  const quoteKey = groupQuoteKey(group.id)
  // 多选导出(2026-11-02):群消息无过程类,全部行(岛主+各居民)可勾
  const exporter = useMessageExport({ groupId: group.id })
  const selectableIds = messages.map((m) => m.id)
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => exporter.selectedIds.has(id))

  useEffect(() => {
    let disposed = false
    const offs = [
      onGroupUserAdded(({ groupId, message }) => {
        if (groupId !== group.id) return
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
      }),
      // 成员回合开始:指示条换人(@多人串行,上一位 Done 清场后下一位 Start 立刻接亮)
      onGroupTurnStart(({ groupId, botId, botName, queue }) => {
        if (groupId !== group.id) return
        turnSeqRef.current++
        setTurn({ botId, botName, queue })
      }),
      onGroupDelta(({ groupId, botId, botName, text }) => {
        if (groupId !== group.id) return
        setStream((prev) => ({ botId, botName, text: prev && prev.botId === botId ? prev.text + text : text }))
      }),
      // 步界(2026-10-28 拍板修订):群聊只发最后结论,中间步已流出的文字清空,过程反馈交还左下角思考指示
      onGroupStep(({ groupId, botId, botName }) => {
        if (groupId !== group.id) return
        setStream((prev) => (prev && prev.botId === botId ? { botId, botName, text: '' } : prev))
      }),
      onGroupDone(({ groupId, message }) => {
        if (groupId !== group.id) return
        turnSeqRef.current++
        if (message) {
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
        }
        setStream(null)
        setTurn(null)
      }),
      onGroupError(({ groupId, error: err, code }) => {
        if (groupId !== group.id) return
        turnSeqRef.current++
        setError(chatErrorText(t, code, err))
        setStream(null)
        setTurn(null)
      })
    ]
    const seqAtFetch = turnSeqRef.current
    api
      .groupHistory(group.id)
      .then(({ messages: list, thinking }) => {
        if (disposed || turnSeqRef.current !== seqAtFetch) return
        setMessages(list)
        // 快照之后已有回合起止事件到达(序号变了):事件流已把 turn 摆到正确状态,
        // 快照里的 thinking 是过期真态,回写会让已结束的回合「复活」堵死发送键
        if (turnSeqRef.current === seqAtFetch) setTurn(thinking)
      })
      .catch((err) => console.error(err))
    return () => {
      disposed = true
      offs.forEach((off) => off())
    }
  }, [group.id, t])

  // 消息/流式内容变化时,吸底才跟随;直接设 scrollTop(不惊动祖先滚动容器),绘制前执行不闪跳
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, stream?.text])

  function onBodyScroll(): void {
    const el = bodyRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24
  }

  function send(): void {
    const text = input.trim()
    const pendingQuotes = quoteStore.record(quoteKey).quotes
    if ((!text && attachments.length === 0 && pendingQuotes.length === 0) || stream || turn) return
    const sending = attachments
    // 选区引用(2026-11-02):发送即消费;IPC 失败把引用还回输入框,chip 不丢
    const quotes = quoteStore.take(quoteKey)
    setInput('')
    setAttachments([])
    setError(null)
    api.groupSend(group.id, text, sending, quotes).catch((err) => {
      quoteStore.restore(quoteKey, quotes)
      // 发送被拒草稿回魂(2026-11-06 codex 审查修复:此前正文与附件直接蒸发);
      // 等待期间用户已重新输入/添加的,不覆盖只补回空缺位
      setInput((cur) => (cur.trim() === '' ? text : cur))
      setAttachments((cur) => (cur.length === 0 ? sending : cur))
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const admin = group.members.find((m) => m.id === group.adminBotId)

  return (
    <div
      className="chat"
      ref={rootRef}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const { files, dirs } = filesFromDataTransfer(e.dataTransfer)
        if (files.length === 0) return
        e.preventDefault()
        void intakeFiles(files, dirs)
      }}
    >
      <QuoteSelection
        rootRef={rootRef}
        onAdd={(c) => quoteStore.add(quoteKey, makeChatQuote(c.text, c.kind, c.botName))}
      />
      <header className="chat-header">
        {exporter.status ? (
          <ExportStatusNote
            status={exporter.status}
            onReveal={() => {
              const st = exporter.status
              if (st?.kind === 'saved') void api.revealInFolder(st.path)
            }}
            onClose={exporter.dismissStatus}
          />
        ) : exporter.selecting ? (
          <ChatSelectionBar
            selectedCount={exporter.selectedIds.size}
            allSelected={allSelected}
            busy={exporter.busy}
            error={exporter.error}
            onToggleAll={() => exporter.selectAll(allSelected ? [] : selectableIds)}
            onCopy={() => void exporter.run('copy')}
            onExport={() => void exporter.run('save')}
            onCancel={exporter.exit}
          />
        ) : (
          <>
            <GroupAvatarStack members={group.members} size="lg" />
            <div className="chat-title">{group.name}</div>
            <div className="header-actions">
              <button className="icon-btn ghost-btn" title={t('chat.exportTitle')} onClick={exporter.enter}>
                <Share2 size={16} />
              </button>
              {onOpenProfile && (
                <button className="icon-btn ghost-btn" title={t('group.manage')} onClick={onOpenProfile}>
                  <UsersRound size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </header>

      {group.announcement && (
        <div className="group-announcement">
          <Megaphone size={13} /> {group.announcement}
        </div>
      )}

      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !stream && (
          <div className="chat-empty">
            <Megaphone size={22} />
            <p>{t('group.empty', { name: admin?.name ?? 'Momo' })}</p>
          </div>
        )}
        {messages.map((m, i) =>
          m.senderType === 'user' ? (
            <div className="msg user" key={m.id}>
              {exporter.selecting && (
                <button
                  type="button"
                  className={`select-check${exporter.selectedIds.has(m.id) ? ' on' : ''}`}
                  aria-pressed={exporter.selectedIds.has(m.id)}
                  aria-label={t('chat.exportCheck')}
                  onClick={() => exporter.toggle(m.id)}
                >
                  <Check size={12} />
                </button>
              )}
              <div className="user-col">
                <QuoteCards quotes={m.meta?.quotes} />
                <UserAttachments attachments={m.attachments ?? []} />
                {m.content.trim() ? (
                  <div className="bubble user-bubble" data-quote-source="user">
                    {m.content}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            // 二轮评审:群聊多居民发言,气泡头像加回(比旧版大)且保留名字行;单聊仍无头像
            <div className="msg assistant" key={m.id}>
              {exporter.selecting && (
                <button
                  type="button"
                  className={`select-check${exporter.selectedIds.has(m.id) ? ' on' : ''}`}
                  aria-pressed={exporter.selectedIds.has(m.id)}
                  aria-label={t('chat.exportCheck')}
                  onClick={() => exporter.toggle(m.id)}
                >
                  <Check size={12} />
                </button>
              )}
              <ResidentAvatar
                appearance={group.members.find((x) => x.id === m.botId)?.appearance ?? null}
                fallbackName={m.botName ?? t('group.residentFallback')}
                fallbackColor={m.botColor}
                size="big"
              />
              <div className="msg-col">
                <div className="msg-name">{m.botName}</div>
                <div className="bubble bot-bubble" data-quote-source="assistant" data-quote-bot={m.botName ?? undefined}>
                  {/* 相对路径按发言居民的工作区解析(2026-11-06 后缀规则) */}
                  <WorkspaceBaseContext.Provider value={group.members.find((x) => x.id === m.botId)?.workspacePath ?? null}>
                    <Markdown content={m.content} />
                  </WorkspaceBaseContext.Provider>
                </div>
                {m.content && <MessageActions text={m.content} always={i === messages.length - 1 && !stream} />}
              </div>
            </div>
          )
        )}
        {stream && stream.text.length > 0 && (
          <div className="msg assistant">
            <ResidentAvatar
              appearance={group.members.find((x) => x.id === stream.botId)?.appearance ?? null}
              fallbackName={stream.botName}
              size="big"
            />
            <div className="msg-col">
              <div className="msg-name">{stream.botName}</div>
              <div className="bubble bot-bubble">
                <WorkspaceBaseContext.Provider value={group.members.find((x) => x.id === stream.botId)?.workspacePath ?? null}>
                  <Markdown content={stream.text} streaming />
                </WorkspaceBaseContext.Provider>
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="chat-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>{t('common.gotIt')}</button>
          </div>
        )}
      </div>

      <footer className="composer group-composer">
        {/* 思考指示(2026-10-30 拍板):静默期(首字前/步界后)亮,正文流出让位给实时气泡 */}
        {turn !== null && !(stream !== null && stream.text.length > 0) && (
          <div className="group-thinking">
            <ResidentAvatar
              appearance={group.members.find((x) => x.id === turn.botId)?.appearance ?? null}
              fallbackName={turn.botName}
              fallbackColor={group.members.find((x) => x.id === turn.botId)?.color ?? null}
              size="small"
            />
            <span className="group-thinking-label">
              {t('group.thinking', { name: turn.botName })}
              {turn.queue > 0 ? t('group.thinkingQueue', { count: turn.queue }) : ''}
            </span>
            <span className="thinking-dots" aria-hidden>
              <i /> <i /> <i />
            </span>
          </div>
        )}
        <div className="mention-row">
          {group.members.map((m) => (
            <button key={m.id} className="chip" onClick={() => setInput((i) => `${i}@${m.name} `)}>
              @{m.name}
            </button>
          ))}
        </div>
        <div className="composer-row">
          <Composer
            input={input}
            onInputChange={setInput}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            busy={stream !== null || turn !== null}
            onStop={() => void api.groupStop(group.id)}
            onSend={send}
            placeholder={t('group.placeholder', { name: group.name })}
            mentionCandidates={group.members}
            quoteKey={quoteKey}
          />
        </div>
      </footer>
    </div>
  )
}


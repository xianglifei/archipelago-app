import { useCallback, useLayoutEffect, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { Copy, Ban, Check, Mail, MoreHorizontal, ChevronDown, Loader2, PenLine, QrCode, SendHorizonal, Upload, X, Download, ArrowUpRight } from 'lucide-react'
import type {
  MessageAttachment,
  PostContact,
  PostInviteInfo,
  PostInviteParsed,
  PostLetter,
  PostLetterStatus,
  PostOverview
} from '@shared/types'
import { api, onPostChanged } from '../api'
import Composer, { AttachmentCards } from './Composer'
import { Markdown } from './markdown/Markdown'
import { countsUnread, outboundStatusText, splitPeerName, stampColorOf, STATION_ISLAND_UID } from '@shared/post-core'
import PostageStamp, { postageArtworkUrl } from './PostageStamp'
import { useTranslation } from 'react-i18next'
import { renderInviteCardPng } from '../invite-card'
import { i18next } from '../i18n'
import { isEn } from '../i18n/localized'

// 邮局(2026-10-29,doc/需求 - 邮局 - 2026-10-29.md):单信件流——所有岛的信混排一条对话式
// 正序流,邮件型气泡;通讯录不成界面(写信时弹选择/回信自动锁定);邀请函=小弹窗(生成/导入)。
// 素材(大邮票/信纸/邮戳回执)未出前用色块邮票+文字回执占位,素材到位后仅换样式。

function peerDisplay(name: string): string {
  const { owner, island } = splitPeerName(name)
  return island ? i18next.t('post.peer', { owner, island }) : owner
}

function stampInitial(peerName: string, fallback: string): string {
  const island = peerName.split(' · ')[1] ?? peerName
  return island.trim().charAt(0) || fallback
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export default function PostView() {
  const { t } = useTranslation()
  const [overview, setOverview] = useState<PostOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 写信态(2026-10-30 评审):邮局页直接点「写信」=先选收件人(choosing,不预设);
  // 从信卡「回信」=锁定收件人(composingTo,防回错人)。不再提供下拉切换,换人=收起重开
  const [choosing, setChoosing] = useState(false)
  const [replyMode, setReplyMode] = useState(false)
  const [recipientOpen, setRecipientOpen] = useState(false)
  const recipientRef = useRef<HTMLDivElement>(null)
  const recipientTrigger = useRef<HTMLButtonElement>(null)
  const [composingTo, setComposingTo] = useState<PostContact | null>(null)
  // 写信相关错误贴着输入框显示(2026-10-30 评审:放页面顶部看不见)
  const [composeError, setComposeError] = useState<string | null>(null)
  // 邀请函弹窗内提示(解析失败/复制成功等):跟着弹窗走,不放页面顶部被弹窗遮住
  const [inviteNotice, setInviteNotice] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [requestBusy, setRequestBusy] = useState(false)
  const sendGuard = useRef(false)
  const requestGuard = useRef(false)
  const parseSequence = useRef(0)
  const [draft, setDraft] = useState('')
  const [draftAtts, setDraftAtts] = useState<MessageAttachment[]>([])
  const [sending, setSending] = useState(false)
  // 邀请函弹窗(2026-11-03 重做:码为主角/分享图导出/六格输入)
  const [invitePane, setInvitePane] = useState<null | 'mine' | 'import'>(null)
  const [inviteInfo, setInviteInfo] = useState<PostInviteInfo | null>(null)
  const [inviteCard, setInviteCard] = useState<string | null>(null)
  const [cardBusy, setCardBusy] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [savingInvite, setSavingInvite] = useState(false)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [codeCells, setCodeCells] = useState<string[]>(['', '', '', '', '', ''])
  const codeCellRefs = useRef<Array<HTMLInputElement | null>>([])
  const [credential, setCredential] = useState('') // 已识别的凭证(码或扫码文本),提交申请时用
  const [parsed, setParsed] = useState<PostInviteParsed | null>(null)
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  // 进页补拉在途(#28):本地为空时以此区分「正在收取信件」与「真的没有信」
  const [fetching, setFetching] = useState(true)
  // 已读标读队列(#27):已入队的信 id;未读判定与主进程未读计数同源 countsUnread
  const readQueuedRef = useRef<Set<string>>(new Set())
  const readTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const refresh = useCallback(() => {
    api
      .postOverview()
      .then((o) => setOverview(o))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    refresh()
    // 进邮局页即补拉一次(#28:首屏不再依赖 120s 轮询/切窗聚焦;主进程侧 ≥30s 节流)
    let cancelled = false
    api
      .postPull()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFetching(false)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  useEffect(() => {
    return onPostChanged(refresh)
  }, [refresh])

  useEffect(() => {
    if (!recipientOpen) return
    const close = (event: PointerEvent) => {
      if (!recipientRef.current?.contains(event.target as Node)) setRecipientOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRecipientOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [recipientOpen])
  useEffect(() => {
    if (!invitePane) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !requestGuard.current && !savingInvite) setInvitePane(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [invitePane, savingInvite])

  // 进入邮局=在看信箱:已见来信 1.5s 后批量标已读(微信式进会话即清未读;已读回执随之发出)。
  // #27 修复:旧写法「一次性 markedRef + effect cleanup 清定时器」下,任何一次 PostChanged 广播
  // (切窗聚焦补拉恰在进出邮局前后高发)都会清掉在途定时器且不补排,整批标记丢失;停留期间
  // 新到的信也永不标读。改为:每轮 overview 把未入队的未读 id 入队并排一批 1.5s 批量标读;
  // 入队即记录,广播重跑不重复;定时器只在卸载时清理,不随 effect 重跑被取消;失败出队等下轮重排。
  useEffect(() => {
    if (!overview) return
    const pending = overview.letters.filter(
      (l) => l.readAt === null && countsUnread(l.kind, l.direction) && !readQueuedRef.current.has(l.id)
    )
    if (pending.length === 0) return
    const ids = pending.map((l) => l.id)
    for (const id of ids) readQueuedRef.current.add(id)
    const timer = setTimeout(() => {
      readTimersRef.current.delete(timer)
      api.postMarkReadMany(ids).catch(() => {
        for (const id of ids) readQueuedRef.current.delete(id) // 失败出队,下一轮广播/刷新重排重试
      })
    }, 1500)
    readTimersRef.current.add(timer)
  }, [overview])

  // 卸载时清在途标读定时器(组件可能随视图切走;未标到的信下次进页重新排)
  useEffect(() => {
    const timers = readTimersRef.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // 新内容滚动到底(对话式正序流)
  useEffect(() => {
    const el = flowRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [overview?.letters.length])

  const letters = overview?.letters ?? []
  const contacts = overview?.contacts ?? []
  const empty = letters.length === 0

  function startCompose(to?: PostContact): void {
    if (contacts.length === 0) {
      setNotice(t('post.noFriends'))
      setInvitePane('mine')
      return
    }
    if (sendGuard.current) return
    setReplyMode(!!to)
    setRecipientOpen(false)
    setComposeError(null)
    setDraft('')
    setDraftAtts([])
    if (to) {
      setChoosing(false)
      setComposingTo(to)
    } else {
      setComposingTo(null)
      setChoosing(true)
    }
  }

  async function send(): Promise<void> {
    if (!composingTo || sendGuard.current || (!draft.trim() && draftAtts.length === 0)) return
    sendGuard.current = true
    setSending(true)
    setComposeError(null)
    try {
      await api.postSendLetter({
        toIsland: composingTo.islandUid,
        body: draft,
        attachments: draftAtts.map((a) => ({ path: a.path }))
      })
      setComposingTo(null)
      setChoosing(false)
      setRecipientOpen(false)
      setDraft('')
      setDraftAtts([])
      refresh()
    } catch (err) {
      // 写信错误贴着输入框(网络失败等当场可见),不进页面顶部横条
      setComposeError(err instanceof Error ? err.message : String(err))
    } finally {
      sendGuard.current = false
      setSending(false)
    }
  }

  async function respondRequest(letter: PostLetter, accept: boolean): Promise<void> {
    await api.postFriendRespond(letter.peerIsland, accept)
    refresh()
  }

  async function generateInvite(): Promise<void> {
    if (inviteBusy || savingInvite) return
    setInviteBusy(true)
    setInviteNotice(null)
    setCopyNotice(null)
    setSaveNotice(null)
    try {
      const info = await api.postInviteCreate()
      setInviteInfo(info)
      // 分享图异步生成(画布 1080×1620,不阻塞码展示)
      setCardBusy(true)
      setInviteCard(null)
      renderInviteCardPng({
        code: info.code,
        link: info.link,
        islandName: info.islandName,
        ownerName: info.ownerName ?? '',
        artworkUrl: postageArtworkUrl(info.artworkId)
      })
        .then(setInviteCard)
        .catch(() => setInviteNotice(t('post.cardRenderFailed')))
        .finally(() => setCardBusy(false))
    } catch (err) {
      setInviteNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setInviteBusy(false)
    }
  }

  async function saveInviteCard(): Promise<void> {
    if (!inviteCard || savingInvite) return
    setSavingInvite(true); setInviteNotice(null); setSaveNotice(null)
    try { const result = await api.postSaveInviteQr(inviteCard); if (result.saved) setSaveNotice(t('post.imageSaved')) }
    catch { setInviteNotice(t('post.qrSaveFailed')) }
    finally { setSavingInvite(false) }
  }

  async function copyInviteImage(): Promise<void> {
    if (!inviteCard || savingInvite) return
    setSavingInvite(true); setInviteNotice(null); setSaveNotice(null)
    try { await api.postCopyInviteImage(inviteCard); setSaveNotice(t('post.imageCopied')) }
    catch { setInviteNotice(t('post.copyImageFailed')) }
    finally { setSavingInvite(false) }
  }

  async function copyCode(code: string): Promise<void> {
    setCopyNotice(null)
    try { await navigator.clipboard.writeText(code); setCopyNotice(t('post.codeCopied', { code })) }
    catch { setCopyNotice(t('post.copyFailed')) }
  }

  async function copyInviteLink(): Promise<void> {
    if (!inviteInfo) return
    setCopyNotice(null)
    try { await navigator.clipboard.writeText(inviteInfo.link); setCopyNotice(t('post.linkCopied')) }
    catch { setCopyNotice(t('post.copyFailed')) }
  }

  function formatValidUntil(expiresAt: number): string {
    const d = new Date(expiresAt)
    return `${d.getMonth() + 1} ${t('post.monthUnit')} ${d.getDate()} ${t('post.dayUnit')}`
  }

  /** 六格输入:只收字母表字符并大写,输完自动跳格;满 6 位自动识别 */
  function onCodeCellInput(index: number, raw: string): void {
    const cleaned = raw.toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, '').slice(-1)
    const next = [...codeCells]
    next[index] = cleaned
    setCodeCells(next)
    setInviteNotice(null)
    setParsed(null)
    setCredential('')
    if (cleaned && index < 5) codeCellRefs.current[index + 1]?.focus()
    if (next.every((c) => c !== '')) void parseInvite(next.join(''))
  }

  function onCodeCellKeydown(index: number, key: string): void {
    if (key === 'Backspace' && !codeCells[index] && index > 0) codeCellRefs.current[index - 1]?.focus()
  }

  function resetImport(): void {
    setCodeCells(['', '', '', '', '', ''])
    setParsed(null)
    setCredential('')
    setNote('')
    setImportText('')
    setInviteNotice(null)
    codeCellRefs.current[0]?.focus()
  }

  async function parseInvite(text?: string): Promise<void> {
    const raw = (text ?? importText).trim()
    if (!raw) { setInviteNotice(t('post.linkRequired')); return }
    const sequence = ++parseSequence.current
    setParsing(true)
    setInviteNotice(null)
    try {
      const result = await api.postInviteParse(raw)
      if (sequence === parseSequence.current) { setParsed(result); setCredential(raw) }
    } catch (err) {
      if (sequence === parseSequence.current) {
        setParsed(null)
        setInviteNotice(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (sequence === parseSequence.current) setParsing(false)
    }
  }

  async function parseImage(file: File): Promise<void> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    }).catch(() => null)
    if (!dataUrl) { setInviteNotice(t('post.qrNotRecognized')); return }
    const img = new Image()
    img.src = dataUrl
    await new Promise((r) => {
      img.onload = r
      img.onerror = r
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx || !canvas.width) { setInviteNotice(t('post.qrNotRecognized')); return }
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const found = jsQR(data.data, data.width, data.height)
    if (found?.data) {
      setImportText(found.data)
      await parseInvite(found.data)
    } else {
      setInviteNotice(t('post.qrNotRecognized'))
    }
  }

  async function submitRequest(): Promise<void> {
    if (!parsed || requestGuard.current) return
    requestGuard.current = true
    setRequestBusy(true)
    setInviteNotice(null)
    try {
      await api.postFriendRequest(credential || codeCells.join(''), note.trim())
      setInvitePane(null)
      setParsed(null)
      setImportText('')
      setNote('')
      setNotice(t('post.requestSent'))
      refresh()
    } catch (err) {
      setInviteNotice(err instanceof Error ? err.message : String(err))
    } finally {
      requestGuard.current = false
      setRequestBusy(false)
    }
  }


  return (
    <section className="post-view">
      <header className="post-head">
        <h1>{t('post.title')}</h1>
        {!!overview?.unread && (
            <span className="post-unread-chip">{t('post.unread', { count: overview.unread })}</span>
          )}
        <div className="post-head-actions">
          <button className="post-action primary" onClick={() => startCompose()}>
            <PenLine size={14} /> {t('post.write')}
          </button>
          <button className="post-action" onClick={() => setInvitePane((p) => (p ? null : 'mine'))}>
            <QrCode size={14} /> {t('post.invite')}
          </button>
        </div>
      </header>

      {(notice || error) && (
        <div className="post-notice">
          <span>{error ?? notice}</span>
          <button onClick={() => { setNotice(null); setError(null) }}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="post-flow" ref={flowRef}>
        {!overview ? (
          // 快照未到:出错则横条已示错、这里留白;否则给收取中(旧版此处会闪一下邀请函空态)
          error ? null : (
            <div className="post-empty post-fetching" role="status">
              <Loader2 size={22} className="spin" />
              <p>{t('post.fetching')}</p>
            </div>
          )
        ) : !overview.islandUid ? (
          <div className="post-empty">
            <Mail size={32} />
            <p>{t('post.needLogin')}</p>
          </div>
        ) : empty && fetching ? (
          // #28:本地为空且补拉在途——区分「正在收取信件」与「确实没有信」,不再一进页就是邀请函空态
          <div className="post-empty post-fetching" role="status">
            <Loader2 size={22} className="spin" />
            <p>{t('post.fetching')}</p>
          </div>
        ) : empty ? (
          <div className="post-empty">
            <span className="post-empty-envelope"><Mail size={33} /></span>
            <h3>{t('post.emptyTitle')}</h3>
            <div className="post-empty-cards">
              <button className="post-empty-card" onClick={() => setInvitePane('mine')}>
                <QrCode size={22} />
                <strong>{t('post.emptyShareTitle')}</strong>
                <span>{t('post.emptyShareSub')}</span>
              </button>
              <button className="post-empty-card" onClick={() => setInvitePane('import')}>
                <Upload size={22} />
                <strong>{t('post.emptyImportTitle')}</strong>
                <span>{t('post.emptyImportSub')}</span>
              </button>
            </div>
          </div>
        ) : (
          letters.map((l) => (
            <LetterRow
              key={l.id}
              letter={l}
              ownIslandUid={overview?.islandUid ?? null}
              ownArtworkId={overview?.artworkId}
              onReply={() => {
                const contact = contacts.find((c) => c.islandUid === l.peerIsland)
                if (contact) startCompose(contact)
                else setNotice(t('post.channelGone'))
              }}
              onRespond={(accept) => respondRequest(l, accept)}
              onBlock={async () => { await api.postBlock(l.peerIsland, l.id); refresh() }}
              onDeleteChannel={async () => { await api.postDeleteContact(l.peerIsland, l.id); refresh() }}
              onDeleteLetter={async () => { await api.postDeleteLetter(l.id); refresh() }}
            />
          ))
        )}
      </div>

      {(choosing || composingTo) && (
        <div className="post-compose">
          <div className="post-recipient" ref={recipientRef}>
            <span className="post-recipient-label">{t('post.recipient')}</span>
            {replyMode && composingTo ? <strong className="post-reply-to">{peerDisplay(`${composingTo.ownerName} · ${composingTo.islandName}`)}</strong> :
              <div className="post-select-wrap">
                <button ref={recipientTrigger} type="button" className="post-recipient-select" role="combobox" disabled={sending} aria-haspopup="listbox" aria-controls="post-recipient-options" aria-expanded={recipientOpen} onClick={() => setRecipientOpen((v) => !v)} onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    setRecipientOpen(true)
                    requestAnimationFrame(() => {
                      const items = recipientRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')
                      if (items?.length) items[event.key === 'ArrowUp' ? items.length - 1 : 0]!.focus()
                    })
                  }
                }}>
                  {composingTo ? peerDisplay(`${composingTo.ownerName} · ${composingTo.islandName}`) : t('post.chooseRecipient')}<ChevronDown size={13} />
                </button>
                {recipientOpen && <div id="post-recipient-options" className="post-select-options" role="listbox" aria-label={t('post.recipient')} onKeyDown={(event) => {
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'))
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
                  } else if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); setRecipientOpen(false); recipientTrigger.current?.focus()
                  }
                }}>
                  {contacts.map((contact) => <button type="button" role="option" aria-selected={contact.islandUid === composingTo?.islandUid} key={contact.islandUid} onClick={() => { setComposingTo(contact); setChoosing(false); setRecipientOpen(false); setComposeError(null); recipientTrigger.current?.focus() }}>
                    <span>{contact.ownerName}</span><small>{contact.islandName}</small>{contact.islandUid === STATION_ISLAND_UID && <em className="post-official-badge">{t('post.officialBadge')}</em>}{contact.islandUid === composingTo?.islandUid && <Check size={13} />}
                  </button>)}
                </div>}
              </div>}
            <button className="post-recipient-close" disabled={sending} title={t('post.collapse')} onClick={() => { setComposingTo(null); setChoosing(false); setRecipientOpen(false); setComposeError(null) }}><X size={13} /></button>
          </div>
          <Composer input={draft} onInputChange={setDraft} attachments={draftAtts} onAttachmentsChange={setDraftAtts}
            busy={sending} onStop={() => undefined} onSend={() => void send()} sendDisabled={!composingTo}
            placeholder={t('post.bodyPlaceholder')} mentionCandidates={[]} attachmentMode="post" />
          {composeError && <p className="post-compose-error" role="alert">{composeError}</p>}
        </div>
      )}

      {invitePane && (
        <div className="post-invite-mask" onClick={() => { if (!requestGuard.current && !savingInvite) setInvitePane(null) }}>
          <div className="post-invite" role="dialog" aria-modal="true" aria-label={t('post.invite')} onClick={(e) => e.stopPropagation()}>
            <div className="post-invite-tabs">
              <button disabled={requestBusy || savingInvite} className={invitePane === 'mine' ? 'active' : ''} onClick={() => setInvitePane('mine')}>
                {t('post.myInvite')}
              </button>
              <button disabled={requestBusy || savingInvite} className={invitePane === 'import' ? 'active' : ''} onClick={() => setInvitePane('import')}>
                {t('post.importInvite')}
              </button>
              <button className="post-invite-close" disabled={requestBusy || savingInvite} title={t('post.collapse')} onClick={() => setInvitePane(null)}>
                <X size={14} />
              </button>
            </div>
            {invitePane === 'mine' ? (
              <div className="post-invite-body post-invite-mine">
                {!inviteInfo ? <div className="post-invite-gen">
                  <span className="post-invite-illustration"><QrCode size={38} /></span>
                  <h2>{t('post.inviteHeading')}</h2>
                  <p>{t('post.inviteGenLead')}</p>
                  <button className="post-action primary wide" disabled={inviteBusy} onClick={() => void generateInvite()}>
                    {inviteBusy && <Loader2 size={14} className="spin" />}{inviteBusy ? t('post.generating') : t('post.generate')}
                  </button>
                </div> : <>
                  <div className="invite-meta">{inviteBusy ? t('post.generating') : <>{t('post.codeLabel')} · <b>{formatValidUntil(inviteInfo.expiresAt)}</b>{t('post.validSuffix')}</>}</div>
                  <button className="code-row" type="button" title={t('post.tapToCopy')} disabled={inviteBusy} onClick={() => void copyCode(inviteInfo.code)}>
                    {inviteInfo.code.split('').map((ch, i) => <span key={i}>{ch}</span>)}
                  </button>
                  {copyNotice && <p className="post-copy-notice" role="status">{copyNotice}</p>}
                  <button className="link-plain" type="button" disabled={inviteBusy} onClick={() => void copyInviteLink()}>
                    {inviteInfo.link} · <b>{t('post.copyLink')}</b>
                  </button>
                  <div className="export-row">
                    {cardBusy && <span className="post-card-loading" role="status"><Loader2 size={14} className="spin" /></span>}
                    {inviteCard && <img className="thumb" src={inviteCard} alt={t('post.cardAlt')} />}
                    <div className="export-btns">
                      <button className="post-action primary" disabled={cardBusy || savingInvite || !inviteCard} onClick={() => void copyInviteImage()}>{savingInvite ? <Loader2 size={15} className="spin" /> : <Copy size={15} />}{t('post.copyImage')}</button>
                      <button className="post-action" disabled={cardBusy || savingInvite || !inviteCard} onClick={() => void saveInviteCard()}><Download size={15} />{t('post.saveImage')}</button>
                    </div>
                  </div>
                  {saveNotice && <p className="post-save-notice" role="status">{saveNotice}</p>}
                </>}
                {inviteNotice && <p className="post-invite-notice err" role="alert">{inviteNotice}</p>}
              </div>
            ) : parsed ? (
              <div className="post-invite-body post-invite-parsed">
                <div className="imp-ok-head">
                  <span className="imp-ok-badge">{t('post.identified')}</span>
                  <button type="button" className="imp-ok-back" onClick={resetImport}>{t('post.reinput')}</button>
                </div>
                <div className="imp-card">
                  <PostageStamp islandUid={parsed.islandUid} artworkId={parsed.artworkId} label={parsed.islandName.charAt(0)} />
                  <div className="imp-who"><b>{parsed.islandName}</b><span>{t('post.ownerTitle', { name: parsed.ownerName })}</span></div>
                </div>
                <textarea className="post-invite-input" aria-label={t('post.notePlaceholder')} placeholder={t('post.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} rows={4} readOnly={requestBusy} />
                <div className="post-invite-actions post-greeting-actions">
                  <button className="post-action primary wide" disabled={requestBusy} onClick={() => void submitRequest()}>{requestBusy ? <Loader2 size={14} className="spin" /> : <SendHorizonal size={14} />}{requestBusy ? t('post.sending') : t('post.sendRequest')}</button>
                </div>
                {inviteNotice && <p className="post-invite-notice err" role="alert">{inviteNotice}</p>}
              </div>
            ) : (
              <div className="post-invite-body post-import-body">
                <div className="imp-input-view">
                  <div className="imp-title">{t('post.inputCodeTitle')}</div>
                  <div className="code-row code-input" role="group" aria-label={t('post.inputCodeTitle')}>
                    {codeCells.map((ch, i) => (
                      <input key={i} ref={(el) => { codeCellRefs.current[i] = el }} value={ch} inputMode="text" autoComplete="off" aria-label={t('post.codeCellAria', { n: i + 1 })}
                        onChange={(e) => onCodeCellInput(i, e.target.value)} onKeyDown={(e) => onCodeCellKeydown(i, e.key)} disabled={parsing} />
                    ))}
                  </div>
                  <div className="imp-alt">{parsing ? t('post.parsing') : t('post.codeAlt', { link: t('post.loadQr') })}</div>
                </div>
                <label className={`post-qr-import ${parsing ? 'disabled' : ''}`}>
                  <input type="file" accept="image/*" hidden disabled={parsing} onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseImage(file); event.currentTarget.value = '' }} />
                  <Upload size={18} /><span><strong>{t('post.loadQr')}</strong><small>{t('post.qrImportHint')}</small></span><ArrowUpRight size={14} />
                </label>
                {inviteNotice && <p className="post-invite-notice err" role="alert">{inviteNotice}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function LetterRow(props: {
  letter: PostLetter
  ownIslandUid: string | null
  ownArtworkId?: string | null
  onReply(): void
  onRespond(accept: boolean): Promise<void>
  onBlock(): Promise<void>
  onDeleteChannel(): Promise<void>
  onDeleteLetter(): Promise<void>
}) {
  const { t } = useTranslation()
  const { letter: l } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const peer = splitPeerName(l.peerName)
  const isIn = l.direction === 'in'
  const request = l.kind === 'friend_request' && isIn
  // 群岛联络站(2026-11-02 拍板):官方联系人,名下两角色——首席联络官('officer',可回信)与
  // 系统通知('system',不可回信)。三概念分家:isSystem(无回信的轻量信)、canReply、canChannelOps(联络站禁通道操作)
  const isStation = l.peerIsland === STATION_ISLAND_UID
  const isSystem = l.kind === 'friend_accept' || l.senderKind === 'system'
  const canReply = isIn && !isSystem
  const canChannelOps = canReply && !isStation
  // 中性邮票只给非联络站的系统信(friend_accept);联络站两角色共用灯塔大邮票(artworkId 由云端合成)
  const stampSystem = !isStation && isSystem
  const outTitle = peer.island ? t('post.to', { owner: peer.owner, island: peer.island }) : peer.owner
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  async function act(action: () => Promise<void>): Promise<void> {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    setMenuOpen(false)
    try { await action() }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const stampLabel = stampInitial(l.peerName, t('post.stampFallback'))
  return (
    <article className={`post-letter ${isIn ? 'in' : 'out'} ${request ? 'friend-card' : ''} ${l.outcome ? 'done' : ''} ${isSystem ? 'system' : ''}`}>
      <div className="post-letter-head">
        <PostageStamp islandUid={isIn ? l.peerIsland : props.ownIslandUid ?? ''} artworkId={isIn ? l.peerArtworkId : props.ownArtworkId} label={isIn ? stampLabel : t('post.stampFallback')} color={stampColorOf(isIn ? l.peerIsland : props.ownIslandUid ?? '')} system={stampSystem} />
        <div className="post-letter-meta">
          <strong>{isIn ? peerDisplay(l.peerName) : outTitle}</strong>
          <span>{formatTime(l.createdAt)}</span>
          {request && <span className="post-request-label">{t('post.connectionRequest')}</span>}
          {l.senderKind === 'resident' && <em className="post-resident-badge">{t('post.residentBadge')}</em>}
          {isStation && <em className="post-official-badge">{t('post.officialBadge')}</em>}
        </div>
        {request ? !l.outcome ? <div className="post-letter-ops post-request-ops">
          <button className="post-action primary" disabled={pending} onClick={() => void act(() => props.onRespond(true))}><Check size={13} />{t('post.connect')}</button>
          <button className="post-action" disabled={pending} onClick={() => void act(() => props.onRespond(false))}>{t('post.decline')}</button>
          <button className="post-action danger" disabled={pending} onClick={() => void act(props.onBlock)}><Ban size={13} />{t('post.block')}</button>
        </div> : null : <div className="post-letter-ops">
            {canReply && <button className="post-action" disabled={pending} onClick={props.onReply}><PenLine size={13} />{t('post.reply')}</button>}
            <div className="post-more" ref={menuRef}>
              <button className="post-action" disabled={pending} aria-expanded={menuOpen} aria-haspopup="menu" title={t('post.more')} onClick={() => setMenuOpen((v) => !v)}><MoreHorizontal size={15} /></button>
              {menuOpen && <div className="post-more-menu" role="menu">
                <button role="menuitem" onClick={() => void act(props.onDeleteLetter)}>{t('post.deleteLetter')}</button>
                {canChannelOps && <button role="menuitem" className="danger" onClick={() => void act(props.onDeleteChannel)}>{t('post.deleteChannel')}</button>}
              </div>}
            </div>
        </div>}
        {/* #27:小圆点与未读计数同源 countsUnread(letter/friend_request 才计)——friend_accept 系统行
            不再挂永久圆点;已置结果章的申请卡靠批量标读清 readAt,与导航栏红点数严格一致 */}
        {countsUnread(l.kind, l.direction) && l.readAt === null && <i className="post-unread-dot" />}
      </div>
      <LetterBody body={l.body} />
      {l.attachments.length > 0 && <div className="post-letter-atts"><AttachmentCards attachments={l.attachments.map((a) => ({
        kind: a.mime?.startsWith('image/') || a.thumb ? 'image' : 'file', path: a.localPath ?? '', name: a.filename, size: a.size, thumb: a.thumb
      }))} /></div>}
      <div className="post-letter-footer">
          {l.outcome && <span className={`post-outcome ${l.outcome}`}>
            {l.outcome === 'accepted' ? t('post.connectedWith', { island: peer.island || peer.owner })
              : l.outcome === 'channel_deleted' ? t('post.channelDeletedWith', { island: peerDisplay(l.peerName) }) : outcomeTextOf(l.outcome, t, peerDisplay(l.peerName))}
          </span>}
        {!isIn && <span className={`post-postmark ${l.status === 'failed' ? 'fail' : ''}`}>{outboundStatusText(displayStatus(l.status), isEn())}</span>}
        {pending && <Loader2 size={13} className="spin" aria-label={t('common.loading')} />}
      </div>
      {actionError && <p className="post-letter-error" role="alert">{actionError}</p>}
      {l.status === 'failed' && l.error && <p className="post-letter-error">{t('post.sendFailed', { error: l.error })}</p>}
    </article>
  )
}

/** 操作结果章文案 */
function outcomeTextOf(outcome: NonNullable<PostLetter['outcome']>, t: (k: string, options?: Record<string, string>) => string, peer: string): string {
  switch (outcome) {
    case 'accepted':
      return t('post.outcomeAccepted')
    case 'declined':
      return t('post.declinedWith', { peer })
    case 'blocked':
      return t('post.blockedWith', { peer })
    case 'channel_deleted':
      return t('post.outcomeChannelDeleted')
  }
}

/** 对方已读不展示(2026-10-30 评审:社交压迫感 + 读信的可能是对方的居民);回执数据照记,显示封顶「已送达」 */
function displayStatus(status: PostLetterStatus): PostLetterStatus {
  return status === 'read' ? 'delivered' : status
}

/** 信件正文:默认最多 6 行,超出折叠 + 展开全文(2026-10-30 评审:防长信刷屏) */
function LetterBody({ body }: { body: string | null }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [expandable, setExpandable] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      // 与截断样式共用同一把尺(2026-11-06 codex 审查修复:此前按「行高×6+4」估算,与 CSS 的
      // max-height 存在漏判区间,部分被截断的信没有展开按钮;直接比 clamp 后的 clientHeight,
      // 不再假设字号/行高,样式怎么改都不会脱钩)
      setExpandable(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [body])
  if (!body?.trim()) return null
  return (
    <div className="post-letter-body-wrap">
      <div ref={ref} className={`post-letter-body ${expanded ? '' : 'clamp'}`}>
        <Markdown content={body} />
      </div>
      {expandable && (
        <button type="button" className="post-body-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('post.collapseLetter') : t('post.expand')}
        </button>
      )}
    </div>
  )
}

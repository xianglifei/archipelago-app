import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, CircleHelp, Coins, Palmtree, Settings, Sparkles, UserRound } from 'lucide-react'
import type { SettingsState, UiLanguage } from '@shared/types'
import { api } from '../api'
import { cacheTurnProcessPref, turnProcessPrefExpanded } from '../utils/turn-process-pref'
import { useTranslation } from '../i18n'
import AccountTab from './AccountTab'
import CreditsTab from './CreditsTab'
import MemoryPanel from './MemoryPanel'
import UpdatePanel from './UpdatePanel'
import { ByokDetail, ModelSourceCard } from './ModelSource'

// 设置(0.9 群岛通道切换):岛务 / 设备连接 / 套餐与积分 / 记忆 / 关于 五个页签
// —— 「模型」「安全」页签已删除(危险命令模式不再对用户暴露)。
// 2026-11-13 BYOK:模型来源回到岛务页(一张常驻卡),自带 Key 的细节在岛务页内的二级层,
// 不新增左侧页签——「岛务做大决定,二级页做细节」。
type SettingsTab = 'island' | 'account' | 'credits' | 'memory' | 'about'
type IslandPane = 'main' | 'byok'

export default function SettingsModal({
  onClose,
  onSaved,
  initialTab = 'island',
  initialMemoryScope,
  updateBadge = false,
  embedded = false
}: {
  onClose: () => void
  onSaved: (state: SettingsState) => void
  initialTab?: SettingsTab
  /** 记忆页签打开时预选的作用域(侧栏「岛主」入口跳到「岛主档案」用) */
  initialMemoryScope?: string
  updateBadge?: boolean
  /** 内嵌模式(2026-10-28 导航栏方案):不套弹窗外壳,作为导航栏右侧整区面板渲染;内容与弹窗完全一致 */
  embedded?: boolean
}) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  // 岛务页内部层(2026-11-13 BYOK):main=岛务本页 / byok=自带 DeepSeek Key 详情页
  const [islandPane, setIslandPane] = useState<IslandPane>('main')
  const [state, setState] = useState<SettingsState | null>(null)
  const [islandName, setIslandName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  // 岛名/称呼即时保存(2026-11-09 走查统一):idle 无事 / saving 保存中 / saved 已保存(1.5s 收回)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  // 回合过程默认折叠/展开(2026-11-08 设置项):null=尚未读到
  const [turnProcessExpanded, setTurnProcessExpanded] = useState<boolean | null>(null)
  // 即时保存的家伙什:跳过首载回显触发 / 晚归旧响应丢弃 / 上一个已存值(空值回填与脏判定)
  const skipEchoRef = useRef(true)
  const saveSeqRef = useRef(0)
  const lastSavedRef = useRef({ island: '', owner: '' })
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    api
      .settingsGet()
      .then((s) => {
        skipEchoRef.current = true
        lastSavedRef.current = { island: s.space.name, owner: s.space.ownerName }
        setState(s)
        setIslandName(s.space.name)
        setOwnerName(s.space.ownerName)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    api
      .turnProcessGet()
      .then((v) => {
        setTurnProcessExpanded(v)
        // 读回即对齐模块缓存(2026-11-08 codex 评审:重开设置读到旧值时,缓存不许留着没落库的新值)
        cacheTurnProcessPref(v)
      })
      .catch(() => {
        // 读失败退回模块缓存兜底(未加载=默认折叠),不让按钮永久禁用;点按本身即重试
        setTurnProcessExpanded(turnProcessPrefExpanded())
      })
  }, [])

  // 看过「关于」页签即消红点
  useEffect(() => {
    if (tab === 'about') api.updateMarkSeen().catch(console.error)
  }, [tab])

  // 界面语言切换(2026-10-30 双语):即时生效,不走「保存」按钮
  function switchLanguage(lang: UiLanguage): void {
    if (lang === i18n.language) return
    api.uiLanguageSet(lang).catch(console.error)
  }

  // 回合过程默认折叠/展开(2026-11-08):即时生效,不走「保存」按钮;同步渲染端缓存,
  // 之后新挂载的「工作中」「回信中」运行签立即按新默认值来
  function switchTurnProcess(v: boolean): void {
    if (v === turnProcessExpanded) return
    const prev = turnProcessExpanded
    setTurnProcessExpanded(v)
    cacheTurnProcessPref(v)
    api.turnProcessSet(v).catch((err) => {
      // 写失败回滚控件与缓存(codex 评审):别让界面停在没落库的值上
      setTurnProcessExpanded(prev)
      if (prev !== null) cacheTurnProcessPref(prev)
      console.error(err)
    })
  }

  // 岛名/称呼即时保存(2026-11-09 走查统一,与语言/工作过程同语义):文本框不能逐键写库,
  // 停顿 600ms 自动落库;失焦/回车立即冲刷;空值不保存(失焦回填上一个已存值,转瞬的空态不落库)
  const autoSave = useCallback(
    async (island: string, owner: string): Promise<void> => {
      const seq = ++saveSeqRef.current
      setSaveState('saving')
      setError(null)
      try {
        const next = await api.settingsSave({ islandName: island, ownerName: owner })
        if (seq !== saveSeqRef.current) return // 期间又改了:晚归的旧响应丢弃,新保存已在路上
        lastSavedRef.current = { island, owner }
        setState(next)
        onSaved(next)
        setSaveState('saved')
        window.setTimeout(() => {
          if (saveSeqRef.current === seq) setSaveState('idle')
        }, 1500)
      } catch (err) {
        if (seq !== saveSeqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setSaveState('idle')
      }
    },
    [onSaved]
  )

  useEffect(() => {
    if (skipEchoRef.current) {
      // 首载把已存值回显进输入框,不是用户改动,不触发保存
      skipEchoRef.current = false
      return
    }
    const island = islandName.trim()
    const owner = ownerName.trim()
    if (!island || !owner) return
    if (island === lastSavedRef.current.island && owner === lastSavedRef.current.owner) return
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      void autoSave(island, owner)
    }, 600)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [islandName, ownerName, autoSave])

  /** 失焦/回车冲刷:立即保存挂起的改动;清空的字段回填上一个已存值 */
  function flushFields(): void {
    const island = islandName.trim()
    const owner = ownerName.trim()
    if (!island) setIslandName(lastSavedRef.current.island)
    if (!owner) setOwnerName(lastSavedRef.current.owner)
    if (!island || !owner) return
    if (island === lastSavedRef.current.island && owner === lastSavedRef.current.owner) return
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    void autoSave(island, owner)
  }

  const inner = (
    <>
      <nav className="settings-nav">
          <h2>
            <Settings size={16} /> {t('settings.title')}
          </h2>
          <button
            className={`settings-nav-item ${tab === 'island' ? 'active' : ''}`}
            onClick={() => {
              setTab('island')
              setIslandPane('main')
            }}
          >
            <Palmtree size={15} /> {t('settings.tabIsland')}
          </button>
          <button
            className={`settings-nav-item ${tab === 'account' ? 'active' : ''}`}
            onClick={() => setTab('account')}
          >
            <UserRound size={15} /> {t('settings.tabAccount')}
          </button>
          <button
            className={`settings-nav-item ${tab === 'credits' ? 'active' : ''}`}
            onClick={() => setTab('credits')}
          >
            <Coins size={15} /> {t('settings.tabCredits')}
          </button>
          <button
            className={`settings-nav-item ${tab === 'memory' ? 'active' : ''}`}
            onClick={() => setTab('memory')}
          >
            <Brain size={15} /> {t('settings.tabMemory')}
          </button>
          <button
            className={`settings-nav-item ${tab === 'about' ? 'active' : ''}`}
            onClick={() => setTab('about')}
          >
            <Sparkles size={15} /> {t('settings.tabAbout')}{updateBadge && <span className="tab-dot" />}
          </button>
        </nav>

        <div className="settings-body">
          {tab === 'account' ? (
            <AccountTab
              onGoIsland={() => {
                setTab('island')
                setIslandPane('main')
              }}
            />
          ) : tab === 'credits' ? (
            <CreditsTab
              providerId={state?.model.providerId}
              onOpenModelSource={() => {
                setTab('island')
                setIslandPane('main')
              }}
            />
          ) : tab === 'memory' ? (
            <MemoryPanel initialScope={initialMemoryScope} />
          ) : tab === 'about' ? (
            <UpdatePanel />
          ) : !state ? (
            <p className="modal-lead">{error ?? t('common.loading')}</p>
          ) : islandPane === 'byok' ? (
            <ByokDetail
              state={state}
              onBack={() => setIslandPane('main')}
              onChanged={(next) => {
                setState(next)
                onSaved(next)
              }}
            />
          ) : (
            <>
              {/* 卡片化(2026-11-09 全设置页统一):归属卡撤下(账号信息归设备连接页),字段收成行内右置小输入框 */}
              <label className="field-label card-section-title">{t('settings.cardIslandTitle')}</label>
              <div className="settings-card">
                <div className="settings-card-row">
                  <label className="toggle-title">{t('settings.islandName')}</label>
                  <input
                    className="input settings-inline-input"
                    value={islandName}
                    onChange={(e) => setIslandName(e.target.value)}
                    onBlur={flushFields}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                  />
                </div>
                <div className="settings-card-row">
                  <label className="toggle-title">{t('settings.ownerName')}</label>
                  <input
                    className="input settings-inline-input"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    onBlur={flushFields}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                  />
                </div>
              </div>

              <label className="field-label card-section-title">{t('settings.cardPrefsTitle')}</label>
              <div className="settings-card">
                <div className="settings-card-row">
                  <label className="toggle-title">{t('settings.langLabel')}</label>
                  <div className="lang-switch" role="group" aria-label={t('settings.langLabel')}>
                    <button
                      className={i18n.language === 'zh' ? 'active' : ''}
                      onClick={() => switchLanguage('zh')}
                    >
                      {t('settings.langZh')}
                    </button>
                    <button
                      className={i18n.language === 'en' ? 'active' : ''}
                      onClick={() => switchLanguage('en')}
                    >
                      {t('settings.langEn')}
                    </button>
                  </div>
                </div>
                {/* 工作过程展示(2026-11-08 设置项;11-09 走查改版:说明收进问号浮窗) */}
                <div className="settings-card-row">
                  <span className="toggle-title qmark-host">
                    {t('settings.turnProcessLabel')}
                    <span
                      className="qmark"
                      data-tip={t('settings.turnProcessHint')}
                      tabIndex={0}
                      aria-label={t('settings.turnProcessHint')}
                    >
                      <CircleHelp size={13} />
                    </span>
                  </span>
                  <div className="lang-switch" role="group" aria-label={t('settings.turnProcessLabel')}>
                    <button
                      className={turnProcessExpanded === false ? 'active' : ''}
                      disabled={turnProcessExpanded === null}
                      onClick={() => switchTurnProcess(false)}
                    >
                      {t('settings.turnProcessCollapsed')}
                    </button>
                    <button
                      className={turnProcessExpanded === true ? 'active' : ''}
                      disabled={turnProcessExpanded === null}
                      onClick={() => switchTurnProcess(true)}
                    >
                      {t('settings.turnProcessExpanded')}
                    </button>
                  </div>
                </div>
              </div>

              {/* 模型来源(2026-11-13 BYOK):两个来源直接展开在岛务页;换档立即对整座岛生效 */}
              <label className="field-label card-section-title">{t('settings.modelSrcTitle')}</label>
              <ModelSourceCard
                state={state}
                onOpenDetail={() => setIslandPane('byok')}
                onChanged={(next) => {
                  setState(next)
                  onSaved(next)
                }}
              />

              {error && <div className="wizard-error">{error}</div>}

              {/* 即时保存状态行(2026-11-09):全页设置都直接生效,「关闭/保存」按钮排撤下 */}
              <div className="settings-autosave" data-state={saveState} aria-live="polite">
                {saveState === 'saving' ? t('common.saving') : saveState === 'saved' ? t('common.saved') : ''}
              </div>
            </>
          )}
        </div>
    </>
  )

  if (embedded) return <div className="settings-panel">{inner}</div>
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">{inner}</div>
    </div>
  )
}

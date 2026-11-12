import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Dices, Loader2, Sparkles, Waves } from 'lucide-react'
import type { BootState, WizardGrantInfo, WizardResult } from '@shared/types'
import { randomIslandName } from '@shared/names'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { i18nLang } from '../i18n/localized'

// 首次开场(0.9:模型/API Key 步骤已删除——群岛通道开箱即用,注册即送积分):
// 落地欢迎 → 命名岛 → 岛主称呼 → 完成页(岛务长 Momo 独自登岛 + 新用户首岛展示赠送卡片)
// 0.9.2 自走查:A3 完成页计入第 4 步指示条;A4 赠送卡片仅新用户首岛展示、判定与取数前置
export default function Wizard({ onDone }: { onDone: (boot: BootState) => void }) {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [islandName, setIslandName] = useState(() => randomIslandName())
  const [ownerName, setOwnerName] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [result, setResult] = useState<WizardResult | null>(null)
  const [grantInfo, setGrantInfo] = useState<WizardGrantInfo | null>(null)

  // 预取(A4):用户还在写岛名时就判定首岛、拉取赠送额,完成页现场零查询
  useEffect(() => {
    api
      .wizardGrantInfo()
      .then((info) => setGrantInfo(info))
      .catch(() => setGrantInfo(null))
  }, [])

  async function finish(): Promise<void> {
    setFinishing(true)
    setFinishError(null)
    try {
      const res = await api.wizardComplete({ islandName, ownerName })
      setResult(res)
      setStep(3)
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err))
      setFinishing(false)
    }
  }

  const steps = t('wizard.steps', { returnObjects: true }) as string[]

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="steps">
          {steps.map((label, i) => (
            <div key={label} className={`step-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <Waves size={44} className="wizard-icon" />
            <h1>{t('wizard.welcomeTitle')}</h1>
            <p className="wizard-lead">
              {/* 截图评审(v6):Mac→电脑(为将来 Windows 版留口);「AI Bot 团队」经口头权衡保留(agent team 太生僻) */}
              {t('wizard.welcomeLead')}
            </p>
            <button className="btn primary big" onClick={() => setStep(1)}>
              {t('wizard.claimBtn')} <ArrowRight size={16} />
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <h1>{t('wizard.nameTitle')}</h1>
            <p className="wizard-lead">{t('wizard.nameLead')}</p>
            <div className="field-row">
              <input
                className="input big"
                value={islandName}
                onChange={(e) => setIslandName(e.target.value)}
                placeholder={t('wizard.namePlaceholder')}
                autoFocus
              />
              <button className="btn ghost" title={t('wizard.reroll')} onClick={() => setIslandName(randomIslandName())}>
                <Dices size={16} /> {t('wizard.reroll')}
              </button>
            </div>
            <div className="wizard-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                <ArrowLeft size={16} /> {t('common.back')}
              </button>
              <button className="btn primary" disabled={!islandName.trim()} onClick={() => setStep(2)}>
                {t('common.next')} <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>{t('wizard.ownerTitle')}</h1>
            <p className="wizard-lead">{t('wizard.ownerLead')}</p>
            <input
              className="input big"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder={t('wizard.ownerPlaceholder')}
              autoFocus
            />
            {finishError && <div className="wizard-error">{finishError}</div>}
            <div className="wizard-actions">
              <button className="btn ghost" disabled={finishing} onClick={() => setStep(1)}>
                <ArrowLeft size={16} /> {t('common.back')}
              </button>
              <button className="btn primary" disabled={finishing} onClick={() => void finish()}>
                {finishing ? (
                  <>
                    <Loader2 size={15} className="spin" /> {t('wizard.preparing')}
                  </>
                ) : (
                  <>
                    {t('common.next')} <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {step === 3 && result && (
          <>
            <Sparkles size={40} className="wizard-icon" />
            <h1>{t('wizard.doneTitle')}</h1>
            <p className="wizard-lead">{t('wizard.doneLead')}</p>
            {/* A4:赠送按账号维度只发一次——仅新用户首岛展示;老账号新设备/第二座岛看到余额数字只会误以为又送了一笔 */}
            {grantInfo?.firstIsland && grantInfo.signupGrantMilli > 0 && (
              <div className="wizard-grant-card">
                <div className="wizard-grant-title">
                  {t('wizard.grantTitle', { amount: (grantInfo.signupGrantMilli / 1000).toLocaleString(i18nLang()) })}
                </div>
                <div className="wizard-grant-sub">{t('wizard.grantSub')}</div>
              </div>
            )}
            <button className="btn primary big" onClick={() => onDone(result.boot)}>
              {/* 截图评审(v6):恢复 0.9 之前的收尾文案「岛上见!」——「开始聊天」显得我们是聊天机器人 */}
              {t('wizard.seeYou')} <ArrowRight size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

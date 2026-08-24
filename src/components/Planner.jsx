import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePlanner } from '../state/usePlanner'
import WeekView from './WeekView'
import DayView from './DayView'
import Settings from './Settings'
import Help from './Help'
import Stats from './Stats'
import { LANGS, tr } from '../lib/i18n'
import { useLang } from '../state/LangContext'
import { getHints, setHints, subscribeHints } from '../lib/prefs'
import { dateKey, fromDateKey, weekStart } from '../lib/dates'

const VIEW_KEY = 'weekly-planner:view'

/**
 * 上次停在哪一页，下次打开还回到那儿。
 *
 * 这个 app 一天要开好几次，几乎每次都是直接奔当天那一页去的。
 * 每次都从周视图起步，等于每次都多点一下。
 *
 * 两条限制：
 *   - **只记周视图和日视图。** 设置 / 帮助 / 统计是「去一趟就回来」的地方，
 *     下次打开落在设置页很怪。
 *   - 存的那一天**不在本周就回到今天**。planner 默认装的就是本周，跨周还得
 *     连带把周也挪过去；而隔了一天再打开，想看的本来就是今天，不是昨天。
 */
function initialView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
    if (saved?.name === 'day' && saved.date) {
      const day = fromDateKey(saved.date)
      const sameWeek = dateKey(weekStart(day)) === dateKey(weekStart(new Date()))
      return { name: 'day', date: sameWeek ? day : new Date() }
    }
  } catch {
    // 存坏了、或者隐私模式下读不了，就当没存过
  }
  return { name: 'week' }
}

/** 历史状态里只放得下能序列化的东西，Date 换成 '2026-08-19' 这种字符串。 */
const packView = (v) =>
  v.name === 'day' ? { name: 'day', date: dateKey(v.date) } : { name: v.name }

const unpackView = (v) =>
  v?.name === 'day' && v.date ? { name: 'day', date: fromDateKey(v.date) } : { name: v?.name ?? 'week' }

export default function Planner({ repo, onSignOut }) {
  const planner = usePlanner(repo)
  const [view, setViewState] = useState(initialView)

  /**
   * 安卓的返回手势（屏幕边缘左滑）走的是浏览器历史。
   *
   * 这个 app 从来没往历史里压过东西，于是在日视图上左滑一下**直接退出**，
   * 而人的预期是先回到周视图、再滑一次才走。
   *
   * 只分两层：周视图 = 底层；日视图 / 设置 / 帮助 / 统计 = 上面那一层。
   *
   * 关键是**每次视图变化都自检一遍**，而不是只在挂载时搭一次栈。
   * 上一版就是只在挂载时搭：万一那一下因为时序或设备差异没生效
   * （冷启动、从桌面图标重新拉起、刷新后浏览器恢复 history.state……），
   * 之后再也补不回来，返回手势就一直是直接退出。自检的写法哪一次漏了
   * 下一次就补上。
   */
  const viewRef = useRef(view)
  viewRef.current = view
  /** history.back() 没退成时的兜底，见下面 */
  const backTimer = useRef(null)

  /** 这一次加载有没有搭过历史栈。第一次必须无条件搭，见下面。 */
  const built = useRef(false)

  useEffect(() => {
    const deep = view.name !== 'week'

    if (!built.current) {
      built.current = true
      /**
       * 每次加载都**无条件**把底垫一遍，不去判断「底下是不是已经有一条了」。
       *
       * 判断不出来。history.length 把进 app 之前的条目也算进去，
       * 而刷新之后浏览器会把 state 原样恢复 —— 一条孤零零的历史照样写着
       * pv:day。之前两版都栽在这上面：推测「底下有」，于是不补，
       * 返回手势还是一下退出。
       *
       * 代价是刷新之后周视图那一层可能多出一条：在周视图上要按两次返回
       * 才退出 app。这个方向的错犯得起 —— 反过来（少垫一条）就是
       * 正编辑着一天，手一滑整个 app 没了。
       */
      window.history.replaceState({ pv: { name: 'week' }, idx: 0 }, '')
      if (deep) window.history.pushState({ pv: packView(view), idx: 1 }, '')
      return
    }

    if (!deep) return
    const idx = window.history.state?.idx
    if (idx === 1) {
      // 上层之间换一页（日视图翻天、日视图 -> 设置）。这里要是也 push，
      // 翻几天历史里就堆一摞，得按好几次返回才出得去
      window.history.replaceState({ pv: packView(view), idx: 1 }, '')
    } else {
      window.history.pushState({ pv: packView(view), idx: 1 }, '')
    }
  }, [view])

  useEffect(() => {
    const onPop = (e) => {
      clearTimeout(backTimer.current)
      setViewState(unpackView(e.state?.pv))
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      clearTimeout(backTimer.current)
    }
  }, [])

  const setView = useCallback((next) => {
    if (next.name === 'week' && viewRef.current.name !== 'week') {
      /**
       * 回周视图交给 history.back()，界面由 popstate 统一改 ——
       * 两条路各改一次的话，历史指针和界面迟早对不上。
       *
       * 但 back() 不一定退得成（历史里没有可退的），那样 popstate 不会来、
       * 界面就卡在原地：「‹ 回到周视图」按下去没反应。所以挂个兜底，
       * popstate 先到就把它清掉。
       */
      clearTimeout(backTimer.current)
      backTimer.current = setTimeout(() => setViewState({ name: 'week' }), 150)
      window.history.back()
      return
    }
    setViewState(next)
  }, [])

  // 上次停在哪一页，存起来给下次打开用（见 initialView）
  useEffect(() => {
    try {
      if (view.name === 'week') {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ name: 'week' }))
      } else if (view.name === 'day') {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ name: 'day', date: dateKey(view.date) }))
      }
      // 设置 / 帮助 / 统计不记，见 initialView
    } catch {
      // 存不下就只是这次不记，不影响使用
    }
  }, [view])

  // Ctrl/Cmd + Z 也能撤销
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        planner.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [planner])

  /**
   * 日视图停在的那一天，必须落在 planner 装着的那一周里。
   *
   * 会对不上是因为 planner 自己会挪周：页面挂一夜再切回来，跨过周日的话
   * 它会跟着翻到新的一周（见 usePlanner 的 resync）。日视图不跟着走的话，
   * entries 里全是新那一周的，`e.date === key` 一条都对不上 —— 屏幕上
   * **一片空白，而且不报错**。这时候加一条待办，加是真加上了，只是不在你
   * 正看着的那一天，看起来就像「没加上」。
   *
   * 跟着回到「今天」而不是硬把周挪回去：早上打开 app 想看的本来就是今天。
   */
  useEffect(() => {
    if (view.name !== 'day') return
    if (planner.days.some((d) => dateKey(d) === dateKey(view.date))) return
    setView({ name: 'day', date: new Date() })  // 同一层，setView 里会走 replaceState
    // days 每次渲染都是新数组，用 monday 作为真实依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planner.monday, view])

  return (
    <div className="app">
      <header className="app-bar">
        <span className="brand">Weekly Planner</span>
        {planner.mode === 'mock' && (
          <span className="badge" title={tr('没有配置 .env.local，数据存在浏览器本地')}>{tr('本地模式')}</span>
        )}
        <span className="spacer" />
        {planner.loading && <span className="muted small">{tr('载入中…')}</span>}

        {/* 「统计」是每周都会去的地方，留成文字；设置 / 帮助 / 语言 / 退出
            都是偶尔一次，收进齿轮里 —— 顶栏在 320px 上本来就快挤不下了 */}
        <button className="ghost" onClick={() => setView({ name: 'stats' })}>{tr('统计')}</button>
        <GearMenu setView={setView} onSignOut={onSignOut} />
      </header>

      {planner.error && (
        <div className="error-bar">
          <div className="error-text">
            <span>{planner.error}</span>
            {/* 手机上看不了 console：安卓要开发者模式加一根线，iPhone 要一台 Mac。
                所以技术细节收在这里，出问题截个图就能发过来 */}
            {planner.errorDetail && (
              <details className="error-detail">
                <summary>{tr('详情')}</summary>
                <code>{planner.errorDetail}</code>
              </details>
            )}
          </div>
          <button className="ghost" onClick={planner.clearError} aria-label={tr('关闭')}>
            ✕
          </button>
        </div>
      )}

      <main>
        {view.name === 'week' && (
          <WeekView
            planner={planner}
            onOpenDay={(date) => setView({ name: 'day', date })}
          />
        )}
        {view.name === 'day' && (
          <DayView
            planner={planner}
            date={view.date}
            onBack={() => setView({ name: 'week' })}
            // 换天要连着把周也切过去，否则跨周之后 planner 手里还是上一周的数据
            onGoDay={(next) => {
              planner.goToDate(next)
              setView({ name: 'day', date: next })
            }}
          />
        )}
        {view.name === 'settings' && (
          <Settings planner={planner} onBack={() => setView({ name: 'week' })} />
        )}
        {view.name === 'help' && <Help onBack={() => setView({ name: 'week' })} />}
        {view.name === 'stats' && (
          <Stats planner={planner} onBack={() => setView({ name: 'week' })} />
        )}
      </main>

      {/* 固定在右下角：撤销以前在顶栏，页面一长就得往上滑才找得到 */}
      {planner.canUndo && (
        <button
          className="undo-fab"
          onClick={planner.undo}
          title={`${tr('撤销')}：${planner.undoLabel}`}
          aria-label={`${tr('撤销')}：${planner.undoLabel}`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M9 5 4 10l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 10h9a5.5 5.5 0 0 1 0 11h-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

/**
 * 齿轮菜单。图标比文字省地方，也比「设置」两个字更容易一眼认出来。
 *
 * 用 <details> 而不是自己写一套开合 + 点外面关闭：浏览器原生就管好了
 * 键盘、焦点和 Esc，少写一堆容易出错的代码。
 */
function GearMenu({ setView, onSignOut }) {
  const { lang, setLang } = useLang()
  const hints = useSyncExternalStore(subscribeHints, getHints, getHints)
  const box = useRef(null)
  const close = () => box.current?.removeAttribute('open')

  // 点菜单外面就收起来
  useEffect(() => {
    const onDown = (e) => {
      if (box.current?.hasAttribute('open') && !box.current.contains(e.target)) close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  const go = (name) => {
    close()
    setView({ name })
  }

  return (
    <details className="gear" ref={box}>
      <summary className="ghost gear-btn" title={tr('设置')} aria-label={tr('设置')}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
          />
          <path
            fill="currentColor"
            d="m19.4 13-.1-1 .1-1 1.7-1.3a.7.7 0 0 0 .2-.9l-1.7-2.9a.7.7 0 0 0-.8-.3l-2 .8a7.4 7.4 0 0 0-1.7-1l-.3-2.1a.7.7 0 0 0-.7-.6h-3.4a.7.7 0 0 0-.7.6l-.3 2.1c-.6.2-1.2.6-1.7 1l-2-.8a.7.7 0 0 0-.8.3L2.7 8.8a.7.7 0 0 0 .2.9L4.6 11l-.1 1 .1 1-1.7 1.3a.7.7 0 0 0-.2.9l1.7 2.9c.2.3.5.4.8.3l2-.8c.5.4 1.1.8 1.7 1l.3 2.1c0 .3.4.6.7.6h3.4c.3 0 .6-.3.7-.6l.3-2.1c.6-.2 1.2-.6 1.7-1l2 .8c.3.1.6 0 .8-.3l1.7-2.9a.7.7 0 0 0-.2-.9L19.4 13Zm-1.9 3.5-1.6-.6-.7.6c-.4.3-.9.6-1.4.8l-.9.3-.2 1.7h-1.4l-.2-1.7-.9-.3c-.5-.2-1-.5-1.4-.8l-.7-.6-1.6.6-.7-1.2 1.4-1v-.9l-.1-.9.1-.9v-.9l-1.4-1 .7-1.2 1.6.6.7-.6c.4-.3.9-.6 1.4-.8l.9-.3.2-1.7h1.4l.2 1.7.9.3c.5.2 1 .5 1.4.8l.7.6 1.6-.6.7 1.2-1.4 1v1.8l.1.9-.1.9v.9l1.4 1-.7 1.2Z"
          />
        </svg>
      </summary>
      <div className="gear-menu">
        <button className="gear-item" onClick={() => go('settings')}>{tr('设置')}</button>
        <button className="gear-item" onClick={() => go('help')}>{tr('帮助')}</button>

        <div className="gear-sep" />
        <span className="gear-label">{tr('语言')}</span>
        <div className="gear-row">
          {Object.entries(LANGS).map(([code, label]) => (
            <button
              key={code}
              className={`chip${lang === code ? ' selected' : ''}`}
              onClick={() => setLang(code)}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="gear-label">{tr('操作提示')}</span>
        <div className="gear-row">
          <button className={`chip${hints ? ' selected' : ''}`} onClick={() => setHints(true)}>{tr('开')}</button>
          <button className={`chip${hints ? '' : ' selected'}`} onClick={() => setHints(false)}>{tr('关')}</button>
        </div>

        {onSignOut && (
          <>
            <div className="gear-sep" />
            <button className="gear-item" onClick={onSignOut}>{tr('退出')}</button>
          </>
        )}
      </div>
    </details>
  )
}

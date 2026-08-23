import { useCallback, useEffect, useRef, useState } from 'react'
import { format, isSameDay } from 'date-fns'
import { dateKey, minutesOfDay, weekdayLabel, addDays } from '../lib/dates'
import { layoutBlocks } from '../lib/layout'
import { blockState, describeRange, habitsOfDay, isScheduled, todosOfDay } from '../lib/schedule'
import { anchorFor, capacityOf, findSlot, minutesToIso, placementMinutes } from '../lib/place'
import { describeDuration, formatClock } from '../lib/time'
import { colorOf, makeColorResolver } from '../lib/colors'
import EntryEditor from './EntryEditor'
import ProgressTable from './ProgressTable'
import QuickAdd from './QuickAdd'
import DayBreakdown from './DayBreakdown'
import { useDragBlock } from './useDragBlock'
import { useEmptyPress } from './useEmptyPress'
import { dateFmt, pick, tr } from '../lib/i18n'
import Hint from './Hint'

// 完整 24 小时一次画完，不在卡片里再套滚动
const HOUR_PX = 44
const HOURS = Array.from({ length: 24 }, (_, i) => i)
/** 块矮于这个高度就只显示标题，不显示时间 —— 内容比时间重要。 */
const TIME_VISIBLE_PX = 34

export default function DayView({ planner, date, onBack, onGoDay }) {
  const key = dateKey(date)
  // 正在计时的块要一直长到「现在」，所以每 30 秒重画一次
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  void tick // 只是为了让计时中的块每 30 秒重画一次
  const now = new Date()
  // 「现在」是这一天的第几分钟：看过去的日子时那天已经全部过完了，
  // 看以后的日子时那天一分钟都还没开始
  const nowMinutes = isSameDay(date, now)
    ? now.getHours() * 60 + now.getMinutes()
    : date < now
      ? 24 * 60
      : 0
  const [picked, setPicked] = useState([]) // 选中的块，可多选
  const [editing, setEditing] = useState(null)
  const [quick, setQuick] = useState(null) // 空白处长按：{ field, at }
  const [cascade, setCascade] = useState(true) // 拖一个块，后面的跟着顺延
  const timelineRef = useRef(null)

  /**
   * 打开日视图先滚到有内容的地方。
   *
   * 时间轴是完整 24 小时，不滚的话每次都停在 00:00 —— 一片空白，
   * 每天都要手动往下划到现在几点。今天滚到 now 线，别的日子滚到第一个块。
   * 放在 1/3 高度而不是顶端：上面留一点，看得见「刚才」发生了什么。
   */
  useEffect(() => {
    const el = timelineRef.current
    if (!el) return
    const anchor = el.querySelector('.now-line') ?? el.querySelector('.entry-block')
    if (!anchor) return
    const top = anchor.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3), behavior: 'auto' })
    // 只在换了日子时滚一次 —— 每次数据变化都滚会把人从正在编辑的地方拽走
  }, [key])

  const dayEntries = planner.entries.filter((e) => e.date === key)
  const planned = dayEntries.filter(isScheduled)
  const todos = todosOfDay(dayEntries, key)
  const running = dayEntries.find((e) => e.status === 'in_progress' && e.actual_start)
  const actual = dayEntries.filter((e) => e.actual_start && e.actual_end)
  // 正在计时的那条还没有结束时间，临时按「现在」画出来
  const actualShown = running
    ? [...actual, { ...running, actual_end: now.toISOString() }]
    : actual
  const habits = habitsOfDay(planner.templates, date)
  const special = planner.specialDays.find((s) => s.date === key)
  const resolveColor = makeColorResolver(planner.templates, planner.categories)

  const onlyPicked = picked.length === 1 ? dayEntries.find((e) => e.id === picked[0]) : null

  const isPicked = (id) => picked.includes(id)
  const togglePick = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  /**
   * 双击**自己判**，不用浏览器的 dblclick。
   *
   * 原生 dblclick 在手机上很不稳：两下位置差几像素、中间轻微滚一下、
   * 或者系统正在判断要不要「双击缩放」，它就不发了 —— 表现就是
   * 「双击有时候不管用，要点好几次」。自己按时间判就没这些讲究，
   * 而且鼠标和手指走的是同一套逻辑。
   *
   * 单击选中同样要等一下再生效：不等的话双击 = 选中又取消选中，
   * 操作条白闪一下，还留个莫名其妙的选中态。
   *
   * 两个阈值**故意设成同一个数**：早于它的第二下算双击，晚于它的算新的一次
   * 单击。设成两个数的话中间那段会既选中又触发双击，谁都说不清发生了什么。
   */
  const DOUBLE_MS = 380
  const clickTimer = useRef(null)
  const lastTap = useRef({ id: null, at: 0 })
  useEffect(() => () => clearTimeout(clickTimer.current), [])

  const onBlockClick = (id, entry, field) => {
    const now = Date.now()
    const twice = lastTap.current.id === id && now - lastTap.current.at < DOUBLE_MS
    clearTimeout(clickTimer.current)
    if (twice) {
      lastTap.current = { id: null, at: 0 }
      if (field === 'actual') undoDone(entry)
      else markDone(entry)
      return
    }
    lastTap.current = { id, at: now }
    clickTimer.current = setTimeout(() => togglePick(id), DOUBLE_MS)
  }

  /** 松手：一次拖动可能动了好几个块，合成一步撤销。 */
  const commitDrag = useCallback(
    (changed, mode) => {
      const updates = changed.map((m) => {
        if (m.field === 'actual') {
          return {
            id: m.id,
            patch: {
              actual_start: minutesToIso(key, m.startMin),
              actual_end: minutesToIso(key, m.endMin),
            },
          }
        }
        const length = m.endMin - m.startMin
        return {
          id: m.id,
          patch: {
            planned_start: minutesToIso(key, m.startMin),
            planned_end: minutesToIso(key, m.endMin),
            // 手动拉过长短 = 自己定了时长，区间收敛成定值（块随之变实心）
            ...(mode === 'resize'
              ? { min_duration_minutes: length, max_duration_minutes: length }
              : {}),
          },
        }
      })
      const verb = mode === 'resize' ? tr('调整时长') : tr('拖动')
      planner.updateEntries(
        updates,
        changed.length > 1 ? pick(() => `${verb} ${changed.length} 项`, () => `${verb} ${changed.length} items`) : verb,
      )
    },
    [planner, key],
  )

  const drag = useDragBlock({
    hourPx: HOUR_PX,
    onCommit: commitDrag,
    onLongPress: (id, field) =>
      setEditing({
        entry: dayEntries.find((e) => e.id === id),
        focus: field === 'actual' ? 'actual' : 'plan',
      }),
    // 把手上点一下 = 点在块上，走同一套单击/双击
    onTap: (id, field) => {
      const entry = dayEntries.find((e) => e.id === id)
      if (entry) onBlockClick(id, entry, field)
    },
  })

  /** 一次拖动要带动哪些块。 */
  function membersFor(entry, field, mode) {
    const source = field === 'actual' ? actualShown : planned
    const at = (e) => ({
      id: e.id,
      field,
      startMin: minutesOfDay(field === 'actual' ? e.actual_start : e.planned_start),
      endMin:
        minutesOfDay(field === 'actual' ? e.actual_end : e.planned_end) ||
        (minutesOfDay(field === 'actual' ? e.actual_start : e.planned_start) > 0 ? 1440 : 0),
    })
    const self = at(entry)

    // 选了好几个就一起动，被抓住的那个排第一
    const multi = source.filter((e) => isPicked(e.id))
    if (multi.length > 1 && isPicked(entry.id)) {
      return [self, ...multi.filter((e) => e.id !== entry.id).map(at)]
    }
    // 顺延只对计划生效：Actually 是「实际发生了什么」的记录，
    // 改一条不该顺手改掉后面几条已经发生的事。
    if (cascade && mode === 'move' && field === 'planned') {
      const later = source
        .map(at)
        .filter((m) => m.id !== self.id && m.startMin >= self.startMin)
        .sort((a, b) => a.startMin - b.startMin)
      return [self, ...later]
    }
    return [self]
  }

  function markDone(entry) {
    const stamp = new Date().toISOString()
    planner.updateEntry(entry.id, {
      status: 'done',
      actual_start: entry.actual_start ?? entry.planned_start ?? stamp,
      actual_end: entry.actual_end ?? entry.planned_end ?? stamp,
    })
  }

  /** 开始计时 —— 出去玩这类事本来就猜不准时长，不如直接记。 */
  function startTimer(entry) {
    planner.updateEntry(
      entry.id,
      { status: 'in_progress', actual_start: new Date().toISOString(), actual_end: null },
      pick(() => `开始「${entry.title}」`, () => `Start “${entry.title}”`),
    )
  }

  function stopTimer(entry) {
    planner.updateEntry(
      entry.id,
      { status: 'done', actual_end: new Date().toISOString() },
      pick(() => `结束「${entry.title}」`, () => `Stop “${entry.title}”`),
    )
  }

  function undoDone(entry) {
    planner.updateEntry(entry.id, { status: 'planned', actual_start: null, actual_end: null })
  }

  const saveTodo = (id, { pct, note }) =>
    planner.updateEntry(id, {
      completion_pct: pct,
      note,
      status: pct >= 100 ? 'done' : 'planned',
    })

  const saveHabit = (templateId, { pct, note }) =>
    planner.saveHabitLog({ template_id: templateId, date: key, completion_pct: pct, note })

  /**
   * 新加一条默认从几点开始。
   *
   * **不用手指按下去的那个位置。** 24 小时压在 1056px 里，一像素 1.4 分钟，
   * 手机上根本点不准。而绝大多数时候下一件事就是接着上一件做的，
   * 所以默认取**这一栏里最后一件在按压点之前结束的事的结束时间**。
   * 一件都没有就退回按压点（取整到 5 分钟）。
   *
   * 浮层里那个输入框可以随便改，还留了个「按的位置」按钮退回原来的行为。
   */
  function defaultStartFor(field, around) {
    const source = field === 'actual' ? actualShown : planned
    const ends = source
      .map((e) =>
        field === 'actual'
          ? minutesOfDay(e.actual_end) || (minutesOfDay(e.actual_start) > 0 ? 1440 : 0)
          : minutesOfDay(e.planned_end) || (minutesOfDay(e.planned_start) > 0 ? 1440 : 0),
      )
      .filter((m) => m <= around)
    return ends.length ? Math.max(...ends) : Math.round(around / 5) * 5
  }

  const openQuick = useCallback(
    (field, at) => setQuick({ field, at: defaultStartFor(field, at), pressedAt: at }),
    // defaultStartFor 每次渲染都是新的，但它读的是当前这一帧的块，正是要的
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayEntries],
  )

  const empty = useEmptyPress({ hourPx: HOUR_PX, onOpen: openQuick })

  /**
   * 空白处长按之后能选哪些 —— 「这一栏还空着的那些事」：
   * Plan 那栏列还没排时间的，Actually 那栏列还没记过实际的。
   */
  const quickCandidates = (field) =>
    dayEntries.filter(
      (e) =>
        e.status !== 'skipped' &&
        (field === 'actual' ? !(e.actual_start && e.actual_end) : !isScheduled(e)),
    )

  /** 加到哪一栏就写哪一组时间。记进 Actually = 这件事做了。 */
  const quickTimes = (field, at, minutes) => {
    const from = minutesToIso(key, at)
    const to = minutesToIso(key, at + minutes)
    return field === 'actual'
      ? { actual_start: from, actual_end: to, status: 'done', completion_pct: 100 }
      : { planned_start: from, planned_end: to }
  }

  function quickPick(entry, at) {
    const minutes = placementMinutes(entry)
    planner.updateEntry(
      entry.id,
      quickTimes(quick.field, at, minutes),
      pick(() => `${quick.field === 'actual' ? '记下' : '排入'}「${entry.title}」`, () => `${quick.field === 'actual' ? 'Log' : 'Schedule'} “${entry.title}”`),
    )
    setQuick(null)
  }

  /**
   * 自动补全的候选：最近用过的标题，按「用得多 + 用得近」排。
   *
   * 源头收敛比事后清洗有效得多 —— 「去超市」第二次是点选而不是重打，
   * 就不会长出「去趟超市」「超市」这些同义异形的标题来。
   * 顺带把上次的时长和分类也带过来，等于记住了这件事的默认值。
   */
  const recentTitles = () => {
    const seen = new Map()
    for (const e of planner.entries) {
      const t = e.title?.trim()
      if (!t) continue
      const prev = seen.get(t)
      // 和「排入」用同一条链（区间 -> 计划长度 -> 实际长度），
      // 不然自动补全给出来的时长和排进去的时长会是两个数。
      // 兜底传 null：这里是「上次这件事多久」，不知道就该留空，不该编一个 60
      const minutes = placementMinutes(e, null)
      if (!prev) seen.set(t, { title: t, count: 1, last: e.date, minutes, categoryId: e.category_id ?? null })
      else {
        prev.count += 1
        if (e.date > prev.last) {
          prev.last = e.date
          prev.minutes = minutes ?? prev.minutes
          prev.categoryId = e.category_id ?? prev.categoryId
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
  }

  async function quickCreate(title, minutes, at, categoryId = null) {
    const created = planner.addEntry({
      template_id: null,
      date: key,
      title,
      planned_start: null,
      planned_end: null,
      actual_start: null,
      actual_end: null,
      min_duration_minutes: minutes,
      max_duration_minutes: minutes,
      color: null,
      category_id: categoryId,
      keep_in_todo: false,
      note: null,
      status: 'planned',
      completion_pct: null,
      rescheduled_from: null,
      ...quickTimes(quick.field, at, minutes),
    })
    setQuick(null)
    flashNew(await created)
  }

  /** 待办排进时间轴：自动找第一个装得下的空档，装不下也照排、标红。 */
  function placeTodo(entry) {
    const minutes = placementMinutes(entry)
    const at = findSlot(dayEntries, minutes, { anchor: anchorFor(key), nowMin: nowMinutes })
    planner.updateEntry(
      entry.id,
      {
        planned_start: minutesToIso(key, at),
        planned_end: minutesToIso(key, at + minutes),
      },
      pick(() => `排入「${entry.title}」`, () => `Schedule “${entry.title}”`),
    )
  }

  /**
   * 新加的那一条，加完滚过去并且闪一下。
   *
   * 加成功和根本没点上，以前**看起来一模一样**：没有确认，也没有出错。
   * 新加的待办落在页面顶上的 To do 卡里，人却常常正看着下面的时间轴 ——
   * 屏幕上什么都没变，只能再点一次。这里让它自己现身，一眼就知道成没成。
   */
  const [flashId, setFlashId] = useState(null)
  useEffect(() => {
    if (!flashId) return
    const el = document.querySelector(`[data-entry-id="${flashId}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setFlashId(null), 1600)
    return () => clearTimeout(t)
  }, [flashId])

  /** 新建返回的是刚插进去的那几行；改已有的不用闪，改的就是你正看着的那条。 */
  const flashNew = (created) => {
    const id = Array.isArray(created) ? created[0]?.id : created?.id
    if (id) setFlashId(id)
  }

  async function saveEditor(payload) {
    if (editing?.entry) await planner.updateEntry(editing.entry.id, payload)
    else flashNew(await planner.addEntry(payload))
    setEditing(null)
  }

  async function removeEntry(entry) {
    await planner.deleteEntry(entry.id)
    setPicked((p) => p.filter((x) => x !== entry.id))
    setEditing(null)
  }

  // 拖动中的块按临时位置参与冲突判断，松手之前就能看到变红
  const live = (list, field) =>
    list.map((e) => {
      const o = drag.overlay(e.id, field)
      if (!o) return e
      return field === 'actual'
        ? {
            ...e,
            actual_start: minutesToIso(key, o.startMin),
            actual_end: minutesToIso(key, o.endMin),
          }
        : {
            ...e,
            planned_start: minutesToIso(key, o.startMin),
            planned_end: minutesToIso(key, o.endMin),
          }
    })
  const livePlanned = live(planned, 'planned')
  // 占用时段按「已经做完的算实际、还没做的算计划」来 —— 见 place.js/busyIntervals
  const capacity = capacityOf(dayEntries, todos, {
    anchor: anchorFor(key),
    nowMin: nowMinutes,
  })

  const plannedLayout = layoutBlocks(
    planned.map((e) => ({ entry: e, start: e.planned_start, end: e.planned_end })),
  )
  const actualLayout = layoutBlocks(
    actualShown.map((e) => ({ entry: e, start: e.actual_start, end: e.actual_end })),
  )

  const renderBlock = (b, field) => {
    const entry = b.entry
    return (
      <EntryBlock
        key={entry.id}
        block={b}
        field={field}
        state={
          field === 'actual'
            ? 'solid'
            : blockState(livePlanned.find((e) => e.id === entry.id) ?? entry, livePlanned)
        }
        overlay={drag.overlay(entry.id, field)}
        faded={field === 'planned' && (entry.status === 'done' || entry.status === 'skipped')}
        picked={isPicked(entry.id)}
        flash={entry.id === flashId}
        onClick={() => onBlockClick(entry.id, entry, field)}
        color={resolveColor(entry)}
        onGrip={(event, mode) =>
          drag.begin(event, { mode, members: membersFor(entry, field, mode) })
        }
      />
    )
  }

  return (
    <div className="day-view">
      <div className="day-head">
        <div className="row-gap">
          <button className="ghost" onClick={onBack}>{tr('‹ 回到周视图')}</button>
          {/* 前一天 / 后一天：翻一天不用回周视图再点一次 */}
          <button
            className="ghost day-step"
            onClick={() => onGoDay?.(addDays(date, -1))}
            disabled={!onGoDay}
            title={tr('前一天')}
            aria-label={tr('前一天')}
          >
            ‹
          </button>
          <h1>
            {format(date, dateFmt('monthDay'))} <span className="muted">{weekdayLabel(date)}</span>
          </h1>
          <button
            className="ghost day-step"
            onClick={() => onGoDay?.(addDays(date, 1))}
            disabled={!onGoDay}
            title={tr('后一天')}
            aria-label={tr('后一天')}
          >
            ›
          </button>
          {/* 只显示，不在这里编辑 —— 标记特殊日一个月用不到一次，
              却在日视图顶上独占一行。设置页里有完整的增删 */}
          {special && <span className="special-badge">{special.label}</span>}
        </div>
      </div>

      {running && (
        <div className="running-bar">
          <span className="running-dot" />
          <b>{running.title}</b>
          <span className="muted small">{elapsedText(running.actual_start, now)}</span>
          <span className="spacer" />
          {/* 「结束」在中文里一词两用：这里是「停止计时」，
              时间输入框那个是「结束时刻」。英文分得开，所以用不同的 key */}
          <button className="primary" onClick={() => stopTimer(running)}>{tr('结束计时')}</button>
        </div>
      )}

      {picked.length > 0 && (
        <div className="action-bar">
          <span className="selected-title">
            {onlyPicked
              ? onlyPicked.title
              : pick(() => `选中 ${picked.length} 项`, () => `${picked.length} selected`)}
          </span>
          {/* 「拖把手可以一起挪」那句话搬走了：浮条要一行放得下，
              手机上一换行就摞成四层，挡住半个时间轴。这句在时间轴下面的说明里有 */}
          {onlyPicked && (
            <>
              {/* 双击标完成是快捷方式，不是唯一的路。手指点不准的时候
                  （块只有 26px 高），选中之后这里总有一个按钮可以按 */}
              {onlyPicked.status === 'done' ? (
                <button onClick={() => undoDone(onlyPicked)}>{tr('未完成')}</button>
              ) : (
                <button onClick={() => markDone(onlyPicked)}>{tr('完成')}</button>
              )}
              <button onClick={() => setEditing({ entry: onlyPicked })}>{tr('编辑')}</button>
              <button className="danger" onClick={() => removeEntry(onlyPicked)}>{tr('删除')}</button>
            </>
          )}
          <button className="ghost" onClick={() => setPicked([])} title={tr('取消选中')} aria-label={tr('取消选中')}>
            ✕
          </button>
        </div>
      )}

      {/* 顺序：待办 -> 时间轴 -> 习惯 */}
      <ProgressTable
        title="To do"
        onAdd={() => setEditing({ entry: null })}
        rows={todos.map((e) => ({
          id: e.id,
          title: e.title,
          pct: e.completion_pct ?? 0,
          note: e.note,
          duration: describeRange(e),
          keep: e.keep_in_todo,
          scheduled: isScheduled(e),
          color: resolveColor(e),
        }))}
        onSave={saveTodo}
        onOpen={(id) => setEditing({ entry: todos.find((e) => e.id === id) })}
        onPlace={(id) => placeTodo(todos.find((e) => e.id === id))}
        onToggleKeep={(id, keep) =>
          planner.updateEntry(id, { keep_in_todo: keep }, keep ? tr('保留在待办') : tr('排入后移出待办'))
        }
        onStart={(id) => startTimer(todos.find((e) => e.id === id))}
        onStop={(id) => stopTimer(todos.find((e) => e.id === id))}
        runningId={running?.id}
        flashId={flashId}
        footer={capacity.count > 0 ? <Capacity capacity={capacity} /> : null}
        emptyText={tr('今天没有待办。')}
      />

      <section className="card timeline-card">
        <div className="card-head">
          <h2>Time schedule</h2>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
            />{tr('拖一个，后面的跟着顺延')}</label>
        </div>
        <div className="timeline-head">
          <span className="row-gap col-head">
            Plan
            <button
              className="ghost small-btn"
              onClick={() => openQuick('planned', anchorFor(key))}
              title={tr('加一件要做的事')}
            >
              ＋
            </button>
          </span>
          <span />
          <span className="row-gap col-head">
            Actually
            <button
              className="ghost small-btn"
              onClick={() => openQuick('actual', anchorFor(key))}
              title={tr('记一件没排过计划、但确实做了的事')}
            >
              ＋
            </button>
          </span>
        </div>
        <div
          ref={timelineRef}
          className={`timeline${drag.isDragging ? ' dragging' : ''}`}
          style={{ height: 24 * HOUR_PX, '--hour-px': `${HOUR_PX}px` }}
          {...drag.handlers}
          onPointerMove={(e) => {
            drag.handlers.onPointerMove(e)
            empty.move(e)
          }}
          onPointerUp={(e) => {
            drag.handlers.onPointerUp(e)
            empty.cancel()
          }}
          onPointerCancel={(e) => {
            drag.handlers.onPointerCancel(e)
            empty.cancel()
          }}
        >
          {isSameDay(date, now) && (
            <div
              className="now-line"
              style={{ top: (minutesOfDay(now.toISOString()) / 60) * HOUR_PX }}
            />
          )}

          {/* 空白处长按 = 在这儿加一条。落在块上的按压由块自己的把手接管 */}
          <div
            className="timeline-col plan"
            onPointerDown={(e) => empty.begin(e, 'planned')}
          >
            {plannedLayout.map((b) => renderBlock(b, 'planned'))}
            <PressHint hint={empty.hint} field="planned" />
          </div>

          <div className="timeline-axis">
            {HOURS.map((h) => (
              <div className="hour" key={h} style={{ height: HOUR_PX }}>
                <span>{String(h).padStart(2, '0')}</span>
              </div>
            ))}
          </div>

          <div
            className="timeline-col actually"
            onPointerDown={(e) => empty.begin(e, 'actual')}
          >
            {actualLayout.map((b) => renderBlock(b, 'actual'))}
            <PressHint hint={empty.hint} field="actual" />
          </div>
        </div>
        <Hint>
          <b>{tr('长按空白处')}</b>{tr('（或点栏头的 ＋）在那个时间加一条：从今天还没安排的事里挑一件， 或者直接写一件新的。两栏都行 —— 加到右边就是「做了」，加到左边是「打算做」。 拖块左边的竖条挪时间，拖底边改时长。')}<b>{tr('长按块')}</b>{tr('打开编辑 —— 从哪一栏长按，编辑器就把哪一组时间放在最上面（计划是橙的、实际是绿的）， 记实际时间时点开始/结束那一格可以一下填「现在」。单击选中 （可以点好几个一起拖），双击计划块 = 完成、双击右边的块 = 撤销； 选中之后底下那条也有「完成」，点不准时用它。')}<b>{tr('半透明')}</b>{tr('是时长还没定死，')}<b>{tr('红色')}</b>{tr('是撞车。')}</Hint>
      </section>

      {/* 时间轴看的是「什么时候」，这里看的是「一共多久」 —— 同一份数据的
          另一个问题，紧挨着放，滚一下就从时刻表变成总账 */}
      <DayBreakdown
        entries={dayEntries}
        templates={planner.templates}
        categories={planner.categories}
        elapsedMinutes={nowMinutes}
      />

      <ProgressTable
        title="Habits"
        rows={habits.map((h) => {
          const log = planner.habitLogs.find((l) => l.template_id === h.id && l.date === key)
          return {
            id: h.id,
            title: h.title,
            pct: log ? log.completion_pct : null,
            note: log?.note,
            color: h.color,
          }
        })}
        onSave={saveHabit}
        emptyText={tr('今天没有需要打卡的习惯。')}
      />

      {editing && (
        <EntryEditor
          entry={editing.entry}
          actualOnly={editing.actualOnly}
          focus={editing.focus}
          // 只有「今天」的实际时间填「现在」才说得通
          now={isSameDay(date, now) ? nowMinutes : null}
          date={key}
          dayEntries={dayEntries}
          categories={planner.categories}
          templates={planner.templates}
          onSave={saveEditor}
          onDelete={() => removeEntry(editing.entry)}
          onClose={() => setEditing(null)}
        />
      )}

      {quick && (
        <QuickAdd
          field={quick.field}
          at={quick.at}
          pressedAt={quick.pressedAt}
          now={isSameDay(date, now) ? nowMinutes : null}
          candidates={quickCandidates(quick.field)}
          recent={recentTitles()}
          categories={planner.categories}
          resolveColor={resolveColor}
          onPick={quickPick}
          onCreate={quickCreate}
          onClose={() => setQuick(null)}
        />
      )}
    </div>
  )
}

/** 长按空白处时先冒出来的那道线：告诉你这个手势有反应，也标出会加在哪儿。 */
function PressHint({ hint, field }) {
  if (!hint || hint.field !== field) return null
  return (
    <div className="press-hint" style={{ top: (hint.at / 60) * HOUR_PX }}>
      <span>{pick(() => `${formatClock(hint.at)} 起`, () => `from ${formatClock(hint.at)}`)}</span>
    </div>
  )
}

function EntryBlock({
  block,
  color,
  state = 'solid',
  overlay,
  faded,
  picked,
  flash,
  onClick,
  onGrip,
}) {
  const { entry } = block
  // 拖动中用本地的临时时间画，松手才写库
  const startMin = overlay ? overlay.startMin : minutesOfDay(block.start)
  const endMin = overlay
    ? overlay.endMin
    : minutesOfDay(block.end) || (minutesOfDay(block.start) > 0 ? 1440 : 0)
  const height = Math.max(26, ((endMin - startMin) / 60) * HOUR_PX)
  const width = 100 / block.lanes
  const range = describeRange(entry)
  const tint = colorOf(color)

  return (
    <div
      data-entry-id={entry.id}
      className={[
        'entry-block',
        `state-${state}`,
        `status-${entry.status}`,
        faded ? 'faded' : '',
        picked ? 'picked' : '',
        overlay ? 'dragging' : '',
        flash ? 'flash' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        top: (startMin / 60) * HOUR_PX,
        height,
        left: `calc(${block.lane * width}% + 4px)`,
        width: `calc(${width}% - 8px)`,
        // 撞车时统一用红底，颜色让位给警告
        ...(state === 'conflict' ? {} : { background: tint.block, borderColor: tint.edge }),
      }}
    >
      <span
        className="block-grip"
        title={tr('拖我挪时间')}
        onPointerDown={(e) => onGrip(e, 'move')}
      />
      <button className="block-body" onClick={onClick}>
        <span className="entry-title">{entry.title}</span>
        {/* 放不下就只留标题 —— 内容比时间重要 */}
        {height >= TIME_VISIBLE_PX && (
          <span className="entry-time">
            {formatClock(startMin % 1440)}–{formatClock(endMin % 1440)}
            {range && state === 'loose' ? ` · ${range}` : ''}
          </span>
        )}
      </button>
      <span
        className="block-resize"
        title={tr('拖我改时长')}
        onPointerDown={(e) => onGrip(e, 'resize')}
      />
    </div>
  )
}

/**
 * 「装不装得下」—— 纸质 planner 做不到的就是这个加减法。
 * 我觉得这比替你排程更有用：知道差多少，人自己两秒就决定砍哪个。
 */
function Capacity({ capacity }) {
  const { free, min, max, count, fits, short } = capacity
  return (
    <p className={`capacity${fits ? '' : ' over'}`}>
      {tr('剩下的时间还空着')}
      <b>{describeDuration(free)}</b>
      {pick(() => `；还没排的 ${count} 件待办需要 `, () => `; ${count} unscheduled to-dos need `)}
      <b>{min === max ? describeDuration(max) : `${describeDuration(min)} – ${describeDuration(max)}`}</b>
      {' — '}
      {fits ? (
        tr('装得下。')
      ) : (
        <b>
          {pick(
            () => `差 ${describeDuration(short)}，得砍一件或者压缩一下。`,
            () => `${describeDuration(short)} short — drop one or shorten something.`,
          )}
        </b>
      )}
    </p>
  )
}

/** 刚点开始的时候别说「已经 1 分钟」。 */
function elapsedText(startIso, now) {
  const mins = Math.floor((now - new Date(startIso)) / 60000)
  return mins < 1 ? tr('刚开始') : pick(() => `已经 ${describeDuration(mins)}`, () => `${describeDuration(mins)} so far`)
}

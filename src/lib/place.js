import { combineDateTime, minutesOfDay } from './dates'
import { isScheduled } from './schedule'
import { formatClock } from './time'

const DAY_END = 24 * 60
/** 别的日子从早上 8 点开始找；今天从「现在」开始找。 */
const DEFAULT_ANCHOR = 8 * 60
/** 起始时间取整到 5 分钟，免得排出 14:07 这种。 */
const STEP = 5

const roundUp = (m) => Math.ceil(m / STEP) * STEP

/** 两个时刻之间几分钟；缺一个就返回 0。 */
const spanMinutes = (from, to) =>
  from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000)) : 0

/**
 * 一条待办排进时间轴时占多长。
 *
 * 按这个顺序问：
 *   1. 填过时长区间吗 —— 填了就按上限，宁可留富余
 *   2. 计划里排了多长 —— 模板写 07:00–07:30 生成出来就是半小时
 *   3. 实际做了多长
 *   4. 都没有，才用 60 分钟兜底
 *
 * 第 2 条是补上的。以前只看区间，而模板只填起止时间、不填区间是很常见的
 * 写法（「洗澡 07:00–07:30」），生成的条目 min/max 都是 null ——
 * 于是计划里明明是 30 分钟，长按加进去却变成 60 分钟。
 * 计划的长度本来就是「这件事要多久」最直接的答案，不该跳过它去用兜底值。
 */
export function placementMinutes(entry, fallback = 60) {
  const range = entry.max_duration_minutes ?? entry.min_duration_minutes
  if (range != null) return range
  return (
    spanMinutes(entry.planned_start, entry.planned_end) ||
    spanMinutes(entry.actual_start, entry.actual_end) ||
    fallback
  )
}

/**
 * 这一天真正被占掉的时段 —— 计算空闲和自动排入都用这一份。
 *
 * 不能一刀切成「按实际算」：**未来根本没有实际**。今天下午三点的时候，
 * 晚上八点那件事只有计划、没有实际，忽略计划等于假装晚上是空的。
 * 所以两者各管一段，按条目的状态分：
 *
 *   做完了（有实际起止）→ 占**实际**那一段，计划那段就此让出来
 *                          （计划 21:00 读书、实际下午三点读完了，
 *                           那 21:00–22:00 现在是空的，本来就该能再排事）
 *   正在做（in_progress）→ 从实际开始到 max(现在, 计划结束)
 *                          —— 超时了就按已经拖到的时间算，还没到点就按计划算
 *   跳过了（skipped）    → 不占时间，让出来
 *   还没做              → 占**计划**那一段，这是唯一的依据
 *
 * @param nowMin 「现在」是当天的第几分钟；别的日子传锚点就行
 * @returns 按起点排好序的 {from,to}
 */
export function busyIntervals(dayEntries, { nowMin = DEFAULT_ANCHOR } = {}) {
  const spans = []
  for (const e of dayEntries) {
    if (e.status === 'skipped') continue

    if (e.actual_start && e.actual_end) {
      spans.push({ from: minutesOfDay(e.actual_start), to: endMinute(e.actual_end) })
      continue
    }
    if (e.status === 'in_progress' && e.actual_start) {
      const from = minutesOfDay(e.actual_start)
      const planEnd = e.planned_end ? endMinute(e.planned_end) : 0
      spans.push({ from, to: Math.max(nowMin, planEnd, from + 5) })
      continue
    }
    if (isScheduled(e)) {
      spans.push({ from: minutesOfDay(e.planned_start), to: endMinute(e.planned_end) })
    }
  }
  return spans.sort((a, b) => a.from - b.from)
}

/** 结束在第二天 0 点的算 24:00，不然会缩成 0 把整天都算成空的。 */
const endMinute = (iso) => minutesOfDay(iso) || DAY_END

/**
 * 找当天第一个塞得下 minutes 的空档。
 *
 * 「之后的顺序加入」是自动的：上一条排进去之后就成了占用时段，
 * 下一条自然只能落在它后面。
 *
 * 塞不下也照样给个位置（接在最后一个块后面，哪怕过了 24 点）——
 * 拒绝排入只会逼人去别处手动填时间。排上去、标红、自己拖，比拒绝有用。
 *
 * @returns 起始分钟数，永远不为 null
 */
export function findSlot(dayEntries, minutes, { anchor = DEFAULT_ANCHOR, nowMin } = {}) {
  if (!minutes || minutes <= 0) minutes = 60

  const busy = busyIntervals(dayEntries, { nowMin: nowMin ?? anchor })

  let cursor = roundUp(Math.max(0, anchor))
  for (const block of busy) {
    if (block.to <= cursor) continue
    if (block.from - cursor >= minutes) return cursor // 这个缝够大
    cursor = Math.max(cursor, roundUp(block.to))
  }
  return cursor
}

/** 今天的话从现在开始找，其它日子从默认锚点开始。 */
export function anchorFor(dateKey, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return dateKey === today
    ? Math.max(DEFAULT_ANCHOR - 24 * 60, now.getHours() * 60 + now.getMinutes())
    : DEFAULT_ANCHOR
}

/** 某天的第 n 分钟 -> ISO。超过 24 点算到第二天，拖过午夜也存得下。 */
export function minutesToIso(key, minutes) {
  const within = ((minutes % 1440) + 1440) % 1440
  const d = new Date(combineDateTime(key, formatClock(within)))
  d.setDate(d.getDate() + Math.floor(minutes / 1440))
  return d.toISOString()
}

/**
 * 「装不装得下」—— 纸质 planner 唯一做不到的事就是加减法。
 *
 * 空闲时间从 anchor（今天就是「现在」）算到当天结束，扣掉 busyIntervals 里的时段；
 * 需要的时间是还没排进时间轴、也还没做完的待办的时长合计（区间就给出上下限）。
 *
 * 和 findSlot 共用同一份占用时段是有意的：不然会出现「说还剩两小时、
 * 一点排入却塞不进去」这种自相矛盾。
 */
export function capacityOf(dayEntries, todos, { anchor = DEFAULT_ANCHOR, nowMin } = {}) {
  const busy = busyIntervals(dayEntries, { nowMin: nowMin ?? anchor })

  let free = 0
  let cursor = Math.max(0, Math.min(anchor, DAY_END))
  for (const b of busy) {
    if (b.to <= cursor) continue
    if (b.from > cursor) free += Math.min(b.from, DAY_END) - cursor
    cursor = Math.max(cursor, b.to)
    if (cursor >= DAY_END) break
  }
  free += Math.max(0, DAY_END - cursor)

  // 已经做完的不再算进「还需要多少时间」—— 勾了「留在待办」的做完了也还在列表里
  const pending = todos.filter(
    (t) =>
      !isScheduled(t) &&
      t.status !== 'done' &&
      t.status !== 'skipped' &&
      !(t.actual_start && t.actual_end) &&
      (t.completion_pct ?? 0) < 100,
  )
  // 下限用同一条链，只是区间取下限 —— 两处各写一份迟早会走岔
  const min = pending.reduce(
    (sum, t) =>
      sum +
      (t.min_duration_minutes ?? t.max_duration_minutes ?? placementMinutes(t)),
    0,
  )
  const max = pending.reduce((sum, t) => sum + placementMinutes(t), 0)

  return { free, min, max, count: pending.length, fits: max <= free, short: max - free }
}

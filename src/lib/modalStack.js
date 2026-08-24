/**
 * 现在开着的弹窗，后开的在后面。
 *
 * 为的是安卓的返回手势：开着弹窗时先关弹窗，再滑一次才回周视图。
 * 浏览器里拦不到「返回被按了」这个事件，只能在 popstate 里回过头来处理
 * （见 Planner），而弹窗的开关状态散在 DayView / Settings 各自的 state 里，
 * 所以在这儿摆个共用的登记处，让 Planner 够得着。
 */
const open = []

export const hasOpenModal = () => open.length > 0

/** 弹窗挂上时登记，返回值是注销函数，直接给 useEffect 当 cleanup。 */
export function pushModal(close) {
  open.push(close)
  return () => {
    const i = open.indexOf(close)
    if (i >= 0) open.splice(i, 1)
  }
}

/**
 * 关掉最上面那个。这里只管调它的 onClose，**不从数组里摘** ——
 * 摘的活儿统一交给上面那个 cleanup，免得一条命两处销。
 */
export function closeTopModal() {
  const close = open[open.length - 1]
  if (!close) return false
  close()
  return true
}

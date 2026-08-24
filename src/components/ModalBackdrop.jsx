import { useEffect, useRef } from 'react'
import { pushModal } from '../lib/modalStack'

/**
 * 弹窗后面那层灰底：点它才关。
 *
 * **按下和松开必须都落在灰底上**才算「点了外面」。只看 click 会出事：
 * 长按空白处开出来的浮层，手指这时候还按在屏幕上，抬起那一下的 click
 * 正好落在刚冒出来的灰底上 —— 浮层自己把自己关掉，人还以为是没点中。
 *
 * 原来靠「开出来 350ms 之内不理会点击」挡这个，可按多久是人说了算：
 * 长按 520ms 才开浮层，再按满 900ms 松手，那 350ms 早过完了，照样关。
 * 量过：松手时机落在 520–870ms 之间才活得下来，再久一点就白按一次。
 * 「长按之后点待办没加上，第二次才行」就是这么来的 —— 第二次因为知道
 * 浮层出得快，手松得也早。
 *
 * 按 pointerdown 判就和按多久无关了：那一下 down 落在时间轴上、不在灰底上，
 * 所以这一次 click 不算数。
 */
export default function ModalBackdrop({ onClose, children }) {
  const downOnSelf = useRef(false)

  // 安卓返回手势先关弹窗，不要一下跳回周视图（见 lib/modalStack、Planner）
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => pushModal(() => close.current()), [])

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        downOnSelf.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        // target === currentTarget：点在弹窗里面的不算，冒泡上来也不关
        if (e.target === e.currentTarget && downOnSelf.current) onClose()
        downOnSelf.current = false
      }}
    >
      {children}
    </div>
  )
}

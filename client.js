// 围棋道场 · 浏览器半边
// 侧栏加「围棋道场」入口；主区域是 /go-dojo/ 的闯关 SPA（iframe）。
// 明暗跟随 dsh 主题，切换时把配色发给页面。
//
// 注意：这个文件直接调 window.__ModuleLoader__.load，不要再被 build banner 包一层，
// 否则同一个 id 会注册两次（宿主会报 duplicate factory registration）。
window.__ModuleLoader__.load({
  id: 'dsh-go-dojo',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'go-dojo'
    const LABEL = '围棋道场'
    const SRC = '/go-dojo/'

    // 画框 + 调色点：和 icon.svg 同一枚徽标（黑白双子）
    function GoIcon(props) {
      const s = (props && props.size) || 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round'
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }),
        h('circle', { cx: 9.2, cy: 9.2, r: 3.4, fill: 'currentColor' }),
        h('circle', { cx: 15.6, cy: 15.6, r: 3.4 }))
    }

    function apply(ctx) {
      const frames = new Set()
      let scheme = null

      const post = (frame, payload) => {
        try { if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, location.origin) } catch { /* 跨域/已卸载 */ }
      }
      const pushScheme = () => {
        if (scheme) for (const frame of frames) post(frame, { type: 'go-dojo:scheme', scheme })
      }

      // 主题：有 theme 服务就跟随，没有（老宿主/无主题）就用页面自己的默认
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['theme'], (c) => {
            const push = (snap) => {
              try { scheme = snap.active.colorScheme } catch { scheme = null }
              pushScheme()
            }
            try { push(c.theme.getTheme()) } catch { /* ignore */ }
            c.on('theme/change', push)
          })
        }
      } catch { /* ignore */ }

      function DojoPanel() {
        const ref = React.useRef ? React.useRef(null) : { current: null }
        const wrapRef = React.useRef ? React.useRef(null) : { current: null }
        const sizeRef = React.useRef({ width: 0, height: 0 })
        const [, forceRender] = React.useState ? React.useState(0) : [0, () => {}]

        // 主区域容器在部分宿主布局里是 100vw（比可见区域宽），iframe 用 width:100%
        // 就会把 SPA 撑到屏幕外：右侧被裁、右上角的设置按钮点不到。
        // 这里按「可见视口 − 容器左偏移」算死像素尺寸，保证 SPA 视口就是用户看到的区域。
        React.useEffect(() => {
          const measure = () => {
            const el = wrapRef.current
            if (!el) return
            try {
              const rect = el.getBoundingClientRect()
              const doc = document.documentElement
              const vw = doc.clientWidth || window.innerWidth
              const vh = doc.clientHeight || window.innerHeight
              const width = Math.max(320, Math.floor(vw - Math.max(0, rect.left)))
              const height = Math.max(240, Math.floor(vh - Math.max(0, rect.top)))
              const prev = sizeRef.current
              if (prev.width === width && prev.height === height) return
              sizeRef.current = { width, height }
              forceRender((n) => n + 1)
            } catch { /* 量不到就退回 100% */ }
          }
          measure()
          const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
          if (ro) {
            try { ro.observe(document.documentElement) } catch { /* ignore */ }
            if (wrapRef.current) { try { ro.observe(wrapRef.current) } catch { /* ignore */ } }
          }
          window.addEventListener('resize', measure)
          return () => {
            window.removeEventListener('resize', measure)
            if (ro) ro.disconnect()
          }
        }, [])

        React.useEffect(() => {
          const self = ref.current
          if (self) frames.add(self)
          pushScheme()
          return () => { frames.delete(self) }
        }, [])

        const measured = sizeRef.current

        return h('div', {
          ref: wrapRef,
          style: { width: '100%', height: '100%', overflow: 'hidden', display: 'block' }
        },
          h('iframe', {
            ref,
            src: SRC,
            title: LABEL,
            allow: 'clipboard-write',
            onLoad: (e) => { pushScheme(); post(e.currentTarget, { type: 'go-dojo:scheme', scheme }) },
            style: {
              width: measured.width ? `${measured.width}px` : '100%',
              height: measured.height ? `${measured.height}px` : '100%',
              maxWidth: '100%',
              maxHeight: '100%',
              border: 0,
              display: 'block',
              background: 'transparent'
            }
          }))
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 9, label: () => LABEL }, GoIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, DojoPanel))
    }

    return { inject: ['slots'], apply }
  }
})

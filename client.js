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

        React.useEffect(() => {
          const self = ref.current
          if (self) frames.add(self)
          pushScheme()
          return () => { frames.delete(self) }
        }, [])

        return h('iframe', {
          ref,
          src: SRC,
          title: LABEL,
          allow: 'clipboard-write',
          onLoad: (e) => { pushScheme(); post(e.currentTarget, { type: 'go-dojo:scheme', scheme }) },
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 9, label: () => LABEL }, GoIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, DojoPanel))
    }

    return { inject: ['slots'], apply }
  }
})

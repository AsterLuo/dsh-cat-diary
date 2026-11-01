/**
 * `dsh-cat-diary` — 浏览器半区：侧边栏「日记 / 好感度」面板。
 *
 * 它只读两样东西，而且都来自本机 Host 路由：
 *   `/dsh-cat-diary/affinity/overview`  好感度概览（分数、区间序列、最近变化）
 *   `/dsh-cat-diary/diary/day?day=…`    某一天的日记正文（服务端只放最近 7 天）
 *
 * 这里**没有任何写操作**：面板不会改分，也不会生成日记。改分只有裁判一条路，
 * 生成日记只有 CLI / 宿主定时一条路。读页面必须是完全无副作用的。
 *
 * 形态沿用 Web 客户端的模块协议（`window.__ModuleLoader__.load` + react.createElement），
 * 没有 JSX、没有构建步骤，和随包发布的插件保持一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cat-diary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** 侧边栏页签身份（全局唯一）。 */
    const TAB_ID = 'dsh-cat-diary:diary'
    /** 页签种类，用来打开面板。 */
    const TAB_KIND = 'cat-diary'
    /** 概览路由，必须与 lib/route.js 的 OVERVIEW_ROUTE 一致。 */
    const OVERVIEW_ROUTE = '/dsh-cat-diary/affinity/overview'
    /** 日记正文路由。 */
    const DIARY_ROUTE = '/dsh-cat-diary/diary/day'

    /** 只打一次样式表；重复注入会让样式表数量无限增长。 */
    let stylesInstalled = false
    function installStyles () {
      if (stylesInstalled) return
      stylesInstalled = true
      if (typeof document === 'undefined') return
      const element = document.createElement('style')
      element.setAttribute('data-plugin', 'dsh-cat-diary')
      element.textContent = `
        :root { }
        /* ================= 骨架 ================= */
        .cd-panel {
          display: flex; flex-direction: column; height: 100%; min-height: 0;
          font-size: 13px; color: var(--dsw-alias-label-primary, inherit);
        }
        .cd-scroll { overflow: auto; padding: 0 0 22px; flex: 1 1 auto; min-height: 0; }
        .cd-scroll::-webkit-scrollbar { width: 8px; }
        .cd-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, #8883); border-radius: 4px; }
        
        /* ================= 顶栏 ================= */
        .cd-top {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 16px 10px; position: sticky; top: 0; z-index: 2;
          background: var(--dsw-alias-bg-layer-2, transparent);
          backdrop-filter: blur(10px);
        }
        .cd-title { font-weight: 650; font-size: 13.5px; flex: 1 1 auto; letter-spacing: 0.01em; }
        .cd-btn {
          border: 1px solid var(--dsw-alias-border-secondary, #8884);
          background: transparent; color: var(--dsw-alias-label-secondary, inherit);
          border-radius: 8px; padding: 3px 10px; cursor: pointer;
          font-size: 11.5px; line-height: 1.6; transition: background .15s ease, color .15s ease;
        }
        .cd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #8881); color: var(--dsw-alias-label-primary, inherit); }
        .cd-btn[data-busy="1"] { opacity: .55; cursor: default; }
        
        /* ================= 主视觉卡片 ================= */
        .cd-hero {
          margin: 4px 14px 14px; padding: 18px 18px 14px; border-radius: 16px;
          background: var(--dsw-alias-bg-layer-3, #8881);
          border: 1px solid var(--dsw-alias-border-l2, #8882);
          box-shadow: 0 4px 16px -12px rgba(0,0,0,.7);
          position: relative; overflow: hidden;
        }
        .cd-hero::before {
          content: ""; position: absolute; inset: 0;
          background: radial-gradient(120% 140% at 8% 0%,
            var(--dsw-alias-brand-primary, #5b8def) 0%, transparent 58%);
          opacity: .13; pointer-events: none;
        }
        .cd-hero-top { display: flex; align-items: flex-end; gap: 10px; position: relative; }
        .cd-score { font-size: 46px; font-weight: 750; line-height: .92; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
        .cd-score-unit { font-size: 10.5px; font-weight: 500; opacity: .45; margin-bottom: 8px; letter-spacing: .06em; }
        .cd-hero-right { margin-left: auto; text-align: right; }
        .cd-today-delta { font-size: 16px; font-weight: 680; font-variant-numeric: tabular-nums; }
        .cd-today-label { font-size: 10.5px; opacity: .48; margin-top: 3px; letter-spacing: .02em; }
        
        .cd-tone-up { color: var(--dsw-alias-state-success-primary, #2fa86a); }
        .cd-tone-down { color: var(--dsw-alias-state-warn-primary, #d4544f); }
        .cd-tone-flat { color: var(--dsw-alias-label-tertiary, inherit); }
        
        /* ================= 状态挂件 ================= */
        .cd-stage {
          display: flex; align-items: center; gap: 11px;
          margin-top: 15px; padding: 9px 12px 9px 10px;
          border-radius: 12px; position: relative;
          background: var(--dsw-alias-bg-layer-4, rgba(255,255,255,.04));
          border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
        }
        .cd-stage::before {
          content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px;
          border-radius: 0 3px 3px 0; background: var(--cd-stage-tint, #5b8def); opacity: .8;
        }
        .cd-stage[data-tone="warm"] { --cd-stage-tint: #ff9f43; }
        .cd-stage[data-tone="mild"] { --cd-stage-tint: #5b8def; }
        .cd-stage[data-tone="neutral"] { --cd-stage-tint: #8d93a1; }
        .cd-stage[data-tone="cool"] { --cd-stage-tint: #5f7089; }
        .cd-stage[data-tone="cold"] { --cd-stage-tint: #6b7f9e; }
        .cd-stage-glyph { position: relative; width: 44px; height: 44px; flex: 0 0 44px; }
        .cd-stage-ring { position: absolute; inset: 0; width: 44px; height: 44px; }
        .cd-stage-ring-bg { fill: none; stroke: var(--dsw-alias-border-l2, rgba(255,255,255,.1)); stroke-width: 2.5; }
        .cd-stage-ring-fg { fill: none; stroke: var(--cd-stage-tint, #5b8def); stroke-width: 2.5; stroke-linecap: round; transition: stroke-dashoffset .6s cubic-bezier(.4,0,.2,1); }
        .cd-stage-emoji { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 19px; line-height: 1; will-change: transform; }
        .cd-stage-text { min-width: 0; flex: 1 1 auto; }
        .cd-stage-label { font-size: 13.5px; font-weight: 650; letter-spacing: .03em; color: var(--dsw-alias-label-primary, inherit); }
        .cd-stage-hint { font-size: 10.5px; margin-top: 2px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); }
        @keyframes cdBeat { 0%,100% { transform: scale(1); } 14% { transform: scale(1.18); } 28% { transform: scale(1); } 42% { transform: scale(1.12); } 56% { transform: scale(1); } }
        @keyframes cdBreathe { 0%,100% { transform: scale(1); opacity: .92; } 50% { transform: scale(1.1); opacity: 1; } }
        @keyframes cdSway { 0%,100% { transform: rotate(-5deg); } 50% { transform: rotate(5deg); } }
        @keyframes cdFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes cdTwinkle { 0%,100% { transform: scale(1); opacity: .85; } 50% { transform: scale(1.14); opacity: 1; } }
        @keyframes cdDrift { 0%,100% { transform: translate(0,0); } 33% { transform: translate(2px,-1px); } 66% { transform: translate(-2px,1px); } }
        @keyframes cdDrip { 0%,100% { transform: translateY(0); opacity: .9; } 60% { transform: translateY(2px); opacity: .7; } }
        @keyframes cdPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        .cd-stage-emoji[data-motion="beat"] { animation: cdBeat 1.6s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="breathe"] { animation: cdBreathe 2.8s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="sway"] { animation: cdSway 3.2s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="float"] { animation: cdFloat 3s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="twinkle"] { animation: cdTwinkle 2.2s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="drift"] { animation: cdDrift 5s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="drip"] { animation: cdDrip 2.6s ease-in-out infinite; }
        .cd-stage-emoji[data-motion="pulse"] { animation: cdPulse 3.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .cd-stage-emoji { animation: none !important; } }
        .cd-usage-wrap { margin-top: 15px; position: relative; }
        .cd-usage-head { display: flex; justify-content: space-between; font-size: 10.5px; opacity: .55; margin-bottom: 6px; }
        .cd-usage { height: 6px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-border-l2, #8883); }
        .cd-usage > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #5b8def); opacity: .85; transition: width .4s cubic-bezier(.4,0,.2,1); }
        
        /* ================= 分段控件 ================= */
        .cd-seg {
          display: inline-flex; gap: 2px; margin: 0 14px 12px; padding: 3px; border-radius: 10px;
          background: var(--dsw-alias-bg-layer-3, #8881);
          border: 1px solid var(--dsw-alias-border-l2, #8882);
        }
        .cd-seg-btn {
          border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit);
          border-radius: 7px; padding: 4px 14px; font-size: 11.5px; cursor: pointer;
          transition: background .15s ease, color .15s ease;
        }
        .cd-seg-btn[data-on="1"] {
          background: var(--dsw-alias-interactive-bg-active, #8882);
          color: var(--dsw-alias-label-primary, inherit); font-weight: 600;
        }
        
        /* ================= 卡片 ================= */
        .cd-card {
          margin: 0 14px 12px; padding: 14px 14px 12px; border-radius: 14px;
          background: var(--dsw-alias-bg-layer-3, #8881);
          border: 1px solid var(--dsw-alias-border-l2, #8882);
        }
        .cd-card-title {
          display: flex; align-items: center; gap: 7px;
          font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
          color: var(--dsw-alias-label-secondary, inherit); margin-bottom: 11px;
        }
        .cd-card-title::before {
          content: ""; width: 3px; height: 11px; border-radius: 2px;
          background: var(--dsw-alias-brand-primary, #5b8def); flex: 0 0 auto;
        }
        .cd-card-extra { margin-left: auto; font-size: 10.5px; opacity: .45; font-weight: 400; letter-spacing: 0; }
        
        /* ================= 图表 ================= */
        .cd-chart { display: block; width: 100%; overflow: visible; }
        .cd-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, inherit); margin-top: 9px; font-variant-numeric: tabular-nums; }
        .cd-legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
        
        /* ================= 变化条目 ================= */
        .cd-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-top: 1px solid var(--dsw-alias-border-l2, #8882); }
        .cd-row:first-child { border-top: 0; padding-top: 1px; }
        .cd-row-badge { flex: 0 0 auto; min-width: 48px; text-align: center; font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; padding: 2px 6px; border-radius: 6px; }
        .cd-row-badge.up { color: var(--dsw-alias-state-success-primary, #2fa86a); background: var(--dsw-alias-state-success-tertiary, rgba(47,168,106,.14)); }
        .cd-row-badge.down { color: var(--dsw-alias-state-warn-primary, #d4544f); background: var(--dsw-alias-state-warn-tertiary, rgba(212,84,79,.14)); }
        .cd-row-main { flex: 1 1 auto; min-width: 0; }
        .cd-row-reason { font-size: 12px; line-height: 1.5; word-break: break-word; }
        .cd-row-meta { font-size: 10.5px; opacity: .45; margin-top: 3px; font-variant-numeric: tabular-nums; }
        

        /* ================= 走势图 ================= */
        .cd-wrap { width: 100%; }
        .cd-chart-line { display: block; width: 100%; overflow: visible; }
        .cd-grid-line { stroke: var(--dsw-alias-border-l2, #8882); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: .55; }
        .cd-grid-base { stroke: var(--dsw-alias-border-l2, #8883); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: .9; }
        .cd-axis-text {
          fill: var(--dsw-alias-label-tertiary, currentColor);
          font-size: 9.5px; font-family: inherit; font-variant-numeric: tabular-nums;
          letter-spacing: .01em;
        }
        .cd-area { fill: url(#cdAreaGrad); stroke: none; }
        .cd-axis-month {
          fill: var(--dsw-alias-label-tertiary, currentColor);
          font-size: 9px; font-family: inherit;
          opacity: .8; letter-spacing: .02em;
        }
        .cd-grad-top { stop-color: var(--dsw-alias-brand-primary, #5b8def); stop-opacity: .38; }
        .cd-grad-bottom { stop-color: var(--dsw-alias-brand-primary, #5b8def); stop-opacity: .02; }
        .cd-line {
          fill: none; stroke: var(--dsw-alias-brand-primary, #5b8def);
          stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round;
          vector-effect: non-scaling-stroke;
        }
        .cd-dot {
          fill: var(--dsw-alias-bg-layer-3, #fff);
          stroke: var(--dsw-alias-brand-primary, #5b8def);
          stroke-width: 2; vector-effect: non-scaling-stroke;
        }
        .cd-dot[data-hover="1"] { fill: var(--dsw-alias-brand-primary, #5b8def); stroke: var(--dsw-alias-bg-layer-3, #fff); }
        .cd-dot-halo { fill: var(--dsw-alias-brand-primary, #5b8def); opacity: .18; }
        .cd-cursor-line {
          stroke: var(--dsw-alias-label-tertiary, currentColor);
          stroke-width: 1; stroke-dasharray: 3 3; opacity: .5;
          vector-effect: non-scaling-stroke;
        }
        .cd-tooltip-bg {
          fill: var(--dsw-alias-bg-layer-4, #1e1e22);
          stroke: var(--dsw-alias-border-l2, #8883); stroke-width: 1;
        }
        .cd-tooltip-score {
          fill: var(--dsw-alias-label-primary, currentColor);
          font-size: 15px; font-weight: 700; font-family: inherit;
          font-variant-numeric: tabular-nums;
        }
        .cd-tooltip-date {
          fill: var(--dsw-alias-label-tertiary, currentColor);
          font-size: 9.5px; font-family: inherit; font-variant-numeric: tabular-nums;
        }
        /* ================= 并排布局 ================= */
        /*
         * 走势图要横向空间，占整行；柱状图和变化流水都偏窄，正好并排。
         * 用 minmax(0,1fr) 而不是 1fr：grid 的 1fr 默认最小宽度是 auto，
         * 内容一长就会把列撑开、溢出容器；minmax(0,1fr) 允许收缩。
         */
        .cd-split {
          display: grid;
          grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
          gap: 12px;
          margin: 0 14px 12px;
          align-items: stretch;
        }
        /* 并排时卡片自己不再带外边距——间距由 grid 的 gap 统一管 */
        .cd-split > .cd-card { margin: 0; display: flex; flex-direction: column; min-height: 0; }

        .cd-card-split { padding: 12px 12px 10px; }
        .cd-card-split .cd-card-title { margin-bottom: 8px; }
        /* 侧边栏被拖窄时退回单列堆叠，避免两栏都挤到看不清 */
        @media (max-width: 380px) {
          .cd-split { grid-template-columns: minmax(0, 1fr); }
        }

        /* ================= 波浪曲线（每日加减） ================= */
        /* ================= 波浪曲线（每日加减） ================= */
        /* 波形区撑满卡片剩余空间并垂直居中；日期轴是 HTML，永远贴底 */
        .cd-wave-box {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
        }
        .cd-wave-plot {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
        }
        .cd-chart-wave { display: block; width: 100%; }
        .cd-wave-axis-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          padding-top: 6px;
          margin-top: auto;
          border-top: 1px solid var(--dsw-alias-border-l2, #8882);
          flex: 0 0 auto;
        }
        .cd-wave-tick {
          flex: 1 1 0;
          text-align: center;
          font-size: 9.5px;
          font-family: inherit;
          font-variant-numeric: tabular-nums;
          color: var(--dsw-alias-label-tertiary, currentColor);
          white-space: nowrap;
        }
        .cd-wave-tick[data-on="1"] {
          color: var(--dsw-alias-label-primary, currentColor);
          font-weight: 600;
        }
        .cd-wave-tick-empty { flex: 1 1 0; }
        .cd-wave-axis {
          stroke: var(--dsw-alias-border-l2, #8884);
          stroke-width: 1;
          stroke-dasharray: 3 3;
          vector-effect: non-scaling-stroke;
        }
        .cd-wave-up-top { stop-color: var(--dsw-alias-state-success-primary, #2fa86a); stop-opacity: .42; }
        .cd-wave-up-bottom { stop-color: var(--dsw-alias-state-success-primary, #2fa86a); stop-opacity: .02; }
        .cd-wave-down-top { stop-color: var(--dsw-alias-state-warn-primary, #d4544f); stop-opacity: .02; }
        .cd-wave-down-bottom { stop-color: var(--dsw-alias-state-warn-primary, #d4544f); stop-opacity: .42; }
        .cd-wave-area-up { fill: url(#cdWaveUp); stroke: none; }
        .cd-wave-area-down { fill: url(#cdWaveDown); stroke: none; }
        .cd-wave-line-up {
          fill: none; stroke: var(--dsw-alias-state-success-primary, #2fa86a);
          stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round;
          vector-effect: non-scaling-stroke;
        }
        .cd-wave-line-down {
          fill: none; stroke: var(--dsw-alias-state-warn-primary, #d4544f);
          stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round;
          vector-effect: non-scaling-stroke;
        }
        .cd-wave-dot-up { fill: var(--dsw-alias-state-success-primary, #2fa86a); stroke: none; }
        .cd-wave-dot-down { fill: var(--dsw-alias-state-warn-primary, #d4544f); stroke: none; }
        .cd-bar-tip {
          fill: var(--dsw-alias-label-secondary, currentColor);
          font-size: 9.5px;
          font-family: inherit;
          font-variant-numeric: tabular-nums;
        }

        /* 并排后变化列表变窄，压缩一下留白，免得一条就占满一屏 */
        .cd-split .cd-row { padding: 7px 0; gap: 8px; }
        .cd-split .cd-row-reason { font-size: 11.5px; line-height: 1.45; }
        .cd-split .cd-row-badge { min-width: 40px; font-size: 11px; }
        /* 两栏里内容多时各自滚动，不把整页拉长 */
        .cd-change-scroll {
          max-height: 260px;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .cd-change-scroll::-webkit-scrollbar { width: 5px; }
        .cd-change-scroll::-webkit-scrollbar-thumb {
          background: var(--dsw-alias-border-l2, #8883);
          border-radius: 3px;
        }

        /* ================= 日记 ================= */
        .cd-days { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
        .cd-day {
          border: 1px solid var(--dsw-alias-border-l2, #8882);
          background: transparent; color: var(--dsw-alias-label-secondary, inherit);
          border-radius: 9px; padding: 5px 10px; font-size: 11.5px; cursor: pointer;
          transition: background .15s ease, border-color .15s ease, color .15s ease;
          font-variant-numeric: tabular-nums;
        }
        .cd-day:hover { background: var(--dsw-alias-interactive-bg-hover, #8881); }
        .cd-day[data-on="1"] {
          background: var(--dsw-alias-interactive-bg-active, #8882);
          border-color: var(--dsw-alias-brand-primary, #5b8def);
          color: var(--dsw-alias-label-primary, inherit); font-weight: 650;
        }
        .cd-day[data-missing="1"] { opacity: .38; }
        .cd-diary {
          white-space: pre-wrap; line-height: 1.72; font-size: 12.5px;
          padding: 13px 15px; border-radius: 11px;
          background: var(--dsw-alias-bg-layer-4, #8881);
          border: 1px solid var(--dsw-alias-border-l2, #8882);
          max-height: 460px; overflow: auto;
        }
        .cd-diary::-webkit-scrollbar { width: 6px; }
        .cd-diary::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, #8883); border-radius: 3px; }
        
        /* ================= 空态 / 脚注 ================= */
        .cd-empty { padding: 24px 6px; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, inherit); line-height: 1.75; }
        .cd-foot { margin: 6px 14px 0; padding-top: 11px; border-top: 1px solid var(--dsw-alias-border-l2, #8882); font-size: 10px; line-height: 1.7; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit)); }
        
        /* ================= 加载骨架 ================= */
        .cd-skeleton {
          height: 72px; border-radius: 16px; margin: 4px 14px 14px;
          background: var(--dsw-alias-bg-layer-3, #8881);
          position: relative; overflow: hidden;
        }
        .cd-skeleton::after {
          content: ""; position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-4, #8882), transparent);
          transform: translateX(-100%);
          animation: cd-shimmer 1.5s ease-in-out infinite;
        }
        @keyframes cd-shimmer { 100% { transform: translateX(100%); } }
      `
      document.head.appendChild(element)
    }

    /**
     * 两位数补零。
     * @param {number} value - 数字。
     * @returns {string} 文本。
     */
    const pad = (value) => String(value).padStart(2, '0')

    /**
     * 把毫秒时间戳格式化成 HH:MM。
     * @param {number} at - 时间戳。
     * @returns {string} 文本。
     */
    function clockOf (at) {
      const date = new Date(Number(at) || 0)
      return pad(date.getHours()) + ":" + pad(date.getMinutes())
    }

    /**
     * 带符号的数字文本。
     * @param {number} value - 数字。
     * @returns {string} 文本。
     */
    function signed (value) {
      const number = Number(value) || 0
      return (number > 0 ? "+" : "") + number
    }

    /**
     * 变化方向对应的类名。
     * @param {number} value - 数字。
     * @returns {string} 类名。
     */
    function toneOf (value) {
      const number = Number(value) || 0
      if (number > 0) return "cd-delta-up"
      if (number < 0) return "cd-delta-down"
      return "cd-delta-flat"
    }

    /**
     * 好感度阶段表。
     *
     * 每 20 分一档，从 -100 到 100 共 10 档。这里刻意**不用**"喜欢/讨厌"这种直白
     * 标签——那种词一眼就到底了，读者不会多看一眼。改用带画面的意象：
     * "檐下初逢""暖光常驻"，一眼能想象出场景，也留了点余味。
     *
     * 每档配一个 emoji 作为图形符号，再叠一层 CSS 动画（飘、摇、跳、闪），
     * 让状态自己会动。用 emoji 而不是 GIF 有三个实际理由：
     * 1. 不联网、不带资源，插件包里不用塞图；
     * 2. 跟着系统字体走，明暗主题下都不糊；
     * 3. 缩放时永远清晰，不受位图分辨率限制。
     *
     * min 是闭区间下界，查找时从上往下取第一个命中的档。
     */
    const AFFINITY_STAGES = [
      { min: 80, label: '心之所向', hint: '眼里已经装不下别人了', glyph: '💗', tone: 'warm', motion: 'beat', tint: '#ff5d8f' },
      { min: 60, label: '暖光常驻', hint: '你在，屋子就是亮的', glyph: '🌤️', tone: 'warm', motion: 'breathe', tint: '#ff9f43' },
      { min: 40, label: '檐下初逢', hint: '开始盼着你来了', glyph: '🍃', tone: 'warm', motion: 'sway', tint: '#4ecdc4' },
      { min: 20, label: '渐生默契', hint: '话不用说完也能懂', glyph: '🫧', tone: 'mild', motion: 'float', tint: '#5b8def' },
      { min: 10, label: '偶然相望', hint: '偶尔会多看两眼', glyph: '✨', tone: 'mild', motion: 'twinkle', tint: '#7c8cff' },
      { min: -9, label: '不相熟', hint: '还在互相打量', glyph: '🌸', tone: 'neutral', motion: 'drift', tint: '#8d93a1' },
      { min: -29, label: '隔了层雾', hint: '有些话没再说出口', glyph: '☁️', tone: 'cool', motion: 'drift', tint: '#77839b' },
      { min: -49, label: '话少了', hint: '回话越来越短', glyph: '🌧️', tone: 'cool', motion: 'drip', tint: '#5f7089' },
      { min: -69, label: '避着走', hint: '刻意绕开彼此', glyph: '❄️', tone: 'cold', motion: 'pulse', tint: '#6b7f9e' },
      { min: -100, label: '关上了门', hint: '门锁了，也不再应声', glyph: '🚪', tone: 'cold', motion: 'none', tint: '#7a6f7d' }
    ]

    /**
     * 按分数挑一档。
     * @param {number} score - 当前分。
     * @returns {object} 命中的档位。
     */
    function stageOf (score) {
      const value = Number(score)
      if (!Number.isFinite(value)) return AFFINITY_STAGES[5]
      for (const stage of AFFINITY_STAGES) {
        if (value >= stage.min) return stage
      }
      return AFFINITY_STAGES[AFFINITY_STAGES.length - 1]
    }

    /**
     * 状态挂件：图形符号 + 名称 + 一句话。
     *
     * 图形用 emoji 拼一颗光晕底，外面套一圈跟着分数走的进度弧；
     * 读者不用看数字也知道自己在哪个位置。
     *
     * @param {{score: number}} props - 分数。
     * @returns {object} 元素。
     */
    function StageBadge ({ score }) {
      const stage = stageOf(score)
      const value = Number(score)
      const clamped = Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : 0
      const progress = (clamped + 100) / 200
      const R = 19
      const C = 2 * Math.PI * R
      return h('div', { className: 'cd-stage', 'data-tone': stage.tone },
        h('div', { className: 'cd-stage-glyph' },
          h('svg', { className: 'cd-stage-ring', viewBox: '0 0 44 44' },
            h('circle', { cx: '22', cy: '22', r: String(R), className: 'cd-stage-ring-bg' }),
            h('circle', {
              cx: '22',
              cy: '22',
              r: String(R),
              className: 'cd-stage-ring-fg',
              strokeDasharray: C.toFixed(1) + ' ' + C.toFixed(1),
              strokeDashoffset: (C * (1 - progress)).toFixed(1),
              transform: 'rotate(-90 22 22)'
            })),
          h('span', {
            className: 'cd-stage-emoji',
            'data-motion': stage.motion,
            style: { color: stage.tint }
          }, stage.glyph)),
        h('div', { className: 'cd-stage-text' },
          h('div', { className: 'cd-stage-label' }, stage.label),
          h('div', { className: 'cd-stage-hint' }, stage.hint)))
    }

    /**
     * 刻度步长：优先用圆整的大跨度（20/10/5/2），绝不给个位数。
     *
     * 目标有两个，缺一个就难看：
     * 1. 刻度必须是圆整数——69/72/74 这种"跟着数据走"的刻度看起来像没设计过；
     * 2. 数据要占得住画面——如果为了圆整把 0-100 全画出来，71 分就是一条死平的线。
     *
     * 所以先试大步长，再用"区间跨度不超过数据跨度 4 倍"卡住，避免上面那种情况。
     *
     * @param {number} low - 数据最小值。
     * @param {number} high - 数据最大值。
     * @returns {{step: number, lo: number, hi: number}} 刻度方案。
     */
    function chooseScale (low, high) {
      const span = Math.max(0, high - low)
      // 分数持平时（span=0）也必须有上下界，否则曲线会贴在格线最顶端。
      const effectiveSpan = Math.max(span, 1)

      // 刻度优先用圆整整档（20/10/5/2/1），绝不出现 69/72/74 这种数字。
      //
      // 但三个约束缺一不可，每一个都是实测出来的：
      // 1. 至少 2 格 → 1 格等于没刻度；
      // 2. 最多 6 格 → 太多线比数据还抢眼；
      // 3. **数据必须在格子内部留边**：如果最高点恰好压在顶线、
      //    或最低点正好落在底线，视觉上会像"溢出"或"掉出去了"。
      //    所以要求 lo < 数据最低 且 hi > 数据最高。
      const candidates = [20, 10, 5, 2, 1]
      for (const step of candidates) {
        let lo = Math.floor(low / step) * step
        let hi = Math.ceil(high / step) * step
        // 顶/底贴边：往外再放一格
        if (hi <= high) hi += step
        if (lo >= low) lo -= step
        const intervals = Math.round((hi - lo) / step)
        if (intervals < 2 || intervals > 6) continue
        if ((hi - lo) > effectiveSpan * 8) continue
        return { step, lo, hi }
      }

      // 兜底：贴着数据各留一格，步长也取整
      const step = Math.max(1, Math.ceil(effectiveSpan / 4))
      return {
        step,
        lo: Math.floor(low / step) * step - step,
        hi: Math.ceil(high / step) * step + step
      }
    }

    /**
     * Catmull-Rom 样条转三次贝塞尔，用来画平滑曲线。
     *
     * 为什么不用直线段：好感度是连续的心理状态，不是台阶函数。直线段在等值那天
     * 会呈现一条死平的横线接一个折角，观感很硬；样条让"缓缓升上去"这件事看得见。
     *
     * 控制点用 1/6 张力（标准 Catmull-Rom），并夹在相邻点的取值区间内，
     * 避免曲线冲出数据范围画出一个假的峰。
     *
     * @param {Array<[number, number]>} pts - 真实坐标点。
     * @returns {string} SVG path 的 d 属性。
     */
    function smoothPath (pts) {
      if (pts.length === 0) return ''
      if (pts.length === 1) return 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1)
      if (pts.length === 2) {
        return 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1) +
          ' L' + pts[1][0].toFixed(1) + ' ' + pts[1][1].toFixed(1)
      }
      let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1)
      for (let i = 0; i < pts.length - 1; i += 1) {
        const p0 = pts[i - 1] || pts[i]
        const p1 = pts[i]
        const p2 = pts[i + 1]
        const p3 = pts[i + 2] || p2
        const t = 1 / 6
        let c1y = p1[1] + (p2[1] - p0[1]) * t
        let c2y = p2[1] - (p3[1] - p1[1]) * t
        const lowY = Math.max(p1[1], p2[1])
        const highY = Math.min(p1[1], p2[1])
        c1y = Math.min(lowY, Math.max(highY, c1y))
        c2y = Math.min(lowY, Math.max(highY, c2y))
        const c1x = p1[0] + (p2[0] - p0[0]) * t
        const c2x = p2[0] - (p3[0] - p1[0]) * t
        d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) +
          ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
          ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1)
      }
      return d
    }

    /**
     * 分数走势图。
     *
     * 用平滑样条 + 渐变面积 + 圆整刻度 + 每日日期。
     *
     * 三个曾经的坑：
     * - preserveAspectRatio="none" 会把 **文字** 一起横向拉伸，轴标签会变扁；
     *   改成按实测宽度设 viewBox，1:1 映射就不变形。
     * - 等值时面积会缩成一块方块；现在面积闭合到基线，并给曲线上下留呼吸位。
     * - 只在首/中/尾标日期，读者分不清中间跨了几天；现在每天都标，日期多时斜排。
     *
     * @param {{points: Array<{label: string, value: number|null}>}} props - 数据。
     * @returns {object} 元素。
     */
    function LineChart ({ points }) {
      const rows = Array.isArray(points) ? points : []
      const [hover, setHover] = react.useState(-1)
      const wrapRef = react.useRef(null)
      const [width, setWidth] = react.useState(320)

      react.useEffect(() => {
        const el = wrapRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const measure = () => {
          const next = Math.max(200, Math.round(el.clientWidth || 320))
          setWidth((current) => (Math.abs(current - next) > 1 ? next : current))
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])

      if (rows.length === 0) return h('div', { className: 'cd-empty' }, '暂无数据')

      const values = rows.map((row) => (row.value === null || row.value === undefined ? NaN : Number(row.value)))
      const known = values.filter((value) => Number.isFinite(value))
      if (known.length === 0) {
        return h('div', { className: 'cd-wrap', ref: wrapRef },
          h('div', { className: 'cd-empty' }, '暂无分数记录'))
      }

      const scale = chooseScale(Math.min.apply(null, known), Math.max.apply(null, known))
      const span = Math.max(1, scale.hi - scale.lo)

      const W = Math.max(200, width)
      // 底部留白要容下斜排的日期；天数越多日期越斜、越长，留得越多。
      // 先算留白再算高度——反过来会在初始化前引用它（踩过一次）。
      const bottomRoom = rows.length <= 8 ? 26 : rows.length <= 16 ? 40 : 46
      const H = Math.max(140, 132 + (bottomRoom - 26))
      const M = { top: 16, right: 14, bottom: bottomRoom, left: 36 }
      const iw = Math.max(10, W - M.left - M.right)
      const ih = H - M.top - M.bottom
      const stepX = rows.length === 1 ? 0 : iw / (rows.length - 1)
      const xOf = (index) => M.left + (rows.length === 1 ? iw / 2 : index * stepX)
      const yOf = (value) => M.top + ih - ((value - scale.lo) / span) * ih

      // 网格与刻度：从 lo 到 hi，每 step 一条
      const gridValues = []
      for (let value = scale.lo; value <= scale.hi + 1e-9; value += scale.step) {
        gridValues.push(Math.round(value))
      }

      const grid = gridValues.map((value, index) => h('line', {
        key: 'g' + index,
        x1: M.left,
        y1: yOf(value).toFixed(1),
        x2: W - M.right,
        y2: yOf(value).toFixed(1),
        className: value === scale.lo ? 'cd-grid-base' : 'cd-grid-line'
      }))

      const yLabels = gridValues.map((value, index) => h('text', {
        key: 'y' + index,
        x: M.left - 8,
        y: (yOf(value) + 3.5).toFixed(1),
        className: 'cd-axis-text',
        'data-axis': 'y',
        textAnchor: 'end'
      }, String(value)))

      // 只有真实点才连线；缺失日断开，不硬拉到 0
      const segments = []
      let current = []
      rows.forEach((row, index) => {
        const value = values[index]
        if (Number.isFinite(value)) {
          current.push([xOf(index), yOf(value)])
        } else if (current.length > 0) {
          segments.push(current)
          current = []
        }
      })
      if (current.length > 0) segments.push(current)

      const linePath = segments.map((seg) => smoothPath(seg)).join(' ')

      // 面积：沿曲线走到末点，再垂直落到基线闭合
      const baseY = (M.top + ih).toFixed(1)
      const areaPath = segments.map((seg) => {
        if (seg.length < 2) return ''
        const head = smoothPath(seg)
        const last = seg[seg.length - 1]
        const first = seg[0]
        return ' ' + head +
          ' L' + last[0].toFixed(1) + ' ' + baseY +
          ' L' + first[0].toFixed(1) + ' ' + baseY + ' Z'
      }).join(' ')

      const dots = rows.map((row, index) => {
        const value = values[index]
        if (!Number.isFinite(value)) return null
        const isHover = hover === index
        return h('g', { key: 'd' + index },
          isHover ? h('circle', {
            cx: xOf(index).toFixed(1),
            cy: yOf(value).toFixed(1),
            r: '7',
            className: 'cd-dot-halo'
          }) : null,
          h('circle', {
            cx: xOf(index).toFixed(1),
            cy: yOf(value).toFixed(1),
            r: isHover ? '4.2' : '2.8',
            className: 'cd-dot',
            'data-hover': isHover ? '1' : '0'
          }))
      })

      // 每天都标日期——这是明确要求，不是"尽量"。
      //
      // 30 天挤在侧边栏宽度里，横排必然叠字，所以按密度自动换排法：
      // 稀疏横排 → 中等斜排 → 密集只留日（月写到轴下方说明）。
      // 关键是不丢任何一天：斜排时每个标签仍然各自对应一个点。
      const density = rows.length
      const mode = density <= 8 ? 'flat' : density <= 16 ? 'tilt' : 'compact'
      const tickCount = rows.length
      const slot = tickCount > 1 ? iw / (tickCount - 1) : iw

      // 日期只取"日"部分，月份统一写在轴末端，避免每天重复 MM-。
      const dayOnly = (label) => String(label ?? '').slice(8) || String(label ?? '')
      const monthOf = (label) => String(label ?? '').slice(5, 7)

      const xLabels = rows.map((row, index) => {
        const x = xOf(index)
        const text = dayOnly(row.label)
        const first = index === 0
        const last = index === rows.length - 1
        if (mode === 'flat') {
          // 稀疏场景空间够，直接给完整 MM-DD——省得读者还要去猜月份。
          return h('text', {
            key: 'x' + index,
            x: x.toFixed(1),
            y: H - 9,
            className: 'cd-axis-text',
            'data-axis': 'x',
            textAnchor: first ? 'start' : last ? 'end' : 'middle'
          }, String(row.label ?? '').slice(5))
        }
        // 斜排 / 紧凑：从点正下方出发往右下倒，锚点统一 end 防叠
        return h('text', {
          key: 'x' + index,
          x: x.toFixed(1),
          y: H - (mode === 'tilt' ? 12 : 10),
          className: 'cd-axis-text',
          'data-axis': 'x',
          textAnchor: 'end',
          transform: 'rotate(-45 ' + x.toFixed(1) + ' ' + (H - (mode === 'tilt' ? 12 : 10)) + ')'
        }, text)
      })

      // 紧凑模式下每格只有"日"，月份写在左下角，避免读者不知道是哪个月
      const monthHint = mode === 'compact'
        ? h('text', {
          x: M.left.toFixed(1),
          y: H - 3,
          className: 'cd-axis-month',
          'data-axis': 'month',
          textAnchor: 'start'
        }, monthOf(rows[0].label) + ' 月 → ' + monthOf(rows[rows.length - 1].label) + ' 月')
        : null

      const hotspots = rows.map((row, index) => h('rect', {
        key: 'h' + index,
        x: (xOf(index) - Math.max(4, stepX / 2)).toFixed(1),
        y: M.top,
        width: Math.max(8, stepX).toFixed(1),
        height: ih,
        fill: 'transparent',
        onMouseEnter: () => setHover(index),
        onMouseLeave: () => setHover(-1)
      }))

      // 悬停气泡：突出显示当天分数
      const hovered = hover >= 0 && hover < rows.length ? rows[hover] : null
      const hoverValue = hover >= 0 ? values[hover] : null
      const canTip = hovered !== null && Number.isFinite(hoverValue)
      const tipW = 84
      const tipH = 38
      const tipX = canTip ? Math.min(W - M.right - tipW, Math.max(M.left, xOf(hover) - tipW / 2)) : 0
      const dotY = canTip ? yOf(hoverValue) : 0
      const tipY = Math.max(M.top, dotY - tipH - 12)
      const tooltip = canTip
        ? h('g', { className: 'cd-tooltip' },
          h('line', {
            x1: xOf(hover).toFixed(1),
            y1: String(M.top),
            x2: xOf(hover).toFixed(1),
            y2: (M.top + ih).toFixed(1),
            className: 'cd-cursor-line'
          }),
          h('rect', {
            x: tipX.toFixed(1),
            y: tipY.toFixed(1),
            width: String(tipW),
            height: String(tipH),
            rx: '9',
            className: 'cd-tooltip-bg'
          }),
          h('text', {
            x: (tipX + tipW / 2).toFixed(1),
            y: (tipY + 17).toFixed(1),
            className: 'cd-tooltip-score',
            textAnchor: 'middle'
          }, String(hoverValue)),
          h('text', {
            x: (tipX + tipW / 2).toFixed(1),
            y: (tipY + 30).toFixed(1),
            className: 'cd-tooltip-date',
            textAnchor: 'middle'
          }, String(hovered.label)))
        : null

      return h('div', { className: 'cd-wrap', ref: wrapRef },
        h('svg', {
          className: 'cd-chart cd-chart-line',
          viewBox: '0 0 ' + W + ' ' + H,
          width: '100%',
          height: String(H),
          preserveAspectRatio: 'xMidYMid meet'
        },
          h('defs', null,
            h('linearGradient', { id: 'cdAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', className: 'cd-grad-top' }),
              h('stop', { offset: '100%', className: 'cd-grad-bottom' }))),
          ...grid,
          ...yLabels,
          ...xLabels,
          monthHint,
          areaPath.trim() === '' ? null : h('path', { d: areaPath.trim(), className: 'cd-area' }),
          linePath === '' ? null : h('path', { d: linePath, className: 'cd-line' }),
          ...dots,
          tooltip,
          ...hotspots))
    }

    /**
     * 每日加减：双向波浪曲线。
     *
     * 为什么从柱状图换成曲线：柱子只能表达"这天有多高"，读者还得在心里
     * 逐根比较；曲线把相邻两天连起来，涨落趋势直接看得出来，也更贴合
     * 好感度是连续状态这件事。
     *
     * 结构是**两条对称的波浪**，共用一条零轴：
     * - 轴上方向上的绿色波浪 = 当天加分；
     * - 轴下方向下的红色波浪 = 当天减分；
     * - 两条都做渐变面积，落到轴上收口。
     *
     * 布局上做了一件事：**日期轴挪出 SVG，用 HTML 放在卡片底部**。
     * 原因是 SVG 高度固定，而卡片被网格拉伸后会有多余空间——
     * 日期画在 SVG 里就只能跟着波形浮在半空，下方空一大块。
     * 拆出来之后：波形区 flex 撑满并垂直居中，日期轴永远贴着卡片底边。
     *
     * @param {{points: Array<{label: string, added: number, subtracted: number}>}} props - 数据。
     * @returns {object} 元素。
     */
    function BarChart ({ points }) {
      const rows = Array.isArray(points) ? points : []
      const [hover, setHover] = react.useState(-1)
      const wrapRef = react.useRef(null)
      const [width, setWidth] = react.useState(140)

      react.useEffect(() => {
        const el = wrapRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const measure = () => {
          const next = Math.max(90, Math.round(el.clientWidth || 140))
          setWidth((current) => (Math.abs(current - next) > 1 ? next : current))
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])

      if (rows.length === 0) return h('div', { className: 'cd-empty' }, '暂无数据')

      const peak = Math.max(1, ...rows.map((row) => Math.max(Math.abs(Number(row.added) || 0), Math.abs(Number(row.subtracted) || 0))))
      const W = Math.max(90, width)
      // SVG 不再留日期高度，波形自己占满；日期是 HTML，在 SVG 外面。
      const H = 118
      const M = { top: 8, right: 6, bottom: 8, left: 6 }
      const iw = Math.max(10, W - M.left - M.right)
      const ih = H - M.top - M.bottom
      const mid = M.top + ih / 2
      const slot = iw / Math.max(1, rows.length)
      const xOf = (index) => (rows.length === 1
        ? M.left + iw / 2
        : M.left + (index / (rows.length - 1)) * iw)
      const halfH = ih / 2 - 4

      const upPts = rows.map((row, index) => {
        const value = Number(row.added) || 0
        return [xOf(index), mid - (Math.max(0, value) / peak) * halfH]
      })
      const downPts = rows.map((row, index) => {
        const value = Math.abs(Number(row.subtracted) || 0)
        return [xOf(index), mid + (value / peak) * halfH]
      })

      const upLine = upPts.length >= 2 ? smoothPath(upPts) : ''
      const downLine = downPts.length >= 2 ? smoothPath(downPts) : ''
      const axisY = mid.toFixed(1)
      const areaOf = (pts, line) => {
        if (pts.length < 2 || line === '') return ''
        const first = pts[0]
        const last = pts[pts.length - 1]
        return ' ' + line
          + ' L' + last[0].toFixed(1) + ' ' + axisY
          + ' L' + first[0].toFixed(1) + ' ' + axisY + ' Z'
      }
      const upArea = areaOf(upPts, upLine)
      const downArea = areaOf(downPts, downLine)

      const dots = rows.map((row, index) => {
        const added = Number(row.added) || 0
        const sub = Math.abs(Number(row.subtracted) || 0)
        const isHover = hover === index
        const nodes = []
        if (added > 0) {
          nodes.push(h('circle', {
            key: 'u' + index,
            cx: upPts[index][0].toFixed(1),
            cy: upPts[index][1].toFixed(1),
            r: isHover ? '3.4' : '2.2',
            className: 'cd-wave-dot-up'
          }))
        }
        if (sub > 0) {
          nodes.push(h('circle', {
            key: 'd' + index,
            cx: downPts[index][0].toFixed(1),
            cy: downPts[index][1].toFixed(1),
            r: isHover ? '3.4' : '2.2',
            className: 'cd-wave-dot-down'
          }))
        }
        return nodes
      })

      const hotspots = rows.map((row, index) => {
        const step = rows.length > 1 ? iw / (rows.length - 1) : iw
        return h('rect', {
          key: 'h' + index,
          x: (xOf(index) - step / 2).toFixed(1),
          y: M.top,
          width: step.toFixed(1),
          height: ih,
          fill: 'transparent',
          onMouseEnter: () => setHover(index),
          onMouseLeave: () => setHover(-1)
        })
      })

      const hovered = hover >= 0 && hover < rows.length ? rows[hover] : null
      const tip = hovered
        ? h('text', {
          x: (W / 2).toFixed(1),
          y: '9',
          className: 'cd-bar-tip',
          textAnchor: 'middle'
        }, String(hovered.label ?? '').slice(5)
          + '  +' + (Number(hovered.added) || 0)
          + ' / −' + Math.abs(Number(hovered.subtracted) || 0))
        : null

      // 日期轴：HTML 实现，永远贴卡片底边。
      // 用等分 flex，每格居中；天数多时只显示首末，避免挤成一片。
      const showAll = rows.length <= 10
      const axis = h('div', { className: 'cd-wave-axis-row' },
        ...rows.map((row, index) => {
          const isFirst = index === 0
          const isLast = index === rows.length - 1
          if (!showAll && !isFirst && !isLast) return h('span', { key: 's' + index, className: 'cd-wave-tick-empty' })
          return h('span', {
            key: 's' + index,
            className: 'cd-wave-tick',
            'data-on': hover === index ? '1' : '0',
            onMouseEnter: () => setHover(index),
            onMouseLeave: () => setHover(-1)
          }, String(row.label ?? '').slice(8))
        }))

      return h('div', { className: 'cd-wave-box' },
        h('div', { className: 'cd-wave-plot', ref: wrapRef },
          h('svg', {
            className: 'cd-chart cd-chart-wave',
            viewBox: '0 0 ' + W + ' ' + H,
            width: '100%',
            height: String(H),
            preserveAspectRatio: 'xMidYMid meet'
          },
            h('defs', null,
              h('linearGradient', { id: 'cdWaveUp', x1: '0', y1: '0', x2: '0', y2: '1' },
                h('stop', { offset: '0%', className: 'cd-wave-up-top' }),
                h('stop', { offset: '100%', className: 'cd-wave-up-bottom' })),
              h('linearGradient', { id: 'cdWaveDown', x1: '0', y1: '0', x2: '0', y2: '1' },
                h('stop', { offset: '0%', className: 'cd-wave-down-top' }),
                h('stop', { offset: '100%', className: 'cd-wave-down-bottom' }))),
            h('line', { x1: M.left, y1: axisY, x2: W - M.right, y2: axisY, className: 'cd-wave-axis' }),
            upArea === '' ? null : h('path', { d: upArea.trim(), className: 'cd-wave-area-up' }),
            downArea === '' ? null : h('path', { d: downArea.trim(), className: 'cd-wave-area-down' }),
            upLine === '' ? null : h('path', { d: upLine, className: 'cd-wave-line-up' }),
            downLine === '' ? null : h('path', { d: downLine, className: 'cd-wave-line-down' }),
            ...dots,
            tip,
            ...hotspots)),
        axis)
    }

    /**
     * 挑一个可读的默认日记日：最新的、存在正文的那一天。
     * @param {object[]} days - 概览里的 diaryDays。
     * @returns {string|null} 日键。
     */
    function pickDefaultDay (days) {
      if (!Array.isArray(days)) return null
      for (let index = days.length - 1; index >= 0; index -= 1) {
        if (days[index]?.exists) return days[index].day
      }
      return days.length > 0 ? days[days.length - 1].day : null
    }

    /**
     * 面板主体。
     *
     * 结构上分成四块：主视觉（分数 + 今日 + 额度）→ 区间切换 + 两张图 → 变化流水 → 日记。
     * 每一块都是独立变量，不用把多层三元塞进一个 h() 调用里——
     * 那样括号一多就没法核对，出错只能整段重写（这次已经踩过）。
     *
     * @param {object} props - 无。
     * @returns {object} 元素。
     */
    function DiaryPanel () {
      installStyles()
      const [state, setState] = react.useState({ phase: 'loading', data: null, error: null })
      const [range, setRange] = react.useState('7d')
      const [day, setDay] = react.useState(null)
      const [diary, setDiary] = react.useState({ phase: 'idle', day: null, text: null, error: null })

      const load = react.useCallback(() => {
        setState((current) => ({ phase: current.data === null ? 'loading' : 'refreshing', data: current.data, error: null }))
        fetch(OVERVIEW_ROUTE, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then((data) => {
            setState({ phase: 'ready', data, error: null })
            setDay((current) => current ?? pickDefaultDay(data?.diaryDays))
          })
          .catch((error) => setState((current) => current.data === null
            ? { phase: 'failed', data: null, error: String(error?.message ?? error) }
            : current));
      }, [])

      react.useEffect(() => { load() }, [load])

      react.useEffect(() => {
        if (day === null) return
        let cancelled = false
        setDiary({ phase: 'loading', day, text: null, error: null })
        fetch(DIARY_ROUTE + '?day=' + encodeURIComponent(day), { cache: 'no-store' })
          .then((response) => response.json().catch(() => ({})).then((body) => ({ response, body })))
          .then(({ response, body }) => {
            if (cancelled) return
            if (!response.ok) {
              setDiary({ phase: 'empty', day, text: null, error: String(body?.error ?? ('HTTP ' + response.status)) })
              return
            }
            setDiary({ phase: 'ready', day, text: String(body?.text ?? ''), error: null })
          })
          .catch((error) => {
            if (!cancelled) setDiary({ phase: 'empty', day, text: null, error: String(error?.message ?? error) })
          })
        return () => { cancelled = true }
      }, [day])

      // ---- 加载失败 ----
      if (state.data === null) {
        const failed = state.phase === 'failed'
        return h('div', { className: 'cd-panel' },
          h('div', { className: 'cd-top' },
            h('span', { className: 'cd-title' }, '日记 / 好感度')),
          h('div', { className: 'cd-scroll' },
            failed
              ? h('div', { className: 'cd-empty' },
                '读取失败',
                h('div', { style: { marginTop: '12px' } },
                  h('button', { type: 'button', className: 'cd-btn', onClick: load }, '重试')))
              : h('div', null,
                h('div', { className: 'cd-skeleton' }),
                h('div', { className: 'cd-skeleton', style: { height: '120px' } }),
                h('div', { className: 'cd-skeleton', style: { height: '90px' } }))))
      }

      const data = state.data
      const net = Number(data.todayNet) || 0
      const used = Number(data.todayUsed) || 0
      const maxDaily = Number(data.maxDaily) || 10
      const ratio = Math.max(0, Math.min(1, used / Math.max(1, maxDaily)))
      const series = range === '7d' ? data.days7 : data.days30
      const rows = Array.isArray(series) ? series : []
      const chartPoints = rows.map((row) => ({ label: row.day, value: row.closing }))
      const changes = Array.isArray(data.recentChanges) ? data.recentChanges : []
      const diaryDays = Array.isArray(data.diaryDays) ? data.diaryDays : []
      const windowAdd = rows.reduce((sum, row) => sum + (Number(row.added) || 0), 0)
      const windowSub = rows.reduce((sum, row) => sum + Math.abs(Number(row.subtracted) || 0), 0)

      // ---- 主视觉 ----
      const hero = h('div', { className: 'cd-hero' },
        h('div', { className: 'cd-hero-top' },
          h('span', { className: 'cd-score' }, String(data.score ?? '-')),
          h('span', { className: 'cd-score-unit' }, '好感度'),
          h('div', { className: 'cd-hero-right' },
            h('div', { className: 'cd-today-delta ' + toneOf(net) }, signed(net)),
            h('div', { className: 'cd-today-label' }, '今日变化'))),
        // 状态挂件紧跟在分数下面：读者先看数字，再一眼看到"这数字意味着什么"
        h(StageBadge, { score: data.score }),
        h('div', { className: 'cd-usage-wrap' },
          h('div', { className: 'cd-usage-head' },
            h('span', null, '今日额度'),
            h('span', null, used + ' / ' + maxDaily)),
          h('div', { className: 'cd-usage' },
            h('i', { style: { width: (ratio * 100).toFixed(1) + '%' } }))))

      // ---- 区间切换 ----
      const seg = h('div', { className: 'cd-seg' },
        ...[['7d', '近 7 日'], ['30d', '近 30 天']].map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          className: 'cd-seg-btn',
          'data-on': range === id ? '1' : '0',
          onClick: () => setRange(id)
        }, label)))

      // ---- 走势卡 ----
      const trendCard = h('div', { className: 'cd-card' },
        h('div', { className: 'cd-card-title' },
          '分数走势',
          h('span', { className: 'cd-card-extra' }, '05:00 换日 · ' + rows.length + ' 天')),
        h(LineChart, { points: chartPoints }),
        h('div', { className: 'cd-legend' },
          h('span', null,
            h('i', { className: 'cd-legend-dot', style: { background: 'var(--dsw-alias-state-success-primary, #2fa86a)' } }),
            '区间 +' + windowAdd),
          h('span', null,
            h('i', { className: 'cd-legend-dot', style: { background: 'var(--dsw-alias-state-warn-primary, #d4544f)' } }),
            '区间 −' + windowSub),
          h('span', null, '今日 ' + (data.today ?? ''))))

      // ---- 加减卡 ----
      //
      // 布局：走势图需要横向空间，占整行；柱状图和变化流水都比较窄，
      // 正好并排成左右两栏。既省纵向长度，也能让"每天加了多少"
      // 和"具体为什么加"左右对照着看。
      //
      // 窄屏用 CSS 的 minmax 自动退回单列，不在 JS 里判断宽度——
      // 那会让组件依赖布局时机，容易闪烁。
      const barCard = h('div', { className: 'cd-card cd-card-split' },
        h('div', { className: 'cd-card-title' }, '每日加减'),
        h(BarChart, { points: rows.map((row) => ({
          label: row.day,
          added: Number(row.added) || 0,
          subtracted: Number(row.subtracted) || 0
        }))}))

      // ---- 变化流水 ----
      const changeList = changes.length === 0
        ? h('div', { className: 'cd-empty' }, '还没有任何加减记录')
        : h('div', { className: 'cd-change-scroll' }, ...changes.slice().reverse().map((item, index) => {
          const delta = Number(item.delta) || 0
          const dir = delta > 0 ? 'up' : 'down'
          return h('div', { className: 'cd-row', key: 'c' + index },
            h('span', { className: 'cd-row-badge ' + dir }, (delta > 0 ? '+' : '') + delta),
            h('div', { className: 'cd-row-main' },
              h('div', { className: 'cd-row-reason' }, String(item.reason ?? '')),
              h('div', { className: 'cd-row-meta' },
                String(item.day ?? '').slice(5) + ' ' + clockOf(item.at)
                + ' · ' + (item.from ?? '?') + ' → ' + (item.to ?? '?'))))
        }))
      const changeCard = h('div', { className: 'cd-card cd-card-split' },
        h('div', { className: 'cd-card-title' },
          '最近变化',
          h('span', { className: 'cd-card-extra' }, changes.length + ' 次')),
        changeList)

      // ---- 日记 ----
      const dayRow = diaryDays.length === 0
        ? null
        : h('div', { className: 'cd-days' }, ...diaryDays.map((item) => h('button', {
          key: item.day,
          type: 'button',
          className: 'cd-day',
          'data-on': item.day === day ? '1' : '0',
          'data-missing': item.exists ? '0' : '1',
          title: item.exists ? '' : '该日没有日记',
          onClick: () => setDay(item.day)
        }, item.day.slice(5))))

      const diaryBody = diary.phase === 'loading'
        ? h('div', { className: 'cd-empty' }, '读取日记…')
        : diary.phase === 'ready'
          ? h('div', { className: 'cd-diary' }, String(diary.text ?? ''))
          : h('div', { className: 'cd-empty' },
            diary.phase === 'idle'
              ? '选一天看看'
              : '该日没有日记（不会拿别的日期顶替）')

      const diaryCard = h('div', { className: 'cd-card' },
        h('div', { className: 'cd-card-title' },
          '最近 7 天日记',
          h('span', { className: 'cd-card-extra' }, '只读')),
        dayRow,
        diaryBody)

      const foot = h('div', { className: 'cd-foot' },
        '数据来源：好感度账本（唯一写入方）。本面板只读，不判定、不补分、不生成日记。')

      return h('div', { className: 'cd-panel' },
        h('div', { className: 'cd-top' },
          h('span', { className: 'cd-title' }, '日记 / 好感度'),
          h('button', {
            type: 'button',
            className: 'cd-btn',
            'data-busy': state.phase === 'refreshing' ? '1' : '0',
            onClick: load
          }, state.phase === 'refreshing' ? '刷新中' : '刷新')),
        h('div', { className: 'cd-scroll' },
          hero,
          seg,
          trendCard,
          h('div', { className: 'cd-split' }, barCard, changeCard),
          diaryCard,
          foot))
    }

    /** 需要的客户端服务。 */
    const inject = ['slots']

    /**
     * 挂载面板。
     * @param {object} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply (ctx) {
      installStyles()

      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (owner) => {
        const tabs = owner.get('sidebarRightTabs')
        const navigation = owner.get('sidebarRight')
        if (!tabs || typeof tabs.register !== 'function') return
        owner.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => '日记 / 好感度',
          guide: [{
            id: 'diary',
            order: 500,
            title: () => '日记 / 好感度',
            description: () => '好感度走势、最近加减原因，以及最近 7 天的日记'
          }]
        }), 'dsh-cat-diary: sidebar tab')

        const register = owner.slots.register.bind(owner.slots)
        owner.slots.inject('sidebar.right.pane.tab', () => register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID
        }, () => h(DiaryPanel, null)))

        void navigation
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.DiaryPanel = DiaryPanel
    exports.LineChart = LineChart
    exports.BarChart = BarChart
    exports.StageBadge = StageBadge
    exports.stageOf = stageOf
    exports.AFFINITY_STAGES = AFFINITY_STAGES
    exports.TAB_ID = TAB_ID
    exports.TAB_KIND = TAB_KIND
    exports.OVERVIEW_ROUTE = OVERVIEW_ROUTE
    exports.DIARY_ROUTE = DIARY_ROUTE
    exports.pickDefaultDay = pickDefaultDay
    return module.exports
  }
})

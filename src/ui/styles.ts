// src/ui/styles.ts
//
// Scoped stylesheet for the DOM overlays. Motion is opt-in under
// prefers-reduced-motion: no-preference; hover styling only on devices that
// can hover.

export const CSS = `
.agentstat{position:relative;font-family:var(--as-font);color:var(--as-text);-webkit-tap-highlight-color:transparent}
.agentstat *,.agentstat *::before,.agentstat *::after{box-sizing:border-box}
.agentstat-canvas{display:block;width:100%;height:100%;border-radius:12px;cursor:crosshair;background:var(--as-bg);border:1px solid var(--as-frame)}
.agentstat-canvas:focus-visible{outline:2px solid var(--as-focus);outline-offset:2px}
.agentstat-surface{background:var(--as-surface);border:1px solid transparent;box-shadow:var(--as-shadow);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.agentstat-legend{position:absolute;top:12px;right:12px;display:flex;flex-wrap:nowrap;justify-content:flex-end;gap:4px;max-width:calc(100% - 120px)}
.agentstat-more-btn{font-variant-numeric:tabular-nums}
.agentstat-menu{position:absolute;top:44px;right:12px;z-index:20;display:flex;flex-direction:column;gap:2px;min-width:180px;max-width:min(280px,calc(100% - 24px));max-height:calc(100% - 56px);overflow:auto;overscroll-behavior:contain;padding:4px;border-radius:12px;transform-origin:top right}
.agentstat-menu .agentstat-btn{justify-content:flex-start;min-height:32px;border-radius:8px;background:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.agentstat-menu .agentstat-btn::before{content:none}
.agentstat-menu .agentstat-name{max-width:none}
.agentstat-menu-all{color:var(--as-text-secondary)}
@media (prefers-reduced-motion:no-preference){.agentstat-menu{transition-property:opacity,scale;transition-duration:150ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}@starting-style{.agentstat-menu{opacity:0;scale:0.97}}}
@starting-style{.agentstat-menu{opacity:0}}
.agentstat[data-theme-switching] *{transition:none!important}
.agentstat-btn{position:relative;appearance:none;margin:0;display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 10px;border-radius:999px;font:500 12px/1 var(--as-font);color:var(--as-text-secondary);cursor:pointer;white-space:nowrap;transition-property:background-color,color,transform;transition-duration:150ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}
.agentstat-btn[aria-pressed="true"]{color:var(--as-text)}
.agentstat-btn.is-off{color:var(--as-text-tertiary)}
.agentstat-btn:focus-visible{outline:2px solid var(--as-focus);outline-offset:2px}
.agentstat-btn::before{content:"";position:absolute;inset:-8px -2px}
@media (hover:hover) and (pointer:fine){.agentstat-btn:hover{background-image:linear-gradient(var(--as-selected),var(--as-selected))}}
@media (prefers-reduced-motion:no-preference){.agentstat-btn:active{transform:scale(0.96)}}
.agentstat-swatch{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--c);box-shadow:inset 0 0 0 1.5px var(--c)}
.agentstat-btn.is-off .agentstat-swatch{background:transparent}
.agentstat-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:16ch}
.agentstat-panel{position:absolute;left:12px;bottom:12px;padding:8px 10px;border-radius:10px;pointer-events:none;display:grid;grid-template-columns:auto minmax(0,auto) auto auto auto;column-gap:10px;row-gap:4px;align-items:center;font-size:12px;line-height:1.3;max-width:calc(100% - 24px)}
.agentstat-head{font-size:11px;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;color:var(--as-text-tertiary);white-space:nowrap}
.agentstat-num{font-variant-numeric:tabular-nums;text-align:right;color:var(--as-text);white-space:nowrap}
.agentstat-secondary{color:var(--as-text-secondary)}
.agentstat-more{grid-column:1/-1;font-size:11px;color:var(--as-text-tertiary)}
.agentstat-status{display:inline-flex;align-items:center;gap:4px;color:var(--as-text-secondary);white-space:nowrap}
.agentstat-status[data-tone="warning"]{color:var(--as-warning)}
.agentstat-status[data-tone="critical"]{color:var(--as-critical)}
.agentstat-status svg{flex-shrink:0}
.agentstat-pause{position:absolute;left:12px;top:12px}
.agentstat-icon{position:relative;width:12px;height:12px;flex-shrink:0}
.agentstat-icon svg{position:absolute;inset:0;transition-property:opacity,transform,filter;transition-duration:300ms;transition-timing-function:cubic-bezier(0.2,0,0,1)}
.agentstat-icon svg[data-on="false"]{opacity:0;transform:scale(0.25);filter:blur(4px)}
@media (prefers-reduced-motion:reduce){.agentstat-icon svg{transition-property:opacity}.agentstat-icon svg[data-on="false"]{transform:none;filter:none}}
.agentstat-tooltip{position:absolute;left:0;top:0;z-index:10;pointer-events:none;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.35;white-space:nowrap;color:var(--as-text);transform:translate(-50%,calc(-100% - 12px))}
.agentstat-tooltip[data-place="below"]{transform:translate(-50%,12px)}
.agentstat-tooltip-head{display:flex;align-items:center;gap:6px;font-weight:500}
.agentstat-tooltip-age{margin-left:auto;padding-left:12px;font-weight:400;color:var(--as-text-tertiary);font-variant-numeric:tabular-nums}
.agentstat-tooltip-body{margin-top:2px;color:var(--as-text-secondary);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:no-preference){.agentstat-tooltip{transition-property:opacity,scale;transition-duration:125ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}}
@starting-style{.agentstat-tooltip{opacity:0;scale:0.97}}
.agentstat-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

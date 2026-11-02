"""Premium dark surveillance theme: design tokens, CSS and small HTML
builders shared by every page. All numbers passed in here come from real
session data - this module only styles, it never invents content.
"""
from __future__ import annotations

import html
import streamlit as st

LEVEL_TONE = {"Normal": "ok", "Suspicious": "warn", "Irregular": "bad"}
_LEVEL_HEX = {"Normal": "#34D399", "Suspicious": "#FBBF24", "Irregular": "#F87171"}

# Design tokens (single source of truth for the palette)
COLORS = {
    "background": "#07080D",       # obsidian
    "surface": "#0D0F16",         # graphite glass base
    "border": "rgba(255,255,255,.08)",
    "accent": "#8B5CF6",          # electric violet
    "secondary": "#22D3EE",       # cyan
    "tertiary": "#60A5FA",        # restrained blue
    "success": "#34D399",
    "warning": "#FBBF24",
    "danger": "#F87171",
}

_CSS = """
<style>
:root{
  --bg:#07080D;
  --panel:rgba(255,255,255,.045); --panel2:rgba(255,255,255,.028);
  --border:rgba(255,255,255,.085); --border-soft:rgba(255,255,255,.05);
  --text:#E8EAF2; --muted:#9AA3B8; --accent:#8B5CF6; --cyan:#22D3EE;
  --blue:#60A5FA;
  --accent-soft:rgba(139,92,246,.18);
  --ok:#34D399; --ok-ink:#4ADE80;
  --warn:#FBBF24; --warn-ink:#FCD34D;
  --bad:#F87171; --bad-ink:#FCA5A5;
  --glass-blur:blur(14px) saturate(150%);
  --lift:0 1px 0 rgba(255,255,255,.06) inset,
         0 24px 48px -24px rgba(0,0,0,.75),
         0 10px 24px -12px rgba(0,0,0,.5);
}
html,body,[data-testid="stAppViewContainer"]{
  background:
    radial-gradient(1100px 520px at 12% -8%, rgba(139,92,246,.14), transparent 62%),
    radial-gradient(900px 430px at 96% -10%, rgba(34,211,238,.09), transparent 60%),
    radial-gradient(1000px 620px at 50% 118%, rgba(96,165,250,.07), transparent 65%),
    var(--bg);
  background-attachment:fixed;
  color:var(--text);
  font-family:"Inter","Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;
  font-size:15px; -webkit-font-smoothing:antialiased;
}
::selection{background:rgba(139,92,246,.35); color:#fff;}
[data-testid="stHeader"]{background:transparent;}
[data-testid="stSidebar"]{
  background:linear-gradient(180deg,rgba(13,15,22,.94),rgba(9,10,16,.94));
  border-right:1px solid var(--border);
  box-shadow:1px 0 28px -14px rgba(0,0,0,.7);
}
[data-testid="stSidebar"] [data-testid="stMarkdownContainer"] p{color:var(--muted);}
[data-testid="stSidebar"] hr{border-color:var(--border-soft); opacity:.55;}
.block-container{padding-top:1.7rem; padding-bottom:3.5rem; max-width:1400px;}
h1,h2,h3,h4{color:var(--text); letter-spacing:-.014em;}
h1{font-size:1.45rem !important; font-weight:720 !important; margin:.05rem 0 .15rem;
  background:linear-gradient(92deg,#F5F6FC 15%,#ABB6DC 90%);
  -webkit-background-clip:text; background-clip:text;
  -webkit-text-fill-color:transparent;}
h2{font-size:1.06rem !important; font-weight:660 !important; margin:.85rem 0 .45rem;
  position:relative; padding-left:.7rem;}
h2::before{content:""; position:absolute; left:0; top:.24rem; width:3px; height:.95rem;
  border-radius:2px; background:linear-gradient(180deg,var(--accent),var(--cyan));
  box-shadow:0 0 10px rgba(139,92,246,.55);}
h3{font-size:.97rem !important; font-weight:630 !important;}
p,li{font-size:.92rem; line-height:1.55;}
div[data-testid="stCaption"],div[data-testid="stCaption"] p{
  color:var(--muted); font-size:.8rem;}
@media (prefers-reduced-motion: reduce){
  *{animation:none !important; transition:none !important;}
}

/* ---------------- sidebar chrome ---------------- */
@keyframes neural-glow{0%,100%{filter:drop-shadow(0 0 3px rgba(139,92,246,.45));}
  50%{filter:drop-shadow(0 0 12px rgba(34,211,238,.6));}}
.brand{display:flex; align-items:center; gap:.62rem; padding:.1rem 0 .75rem;}
.logo{width:33px;height:33px;border-radius:9px;flex:none;
  background:linear-gradient(140deg,#8B5CF6 0%,#5B21B6 60%,#0E7490 150%);
  box-shadow:0 4px 18px rgba(139,92,246,.5),
             0 1px 0 rgba(255,255,255,.25) inset;
  display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:.95rem;font-weight:800;
  animation:neural-glow 3.4s ease-in-out infinite;}
.brand-name{font-weight:770; font-size:.92rem; letter-spacing:.1em; color:#fff;}
.brand-sub{color:var(--muted); font-size:.62rem; letter-spacing:.16em;
  text-transform:uppercase; margin-top:.09rem;}

/* status card in sidebar */
.status-card{background:var(--panel); border:1px solid var(--border);
  border-radius:12px; padding:.6rem .7rem; margin:.15rem 0 .5rem;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);}
.st-row{display:flex; align-items:center; gap:.45rem; padding:.2rem 0;
  font-size:.76rem;}
.st-row .k{color:var(--muted); letter-spacing:.06em; text-transform:uppercase;
  font-size:.65rem; min-width:64px; flex:none;}
.st-row .v{color:var(--text); font-weight:570; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap;}
.dot{width:8px;height:8px;border-radius:50%;flex:none;}
.dot.ok{background:var(--ok); box-shadow:0 0 9px rgba(52,211,153,.8);}
.dot.warn{background:var(--warn-ink); box-shadow:0 0 9px rgba(251,191,36,.7);}
.dot.bad{background:var(--bad); box-shadow:0 0 9px rgba(248,113,113,.75);}
.dot.idle{background:rgba(255,255,255,.18);}
.dot.live{animation:pulse 1.4s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* nav labels inside the sidebar */
[data-testid="stSidebarNav"] li a{
  font-size:.87rem !important; font-weight:560; border-radius:10px;
  transition:background .18s ease, box-shadow .18s ease;}
[data-testid="stSidebarNav"] li a:hover{background:rgba(139,92,246,.13);}
[data-testid="stSidebarNav"] li[aria-selected="true"] a{
  background:linear-gradient(90deg,rgba(139,92,246,.24),rgba(34,211,238,.08)) !important;
  color:#CDC6FF !important;
  border:1px solid rgba(139,92,246,.45) !important;
  box-shadow:0 8px 22px -10px rgba(139,92,246,.6);}

/* ---------------- content components ---------------- */
.kpi{background:var(--panel); border:1px solid var(--border); border-radius:14px;
  padding:.75rem .9rem; height:100%;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);
  transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease;}
.kpi:hover{transform:translateY(-2px); border-color:rgba(139,92,246,.42);
  box-shadow:var(--lift), 0 0 0 1px rgba(139,92,246,.18);}
.kpi .lab{color:var(--muted); font-size:.68rem; text-transform:uppercase;
  letter-spacing:.13em; font-weight:640;}
.kpi .val{font-size:1.6rem; font-weight:750; line-height:1.12; margin:.2rem 0 0;
  font-variant-numeric:tabular-nums;
  background:linear-gradient(92deg,#FFFFFF 25%,#B3BCEF 90%);
  -webkit-background-clip:text; background-clip:text;
  -webkit-text-fill-color:transparent;}
.kpi .sub{color:var(--muted); font-size:.75rem; margin-top:.14rem;}
.kpi.accent{border-color:rgba(139,92,246,.5); background:
  linear-gradient(160deg,rgba(139,92,246,.20),rgba(34,211,238,.06) 90%);}
.kpi.danger{border-color:rgba(248,113,113,.45); background:
  linear-gradient(180deg,rgba(248,113,113,.12),rgba(248,113,113,.02));}
.kpi.warnk{border-color:rgba(251,191,36,.4); background:
  linear-gradient(180deg,rgba(251,191,36,.11),rgba(251,191,36,.02));}
.kpi.okk{border-color:rgba(52,211,153,.4); background:
  linear-gradient(180deg,rgba(52,211,153,.10),rgba(52,211,153,.02));}

/* live status strip */
.status-strip{display:flex; flex-wrap:wrap; gap:.5rem; margin:.1rem 0 .9rem;}
.status-chip{display:inline-flex; align-items:center; gap:.4rem;
  background:var(--panel); border:1px solid var(--border); border-radius:999px;
  padding:.3rem .75rem; font-size:.76rem; color:var(--muted);
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset;}
.status-chip b{color:var(--text); font-weight:630;}

/* generic panels */
.panel{background:var(--panel); border:1px solid var(--border); border-radius:14px;
  padding:.95rem 1.05rem;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);}
.panel + .panel{margin-top:.7rem;}
.panel h3{margin:0 0 .5rem;}
.muted{color:var(--muted);}

/* severity badges */
.badge{display:inline-block; padding:.11rem .55rem; border-radius:999px;
  font-size:.69rem; font-weight:690; letter-spacing:.08em; text-transform:uppercase;
  border:1px solid; font-variant-numeric:tabular-nums;
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset;}
.badge.ok{background:rgba(52,211,153,.14); color:var(--ok-ink);
  border-color:rgba(52,211,153,.42);}
.badge.warn{background:rgba(251,191,36,.14); color:var(--warn-ink);
  border-color:rgba(251,191,36,.42);}
.badge.bad{background:rgba(248,113,113,.15); color:var(--bad-ink);
  border-color:rgba(248,113,113,.44);}
.badge.neutral{background:rgba(255,255,255,.05); color:var(--muted);
  border-color:var(--border);}

/* evidence chips */
.chip{display:inline-block; padding:.12rem .55rem; margin:.14rem .3rem .14rem 0;
  border-radius:7px; background:var(--accent-soft); color:#C9BFFF;
  font-size:.74rem; border:1px solid rgba(139,92,246,.42);
  box-shadow:0 0 16px -8px rgba(139,92,246,.6);}
.chip.ml{background:rgba(34,211,238,.12); color:#8FE9F6;
  border-color:rgba(34,211,238,.4); box-shadow:0 0 16px -8px rgba(34,211,238,.55);}
.chip.scene{background:rgba(96,165,250,.12); color:#A9C9FB;
  border-color:rgba(96,165,250,.4);}

/* buttons: glass, hover elevation */
div[data-testid="stButton"] button, div[data-testid="stDownloadButton"] button{
  border:1px solid var(--border); background:var(--panel2); color:var(--text);
  border-radius:10px; font-size:.85rem; font-weight:590; height:2.25rem; width:100%;
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset,
             0 10px 22px -14px rgba(0,0,0,.65);
  transition:border-color .18s ease, background .18s ease,
             transform .14s ease, box-shadow .18s ease;}
div[data-testid="stButton"] button:hover:not(:disabled),
div[data-testid="stDownloadButton"] button:hover:not(:disabled){
  border-color:rgba(139,92,246,.6); background:rgba(139,92,246,.15); color:#fff;
  transform:translateY(-1px);
  box-shadow:0 1px 0 rgba(255,255,255,.08) inset,
             0 12px 26px -12px rgba(139,92,246,.45);}
div[data-testid="stButton"] button:active{transform:translateY(0);}
div[data-testid="stButton"] button[kind="primary"],
div[data-testid="stDownloadButton"] button[kind="primary"]{
  background:linear-gradient(120deg,#8B5CF6,#6D28D9 58%,#0E7490);
  border-color:rgba(255,255,255,.2); color:#fff;
  box-shadow:0 6px 24px -6px rgba(139,92,246,.55),
             0 1px 0 rgba(255,255,255,.16) inset;}
div[data-testid="stButton"] button[kind="primary"]:hover{
  background:linear-gradient(120deg,#9F74FF,#7A3BEB 58%,#0AA6C9);
  border-color:rgba(255,255,255,.28);}
div[data-testid="stButton"] button:disabled{
  opacity:.45; box-shadow:none;}

/* metrics (fallback styling) */
[data-testid="stMetric"]{background:var(--panel); border:1px solid var(--border);
  border-radius:14px; padding:.75rem .9rem;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);}
[data-testid="stMetric"] label{color:var(--muted) !important; font-size:.72rem !important;}
[data-testid="stMetric"] [data-testid="stMetricValue"]{color:#fff !important;
  font-weight:700 !important;}

/* tables */
[data-testid="stDataFrame"]{
  border:1px solid var(--border); border-radius:12px; overflow:hidden;
  box-shadow:var(--lift);}
[data-testid="stTable"]{border:1px solid var(--border); border-radius:12px;}
[data-testid="stDataFrame"] header{background:rgba(255,255,255,.03) !important;}

/* inputs */
[data-baseweb="input"],[data-baseweb="select"],[data-baseweb="textarea"],
[data-baseweb="tag"]{background:rgba(255,255,255,.03) !important;
  border-color:var(--border) !important;
  border-radius:10px !important; font-size:.86rem; color:var(--text) !important;}
[data-baseweb="input"]:hover,[data-baseweb="select"]:hover{
  border-color:rgba(139,92,246,.5) !important;}
[data-baseweb="input"]:focus-within,[data-baseweb="select"]:focus-within{
  border-color:var(--accent) !important;
  box-shadow:0 0 0 2px rgba(139,92,246,.25),
             0 0 18px -4px rgba(139,92,246,.4) !important;}
[data-baseweb="select"] .bn-input{background:transparent;}
label{color:var(--muted) !important; font-size:.8rem !important;
  font-weight:560 !important;}

/* sliders */
[data-testid="stSlider"]{padding:.35rem 0;}
[data-testid="stSlider"] label{color:var(--muted) !important;}
[data-testid="stSlider"] [data-baseweb="thumb"]{
  background:linear-gradient(135deg,#9F74FF,#0AA6C9) !important;
  border:2px solid rgba(255,255,255,.35) !important;
  box-shadow:0 2px 10px rgba(139,92,246,.55);}
[data-testid="stSlider"] [data-baseweb="track"] > div:first-child{
  background:linear-gradient(90deg,#8B5CF6,#22D3EE) !important;}
[data-testid="stSlider"] [data-baseweb="track"] > div:last-child{
  background:rgba(255,255,255,.12) !important;}
[data-testid="stSlider"] [role="tooltip"]{
  background:var(--accent) !important; border:1px solid rgba(255,255,255,.3) !important;
  color:#fff !important; font-weight:650;}

/* radio + tabs */
[data-testid="stRadio"] > div{gap:.4rem;}
[data-testid="stRadio"] [role="radiogroup"] > div{
  background:rgba(255,255,255,.03); border:1px solid var(--border); border-radius:9px;
  transition:border-color .18s ease, background .18s ease;}
[data-testid="stRadio"] [role="radiogroup"] > div:hover{
  border-color:rgba(139,92,246,.4);}
[data-testid="stRadio"] [aria-checked="true"]{
  background:rgba(139,92,246,.22) !important;
  border-color:rgba(139,92,246,.55) !important;
  box-shadow:0 4px 16px -8px rgba(139,92,246,.55);
  color:#CDC6FF !important;}
[data-testid="stTabs"] [role="tab"]{border-radius:9px 9px 0 0; font-size:.85rem;
  font-weight:580; transition:color .15s ease;}
[data-testid="stTabs"] [role="tab"][aria-selected="true"]{
  color:#B9AAFF !important; border-bottom-color:var(--accent) !important;}/* expander + bordered containers */
div[data-testid="stExpander"]{background:var(--panel); border:1px solid var(--border);
  border-radius:12px;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);}
div[data-testid="stVerticalBlockBorderWrapper"]{
  background:var(--panel); border:1px solid var(--border); border-radius:14px;
  padding:.7rem .9rem;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);}

/* alert banners */
div[data-testid="stAlert"]{border-radius:12px; border:1px solid var(--border);
  font-size:.86rem;
  backdrop-filter:var(--glass-blur); -webkit-backdrop-filter:var(--glass-blur);
  box-shadow:var(--lift);}

/* footer + deploy toolbar: quieter, product-first chrome */
#MainMenu{visibility:hidden;}
footer{visibility:hidden;}
footer::after{content:""; visibility:hidden;}

[data-testid="stToolbar"]{visibility:hidden;}
[data-testid="stDecoration"]{display:none;}

/* file uploader: keep it in the dark theme (default is light) */
[data-testid="stFileUploaderDropzone"]{
  background:rgba(255,255,255,.03) !important;
  border:1px dashed rgba(139,92,246,.35) !important;
  border-radius:14px !important; min-height:86px;
  transition:border-color .2s ease, background .2s ease !important;}
[data-testid="stFileUploaderDropzone"]:hover{
  border-color:rgba(139,92,246,.65) !important;
  background:rgba(139,92,246,.08) !important;}
[data-testid="stFileUploaderDropzone"] *{color:var(--text) !important;
  font-size:.84rem !important;}
[data-testid="stFileUploader"] button{
  background:var(--panel) !important; border:1px solid var(--border) !important;
  border-radius:9px !important; color:var(--text) !important;
  font-size:.84rem !important; font-weight:560;}
[data-testid="stFileUploader"] button:hover{
  border-color:rgba(139,92,246,.6) !important;
  background:rgba(139,92,246,.12) !important;}
[data-testid="stFileUploaderFileWrapper"]{font-size:.82rem !important;}

/* progress + spinners: animated neural plasma bar */
[data-testid="stProgress"] [role="progressbar"]{
  background:rgba(255,255,255,.07) !important; border-radius:99px;
  overflow:hidden;}
[data-testid="stProgress"] > div > div > div > div{
  background:linear-gradient(90deg,#8B5CF6,#22D3EE,#8B5CF6) !important;
  background-size:200% 100%;
  animation:plasma 1.6s linear infinite;
  box-shadow:0 0 12px rgba(139,92,246,.55); border-radius:99px;}
@keyframes plasma{0%{background-position:0% 0}100%{background-position:200% 0}}
[data-testid="stSpinner"]{border-top-color:var(--accent) !important;}

/* image frames: surveillance-monitor glass */
div[data-testid="stImage"] img{
  border:1px solid rgba(255,255,255,.11); border-radius:14px;
  box-shadow:0 1px 0 rgba(255,255,255,.09) inset,
             0 26px 60px -28px rgba(0,0,0,.8),
             0 0 40px -24px rgba(139,92,246,.35);}

/* scrollbars */
::-webkit-scrollbar{width:9px; height:9px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(139,92,246,.28); border-radius:8px;
  border:2px solid transparent; background-clip:content-box;}
::-webkit-scrollbar-thumb:hover{background:rgba(139,92,246,.5); border:2px solid
  transparent; background-clip:content-box;}
</style>
"""


def inject_css() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)


def brand_html() -> str:
    return (
        '<div class="brand"><div class="logo">&#9670;</div><div>'
        '<div class="brand-name">NEURAL&#8202;/&#8202;COMMAND</div>'
        '<div class="brand-sub">intelligent surveillance &amp; anomaly '
        'intel</div></div></div>')


def status_row(dot: str, label: str, value: str, live: bool = False) -> str:
    """One sidebar status line: colored dot + label + value."""
    cls = f"dot {dot}" + (" live" if live else "")
    return (f'<div class="st-row"><span class="{cls}"></span>'
            f'<span class="k">{html.escape(label)}</span>'
            f'<span class="v" title="{html.escape(value)}">'
            f'{html.escape(value)}</span></div>')


def status_card(rows: str) -> str:
    return f'<div class="status-card">{rows}</div>'


def status_chip(dot: str, label: str, value: str, live: bool = False) -> str:
    """One pill for the Overview live-status strip."""
    cls = f"dot {dot}" + (" live" if live else "")
    return (f'<span class="status-chip"><span class="{cls}"></span>'
            f'{html.escape(label)} <b>{html.escape(value)}</b></span>')



def kpi(label: str, value: str, sub: str = "", accent: bool = False) -> str:
    cls = "kpi accent" if accent else "kpi"
    return (f'<div class="{cls}"><div class="lab">{html.escape(label)}</div>'
            f'<div class="val">{html.escape(str(value))}</div>'
            + (f'<div class="sub">{html.escape(sub)}</div>' if sub else "")
            + "</div>")


def badge(level: str) -> str:
    tone = LEVEL_TONE.get(level, "neutral")
    return f'<span class="badge {tone}">{html.escape(level)}</span>'


def panel(inner: str) -> str:
    return f'<div class="panel">{inner}</div>'


def level_color(level: str) -> str:
    return _LEVEL_HEX.get(level, "#98a1b5")


def page_header(title: str, subtitle: str = "") -> None:
    st.markdown(
        f"<h1>{html.escape(title)}</h1>"
        + (f'<p class=\"muted\" style=\"margin:.1rem 0 .9rem;font-size:.9rem;\">'
           f"{html.escape(subtitle)}</p>" if subtitle else ""),
        unsafe_allow_html=True)


def section(title: str, note: str = "") -> None:
    tail = f' <span class="muted" style="font-weight:400;font-size:.82rem;">{html.escape(note)}</span>' if note else ""
    st.markdown(f"<h2>{html.escape(title)}{tail}</h2>", unsafe_allow_html=True)


def empty_state(title: str, body: str, icon: str = "◍") -> None:
    st.markdown(
        f'<div class="panel" style="text-align:center;padding:2.4rem 1.2rem;">'
        f'<div style="font-size:1.6rem;opacity:.75;">{icon}</div>'
        f'<div style="font-weight:640;margin:.4rem 0 .3rem;">{html.escape(title)}</div>'
        f'<div class="muted" style="font-size:.86rem;max-width:520px;'
        f'margin:0 auto;line-height:1.5;">{html.escape(body)}</div></div>',
        unsafe_allow_html=True)


def current_result():
    """The active SessionResult from session state, or None."""
    res = st.session_state.get("session_result")
    if res is not None and getattr(res, "error", None):
        return None
    return res


def require_result_or_hint(page_hint: str) -> bool:
    """True when a usable result exists; otherwise renders the empty state."""
    if current_result() is not None:
        return True
    if st.session_state.get("session_error"):
        st.error(st.session_state["session_error"])
        return False
    empty_state(f"{page_hint} is waiting for an analysis run",
                "Open Video Studio, choose a bundled sample or upload a video, "
                "then press Analyze. Results stay in this browser session "
                "until you run another video.")
    return False

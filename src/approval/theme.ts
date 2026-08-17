// Arcadia's visual system.
//
// Two sources, deliberately layered:
//
//   1. The *patterns* come from ChartRoom (the CMT Association staff portal)
//      via its portable design guidelines — fixed-viewport shell, dark
//      collapsible sidebar rail, slot-based top bar that renders nothing when
//      a page has nothing to report, one card/stat/table/badge/button set that
//      pages compose from rather than styling by hand, and one active-state
//      treatment reused everywhere.
//   2. The *values* come from the S-FX design system (DESIGN.md) — deep navy
//      canvas, electric cyan as the single accent, Clash Grotesk display over
//      Inter body, depth from border + radial glow rather than drop shadows.
//
// ChartRoom's five-token colour model is kept intact; only the hex values move.
// Its rule that a token owns a role is what keeps the surface readable:
//
//   ChartRoom              role                          Arcadia
//   cultured (#f0f0f0)  →  page canvas                →  navy   (#0A1628)
//   white               →  card surface               →  surface(#0C1B30)
//   eagle   (#004d57)   →  ink / primary content      →  ink    (#FFFFFF)
//   steel   (#4b8892)   →  secondary accent           →  periwinkle (#8888FF)
//   opal    (#a9c4bb)   →  soft / receding            →  muted  (#8BA3C0)
//   upsdell (#ae232d)   →  the one saturated colour   →  cyan   (#00D1F9)
//
// Green, amber and red stay reserved for verdicts (approved, degraded,
// failed). ChartRoom borrows the same universal emerald/amber/red for status
// rather than brand colours, for the same reason: a verdict must not read as
// decoration. So a colour on this surface always means one thing.
//
// Kept free of Worker imports so it can be rendered and reviewed on its own.

/** Display + body faces. Fallbacks carry the layout if the CDN is blocked. */
export const fontLinks = [
  "https://api.fontshare.com/v2/css?f%5B%5D=clash-grotesk@600,700&display=swap",
  "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap",
];

export const styles = `
  :root {
    /* S-FX brand — DESIGN.md */
    --navy: #0A1628;          /* primary surface: the page canvas */
    --navy-deep: #06101F;     /* the rail, one step below the canvas */
    --surface: #0C1B30;       /* secondary surface: cards float here */
    --surface-2: #10233C;     /* inputs, table heads, raised rows */
    --ink: #FFFFFF;
    --cyan: #00D1F9;          /* the single accent */
    --cyan-soft: #7FE7FC;
    --periwinkle: #8888FF;    /* secondary accent, decoratives */
    --muted: #8BA3C0;
    --line: rgba(0, 209, 249, .15);
    --line-soft: rgba(139, 163, 192, .14);
    --glow: rgba(0, 209, 249, .08);
    /* Verdicts — universal, never decorative. */
    --ok: #34d399; --warn: #fbbf24; --danger: #f87171;

    --font-display: "Clash Grotesk", "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

    /* Type scale mirrors ChartRoom's. h1–h3 are impact sizes; an operations
       screen lives at --text-h4 and --text-p2, so the page heading below is
       set well under --text-h3 on purpose. */
    --text-h1: 70px; --text-h2: 50px; --text-h3: 35px; --text-h4: 22px;
    --text-p: 18px; --text-p2: 16px;

    --r: 16px;                /* DESIGN.md: feature pill cards */
    --r-sm: 10px;
    --rail: 232px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    font-family: var(--font-sans); font-size: var(--text-p2); font-weight: 400; line-height: 1.55;
    color: var(--ink); background: var(--navy);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  a { color: var(--cyan); text-decoration: none; }
  a:hover { color: var(--cyan-soft); text-decoration: underline; text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; border-radius: 4px; }

  /* ── Shell ───────────────────────────────────────────────────────────────
     Fixed viewport, not a scrolling page: only <main> scrolls, so the rail
     and the status bar are always in view. */
  .app { display: flex; height: 100vh; overflow: hidden; }
  .content { position: relative; display: flex; flex: 1; flex-direction: column; overflow: hidden; }
  main { flex: 1; overflow-y: auto; padding: 1.75rem 2rem 1rem; }
  .wrap { max-width: 78rem; margin: 0 auto; }

  /* Dot-grid texture: depth without noise, 4% per DESIGN.md. */
  .content::before {
    content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0; opacity: .04;
    background-image: radial-gradient(var(--cyan) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  /* Slow-breathing cyan bloom — the decorative layer every S-FX scene carries. */
  .content::after {
    content: ""; position: absolute; inset: -30% 0 auto 0; height: 60%; pointer-events: none; z-index: 0;
    background: radial-gradient(60% 60% at 50% 40%, rgba(0, 209, 249, .10), transparent 70%);
    animation: breathe 14s ease-in-out infinite;
  }
  @keyframes breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  main, .topbar { position: relative; z-index: 1; }

  /* ── Sidebar rail ────────────────────────────────────────────────────── */
  .sidebar {
    display: flex; flex-direction: column; flex: none; width: var(--rail); height: 100%;
    background: var(--navy-deep); border-right: 1px solid var(--line);
    scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .25) transparent;
  }
  .sidebar ::-webkit-scrollbar { width: 6px; }
  .sidebar ::-webkit-scrollbar-track { background: transparent; }
  .sidebar ::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, .25); border-radius: 999px; }

  .brand { display: flex; align-items: center; gap: .6rem; padding: 1.4rem 1.1rem 1.1rem; color: var(--ink); }
  .brand:hover { color: var(--ink); text-decoration: none; opacity: .85; }
  .brand .mark { flex: none; color: var(--cyan); filter: drop-shadow(0 0 10px rgba(0, 209, 249, .55)); }
  .brand .word { font-family: var(--font-display); font-size: 1.32rem; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
  .brand .sub { display: block; margin-top: .28rem; font-size: 9px; font-weight: 600; letter-spacing: .28em; color: var(--muted); }

  /* CTA blast, sidebar scale: cyan fill, navy type. The one flooded element. */
  .cta {
    display: flex; align-items: center; justify-content: center; gap: .5rem;
    margin: 0 .85rem 1.1rem; padding: .68rem .9rem; border-radius: 12px;
    font-size: var(--text-p2); font-weight: 700; letter-spacing: -.01em;
    color: #04121d; background: var(--cyan); box-shadow: 0 0 26px -8px rgba(0, 209, 249, .9);
    transition: background .15s, box-shadow .15s;
  }
  .cta:hover { color: #04121d; background: var(--cyan-soft); text-decoration: none; box-shadow: 0 0 32px -6px rgba(0, 209, 249, 1); }
  .cta.active { background: var(--cyan-soft); }

  .sidebar-nav { flex: 1; overflow-y: auto; padding: 0 .6rem .4rem; }
  .navgroup { margin-bottom: 1.35rem; }
  .navgroup-label {
    margin: 0 0 .45rem; padding: 0 .65rem;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .12em; color: var(--muted);
  }
  .navgroup ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .navitem {
    position: relative; display: flex; align-items: center; gap: .65rem;
    padding: .55rem .65rem; border-radius: var(--r-sm);
    font-size: .92rem; font-weight: 500; color: rgba(255, 255, 255, .72);
    transition: background .15s, color .15s;
  }
  .navitem:hover { color: var(--ink); background: rgba(255, 255, 255, .07); text-decoration: none; }
  .navitem svg { flex: none; color: var(--muted); transition: color .15s; }
  .navitem:hover svg { color: var(--cyan-soft); }
  /* One active treatment, reused everywhere — never invent a second. */
  .navitem.active { color: var(--ink); background: rgba(0, 209, 249, .12); box-shadow: inset 2px 0 0 var(--cyan); }
  .navitem.active svg { color: var(--cyan); }

  .sidebar-foot { border-top: 1px solid var(--line-soft); padding: .55rem; }
  .usermenu { position: relative; }
  .usermenu > summary {
    display: flex; align-items: center; gap: .6rem; padding: .45rem; border-radius: var(--r-sm);
    cursor: pointer; list-style: none; transition: background .15s;
  }
  .usermenu > summary::-webkit-details-marker { display: none; }
  .usermenu > summary:hover { background: rgba(255, 255, 255, .07); }
  .avatar {
    flex: none; display: flex; align-items: center; justify-content: center;
    width: 2.1rem; height: 2.1rem; border-radius: 50%;
    font-size: .75rem; font-weight: 700; color: #04121d; background: var(--cyan);
  }
  .usermenu .idn { min-width: 0; flex: 1; }
  .usermenu .idn b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; font-weight: 700; }
  .usermenu .idn span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .7rem; color: var(--muted); }
  .usermenu > summary > svg { flex: none; color: var(--muted); transition: transform .15s; }
  .usermenu[open] > summary > svg { transform: rotate(180deg); }
  .usermenu .menu {
    position: absolute; bottom: calc(100% + .35rem); left: 0; right: 0; z-index: 30;
    padding: .3rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
    box-shadow: 0 0 40px -12px rgba(0, 209, 249, .5);
  }
  .usermenu .menu a {
    display: flex; align-items: center; gap: .55rem; padding: .45rem .55rem; border-radius: 8px;
    font-size: .84rem; font-weight: 500; color: rgba(255, 255, 255, .82);
  }
  .usermenu .menu a:hover { color: var(--ink); background: rgba(0, 209, 249, .12); text-decoration: none; }
  .usermenu .menu a.out { color: var(--muted); }
  .usermenu .menu a.out:hover { color: var(--danger); background: rgba(248, 113, 113, .12); }

  /* ── Status bar ──────────────────────────────────────────────────────────
     Holds one thing: the provenance/state pill. A page with nothing to report
     renders no bar at all rather than an empty strip. */
  .topbar {
    display: flex; align-items: center; justify-content: flex-end; gap: .6rem; flex-wrap: wrap;
    padding: .7rem 2rem; border-bottom: 1px solid var(--line-soft);
  }
  .pill {
    display: inline-flex; align-items: center; gap: .45rem;
    padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 999px;
    background: var(--surface); font-size: .76rem; font-weight: 600; color: var(--muted);
  }
  .pill b { color: var(--ink); font-weight: 600; }
  .pill .dot { width: .45rem; height: .45rem; }
  .pill.ok .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .pill.warn { border-color: rgba(251, 191, 36, .35); } .pill.warn .dot { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
  .pill.danger { border-color: rgba(248, 113, 113, .45); } .pill.danger .dot { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .pill.idle .dot { background: var(--muted); box-shadow: none; }

  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 12px var(--cyan); flex: none; }

  /* ── Page head ───────────────────────────────────────────────────────── */
  .pagehead { padding-bottom: 1.15rem; margin-bottom: 1.35rem; border-bottom: 1px solid var(--line-soft); }
  h1 { margin: 0 0 .35rem; font-family: var(--font-display); font-size: 2.1rem; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; }
  h1 em { font-style: normal; color: var(--cyan); }
  .lede { margin: 0; max-width: 52rem; font-size: .92rem; font-weight: 300; color: var(--muted); }
  .lede a { font-weight: 400; }
  .who-row { display: flex; flex-wrap: wrap; gap: .35rem; margin: .8rem 0 0; }
  .tag {
    font-size: .71rem; font-weight: 600; padding: .2rem .6rem; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--line-soft); color: var(--muted);
  }
  .tag.role { color: var(--cyan); background: rgba(0, 209, 249, .1); border-color: var(--line); }

  /* Eyebrow label — Inter 600, caps, .12em (DESIGN.md labels). */
  h2 {
    display: flex; align-items: center; gap: .55rem; margin: 2.3rem 0 .85rem;
    font-size: .76rem; font-weight: 600; text-transform: uppercase; letter-spacing: .12em; color: var(--cyan);
  }
  h2::before { content: ""; width: .38rem; height: .38rem; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px rgba(0, 209, 249, .9); }
  h3 { margin: 1.5rem 0 .5rem; font-size: 1rem; font-weight: 700; color: var(--ink); }

  /* ── Cards ───────────────────────────────────────────────────────────────
     Depth is border + radial glow. No drop shadows. */
  .card {
    position: relative; overflow: hidden; padding: 1.25rem 1.35rem;
    border: 1px solid var(--line); border-radius: var(--r); background: var(--surface);
  }
  .card::before {
    content: ""; position: absolute; inset: -60% -30% auto auto; width: 70%; height: 160%; pointer-events: none;
    background: radial-gradient(circle at 70% 25%, var(--glow), transparent 70%);
  }
  .card > * { position: relative; }
  .card > h3:first-child { margin-top: 0; }
  .cardgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1rem; margin: 1.1rem 0 1.4rem; }

  /* Feature pill card: cyan left-accent line + icon (DESIGN.md components). */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .8rem; margin: 1.2rem 0 1.6rem; }
  .stat {
    position: relative; overflow: hidden; padding: .95rem 1.05rem;
    border: 1px solid var(--line); border-radius: var(--r); background: var(--surface);
  }
  .stat::before {
    content: ""; position: absolute; inset: -60% -30% auto auto; width: 70%; height: 160%; pointer-events: none;
    background: radial-gradient(circle at 70% 25%, var(--glow), transparent 70%);
  }
  .stat::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--cyan); }
  .stat.warn::after { background: var(--warn); } .stat.warn .v { color: #fcd34d; }
  .stat.danger::after { background: var(--danger); } .stat.danger .v { color: #fca5a5; }
  .stat.ok::after { background: var(--ok); }
  .stat > * { position: relative; }
  .stat .k { display: block; font-size: .69rem; font-weight: 600; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  .stat .v { display: block; margin: .3rem 0 .15rem; font-family: var(--font-display); font-size: 1.85rem; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
  .stat .n { font-size: .74rem; font-weight: 300; color: var(--muted); }

  /* ── Tables ──────────────────────────────────────────────────────────── */
  table {
    width: 100%; border-collapse: separate; border-spacing: 0; font-size: .86rem;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden;
  }
  td, th { text-align: left; padding: .65rem .85rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th { background: var(--surface-2); font-size: .69rem; font-weight: 600; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: rgba(0, 209, 249, .045); }

  /* ── Forms and buttons ───────────────────────────────────────────────── */
  form { margin: 0 0 .9rem; }
  form.inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin: 0; }
  input[type=text], input[type=number], select, textarea {
    font: inherit; font-size: .87rem; color: var(--ink); background: var(--surface-2);
    border: 1px solid var(--line-soft); border-radius: var(--r-sm); padding: .45rem .7rem; max-width: 100%;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=text] { min-width: 12rem; }
  textarea { width: 100%; min-height: 6rem; resize: vertical; }
  select { cursor: pointer; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(0, 209, 249, .16); }
  ::placeholder { color: #5b7085; }
  input[type=checkbox] { accent-color: var(--cyan); width: 1rem; height: 1rem; vertical-align: -.15rem; }
  label { font-size: .87rem; font-weight: 300; color: var(--muted); }

  button {
    font: inherit; font-size: .84rem; font-weight: 600; color: var(--ink); background: var(--surface-2);
    border: 1px solid var(--line); border-radius: var(--r-sm); padding: .45rem .95rem; cursor: pointer;
    transition: background .15s, border-color .15s, color .15s, box-shadow .15s;
  }
  button:hover { color: var(--cyan-soft); background: rgba(0, 209, 249, .1); border-color: rgba(0, 209, 249, .5); }
  button:disabled { cursor: not-allowed; opacity: .5; }
  button.primary { color: #04121d; background: var(--cyan); border-color: transparent; font-weight: 700; box-shadow: 0 0 24px -10px rgba(0, 209, 249, .95); }
  button.primary:hover { color: #04121d; background: var(--cyan-soft); box-shadow: 0 0 30px -8px rgba(0, 209, 249, 1); }
  button.approve { color: #6ee7b7; background: rgba(52, 211, 153, .12); border-color: rgba(52, 211, 153, .4); }
  button.approve:hover { color: #a7f3d0; background: rgba(52, 211, 153, .2); border-color: rgba(52, 211, 153, .6); }
  button.reject { color: #fca5a5; background: rgba(248, 113, 113, .1); border-color: rgba(248, 113, 113, .35); }
  button.reject:hover { color: #fecaca; background: rgba(248, 113, 113, .18); border-color: rgba(248, 113, 113, .55); }
  button.kill { color: #fff; font-weight: 700; letter-spacing: .03em; background: #dc2626; border-color: transparent; box-shadow: 0 0 24px -10px rgba(239, 68, 68, .95); }
  button.kill:hover { color: #fff; background: #ef4444; }

  /* ── Banners, states ─────────────────────────────────────────────────── */
  .banner {
    display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; margin: 1.1rem 0; font-size: .89rem;
    padding: .85rem 1.05rem; border: 1px solid var(--line-soft); border-left: 3px solid var(--muted);
    border-radius: var(--r); background: var(--surface);
  }
  .banner.ok { border-color: rgba(52, 211, 153, .22); border-left-color: var(--ok); background: linear-gradient(90deg, rgba(52, 211, 153, .1), rgba(52, 211, 153, .02)); }
  .banner.warn { border-color: rgba(251, 191, 36, .25); border-left-color: var(--warn); background: linear-gradient(90deg, rgba(251, 191, 36, .12), rgba(251, 191, 36, .02)); }
  .banner.engaged { border-color: rgba(248, 113, 113, .3); border-left-color: var(--danger); background: linear-gradient(90deg, rgba(248, 113, 113, .14), rgba(248, 113, 113, .03)); }

  p.jump { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 1.2rem; }
  p.jump a {
    font-size: .78rem; font-weight: 600; padding: .3rem .75rem; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--line-soft); color: var(--muted);
  }
  p.jump a:hover { color: var(--cyan); border-color: var(--line); text-decoration: none; }

  /* One muted line, not an illustration — this is an internal tool. */
  .empty { padding: 1.5rem; border: 1px dashed var(--line-soft); border-radius: var(--r); text-align: center; font-weight: 300; color: var(--muted); font-size: .89rem; }
  small { font-size: .8rem; }
  .muted { color: var(--muted); }
  code { font-family: var(--font-mono); font-size: .82em; color: var(--cyan-soft); background: rgba(0, 209, 249, .1); border: 1px solid rgba(0, 209, 249, .16); padding: .05rem .35rem; border-radius: 6px; }
  .sev-day7 { color: #fca5a5; font-weight: 700; }
  .sev-day5 { color: #fcd34d; font-weight: 600; }

  /* ── Planned surfaces ────────────────────────────────────────────────────
     A page whose function is not built says so. It never renders sample rows
     or a placeholder figure: an invented number reads as data. */
  .planned { display: flex; align-items: flex-start; gap: .9rem; }
  /* Feature pill card: cyan left-accent line, one idea per card. */
  .feature { padding-left: 1.5rem; }
  .feature::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--cyan); opacity: .8; }
  .feature h3 { margin: 0 0 .3rem; font-size: .95rem; }
  .feature p { margin: 0; font-size: .87rem; font-weight: 300; color: var(--muted); }
  .planned .glyph {
    flex: none; display: flex; align-items: center; justify-content: center;
    width: 2.6rem; height: 2.6rem; border-radius: 12px;
    color: var(--periwinkle); background: rgba(136, 136, 255, .12); border: 1px solid rgba(136, 136, 255, .25);
  }
  .planned h3 { margin: 0 0 .25rem; }
  .planned p { margin: 0 0 .5rem; font-weight: 300; color: var(--muted); font-size: .89rem; }
  .planned ul { margin: .5rem 0 0; padding-left: 1.1rem; font-size: .86rem; font-weight: 300; color: var(--muted); }
  .planned li { margin: .2rem 0; }
  .planned li b { font-weight: 600; color: var(--ink); }
  .badge {
    display: inline-flex; align-items: center; gap: .35rem; padding: .18rem .55rem; border-radius: 999px;
    font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
    color: var(--periwinkle); background: rgba(136, 136, 255, .12); border: 1px solid rgba(136, 136, 255, .3);
  }
  .badge.wired { color: var(--cyan); background: rgba(0, 209, 249, .1); border-color: var(--line); }

  /* ── Chat ────────────────────────────────────────────────────────────── */
  .turn { display: flex; flex-direction: column; gap: .3rem; margin: 0 0 1.15rem; max-width: min(46rem, 100%); }
  .turn.user { margin-left: auto; align-items: flex-end; text-align: right; }
  .turn .who { font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  .turn .bubble { padding: .8rem 1.05rem; border-radius: var(--r); white-space: pre-wrap; font-size: .93rem; font-weight: 300; border: 1px solid var(--line-soft); background: var(--surface); }
  .turn.user .bubble { border-color: var(--line); border-bottom-right-radius: 4px; background: rgba(0, 209, 249, .1); }
  .turn.arcadia .bubble { border-left: 3px solid var(--cyan); border-bottom-left-radius: 4px; }
  .turn.arcadia.escalated .bubble { border-color: rgba(251, 191, 36, .3); border-left-color: var(--warn); background: rgba(251, 191, 36, .07); }
  .turn small { font-size: .75rem; }
  .composer {
    position: sticky; bottom: 0; margin-top: 1.5rem; padding: .95rem 0 1.2rem;
    background: linear-gradient(180deg, rgba(10, 22, 40, .75), var(--navy) 35%);
    backdrop-filter: blur(10px); border-top: 1px solid var(--line-soft);
  }
  .composer input[type=text] { width: 100%; padding: .75rem .95rem; font-size: .95rem; border-radius: 12px; }
  .composer p { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: .55rem 0 0; }

  footer {
    display: flex; align-items: center; gap: .55rem; margin-top: 2rem; padding: 1.1rem 0 1.5rem;
    border-top: 1px solid var(--line-soft); color: var(--muted); font-size: .76rem; font-weight: 300;
  }

  /* ── Narrow viewports ────────────────────────────────────────────────────
     The rail becomes a top strip; nav items scroll horizontally as pills.
     Server-rendered with no client JS, so there is no drawer to toggle. */
  @media (max-width: 900px) {
    body { overflow: auto; }
    .app { flex-direction: column; height: auto; overflow: visible; }
    .sidebar { width: 100%; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
    .brand { padding: .9rem 1rem .7rem; }
    .cta { margin: 0 1rem .8rem; }
    .sidebar-nav { display: flex; gap: .35rem; overflow-x: auto; padding: 0 1rem .7rem; }
    /* Group labels do not fit a strip; a divider keeps the groups legible. */
    .navgroup { margin: 0; display: flex; gap: .35rem; }
    .navgroup + .navgroup { padding-left: .35rem; border-left: 1px solid var(--line-soft); }
    .navgroup-label { display: none; }
    .navgroup ul { flex-direction: row; gap: .35rem; }
    .navitem { white-space: nowrap; border: 1px solid var(--line-soft); }
    .navitem.active { box-shadow: none; border-color: var(--line); }
    .sidebar-foot { border-top: 1px solid var(--line-soft); }
    .usermenu .menu { bottom: auto; top: calc(100% + .35rem); }
    .content { overflow: visible; }
    main { overflow: visible; padding: 1.1rem 1rem .5rem; }
    .topbar { padding: .6rem 1rem; }
    h1 { font-size: 1.5rem; }
    table { display: block; overflow-x: auto; }
    input[type=text] { min-width: 0; width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .content::after { animation: none; }
    * { transition: none !important; }
  }
`;

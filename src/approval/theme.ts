// The whole visual system: one dark surface, sky blue as the only accent.
// Green, amber and red are reserved for verdicts (approved, degraded, failed),
// so a colour on this surface always means the same thing.
//
// Kept free of Worker imports so it can be rendered and reviewed on its own.
export const styles = `
  :root {
    --bg: #070b11; --bg-soft: #0b1219; --surface: #0f1822; --surface-2: #152130;
    --line: #1e2d3d; --line-soft: #172230;
    --text: #e8eff7; --dim: #8fa4ba;
    --primary: #38bdf8; --primary-soft: #7dd3fc; --primary-deep: #0ea5e9;
    --ok: #34d399; --warn: #fbbf24; --danger: #f87171;
    --r: 12px; --w: 70rem;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0; font-size: 15px; line-height: 1.55; color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(900px 460px at 50% -280px, rgba(56,189,248,.20), transparent 68%),
      radial-gradient(700px 420px at 100% 0, rgba(14,165,233,.09), transparent 62%),
      var(--bg);
    background-attachment: fixed;
  }
  a { color: var(--primary); text-decoration: none; }
  a:hover { color: var(--primary-soft); text-decoration: underline; text-underline-offset: 3px; }

  .topbar { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--line);
    background: rgba(7,11,17,.78); backdrop-filter: blur(12px); }
  .bar { max-width: var(--w); margin: 0 auto; padding: .7rem 1.25rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: .5rem; color: var(--text); font-weight: 700; font-size: 1rem; letter-spacing: -.01em; }
  .brand:hover { color: var(--primary-soft); text-decoration: none; }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--primary); box-shadow: 0 0 12px var(--primary); flex: none; }
  nav { display: flex; align-items: center; gap: .25rem; flex-wrap: wrap; margin-left: auto; }
  nav a, nav strong { font-size: .83rem; font-weight: 600; padding: .35rem .75rem; border-radius: 999px; border: 1px solid transparent; color: var(--dim); }
  nav a:hover { color: var(--primary-soft); background: rgba(56,189,248,.08); text-decoration: none; }
  nav strong { color: var(--primary); background: rgba(56,189,248,.12); border-color: rgba(56,189,248,.3); }
  nav a.out { opacity: .65; }

  main { max-width: var(--w); margin: 0 auto; padding: 1.6rem 1.25rem 4rem; }
  footer { max-width: var(--w); margin: 0 auto; padding: 1.3rem 1.25rem 2.5rem; display: flex; align-items: center; gap: .55rem;
    border-top: 1px solid var(--line-soft); color: var(--dim); font-size: .76rem; }

  .pagehead { padding-bottom: 1.15rem; margin-bottom: 1.3rem; border-bottom: 1px solid var(--line-soft); }
  h1 { margin: 0 0 .3rem; font-size: 1.6rem; font-weight: 700; letter-spacing: -.02em; }
  .lede { margin: 0; color: var(--dim); font-size: .89rem; max-width: 46rem; }
  .who-row { display: flex; flex-wrap: wrap; gap: .35rem; margin: .7rem 0 0; }
  .tag { font-size: .72rem; font-weight: 600; padding: .2rem .6rem; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--line); color: var(--dim); }
  .tag.role { color: var(--primary-soft); background: rgba(56,189,248,.1); border-color: rgba(56,189,248,.28); }

  h2 { display: flex; align-items: center; gap: .55rem; margin: 2.4rem 0 .85rem;
    font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .14em; color: var(--primary-soft); }
  h2::before { content: ""; width: .38rem; height: .38rem; border-radius: 50%; background: var(--primary); box-shadow: 0 0 10px rgba(56,189,248,.9); }
  h3 { margin: 1.5rem 0 .5rem; font-size: .92rem; font-weight: 600; color: var(--text); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; margin: 1.2rem 0 1.6rem; }
  .stat { position: relative; overflow: hidden; padding: .8rem 1rem; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); }
  .stat::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--primary); opacity: .8; }
  .stat.warn::after { background: var(--warn); } .stat.warn .v { color: #fcd34d; }
  .stat.danger::after { background: var(--danger); } .stat.danger .v { color: #fca5a5; }
  .stat.ok::after { background: var(--ok); }
  .stat .k { display: block; font-size: .69rem; font-weight: 600; text-transform: uppercase; letter-spacing: .1em; color: var(--dim); }
  .stat .v { display: block; margin: .15rem 0 .1rem; font-size: 1.5rem; font-weight: 700; letter-spacing: -.02em; }
  .stat .n { font-size: .73rem; color: var(--dim); }

  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .85rem;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
  td, th { text-align: left; padding: .6rem .8rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th { background: var(--surface-2); font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: rgba(56,189,248,.04); }

  form { margin: 0 0 .9rem; }
  form.inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin: 0; }
  input[type=text], input[type=number], select, textarea {
    font: inherit; font-size: .86rem; color: var(--text); background: var(--bg-soft);
    border: 1px solid var(--line); border-radius: 9px; padding: .45rem .65rem; max-width: 100%;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=text] { min-width: 12rem; }
  textarea { width: 100%; min-height: 6rem; resize: vertical; }
  select { cursor: pointer; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(56,189,248,.15); }
  ::placeholder { color: #5b7085; }
  input[type=checkbox] { accent-color: var(--primary); width: 1rem; height: 1rem; vertical-align: -.15rem; }
  label { font-size: .86rem; color: var(--dim); }

  button { font: inherit; font-size: .83rem; font-weight: 600; color: var(--text); background: var(--surface-2);
    border: 1px solid var(--line); border-radius: 9px; padding: .45rem .9rem; cursor: pointer;
    transition: background .15s, border-color .15s, color .15s, box-shadow .15s; }
  button:hover { color: var(--primary-soft); background: rgba(56,189,248,.08); border-color: rgba(56,189,248,.5); }
  button.primary { color: #04121d; background: linear-gradient(180deg, var(--primary), var(--primary-deep));
    border-color: transparent; box-shadow: 0 6px 18px -9px rgba(56,189,248,.9); }
  button.primary:hover { color: #04121d; background: linear-gradient(180deg, var(--primary-soft), var(--primary)); }
  button.approve { color: #6ee7b7; background: rgba(52,211,153,.12); border-color: rgba(52,211,153,.4); }
  button.approve:hover { color: #a7f3d0; background: rgba(52,211,153,.2); border-color: rgba(52,211,153,.6); }
  button.reject { color: #fca5a5; background: rgba(248,113,113,.1); border-color: rgba(248,113,113,.35); }
  button.reject:hover { color: #fecaca; background: rgba(248,113,113,.18); border-color: rgba(248,113,113,.55); }
  button.kill { color: #fff; font-weight: 700; letter-spacing: .03em; background: linear-gradient(180deg, #ef4444, #b91c1c);
    border-color: transparent; box-shadow: 0 6px 18px -9px rgba(239,68,68,.9); }
  button.kill:hover { color: #fff; background: linear-gradient(180deg, #f87171, #dc2626); }

  .banner { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; margin: 1.1rem 0; font-size: .88rem;
    padding: .8rem 1rem; border: 1px solid var(--line); border-left: 3px solid var(--dim); border-radius: var(--r); background: var(--surface); }
  .banner.ok { border-color: rgba(52,211,153,.22); border-left-color: var(--ok);
    background: linear-gradient(90deg, rgba(52,211,153,.1), rgba(52,211,153,.02)); }
  .banner.warn { border-color: rgba(251,191,36,.25); border-left-color: var(--warn);
    background: linear-gradient(90deg, rgba(251,191,36,.12), rgba(251,191,36,.02)); }
  .banner.engaged { border-color: rgba(248,113,113,.3); border-left-color: var(--danger);
    background: linear-gradient(90deg, rgba(248,113,113,.14), rgba(248,113,113,.03)); }

  p.jump { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 1.2rem; }
  p.jump a { font-size: .78rem; font-weight: 600; padding: .3rem .7rem; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--line); color: var(--dim); }
  p.jump a:hover { color: var(--primary); border-color: rgba(56,189,248,.4); text-decoration: none; }

  .empty { padding: 1.5rem; border: 1px dashed var(--line); border-radius: var(--r); text-align: center; color: var(--dim); font-size: .88rem; }
  small { font-size: .8rem; }
  .muted { color: var(--dim); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82em; color: var(--primary-soft);
    background: rgba(56,189,248,.1); border: 1px solid rgba(56,189,248,.16); padding: .05rem .35rem; border-radius: 6px; }
  .sev-day7 { color: #fca5a5; font-weight: 700; }
  .sev-day5 { color: #fcd34d; font-weight: 600; }

  .turn { display: flex; flex-direction: column; gap: .3rem; margin: 0 0 1.15rem; max-width: min(44rem, 100%); }
  .turn.user { margin-left: auto; align-items: flex-end; text-align: right; }
  .turn .who { font-size: .69rem; font-weight: 600; text-transform: uppercase; letter-spacing: .1em; color: var(--dim); }
  .turn .bubble { padding: .75rem 1rem; border-radius: 14px; white-space: pre-wrap; font-size: .92rem;
    border: 1px solid var(--line); background: var(--surface); }
  .turn.user .bubble { border-color: rgba(56,189,248,.35); border-bottom-right-radius: 4px;
    background: linear-gradient(180deg, rgba(56,189,248,.18), rgba(56,189,248,.08)); }
  .turn.arcadia .bubble { border-left: 3px solid var(--primary); border-bottom-left-radius: 4px; }
  .turn.arcadia.escalated .bubble { border-color: rgba(251,191,36,.3); border-left-color: var(--warn); background: rgba(251,191,36,.07); }
  .turn small { font-size: .74rem; }
  .composer { position: sticky; bottom: 0; margin-top: 1.5rem; padding: .95rem 0 1.2rem;
    background: rgba(7,11,17,.9); backdrop-filter: blur(10px); border-top: 1px solid var(--line); }
  .composer input[type=text] { width: 100%; padding: .7rem .9rem; font-size: .95rem; border-radius: 11px; }
  .composer p { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: .55rem 0 0; }

  @media (max-width: 720px) {
    .bar { padding: .6rem .9rem; }
    nav { margin-left: 0; width: 100%; }
    main { padding: 1.2rem .9rem 3rem; }
    h1 { font-size: 1.35rem; }
    table { display: block; overflow-x: auto; }
    input[type=text] { min-width: 0; width: 100%; }
  }
`;

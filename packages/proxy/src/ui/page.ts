/** The operator page's HTML and CSS, as strings the daemon serves. The script is dist/ui/app.js. */

export const APP_CSS = `
:root { --bg: #0f1115; --panel: #161a22; --line: #262c38; --text: #e6e8ee; --muted: #9aa3b5; --accent: #5ac8a6; --bad: #f08a8a; --warn: #f0c674; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --panel: #ffffff; --line: #e1e4ea; --text: #1a1d24; --muted: #5f6775; --accent: #148a68; --bad: #b83b3b; --warn: #9a6b00; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
header.top { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; }
header.top h1 { font-size: 16px; margin: 0; font-weight: 600; }
header.top h1 span { color: var(--muted); font-weight: 400; }
nav a { color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 6px; }
nav a.active, nav a:hover { color: var(--text); background: var(--line); }
header.top .tools { margin-left: auto; display: flex; gap: 8px; align-items: center; }
select, input, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; }
button { background: var(--accent); color: #06130f; border-color: transparent; cursor: pointer; font-weight: 600; }
button.secondary { background: var(--line); color: var(--text); }
main { padding: 16px 20px; max-width: 1400px; }
#status { color: var(--warn); min-height: 1.4em; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
tr:last-child td { border-bottom: none; }
code, pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; overflow: auto; max-height: 240px; margin: 8px 0; }
article { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
article header { display: flex; gap: 10px; align-items: baseline; }
article header time { color: var(--muted); margin-left: auto; font-size: 12px; }
article footer { display: flex; gap: 8px; align-items: center; }
article footer code { color: var(--muted); margin-left: auto; }
article.orphaned { border-color: var(--warn); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--line); color: var(--muted); font-size: 12px; }
.pill.bad { background: rgba(240,138,138,.15); color: var(--bad); }
.intent { color: var(--accent); }
.suggestion { color: var(--muted); }
.empty { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card h3 { margin: 0 0 4px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
.card .big { font-size: 26px; margin: 0; font-weight: 600; }
.card p { margin: 2px 0; color: var(--muted); }
h3 { font-size: 14px; margin: 18px 0 8px; }
`;

export const indexHtml = (version: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Say Again?</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header class="top">
  <h1>Say Again? <span>${version}</span></h1>
  <nav>
    <a href="#holds" data-screen="holds">Holds</a>
    <a href="#servers" data-screen="servers">Servers</a>
    <a href="#deadletters" data-screen="deadletters">Dead letters</a>
    <a href="#ledger" data-screen="ledger">Ledger</a>
    <a href="#tools" data-screen="tools">Tools</a>
    <a href="#errors" data-screen="errors">Errors</a>
    <a href="#report" data-screen="report">Report</a>
  </nav>
  <div class="tools">
    <label>since <select id="since"><option value="24h">24 hours</option><option value="7d" selected>7 days</option><option value="30d">30 days</option><option value="90d">90 days</option></select></label>
    <button id="refresh" class="secondary">Refresh</button>
  </div>
</header>
<main>
  <div id="status"></div>
  <section id="screen-holds"><div id="holds"></div></section>
  <section id="screen-servers" hidden><div id="servers"></div></section>
  <section id="screen-deadletters" hidden><div id="deadletters"></div></section>
  <section id="screen-ledger" hidden><p><input id="ledger-filter" placeholder="filter by server, tool, status or class" size="48"></p><div id="ledger"></div></section>
  <section id="screen-tools" hidden><div id="tools"></div></section>
  <section id="screen-errors" hidden><div id="errors"></div></section>
  <section id="screen-report" hidden><div id="report"></div></section>
</main>
<script type="module" src="/ui/app.js"></script>
</body>
</html>
`;

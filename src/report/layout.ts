/**
 * Shared page furniture for the two HTML reports (`render.ts`), split out
 * because both renderers need the same document shell, CSS, client script and
 * table/section primitives, and a golden test for one should not have to
 * scroll past the other's markup to find the bit that differs.
 *
 * This module is the single place that calls `escapeHtml` / `escapeJsonForScript`
 * on a value being written into the page. `render.ts` only ever hands these
 * helpers plain, already-redacted strings and numbers — it never builds a
 * `<tag>` around a raw value itself — so there is exactly one place to audit
 * for the "everything is escaped" invariant the reports depend on.
 */

import { escapeHtml, escapeJsonForScript, REDACTION_NOTICE } from './redact.js'

/** Escape a value for HTML text or a quoted attribute. `null`/`undefined` render as empty. */
export function esc(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  return escapeHtml(String(value))
}

/** A quoted HTML attribute, name included, ready to splice into a tag. */
export function attr(name: string, value: string | number | boolean): string {
  return ` ${name}="${esc(value)}"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — pure, timezone-stable so golden tests are not machine-dependent
// ─────────────────────────────────────────────────────────────────────────────

/** `toLocaleString` pulls in ICU and varies by build; a hand-rolled thousands separator does not. */
export function formatInteger(n: number): string {
  const rounded = Math.round(n)
  const negative = rounded < 0
  const digits = Math.abs(rounded).toString()
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return negative ? `-${grouped}` : grouped
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return 'n/a'
  return `${((part / whole) * 100).toFixed(1)}%`
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

/** UTC ISO form — deterministic across the reader's and the report author's timezone alike. */
export function formatInstant(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return 'n/a'
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', ' UTC')
}

// ─────────────────────────────────────────────────────────────────────────────
// Document shell
// ─────────────────────────────────────────────────────────────────────────────

const STYLE = `
:root {
  color-scheme: light dark;
  --background: #ffffff;
  --foreground: #1a1d21;
  --muted: #5b6470;
  --border: #dde1e6;
  --accent: #1d5fd6;
  --card-background: #f5f6f8;
  --code-background: #f0f1f3;
  --warn-background: #fff6e0;
  --warn-border: #d9a400;
  --bad-background: #fdecec;
  --bad-border: #c9302c;
  --good-background: #e9f7ee;
  --good-border: #2f8a4b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --background: #14161a;
    --foreground: #e7e9ec;
    --muted: #9aa3ad;
    --border: #2c3138;
    --accent: #6ea2ff;
    --card-background: #1c1f24;
    --code-background: #1a1c20;
    --warn-background: #332a0d;
    --warn-border: #b58a1c;
    --bad-background: #3a1c1c;
    --bad-border: #e06c6c;
    --good-background: #163420;
    --good-border: #4caf6f;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--background);
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  padding: 16px;
}
main { max-width: 1000px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-top: 2em; }
h3 { font-size: 1rem; margin-bottom: 4px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.notice {
  background: var(--card-background);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 0.9rem;
  margin: 12px 0 20px;
}
.warning-line {
  background: var(--warn-background);
  border: 1px solid var(--warn-border);
  border-radius: 6px;
  padding: 8px 12px;
  margin: 10px 0;
  font-size: 0.9rem;
}
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
.card {
  background: var(--card-background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 140px;
  flex: 1 1 140px;
}
.card .label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
.card .value { font-size: 1.3rem; font-weight: 600; }
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 0.8rem;
  border: 1px solid var(--border);
  background: var(--card-background);
}
.badge-good { background: var(--good-background); border-color: var(--good-border); }
.badge-bad { background: var(--bad-background); border-color: var(--bad-border); }
.badge-warn { background: var(--warn-background); border-color: var(--warn-border); }
.table-wrap { overflow-x: auto; margin: 10px 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; white-space: nowrap; }
td.wrap, th.wrap { white-space: normal; }
th { cursor: pointer; user-select: none; color: var(--muted); font-weight: 600; }
th.num, td.num { text-align: right; }
tr.empty-row td { color: var(--muted); font-style: italic; white-space: normal; }
tr.not-actionable { opacity: 0.75; }
.table-filter {
  display: block;
  margin-bottom: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--background);
  color: var(--foreground);
  width: 100%;
  max-width: 320px;
}
pre.log {
  background: var(--code-background);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.82rem;
}
details { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; margin: 8px 0; }
details > summary { cursor: pointer; font-weight: 600; }
code { background: var(--code-background); padding: 1px 4px; border-radius: 4px; }
ul.plain { margin: 4px 0; padding-left: 20px; }
footer { color: var(--muted); font-size: 0.8rem; margin-top: 2em; }
@media (max-width: 480px) {
  body { padding: 10px; }
  .card { min-width: 0; flex-basis: 100%; }
}
`

/**
 * Every table built with {@link sortableTable} carries its rows a second time
 * as JSON so this one script can re-render `<tbody>` on sort or filter
 * without ever touching `innerHTML` — the DOM is rebuilt node by node with
 * `textContent`, so a cell holding literal markup a job read from a file can
 * never be parsed as an element.
 */
const CLIENT_SCRIPT = `
(function () {
  function cellText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function renderRows(tbody, columns, rows, emptyMessage) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    if (rows.length === 0) {
      var tr = document.createElement('tr');
      tr.className = 'empty-row';
      var td = document.createElement('td');
      td.colSpan = columns.length;
      td.textContent = emptyMessage;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tr2 = document.createElement('tr');
      for (var c = 0; c < columns.length; c++) {
        var td2 = document.createElement('td');
        td2.textContent = cellText(row[columns[c].key]);
        if (columns[c].numeric) td2.className = 'num';
        tr2.appendChild(td2);
      }
      tbody.appendChild(tr2);
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('table[data-sortable]'), function (table) {
    var id = table.id;
    var dataScript = document.querySelector('script[data-rows-for="' + id + '"]');
    if (!dataScript) return;
    var rows;
    try {
      rows = JSON.parse(dataScript.textContent);
    } catch (e) {
      return;
    }
    var headerCells = table.querySelectorAll('thead th');
    var columns = Array.prototype.map.call(headerCells, function (th) {
      return { key: th.getAttribute('data-key'), numeric: th.classList.contains('num') };
    });
    var tbody = table.querySelector('tbody');
    var emptyMessage = tbody.getAttribute('data-empty-message') || 'No rows.';
    var sortKey = null;
    var sortDir = 1;

    function currentFilter() {
      var input = document.querySelector('input[data-for="' + id + '"]');
      return input ? input.value.trim().toLowerCase() : '';
    }

    function refresh() {
      var term = currentFilter();
      var visible = rows;
      if (term) {
        visible = rows.filter(function (row) {
          return columns.some(function (col) {
            return cellText(row[col.key]).toLowerCase().indexOf(term) !== -1;
          });
        });
      }
      if (sortKey) {
        visible = visible.slice().sort(function (a, b) {
          var av = a[sortKey];
          var bv = b[sortKey];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          if (av < bv) return -1 * sortDir;
          if (av > bv) return 1 * sortDir;
          return 0;
        });
      }
      renderRows(tbody, columns, visible, emptyMessage);
    }

    Array.prototype.forEach.call(headerCells, function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (sortKey === key) {
          sortDir = -sortDir;
        } else {
          sortKey = key;
          sortDir = 1;
        }
        refresh();
      });
    });

    var filterInput = document.querySelector('input[data-for="' + id + '"]');
    if (filterInput) filterInput.addEventListener('input', refresh);
  });
})();
`

/**
 * Wraps a page body in the shared shell: a single self-contained `.html`
 * document, no external resource of any kind (docs/.local/13-usage-and-
 * debug-records.md §4 — "no CDN, no font, no image URL").
 */
export function renderDocument(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    `<html lang="en">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<main>${bodyHtml}</main>`,
    `<script>${CLIENT_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** The fixed disclosure paragraph every report opens with, plus the level it was run at. */
export function renderRedactionNotice(level: 'default' | 'strict'): string {
  return [
    '<div class="notice">',
    `<p>${esc(REDACTION_NOTICE)}</p>`,
    `<p><strong>Redaction level for this report: ${esc(level)}.</strong></p>`,
    '</div>',
  ].join('\n')
}

export function section(title: string, bodyHtml: string, note?: string): string {
  return [
    `<section>`,
    `<h2>${esc(title)}</h2>`,
    note ? `<p class="muted">${esc(note)}</p>` : '',
    bodyHtml,
    `</section>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n')
}

export function collapsible(summary: string, bodyHtml: string, openByDefault = false): string {
  return `<details${openByDefault ? ' open' : ''}><summary>${esc(summary)}</summary>${bodyHtml}</details>`
}

export function warningLine(text: string): string {
  return `<div class="warning-line">${esc(text)}</div>`
}

export interface Card {
  label: string
  value: string | number
}

export function cards(items: Card[]): string {
  return [
    '<div class="cards">',
    ...items.map(
      (c) => `<div class="card"><div class="label">${esc(c.label)}</div><div class="value">${esc(c.value)}</div></div>`,
    ),
    '</div>',
  ].join('\n')
}

export type BadgeTone = 'default' | 'good' | 'bad' | 'warn'

export function badge(text: string, tone: BadgeTone = 'default'): string {
  const toneClass = tone === 'default' ? '' : ` badge-${tone}`
  return `<span class="badge${toneClass}">${esc(text)}</span>`
}

/** A plain two-column fact table — no sorting, no filtering, just labelled values. */
export function keyValueTable(rows: Array<[label: string, value: string | number | null]>): string {
  const body = rows
    .map(([label, value]) => `<tr><th class="wrap">${esc(label)}</th><td class="wrap">${esc(value ?? 'n/a')}</td></tr>`)
    .join('\n')
  return `<div class="table-wrap"><table><tbody>${body}</tbody></table></div>`
}

export function preBlock(text: string): string {
  return `<pre class="log">${esc(text)}</pre>`
}

export function plainList(items: string[], emptyMessage = 'none'): string {
  if (items.length === 0) return `<p class="muted">${esc(emptyMessage)}</p>`
  return `<ul class="plain">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
}

export interface TableColumn {
  key: string
  label: string
  numeric?: boolean
}

/**
 * A table rendered twice: once as ordinary `<tbody>` markup so the report
 * reads correctly even if a viewer's JavaScript is disabled, and once as a
 * `<script type="application/json">` payload the client script uses to
 * re-render on sort or filter. `rows` must already have passed through
 * `redactText` — this function only escapes for HTML/JSON safety, it does
 * not know what a secret looks like.
 */
export function sortableTable(
  id: string,
  columns: TableColumn[],
  rows: Array<Record<string, string | number | null>>,
  emptyMessage = 'No rows.',
): string {
  const theadCells = columns
    .map((c) => `<th data-key="${esc(c.key)}"${c.numeric ? ' class="num"' : ''}>${esc(c.label)}</th>`)
    .join('')
  const bodyRows =
    rows.length === 0
      ? `<tr class="empty-row"><td colspan="${columns.length}">${esc(emptyMessage)}</td></tr>`
      : rows
          .map(
            (row) =>
              `<tr>${columns.map((c) => `<td${c.numeric ? ' class="num"' : ''}>${esc(row[c.key])}</td>`).join('')}</tr>`,
          )
          .join('')

  return [
    '<div class="table-wrap">',
    rows.length > 5
      ? `<input type="search" class="table-filter" data-for="${esc(id)}" placeholder="Filter…" aria-label="Filter table">`
      : '',
    `<table id="${esc(id)}" data-sortable>`,
    `<thead><tr>${theadCells}</tr></thead>`,
    `<tbody data-empty-message="${esc(emptyMessage)}">${bodyRows}</tbody>`,
    '</table>',
    `<script type="application/json" data-rows-for="${esc(id)}">${escapeJsonForScript(rows)}</script>`,
    '</div>',
  ]
    .filter((s) => s.length > 0)
    .join('\n')
}

/**
 * A minimal inline line-chart, drawn by hand rather than pulling in a
 * charting library (§4: "no chart library, no external anything"). Two
 * series share one baseline so job count and token volume can be read
 * against the same day axis; each is normalised to its own maximum since
 * token totals dwarf job counts by orders of magnitude.
 */
export function sparklineSvg(
  days: string[],
  primary: number[],
  secondary: number[],
  labels: { primary: string; secondary: string },
): string {
  const width = 600
  const height = 120
  const paddingLeft = 4
  const paddingRight = 4
  const top = 10
  const bottom = 20

  if (days.length === 0) {
    return `<p class="muted">No days in this window.</p>`
  }

  const plot = (values: number[], color: string): string => {
    const max = Math.max(1, ...values)
    const step = days.length > 1 ? (width - paddingLeft - paddingRight) / (days.length - 1) : 0
    const points = values
      .map((v, i) => {
        const x = paddingLeft + step * i
        const y = height - bottom - ((height - top - bottom) * v) / max
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" />`
  }

  const lastDay = days[days.length - 1] ?? ''
  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Jobs and tokens by day, ending ${esc(lastDay)}">`,
    plot(primary, 'var(--accent)'),
    plot(secondary, 'var(--muted)'),
    `<text x="${paddingLeft}" y="${height - 4}" font-size="10" fill="var(--muted)">${esc(days[0] ?? '')}</text>`,
    `<text x="${width - paddingRight}" y="${height - 4}" font-size="10" text-anchor="end" fill="var(--muted)">${esc(lastDay)}</text>`,
    '</svg>',
    `<p class="muted">Solid line: ${esc(labels.primary)}. Grey line: ${esc(labels.secondary)}, each scaled to its own maximum.</p>`,
  ].join('\n')
}

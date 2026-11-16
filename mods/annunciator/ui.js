// annunciator: shared drawing kit — fixed character columns, rules, bars, sparklines.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";

export const FONT = "Berkeley Mono";
export const SIZE = 12;      // px, every piece of text
export const ROW = 16;       // px, every table row
export const CH = 7.2;       // px per character at 12 px (Berkeley Mono advance is 0.6 em)

// The four state hues, plus blue-grey for structure (rules, dividers, headers).
// Everything else is grey.
export function palette() {
  const t = theme();
  return {
    t,
    fg: t.foreground, muted: t.muted, dim: t.dim, rule: t.border, bg: t.background,
    amber: t.blocked ?? "#ffb700",
    red: "#ff4136",
    green: t.done ?? "#3fbf74",
    sel: t.selected,   // a neutral grey: focus is shown by weight and rules, never by hue
    head: "#8494a8",   // blue-grey: region names and column headers
    headRule: "#465263", // blue-grey: the rule under column headers (the theme border is the lighter one)
  };
}

export const levelColor = (c, l) => (l === "crit" ? c.red : l === "warn" ? c.amber : null);

// A fixed-width cell: never wraps, clips with an ellipsis.
export function cell(text, chars, opts = {}) {
  let el = div().flex_none().overflow_hidden().whitespace_nowrap().truncate();
  el = chars === "rest" ? el.flex_1().min_w(0) : el.w(chars * CH);
  if (opts.right) el = el.text_right();
  if (opts.color) el = el.text_color(opts.color);
  if (opts.bold) el = el.font_weight(700);
  if (opts.italic) el = el.italic();
  if (opts.underline) el = el.underline();
  return el.child(text == null || text === "" ? (opts.blank ? "" : "—") : String(text));
}

// A table row: optional 3 px status bar on the left, then cells.
export function row(id, cells, opts = {}) {
  const c = palette();
  let el = h_flex().id(id).h(ROW).flex_none().items_center().gap(CH).pr(CH).border_l(3)
    .border_color(opts.bar ?? "#00000000");
  if (opts.bg) el = el.bg(opts.bg);
  if (opts.onClick) el = el.cursor_pointer().hover((s) => s.bg(c.t.hover)).on_click(opts.onClick);
  return el.pl(CH - 3).children(cells);
}

// Header row: lowercase dim column names on a foreground rule.
export function header(id, cells) {
  const c = palette();
  return h_flex().id(id).h(ROW).flex_none().items_center().gap(CH).pl(CH).pr(CH).border_b(1).border_color(c.headRule)
    .text_color(c.head).children(cells);
}

// Region title in the border line: NAME  headline · detail
export function title(id, name, parts = [], right = null) {
  const c = palette();
  return h_flex().id(id).h(ROW + 2).flex_none().items_center().gap(CH).px(CH).border_b(1).border_color(c.rule)
    .child(div().flex_none().font_weight(700).text_color(c.head).child(name))
    .children(parts.map((p, i) => (typeof p === "string" ? div().flex_none().text_color(c.dim).child(p) : p)))
    .child(div().flex_1())
    .when(Boolean(right), (el) => el.child(right));
}

// A clickable word, for toggles in a title line. On: full-strength and underlined; off: dim.
export function toggle(id, label, on, onClick) {
  const c = palette();
  return div().id(id).flex_none().px(4).cursor_pointer().text_color(on ? c.fg : c.dim)
    .when(on, (el) => el.underline())
    .hover((s) => s.text_color(c.fg)).on_click(onClick).child(label);
}

const BLOCKS = "▁▂▃▄▅▆▇█";
// Word-sized graph: one block glyph per sample, scaled to `max` (or the series max).
export function spark(values, width, max = null) {
  const v = values.slice(-width);
  const top = max ?? Math.max(1e-9, ...v);
  const s = v.map((x) => (x == null ? " " : BLOCKS[Math.max(0, Math.min(7, Math.round((x / top) * 7)))])).join("");
  return s.padStart(width, " ");
}

// A filled bar: █ for the share, ░ for the rest.
export function bar(frac, width) {
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const n = Math.round(f * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

// ── number formats: fixed width so columns don't jitter ─────────────────────
export function bytes(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0; let v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)}${u[i]}`;
}
export const pct = (v) => (v == null || isNaN(v) ? "—" : `${Math.round(v)}%`);
export const deg = (v) => (v == null ? "—" : `${Math.round(v)}°`);

export function ago(ms) {
  if (ms == null || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}`;
}

export function clock(ms, secs = true) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}${secs ? ":" + p(d.getSeconds()) : ""}`;
}

// ── agent state: one shape per state, so it reads without color or a word ───
// (Berkeley Mono has no hollow circle, so idle is a flat line and exited is ø.)
const SPIN = ["▖", "▘", "▝", "▗"];
export const GLYPH = { working: "▖", blocked: "■", error: "×", done: "•", idle: "–", exited: "ø" };
export const WORD = { blocked: "needs you", error: "error", done: "done", working: "working", idle: "idle", exited: "exited" };

export function stateColor(c, s) {
  return s === "blocked" ? c.amber : s === "error" ? c.red : s === "done" ? c.green : s === "working" ? c.fg : c.dim;
}
export function stateBar(c, s) {
  return s === "blocked" ? c.amber : s === "error" ? c.red : s === "done" ? c.green : null;
}
export function glyph(c, s, id) {
  const base = div().id(id).flex_none().w(2 * CH).text_color(stateColor(c, s));
  if (s === "working") return base.frames(SPIN, 150).child(SPIN[0]);
  return base.child(GLYPH[s] ?? GLYPH.idle);
}

// Fit columns to a width in px: drop the lowest `drop` first; columns without `drop` always stay.
export function fit(cols, width) {
  const chars = Math.floor((width || 100000) / CH) - 2;
  const need = (cs) => cs.reduce((n, c) => n + (c.w === "rest" ? c.min ?? 12 : c.w) + 1, 1);
  let cs = [...cols];
  while (need(cs) > chars) {
    const victim = cs.filter((c) => c.drop != null).sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    cs = cs.filter((c) => c !== victim);
  }
  return cs;
}

// Rows of a fitted table: `vals` maps column key -> [text, cell opts].
export function fitted(cols, vals) {
  return cols.map((c) => { const [text, o] = vals[c.k] ?? ["", { blank: true }]; return cell(text, c.w, { right: c.right, ...o }); });
}
export const fittedHead = (cols) => cols.map((c) => cell(c.label ?? c.k, c.w, { right: c.right, blank: true }));

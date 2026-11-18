// annunciator — one dense, terminal-like pane of glass over every agent and the machine.
// One mod, several regions: the layout gives each block a `role` prop
// (top, roster, events, pane, system, procs, repos, containers, limits, foot, wall, nav).
// Grey when normal; blue-grey for structure (rules, headers); amber = needs you, red = error, green = done (unseen). Focus has no hue: it is a heavier rule, a neutral tint or an underline.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, run, panes, agents, focused, keys, window, setAgentOrder, terminals, spaces, layout, nextCommand } from "herdr";
import {
  store, roster, trackEvents, noteLevel, level, LIMITS, RANK, shortPath,
  probeSystem, probeSensors, probeDf, probePs, probeCore, probeRepos, probeScreen, treeUsage, ownerOf,
  probeContainers, probeDockerStats, probeLimits,
} from "./data.js";
import {
  FONT, SIZE, ROW, CH, palette, cell, row, header, title, toggle, spark, bar,
  bytes, pct, deg, ago, clock, WORD, GLYPH, stateColor, stateBar, glyph, levelColor, fit, fitted, fittedHead, loadConfig,
} from "./ui.js";
import { wallCommand } from "./wall.js";

const EV_COLS = [
  { k: "time", w: 8 },
  { k: "where", w: 18, drop: 1 },
  { k: "change", w: 20 },
  { k: "detail", w: "rest", min: 12 },
];
const PS_COLS = [
  { k: "pid", w: 7, right: true, drop: 2 },
  { k: "cpu", w: 5, right: true },
  { k: "mem", w: 6, right: true, drop: 3 },
  { k: "time", w: 5, right: true, drop: 1 },
  { k: "agent", w: 17, drop: 4 },
  { k: "command", w: "rest", min: 12 },
];
const CT_COLS = [
  { k: "name", w: 22 },
  { k: "state", w: 10 },
  { k: "for", w: 5, right: true },
  { k: "restarts", w: 8, right: true, drop: 3 },
  { k: "cpu", w: 5, right: true, drop: 2 },
  { k: "mem", w: 6, right: true, drop: 4 },
  { k: "ports", w: "rest", min: 8, drop: 1 },
];
const REPO_COLS = [
  { k: "repo", w: 14 },
  { k: "branch", w: 18 },
  { k: "dirty", w: 5, right: true },
  { k: "ahead", w: 5, right: true, drop: 3 },
  { k: "behind", w: 6, right: true, drop: 2 },
  { k: "agents", w: 6, right: true, drop: 4 },
  { k: "path", w: "rest", min: 10, drop: 1 },
];

const ROLES = ["top", "roster", "events", "pane", "system", "procs", "repos", "foot", "wall", "containers", "nav", "limits"];

// Roster columns, in display order. `drop`: lower goes first when space runs out.
const COLS = [
  { k: "task", w: 26, drop: 99 },
  { k: "where", w: 18, drop: 98 },
  { k: "branch", w: 14, drop: 90 },
  { k: "for", w: 6, right: true, drop: 99 },
  { k: "age", w: 6, right: true, drop: 1 },
  { k: "cpu", w: 5, right: true, drop: 91 },
  { k: "mem", w: 6, right: true, drop: 6 },
  { k: "doing", w: "rest", min: 24, drop: 99 },
];

export default class Annunciator extends View {
  init(_p, cx) {
    const role = props()?.role ?? _p?.role;
    this.role = ROLES.includes(role) ? role : "roster";
    // config.json (temperature unit) is read once per load; redraw when it lands.
    cx.spawn(async (cx) => { await loadConfig(); cx.notify(); });
    this.size = { width: 0, height: 0 };
    this.prefs = load("prefs", { faults: false, sort: "order", folded: [] });
    this.folded = new Set(this.prefs.folded);
    const every = (ms, fn) => { fn(cx); cx.timer.every(ms, fn); };

    if (this.role === "roster") {
      every(5000, (cx) => cx.spawn(async (cx) => {
        await Promise.all([probePs(), probeCore()]);
        // The question a blocked agent is asking: read its screen once per state change.
        for (const r of roster()) if (r.status === "blocked") await probeScreen(r.address, r.since).catch(() => {});
        cx.notify();
      }));
      // alt-up / alt-down (annunciator.prev / .next): step through every row of the tree, shells
      // and mod panes included, in the order shown; wraps at the ends. Only the agent tree
      // listens, so the key acts once however many regions are shown.
      this.navOrder = [];
      cx.spawn(async () => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd !== "next" && cmd !== "prev") continue;
          const order = this.navOrder;
          if (!order.length) continue;
          const i = order.indexOf(focused()?.pane);
          const j = i < 0 ? (cmd === "next" ? 0 : order.length - 1) : (i + (cmd === "next" ? 1 : -1) + order.length) % order.length;
          run("pane.focus", { pane: order[j] });
        }
      });
    }
    if (this.role === "system") {
      every(2000, (cx) => cx.spawn(async (cx) => {
        await Promise.all([probeSystem(), probeSensors(), probeDf()]);
        cx.notify();
      }));
    }
    if (this.role === "limits") every(10000, (cx) => cx.spawn(async (cx) => { await probeLimits(); cx.notify(); }));
    if (this.role === "procs") every(5000, (cx) => cx.spawn(async (cx) => { await probePs(); cx.notify(); }));
    if (this.role === "repos") {
      every(30000, (cx) => cx.spawn(async (cx) => {
        const folders = [...new Set(panes().map((q) => q.cwd).filter(Boolean))];
        await probeRepos(folders);
        cx.notify();
      }));
    }
    if (this.role === "containers") {
      this.open = new Set(load("ctOpen", []));
      // Show the last list at once after a reload or restart, until the first read lands.
      if (store.containers == null) {
        const last = load("ctLast", null);
        if (Array.isArray(last?.list)) { store.containers = last.list; store.dstats = last.stats ?? {}; store.stamp.containersOk = last.at; }
      }
      every(10000, (cx) => cx.spawn(async (cx) => {
        await Promise.all([probeContainers(), probeDockerStats()]);
        if (Array.isArray(store.containers) && !store.ctFails) save("ctLast", { list: store.containers, stats: store.dstats, at: store.stamp.containersOk });
        cx.notify();
      }));
    }
    if (this.role === "events") {
      // Restore the log once per app run; the shared store holds it after that.
      if (!store.events.length) for (const e of load("events2", [])) store.events.push(e);
      this.saved = eventsMark();
    }
    if (this.role === "top") {
      // Probes are shared: with a system panel shown this costs nothing extra.
      // Without one (annunciator-narrow) the top bar is where offending metrics show up.
      let last = "";
      every(5000, (cx) => cx.spawn(async (cx) => {
        await Promise.all([probeSystem(), probeSensors(), probeDf(), probeLimits()]);
        const now = JSON.stringify(levels());
        if (now !== last) { last = now; cx.notify(); }
      }));
      cx.timer.every(10000, (cx) => cx.notify());
    }
    if (this.role === "pane") cx.timer.every(30000, (cx) => cx.notify());
    if (this.role === "wall") {
      // The roster isn't shown on the wall, so its headers keep the shared probes fresh
      // (each probe runs once per interval however many copies ask).
      every(5000, (cx) => cx.spawn(async (cx) => {
        await probeCore();
        const r = roster().find((x) => x.address === props()?.terminal);
        if (r?.status === "blocked") await probeScreen(r.address, r.since).catch(() => {});
        cx.notify();
      }));
    }
    // nav: a 0 px copy that takes the agent wall's key commands (wall.js). The layouts keep one
    // shown at all times, and the wall carries its own, so the keys work on and off the wall.
    if (this.role === "nav") {
      cx.spawn(async () => { for (;;) wallCommand(await nextCommand()); });
    }
  }

  savePrefs() {
    this.prefs.folded = [...this.folded];
    save("prefs", this.prefs);
  }

  render(cx) {
    const c = palette();
    const root = v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(c.bg).font_family(FONT).text_size(SIZE).text_color(c.fg)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    const body = this[this.role](c, cx);
    return root.child(body);
  }

  nav() { return div(); }

  // ── top: who needs you, system offenders, clock (narrow only), window buttons ──
  top(c) {
    const rows = roster();
    trackEvents(rows);
    const now = Date.now();
    const attention = [...rows].filter((r) => r.status === "blocked" || r.status === "error")
      .sort((a, b) => (RANK[b.status] - RANK[a.status]) || (a.since ?? 0) - (b.since ?? 0));
    const offenders = Object.entries(store.levels).filter(([, l]) => l !== "ok");
    const w = window();
    const btn = (id, label, cmd) => div().id(id).flex_none().px(CH).text_color(c.dim).cursor_pointer()
      .hover((s) => s.text_color(c.fg)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run(cmd)).child(label);
    // No counts: this bar only names what needs you, and is empty when nothing does.
    return h_flex().size_full().items_center().gap(CH * 2).pl(CH).border_b(1).border_color(c.rule)
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(CH * 2).whitespace_nowrap()
        .children(attention.map((r) => h_flex().id(`att-${r.address}`).flex_none().gap(CH).cursor_pointer()
          .hover((s) => s.bg(c.t.hover)).on_click(() => run("pane.focus", { pane: r.pane }))
          .child(div().text_color(stateColor(c, r.status)).child(r.status === "blocked" ? "■" : "×"))
          .child(div().text_color(c.fg).child(r.task))
          .child(div().text_color(c.dim).child(r.where))
          .child(div().text_color(stateColor(c, r.status)).child(`${WORD[r.status]} ${ago(now - (r.since ?? now))}`)))))
      .children(offenders.map(([k, l]) => div().flex_none().text_color(levelColor(c, l)).child(offenderText(k))))
      // The SYSTEM panel's title carries the clock; only a layout without it (narrow) shows one here.
      .when(!hasNode(layout(), "system"), (el) => el.child(div().flex_none().text_color(c.muted).child(clock(now, false))))
      .when(Boolean(w?.buttons), (el) => el
        .child(btn("win-min", "─", "window.minimize"))
        .child(btn("win-max", w.maximized ? "▭" : "▢", "window.maximize"))
        .child(btn("win-close", "×", "window.close")));
  }

  // ── roster: a tree of spaces → tabs → panes, agents with their columns ──
  // Each space is a header line (name, branch, "+" for a new tab there); under it
  // every pane of every tab, "├─ 1" (or "├─ 2.1" in a split tab). Agents carry the
  // full row; shells and mod panes are one muted line. "by urgency" switches to a
  // flat triage list (with a where column), "faults only" hides everything calm.
  roster(c, cx) {
    const all = roster();
    trackEvents(all);
    const now = Date.now();
    const faults = this.prefs.faults;
    const flat = this.prefs.sort === "priority";
    let rows = faults ? all.filter((r) => r.urgency >= RANK.done) : all;
    if (flat) rows = [...rows].sort((a, b) => b.urgency - a.urgency || (a.since ?? 0) - (b.since ?? 0));
    const pinned = rows.filter((r) => r.pinned);
    if (flat) rows = [...pinned, ...rows.filter((r) => !r.pinned)];

    // The tree: one entry per line, built before columns so the lead width is known.
    const ss = flat ? [] : spaces();
    const ps = flat ? [] : panes();
    const entries = [];
    if (!flat) {
      const placed = new Set();
      for (const sp of ss) {
        const body = [];
        sp.tabs.forEach((tb, ti) => {
          const qs = ps.filter((q) => q.tab === tb.id);
          qs.forEach((q, qi) => {
            const r = q.terminal ? rows.find((x) => x.pane === q.pane) : null;
            if (r) placed.add(r.address);
            if (!r && (faults || all.some((x) => x.pane === q.pane))) return;
            body.push({ q, r, label: qs.length > 1 ? `${tb.index}.${qi + 1}` : `${tb.index}` });
          });
        });
        if (faults && !body.length) continue;
        entries.push({ sp });
        body.forEach((e, i) => entries.push({ ...e, sp, last: i === body.length - 1 }));
      }
      const rest = rows.filter((r) => !placed.has(r.address));
      rest.forEach((r, i) => entries.push({ r, label: "", last: i === rest.length - 1 }));
    }
    const leadText = (e) => `${e.last ? "└─" : "├─"} ${e.label}`;
    const leadW = flat ? 0 : Math.max(3, ...entries.filter((e) => e.q || e.r).map((e) => leadText(e).length));
    setAgentOrder(flat ? rows.map((r) => r.address) : entries.filter((e) => e.r).map((e) => e.r.address));
    this.navOrder = flat ? rows.map((r) => r.pane).filter(Boolean) : entries.map((e) => e.q?.pane ?? e.r?.pane).filter(Boolean);

    // Fit columns to the width: drop the least important first. The tree says where.
    const chars = Math.floor((this.size.width || 1400) / CH) - 4 - (leadW ? leadW + 1 : 0);
    let cols = flat ? [...COLS] : COLS.filter((x) => x.k !== "where");
    const need = (cs) => cs.reduce((s, x) => s + (x.w === "rest" ? x.min : x.w) + 1, 2);
    while (need(cols) > chars) {
      const victim = cols.filter((x) => x.drop < 90).sort((a, b) => a.drop - b.drop)[0];
      if (!victim) break;
      cols = cols.filter((x) => x !== victim);
    }

    // Spare width: task grows to its longest name first (up to +20), then branch takes up
    // to half of what's left (up to +16); "doing" keeps the rest beyond its minimum.
    let spare = chars - need(cols);
    const longest = (k) => Math.max(0, ...all.map((r) => String(r[k] ?? "").length));
    const grow = (k, max) => {
      const x = cols.find((y) => y.k === k);
      const add = x ? Math.max(0, Math.min(max, longest(k) - x.w, spare)) : 0;
      if (add) { cols = cols.map((y) => (y === x ? { ...y, w: y.w + add } : y)); spare -= add; }
    };
    grow("task", 20);
    grow("branch", Math.min(16, Math.floor(spare / 2)));
    const parts = flat ? [`${all.length} agents`] : [`${ss.length} spaces · ${all.length} agents`];

    const head = title("t-roster", "AGENTS", parts, h_flex().gap(CH)
      .child(toggle("tg-faults", faults ? "[faults only]" : "faults only", faults, (_e, cx) => { this.prefs.faults = !faults; this.savePrefs(); cx.notify(); }))
      .child(toggle("tg-sort", flat ? "[by urgency]" : "by urgency", flat,
        (_e, cx) => { this.prefs.sort = flat ? "order" : "priority"; this.savePrefs(); cx.notify(); }))
      .child(toggle("tg-space", "new space", false, () => run("space.new", {}))));

    const leadHead = leadW ? [cell("", leadW, { blank: true })] : [];
    const colHead = header("h-roster", [...leadHead, div().flex_none().w(2 * CH).child(""), ...cols.map((x) => cell(x.k, x.w, { right: x.right, blank: true }))]);

    // Only the pane that has the keyboard. (focused().agent and agents()[i].focused can name an
    // agent in another space, which lit two rows at once.)
    const focusPane = focused()?.pane ?? null;
    // `metas[i]` says which space (and tab) line i belongs to, for dragging. Lines outside
    // the tree (the flat view, agents no space claims) have none and don't drag.
    const lines = [];
    const metas = [];
    const push = (el, m) => { lines.push(el); metas.push(m); };
    const tabOf = (sp, q) => sp?.tabs.find((t) => t.id === q?.tab) ?? null;
    const addAgent = (r, lead, cont, spBranch, m) => {
      push(this.agentRow(c, r, cols, now, r.pane === focusPane, lead, spBranch), m);
      if (this.folded.has(r.address)) return;
      r.children.forEach((k, i) => push(this.subRow(c, r, k, cols, now, i === r.children.length - 1, cont), m));
    };
    if (flat) rows.forEach((r) => addAgent(r, null, null, null, null));
    for (const e of entries) {
      const lead = { text: leadText(e), w: leadW };
      const cont = { text: e.last ? "" : "│", w: leadW };
      const m = e.sp ? { sp: e.sp, tab: e.q ? tabOf(e.sp, e.q) : null } : null;
      if (e.sp && !e.q) push(this.spaceRow(c, e.sp, ps, cols, leadW), m);
      else if (e.r) addAgent(e.r, lead, cont, e.sp?.branch ?? null, m);
      else push(this.paneRow(c, e.q, cols, lead, e.sp?.branch ?? null), m);
    }
    groupLines(metas);
    const empty = div().px(CH).text_color(c.dim).child(faults ? "no agent needs attention" : "no agents reporting a status yet");
    // The band fits its rows; past 24 it scrolls.
    this.fitHeight("roster", Math.min(24, Math.max(1, lines.length)));
    const dragging = Boolean(this.drag?.active);
    return v_flex().size_full().min_h(0)
      .child(head).child(colHead)
      .child(v_flex().id("roster-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(dragging, (el) => el.cursor_grabbing())
        .on_mouse_up("left", (_e, cx) => this.drop(cx))
        // Leaving the tree mid-drag cancels it: a release out there would never reach us.
        .on_hover((over, cx) => { if (!over && this.drag) { this.drag = null; cx.notify(); } })
        .children(lines.length ? lines.map((el, i) => this.draggable(c, el, i, metas)) : [empty]));
  }

  // ── dragging in the tree: a tab within its space, or a space among spaces ──
  // A press on a tab's line (any of its panes or sub-agents) picks up the tab; a press on a
  // space's header line picks up the space. It becomes a drag after 4 px. A 2 px grey rule
  // shows where it will land; a drop runs tab.move or space.move. Herdr can't move a tab to
  // another space, so other spaces show no rule.
  draggable(c, el, i, metas) {
    const m = metas[i];
    if (!m) return el;
    const d = this.drag?.active ? this.drag : null;
    const picked = d && (d.kind === "tab" ? m.tab?.id === d.id : m.sp.id === d.id);
    const rule = d?.target?.line === i ? d.target.edge : null;
    el = el.relative()
      .on_mouse_down("left", (e) => {
        this.drag = m.tab
          ? { kind: "tab", id: m.tab.id, space: m.sp.id, y0: e.position.y, active: false, target: null }
          : { kind: "space", id: m.sp.id, machine: m.sp.machine, y0: e.position.y, active: false, target: null };
      })
      .on_mouse_move((e, cx) => this.dragOver(e, m, cx));
    if (picked) el = el.opacity(0.4);
    if (rule) el = el.child(div().absolute().left_0().right_0().h(2).bg(c.fg)[rule === "top" ? "top_0" : "bottom_0"]());
    return el;
  }

  dragOver(e, m, cx) {
    const d = this.drag;
    if (!d) return;
    const started = !d.active;
    if (started) {
      if (Math.abs(e.position.y - d.y0) < 4) return;
      d.active = true;
    }
    // Where in its group the pointer is, in rows: the upper half of a group drops before it.
    const frac = Math.max(0, Math.min(1, (e.local_position?.y ?? 0) / ROW));
    let target = null;
    if (d.kind === "tab" && m.sp.id === d.space) {
      const src = m.sp.tabs.find((t) => t.id === d.id)?.index;
      if (m.tab) {
        const before = m.ti + frac < m.tn / 2;
        target = slot(src, m.tab.index, before, before ? m.tFirst : m.tLast);
      } else if (m.firstTab) {
        target = slot(src, m.firstTab.index, true, m.sFirst);
        if (target) target.edge = "bottom";   // the header's lower rule: the top of the space
      }
    } else if (d.kind === "space" && (m.sp.machine ?? null) === (d.machine ?? null)) {
      const src = spaces().find((s) => s.id === d.id)?.index;
      const before = m.si + frac < m.sn / 2;
      target = slot(src, m.sp.index, before, before ? m.sFirst : m.sLast);
    }
    const same = (a, b) => (a?.line === b?.line && a?.edge === b?.edge && a?.index === b?.index);
    if (started || !same(target, d.target)) { d.target = target; cx.notify(); }
  }

  drop(cx) {
    const d = this.drag;
    this.drag = null;
    if (!d?.active) return;
    this.dragEnded = Date.now();
    if (d.target) run(d.kind === "tab" ? "tab.move" : "space.move", { id: d.id, index: d.target.index });
    cx.notify();
  }

  // A click handler that ignores the click a drag ends with.
  clicked(fn) {
    return (e, cx) => {
      if (this.drag?.active || Date.now() - (this.dragEnded ?? 0) < 300) return;
      fn(e, cx);
    };
  }

  // A space's header line: its name over the lead, glyph and task columns, its branch
  // in the branch column, "+" (a new tab in the folder it works in) at the end.
  spaceRow(c, sp, ps, cols, leadW) {
    const task = cols.find((x) => x.k === "task");
    const plus = div().id(`sp-new-${sp.id}`).flex_none().w(2 * CH).text_right().text_color(c.dim).cursor_pointer()
      .hover((st) => st.text_color(c.fg))
      .on_click(this.clicked((_e, cx) => {
        cx.stop_propagation();
        const tabIds = [sp.tabs.find((t) => t.active)?.id, ...sp.tabs.map((t) => t.id)];
        const here = tabIds.map((id) => ps.find((q) => q.tab === id && q.cwd)).find(Boolean)?.cwd || sp.folder || undefined;
        run("tab.new", { space: sp.id, folder: here });
      })).child("+");
    const cells = [cell(sp.name, leadW + 1 + 2 + 1 + task.w, { color: sp.active ? c.fg : c.muted })];
    for (const x of cols.slice(1)) {
      if (x.w === "rest") break;
      cells.push(cell(x.k === "branch" ? sp.branch : "", x.w, { color: c.dim, blank: true }));
    }
    cells.push(cell("", "rest", { blank: true }), plus);
    return row(`sp-${sp.id}`, cells, { bar: stateBar(c, sp.status), onClick: this.clicked(() => run("space.select", { id: sp.id })) });
  }

  // A pane that isn't an agent: "$" and the program and folder for a terminal, "·" for a mod.
  paneRow(c, q, cols, lead, spBranch) {
    const text = q.mod ? (q.title || q.mod) : `${q.program?.name ?? "shell"}${q.cwd ? "  " + shortPath(q.cwd) : ""}`;
    const cells = cols.map((x) => x.k === "task"
      ? cell(text, x.w, { color: c.muted, underline: q.focused })
      : x.k === "branch" && q.branch && q.branch !== spBranch ? cell(q.branch, x.w, { color: c.muted })
      : cell("", x.w, { blank: true }));
    return row(`pq-${q.pane}`, [cell(lead.text, lead.w, { color: c.dim }), div().flex_none().w(2 * CH).text_color(c.dim).child(q.mod ? "·" : "$"), ...cells],
      { bg: q.focused ? c.sel : null, onClick: this.clicked(() => run("pane.focus", { pane: q.pane })) });
  }

  agentRow(c, r, cols, now, focus, lead = null, spBranch = null) {
    const usage = r.pid ? treeUsage(r.pid) : null;
    const hasUsage = usage?.found;
    const hot = hasUsage && usage.cpu >= 1;
    const doing = r.status === "blocked" ? (store.screens[r.address]?.line || r.msg) : r.status === "error" && r.exitCode != null ? `exited ${r.exitCode}` : r.msg;
    const val = {
      task: [r.task, { color: r.status === "idle" ? c.muted : c.fg, bold: r.status === "blocked" || r.status === "error", underline: focus }],
      agent: [r.agent, { color: c.muted }],
      where: [r.where, { color: c.muted }],
      folder: [r.folder, { color: c.dim }],
      branch: [lead && r.branch === spBranch ? "" : r.branch, { color: c.muted, blank: Boolean(lead) }],
      state: [WORD[r.status], { color: stateColor(c, r.status), italic: r.inferred }],
      for: [r.since ? ago(now - r.since) : null, { color: r.status === "blocked" ? c.amber : c.muted, bold: r.status === "blocked" }],
      age: [r.created ? ago((r.finished ?? now) - r.created) : null, { color: c.dim }],
      turns: [r.turn, { color: c.muted }],
      subs: [r.subs || null, { color: c.muted }],
      cpu: [hasUsage ? pct(usage.cpu) : null, { color: usage?.cpu > 100 ? c.amber : hot ? c.muted : c.dim }], // amber over one whole core, as in Processes
      mem: [hasUsage ? bytes(usage.rss) : null, { color: c.muted }],
      doing: [doing, { color: r.status === "blocked" ? c.amber : c.muted }],
    };
    const g = glyph(c, r.status, `g-${r.address}`);
    const foldable = r.children.length > 0;
    const glyphCell = foldable
      ? h_flex().id(`fold-${r.address}`).flex_none().cursor_pointer().on_click(this.clicked((_e, cx) => {
        cx.stop_propagation();
        this.folded.has(r.address) ? this.folded.delete(r.address) : this.folded.add(r.address);
        this.savePrefs(); cx.notify();
      })).child(g)
      : g;
    const leadCell = lead ? [cell(lead.text, lead.w, { color: c.dim })] : [];
    return row(`r-${r.address}`, [...leadCell, glyphCell, ...cols.map((x) => cell(val[x.k][0], x.w, { right: x.right, ...val[x.k][1], blank: x.k === "subs" || val[x.k][1].blank }))], {
      bar: stateBar(c, r.status),
      bg: focus ? c.sel : null,
      onClick: this.clicked(() => run("pane.focus", { pane: r.pane })),
    });
  }

  subRow(c, parent, k, cols, now, last, cont = null) {
    const lead = `${"  ".repeat(Math.max(0, k.depth - 1))}${last ? "└" : "├"} `;
    const usage = k.pid ? treeUsage(k.pid) : null;
    const val = {
      task: [lead + k.task, { color: c.muted }],
      state: [WORD[k.status], { color: stateColor(c, k.status) }],
      for: [k.since ? ago(now - k.since) : null, { color: c.dim }],
      age: [k.created ? ago(now - k.created) : null, { color: c.dim }],
      turns: [k.turn, { color: c.dim }],
      cpu: [usage?.found ? pct(usage.cpu) : null, { color: usage?.cpu > 100 ? c.amber : c.dim }],
      mem: [usage?.found ? bytes(usage.rss) : null, { color: c.dim }],
      doing: [k.record ? "in-process sub-agent" : k.kept ? "has a pane" : "", { color: c.dim }],
    };
    // Children inherit agent/where/folder/branch from the row above: left blank so they read as a group.
    const cells = cols.map((x) => (val[x.k] ? cell(val[x.k][0], x.w, { right: x.right, ...val[x.k][1], blank: x.k === "doing" }) : cell("", x.w, { blank: true })));
    const click = k.record ? null : this.clicked(() => (k.kept ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })));
    const leadCell = cont ? [cell(cont.text, cont.w, { color: c.dim, blank: true })] : [];
    return row(`s-${k.address}`, [...leadCell, glyph(c, k.status, `sg-${k.address}`), ...cells], { bar: stateBar(c, k.status), onClick: click });
  }

  // ── events: every state change and threshold crossing, newest first ──────
  events(c) {
    trackEvents(roster());
    // Save when the newest event changes: the log is capped at 500, so its length stops changing.
    if (eventsMark() !== this.saved) { save("events2", store.events.slice(0, 500)); this.saved = eventsMark(); }
    const now = Date.now();
    const recent = store.events.filter((e) => now - e.at < 600000);
    const shown = store.events.slice(0, 200);
    const cols = fit(EV_COLS, this.size.width);
    const change = (e) => h_flex().flex_none().w(cols.find((x) => x.k === "change").w * CH).overflow_hidden().whitespace_nowrap()
      .child(div().text_color(c.dim).child(`${e.system ? e.from : WORD[e.from] ?? e.from} → `))
      .child(div().text_color(c.muted).child(e.system ? e.to : WORD[e.to] ?? e.to)); // a record: no color, no white
    const lines = shown.map((e, i) => row(`ev-${i}-${e.at}`, cols.map((x) => x.k === "change" ? change(e) : fitted([x], {
      time: [clock(e.at), { color: c.dim }],
      where: [e.where, { color: c.muted }],
      detail: [e.detail, { color: c.muted, blank: true }],
    })[0]), { onClick: e.address && !e.address.includes("#") ? () => run("pane.focus", { terminal: e.address }) : null }));
    // The log takes whatever height the side column has left; older entries scroll. It is the
    // side column's only flexible panel (weight 1 in the layouts), so it gives up height first.
    return v_flex().size_full().min_h(0)
      .child(title("t-events", "EVENTS", [`${store.events.length} logged`, `· ${recent.length} in 10 min`]))
      .child(header("h-events", fittedHead(cols)))
      .child(v_flex().id("ev-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(lines.length === 0, (el) => el.child(div().px(CH).text_color(c.dim).child("no changes since start")))
        .children(lines));
  }

  // ── pane header: one line per pane ────────────────────────────────────────
  pane(c) {
    const me = panes().find((q) => q.pane === props()?.pane);
    if (!me) return div();
    const r = roster().find((x) => x.pane === me.pane);
    const t = me.terminal ? terminals().find((x) => x.address === me.terminal) : null;
    const now = Date.now();
    const status = r?.status ?? me.status ?? null;
    const prog = (me.program?.agent || me.program?.shell) ? me.program.name : me.title || me.program?.name || "shell";
    const since = t?.status_ms ?? null;
    const b = (id, label, cmd, args) => div().id(id).flex_none().px(CH * 0.5).text_color(c.dim).cursor_pointer()
      .hover((s) => s.text_color(c.fg)).on_click((_e, cx) => { cx.stop_propagation(); run(cmd, args); }).child(label);
    return h_flex().id(`ph-${me.pane}`).size_full().items_center().gap(CH).px(CH).border_b(me.focused ? 2 : 1)
      .border_color(me.focused ? c.muted : c.rule).bg(c.bg)
      .on_hover((h, cx) => { this.hovered = h; cx.notify(); })
      .on_click(() => run("pane.focus", { pane: me.pane }))
      .child(status ? glyph(c, status, `phg-${me.pane}`) : div().flex_none().w(2 * CH).text_color(c.dim).child("$"))
      .child(div().flex_none().font_weight(700).text_color(c.fg).child(r?.task ?? prog))
      .child(div().flex_none().text_color(c.muted).child(prog))
      .child(div().flex_none().text_color(c.dim).child(shortPath(me.cwd)))
      .when(Boolean(me.branch), (el) => el.child(div().flex_none().text_color(c.muted).child(me.branch)))
      .when(Boolean(status), (el) => el.child(div().flex_none().text_color(stateColor(c, status)).child(`${WORD[status]}${since ? " " + ago(now - since) : ""}`)))
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().text_color(c.dim).child(r?.msg ?? ""))
      .when(Boolean(this.hovered), (el) => el
        .child(b(`pr-${me.pane}`, "split right", "pane.split", { direction: "right", pane: me.pane }))
        .child(b(`pd-${me.pane}`, "split down", "pane.split", { direction: "down", pane: me.pane }))
        .child(b(`pz-${me.pane}`, me.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane: me.pane }))
        .child(b(`px-${me.pane}`, "close", "pane.close", { pane: me.pane })));
  }

  // ── wall: the header over one agent's column (Agent wall) ────────────────
  // Line 1: state, position, task, where, agent, folder, branch, time in state.
  // Line 2: what it is doing (or the question it is asking).
  wall(c) {
    const p = props() ?? {};
    const addr = p.terminal;
    const r = roster().find((x) => x.address === addr);
    const f = focused();
    const on = Boolean(f?.terminal === addr && !f?.pane);
    const status = r?.status ?? null;
    const now = Date.now();
    const line = status === "blocked" ? (store.screens[addr]?.line || r?.msg) : r?.msg;
    const grey = (text, color = c.muted) => div().flex_none().whitespace_nowrap().text_color(color).child(text);
    // Fit line 1 to the column: the task keeps its name; agent, then folder, go first,
    // then the branch shortens. The space, position and state always stay.
    const task = r?.task ?? addr ?? "—";
    const pos = `${p.index ?? "?"}/${p.total ?? "?"}`;
    const state = status ? `${WORD[status]}${r?.since ? " " + ago(now - r.since) : ""}` : "";
    const fields = { agent: r?.agent ?? "", folder: r?.cwd ? shortPath(r.cwd) : "", branch: r?.branch ?? "" };
    let branchMax = 24;
    const room = Math.floor((this.size.width || 100000) / CH) - 3;
    const need = () => [2, pos.length, Math.min(task.length, 40), (r?.where ?? "—").length, state.length, fields.agent.length,
      fields.folder.length, Math.min(fields.branch.length, branchMax)].filter((n) => n > 0).reduce((a, n) => a + n + 1, 0);
    if (need() > room) fields.agent = "";
    if (need() > room) fields.folder = "";
    if (need() > room) branchMax = 12;
    const top = h_flex().h(ROW).flex_none().items_center().gap(CH)
      .child(status ? glyph(c, status, `wg-${addr}`) : div().flex_none().w(2 * CH).text_color(c.dim).child("$"))
      .child(grey(pos, c.dim))
      .child(div().flex_1().min_w(CH * 6).truncate().whitespace_nowrap().font_weight(700).text_color(c.fg).child(task))
      .child(grey(r?.where ?? "—"))
      .when(Boolean(fields.agent), (el) => el.child(grey(fields.agent, c.dim)))
      .when(Boolean(fields.folder), (el) => el.child(grey(fields.folder, c.dim)))
      .when(Boolean(fields.branch), (el) => el.child(div().flex_none().max_w(CH * branchMax).truncate().whitespace_nowrap().text_color(c.muted).child(fields.branch)))
      .when(Boolean(state), (el) => el.child(grey(state, stateColor(c, status))));
    const bottom = div().h(ROW).flex_none().truncate().whitespace_nowrap().pl(3 * CH).text_color(c.dim).child(line || "—");
    return v_flex().id(`wh-${addr}`).relative().size_full().justify_start().px(CH - 3).pr(CH).border_l(3)
      .border_color(stateBar(c, status) ?? "#00000000")
      .bg(c.bg).cursor_pointer()
      .on_click(() => run("pane.focus", { terminal: addr }))
      .child(top).child(bottom)
      .child(div().absolute().bottom_0().left_0().right_0().h(on ? 2 : 1).bg(on ? c.muted : c.rule));
  }

  // ── system: label / value / graph, grey until a threshold ────────────────
  system(c) {
    const s = store.sys; const g = store.gpu; const tp = store.temps ?? {}; const d = store.df;
    const chars = Math.floor((this.size.width || 600) / CH) - 3;
    const LABEL = 9, VALUE = 18;
    const graphW = Math.max(8, Math.min(60, chars - LABEL - VALUE - 3));
    const lvl = levels();
    const col = (l) => levelColor(c, l) ?? c.muted; // calm values are grey: white is for attention
    const line = (id, label, value, graph, l = "ok", graphColor = null) => row(`sy-${id}`, [
      cell(label, LABEL, { color: c.dim }),
      cell(value, VALUE, { color: col(l), bold: l !== "ok" }),
      cell(graph, graphW, { color: graphColor ?? (l === "ok" ? c.dim : col(l)), blank: true }),
    ]);
    const cores = (s?.cores ?? []).map((v) => spark([v ?? 0], 1, 100)).join("");
    const memFrac = s ? s.memUsed / s.memTotal : 0;
    const gpuIdle = Boolean(g) && (g.memUsed ?? 0) < 64 * 1048576
      && store.hist.gpu.length > 0 && store.hist.gpu.slice(-12).every((u) => !u);
    const rows = [
      line("cpu", "cpu", s?.cpu != null ? pct(s.cpu) : "…", spark(store.hist.cpu, graphW, 100), lvl.cpu),
      line("cores", "cores", `${s?.cores?.length ?? "—"} threads`, cores, "ok"),
      line("load", "load", s ? s.load.map((v) => v.toFixed(2)).join(" ") : "…", s ? `of ${s.cores.length}` : "", lvl.load, c.dim),
      line("psi", "pressure", s ? `cpu ${f1(s.psi.cpu)} io ${f1(s.psi.io)}` : "…", s ? `memory ${f1(s.psi.memory)}` : "", lvl.psiMem, col(lvl.psiMem)),
      line("mem", "memory", s ? `${bytes(s.memUsed)} / ${bytes(s.memTotal)}` : "…", s ? `${bar(memFrac, Math.max(4, graphW - 5))} ${pct(memFrac * 100).padStart(4)}` : "", lvl.mem),
      line("swap", "swap", s ? `${bytes(s.swapUsed)} / ${bytes(s.swapTotal)}` : "…", s && s.swapTotal ? `${bar(s.swapUsed / s.swapTotal, Math.max(4, graphW - 12))} in ${bytes(s.swapInAvg ?? 0).padStart(4)}/s` : "", lvl.swap),
      ...(gpuIdle
        // Asleep (no work for a minute, only the driver's memory): one line, and the panel shrinks.
        ? [line("gpu", "gpu", "idle", g.name ?? "", "ok", c.dim)]
        : [
          line("gpu", "gpu", g ? `${pct(g.util)}  ${deg(g.temp)}` : "—", g ? spark(store.hist.gpu, graphW, 100) : (g === null ? "no gpu reading" : ""), "ok"),
          line("gpumem", "gpu mem", g ? `${bytes(g.memUsed)} / ${bytes(g.memTotal)}` : "—", g?.memTotal ? bar(g.memUsed / g.memTotal, Math.max(4, graphW - 5)) : "", lvl.gpuMem),
          line("gpupow", "gpu power", g?.power != null ? `${g.power.toFixed(0)} W` : "—", g?.name ?? "", "ok", c.dim),
        ]),
      line("ctemp", "cpu temp", deg(tp.cpu), spark(store.hist.temp, graphW, 100), lvl.cpuTemp),
      line("ntemp", "nvme temp", deg(tp.nvme), "", "ok"),
      line("disk", "disk /", d ? `${bytes(d.used, 0)} / ${bytes(d.total, 0)}` : "…", d ? `${bar(d.pct / 100, Math.max(4, graphW - 5))} ${String(d.pct).padStart(3)}%` : "", lvl.disk),
      line("dio", "disk io", s?.rd != null ? `r ${bytes(s.rd)}/s w ${bytes(s.wr)}/s` : "…", spark(store.hist.disk, graphW), "ok"),
      line("net", "net", s?.rx != null ? `↓ ${bytes(s.rx)}/s ↑ ${bytes(s.tx)}/s` : "…", spark(store.hist.net, graphW), "ok"),
      line("ifs", "links", (s?.ifs ?? []).join(" ") || "—", "", "ok"),
    ];
    // The header sums up the machine; Claude limits have their own panel.
    const mine = Object.entries(lvl).filter(([k]) => !k.startsWith("claude_"));
    const worst = mine.some(([, l]) => l === "crit") ? "crit" : mine.some(([, l]) => l === "warn") ? "warn" : "ok";
    const summary = worst === "ok" ? "all normal" : mine.filter(([, l]) => l !== "ok").map(([k]) => offenderText(k)).join(" · ");
    this.fitHeight("system", rows.length, false);
    return v_flex().size_full().min_h(0)
      .child(title("t-sys", "SYSTEM", [div().text_color(levelColor(c, worst) ?? c.dim).child(summary)], div().text_color(c.dim).child(s ? `${clock(s.at)}` : "")))
      .child(v_flex().id("sy-list").flex_1().min_h(0).overflow_y_scrollbar().children(rows));
  }

  // ── limits: Claude plan usage windows and when they reset ─────────────────
  limits(c) {
    const L = store.limits;
    const now = Date.now();
    const lvl = levels();
    const chars = Math.floor((this.size.width || 600) / CH) - 3;
    const WIN = 9, USED = 5, RESETS = 9, IN = 8;
    const barW = Math.max(6, Math.min(60, chars - WIN - USED - RESETS - IN - 4));
    const at = (ms) => (ms - now < 86400000 ? clock(ms, false) : `${DAYS[new Date(ms).getDay()]} ${clock(ms, false)}`);
    const lines = (L?.windows ?? []).map((w) => {
      const gone = w.resets != null && w.resets <= now; // the window reset since this reading
      const l = gone ? "ok" : lvl[`claude_${w.key}`] ?? "ok";
      const col = levelColor(c, l) ?? c.muted;
      return row(`lm-${w.key}`, [
        cell(w.label, WIN, { color: c.dim }),
        cell(gone ? "—" : pct(w.pct), USED, { right: true, color: col, bold: l !== "ok" }),
        cell(gone ? "" : bar(w.pct / 100, barW), barW, { color: l === "ok" ? c.dim : col, blank: true }),
        cell(w.resets == null ? "" : gone ? "reset" : at(w.resets), RESETS, { right: true, color: c.muted }),
        cell(w.resets == null || gone ? "" : `in ${ago(w.resets - now)}`, IN, { right: true, color: c.dim }),
      ]);
    });
    this.fitHeight("limits", Math.max(1, lines.length), false);
    const empty = L === undefined ? "reading…" : "no reading yet: Claude Code's status line saves one (see README)";
    return v_flex().size_full().min_h(0)
      .child(title("t-limits", "CLAUDE LIMITS", L?.at ? [`read ${ago(now - L.at)} ago`] : []))
      .child(v_flex().id("lm-list").flex_1().min_h(0)
        .when(lines.length === 0, (el) => el.child(div().px(CH).text_color(c.dim).child(empty)))
        .children(lines));
  }

  // ── processes: top by cpu, with the agent that started them ──────────────
  procs(c) {
    const ag = roster();
    const roots = new Map();
    for (const r of ag) {
      if (r.pid) roots.set(r.pid, { label: r.where, pane: r.pane });
      for (const k of r.children) if (k.pid) roots.set(k.pid, { label: `${r.where} ›`, pane: r.pane });
    }
    const cols = fit(PS_COLS, this.size.width);
    // Ties (an idle machine shows many at 0%) go to the larger memory user.
    const top = [...store.ps].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, 8);
    const lines = top.map((p) => {
      const who = ownerOf(p.pid, roots);
      const cells = fitted(cols, {
        pid: [p.pid, { color: c.dim }],
        cpu: [pct(p.cpu), { color: p.cpu > 100 ? c.amber : c.muted }], // over one whole core
        mem: [bytes(p.rss), { color: c.muted }],
        time: [ago(p.etimes * 1000), { color: c.dim }],
        agent: [who?.label, { color: who ? c.fg : c.dim }],
        command: [p.comm, { color: c.muted }],
      });
      // The agent's name goes to that agent's terminal (a sub-agent's process goes to its parent).
      const at = cols.findIndex((x) => x.k === "agent");
      if (who?.pane && at >= 0) {
        cells[at] = cells[at].id(`ps-go-${p.pid}`).cursor_pointer().hover((st) => st.underline())
          .on_click(() => run("pane.focus", { pane: who.pane }));
      }
      return row(`ps-${p.pid}`, cells);
    });
    const total = store.ps.reduce((s, p) => s + p.cpu, 0);
    // The top 8 by cpu; the block fits them.
    this.fitHeight("procs", Math.max(1, lines.length));
    return v_flex().size_full().min_h(0)
      .child(title("t-ps", "PROCESSES", ["top 8 by cpu", `· ${store.ps.length} running`, `· ${pct(total)} cpu total`]))
      .child(header("h-ps", fittedHead(cols)))
      .child(v_flex().id("ps-list").flex_1().min_h(0).overflow_y_scrollbar().children(lines));
  }

  // ── repos: one row per repo an agent is working in ───────────────────────
  repos(c) {
    const ag = roster();
    const cols = fit(REPO_COLS, this.size.width);
    const lines = store.repos.map((r) => {
      const n = ag.filter((a) => a.cwd && (a.cwd === r.path || a.cwd.startsWith(r.path + "/"))).length;
      return row(`rp-${r.path}`, fitted(cols, {
        repo: [r.repo, { color: c.fg }],
        branch: [r.branch, { color: c.muted }],
        dirty: [r.dirty || "", { color: r.dirty ? c.fg : c.dim, blank: true }],
        ahead: [r.ahead ? `↑${r.ahead}` : "", { color: c.muted, blank: true }],
        behind: [r.behind ? `↓${r.behind}` : "", { color: c.muted, blank: true }],
        agents: [n || "", { color: c.muted, blank: true }],
        path: [shortPath(r.path), { color: c.dim }],
      }));
    });
    // The block fits its rows: title + header + rows, at most 8.
    this.fitHeight("repos", Math.min(8, Math.max(1, lines.length)));
    return v_flex().size_full().min_h(0)
      .child(title("t-repos", "REPOS", [`${store.repos.length}`]))
      .child(header("h-repos", fittedHead(cols)))
      .child(v_flex().id("rp-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(lines.length === 0, (el) => el.child(div().px(CH).text_color(c.dim).child("reading git…")))
        .children(lines));
  }

  // ── containers: Docker, read-only ────────────────────────────────────────
  // Trouble first, one row each: restarting, unhealthy, or failed (non-zero exit) in the
  // last day. Healthy containers fold into one row per compose project; click to unfold.
  containers(c) {
    const all = store.containers;
    const cols = fit(CT_COLS, this.size.width);
    const now = Date.now();
    const lines = [];
    const st = (x) => (x.kind === "running" || x.kind === "starting" || x.kind === "unhealthy" ? store.dstats[x.name] ?? {} : {});
    const sum = (xs, k) => { const v = xs.map((x) => st(x)[k]).filter((n) => n != null && !isNaN(n)); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    const sps = spaces();
    const spaceOf = (dir) => dir && sps.find((sp) => sp.folder && (dir === sp.folder || dir.startsWith(sp.folder + "/") || sp.folder.startsWith(dir + "/")));
    const go = (dir) => { const sp = spaceOf(dir); return sp ? () => run("space.select", { id: sp.id }) : null; };
    const BAD = { restarting: 0, unhealthy: 1, failed: 2 };
    const line = (id, x, name, opts = {}) => row(id, fitted(cols, {
      name: [name, { color: opts.dim ? c.muted : c.fg, bold: x.kind === "restarting" || x.kind === "unhealthy" }],
      state: [x.kind === "failed" ? `exit ${x.exit}` : x.kind, { color: x.kind in BAD ? c.red : x.kind === "running" ? c.muted : c.dim }],
      for: [x.since ? ago(now - x.since) : "", { color: c.dim, blank: true }],
      restarts: [x.restarts || "", { color: x.kind === "restarting" ? c.red : c.dim, blank: true }],
      cpu: [st(x).cpu != null ? pct(st(x).cpu) : "", { color: st(x).cpu >= 50 ? c.fg : c.dim, blank: true }],
      mem: [st(x).mem != null ? bytes(st(x).mem) : "", { color: c.muted, blank: true }],
      ports: [x.hostPorts.join(" "), { color: c.dim, blank: true }],
    }), { bar: x.kind === "restarting" || x.kind === "unhealthy" ? c.red : null, onClick: opts.onClick ?? go(x.dir) });

    let parts = [];
    if (Array.isArray(all)) {
      const trouble = all.filter((x) => x.kind in BAD && (x.kind !== "failed" || now - (x.finished ?? 0) < 86400000))
        .sort((a, b) => BAD[a.kind] - BAD[b.kind] || a.name.localeCompare(b.name));
      trouble.forEach((x) => lines.push(line(`ct-${x.name}`, x, x.name)));
      const live = all.filter((x) => !(x.kind in BAD) && x.kind !== "stopped" && x.kind !== "failed");
      const byProject = new Map();
      for (const x of live) { const k = x.project || `/${x.name}`; byProject.set(k, [...(byProject.get(k) ?? []), x]); }
      for (const [k, xs] of [...byProject].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (k.startsWith("/") || xs.length === 1) { lines.push(line(`ct-${xs[0].name}`, xs[0], xs[0].name)); continue; }
        const open = this.open.has(k);
        const youngest = Math.max(...xs.map((x) => x.since ?? 0));
        const group = { kind: "running", since: youngest || null, restarts: xs.reduce((a, x) => a + x.restarts, 0), hostPorts: xs.flatMap((x) => x.hostPorts).sort((a, b) => a - b), name: k, dir: xs[0].dir };
        const notRunning = xs.filter((x) => x.kind !== "running" && x.kind !== "starting").length;
        lines.push(row(`ctg-${k}`, fitted(cols, {
          name: [`${open ? "−" : "+"} ${k} ×${xs.length}`, { color: c.fg }],
          state: [notRunning ? `${xs.length - notRunning}/${xs.length} up` : "running", { color: c.muted }],
          for: [group.since ? ago(now - group.since) : "", { color: c.dim, blank: true }],
          restarts: [group.restarts || "", { color: c.dim, blank: true }],
          cpu: [sum(xs, "cpu") != null ? pct(sum(xs, "cpu")) : "", { color: sum(xs, "cpu") >= 50 ? c.fg : c.dim, blank: true }],
          mem: [sum(xs, "mem") != null ? bytes(sum(xs, "mem")) : "", { color: c.muted, blank: true }],
          ports: [group.hostPorts.join(" "), { color: c.dim, blank: true }],
        }), { onClick: (_e, cx) => { open ? this.open.delete(k) : this.open.add(k); save("ctOpen", [...this.open]); cx.notify(); } }));
        if (open) xs.sort((a, b) => a.name.localeCompare(b.name)).forEach((x, i) =>
          lines.push(line(`ct-${x.name}`, x, `  ${i === xs.length - 1 ? "└─" : "├─"} ${x.service || x.name}`, { dim: true })));
      }
      const n = (k) => all.filter((x) => x.kind === k).length;
      const failedToday = trouble.filter((x) => x.kind === "failed").length;
      parts = [`${live.length} running`,
        ...(n("restarting") ? [div().text_color(c.red).child(`· ${n("restarting")} restarting`)] : []),
        ...(n("unhealthy") ? [div().text_color(c.red).child(`· ${n("unhealthy")} unhealthy`)] : []),
        ...(failedToday ? [div().text_color(c.red).child(`· ${failedToday} failed today`)] : []),
        `· ${all.length - live.length - trouble.length} stopped`];
      // Still showing the last good read: say so once reads have failed three times running (~30 s).
      if (store.ctFails >= 3) parts.push(div().text_color(c.red).child(`· ${store.ctError}, last read ${ago(now - (store.stamp.containersOk ?? now))} ago`));
    }
    const note = all == null ? (store.ctFails ? store.ctError : "reading docker…") : lines.length ? null : "no containers running";
    this.fitHeight("containers", Math.min(10, Math.max(1, lines.length)));
    return v_flex().size_full().min_h(0)
      .child(title("t-containers", "CONTAINERS", parts))
      .child(header("h-containers", fittedHead(cols)))
      .child(v_flex().id("ct-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(note), (el) => el.child(div().px(CH).text_color(c.dim).child(note)))
        .children(lines));
  }

  // Sizes this region's block to `rows` table rows (plus title and header). Only when it changes,
  // so dragging the divider sticks until the row count changes.
  fitHeight(id, rows, head = true) {
    const px = (ROW + 2) + (head ? ROW : 0) + rows * ROW + 3;
    if (this.fitted === px) return;
    this.fitted = px;
    run("layout.resize", { id, px });
  }

  // ── foot: key hints in plain words ───────────────────────────────────────
  foot(c) {
    const bound = keys();
    const key = (action) => {
      const b = bound.find((k) => k.section === "global" && k.action === action);
      // keys() can repeat a modifier ("ctrl-shift-shift-p"); show each once.
      return b ? [...new Set(b.keys.split("-"))].join("+") : null;
    };
    // alt+up and alt+down share one hint: "alt+up/down  previous/next terminal".
    const prev = key("annunciator.prev"); const next = key("annunciator.next");
    const mod = (k) => k.slice(0, k.lastIndexOf("+") + 1);
    const step = prev && next && mod(prev) === mod(next)
      ? [[`${prev}/${next.slice(mod(next).length)}`, "previous/next terminal"]]
      : [[next, "next terminal"], [prev, "previous terminal"]];
    const hints = [
      [key("annunciator.wall"), "agent wall"], ...step, [key("app.palette"), "commands"], [key("tab.new"), "new tab"],
    ].filter(([k]) => k);
    return h_flex().size_full().items_center().gap(CH * 2).px(CH).border_t(1).border_color(c.rule).text_color(c.dim)
      .children(hints.map(([k, w]) => h_flex().flex_none().gap(CH).child(div().text_color(c.muted).child(k)).child(div().child(w))));
  }
}

// Marks each tree line with its place in its tab (ti of tn, tFirst..tLast) and in its space
// (si of sn, sFirst..sLast), and gives a space's lines the first tab shown under it.
function groupLines(metas) {
  const mark = (key, i, n, first, last) => Object.assign(metas[i], { [key + "i"]: i - first, [key + "n"]: n, [key + "First"]: first, [key + "Last"]: last });
  const runs = (same, key) => {
    for (let i = 0; i < metas.length;) {
      if (!metas[i]) { i++; continue; }
      let j = i;
      while (j + 1 < metas.length && metas[j + 1] && same(metas[i], metas[j + 1])) j++;
      for (let k = i; k <= j; k++) mark(key, k, j - i + 1, i, j);
      i = j + 1;
    }
  };
  // Copy each meta so lines of one space don't share (and overwrite) one object.
  metas.forEach((m, i) => { if (m) metas[i] = { ...m }; });
  runs((a, b) => a.sp.id === b.sp.id, "s");
  runs((a, b) => a.tab && b.tab && a.tab.id === b.tab.id, "t");
  for (const m of metas) if (m) m.firstTab = metas.slice(m.sFirst, m.sLast + 1).find((x) => x.tab)?.tab ?? null;
}

// The 1-based position a dragged item at `src` ends up at, dropped before or after the one at
// `at`; null when that's where it already is. `line` is the tree line that shows the rule.
function slot(src, at, before, line) {
  if (src == null) return null;
  const index = before ? (src < at ? at - 1 : at) : (src < at ? at : at + 1);
  return index === src ? null : { index, line, edge: before ? "top" : "bottom" };
}

const hasNode = (n, id) => Boolean(n && (n.id === id || (n.children ?? []).some((c) => hasNode(c, id))));

function levels() {
  const s = store.sys; const g = store.gpu; const tp = store.temps ?? {}; const d = store.df;
  return {
    cpu: noteLevel("cpu", "cpu 1 min avg", s?.cpuAvg, pct),
    mem: noteLevel("mem", "memory", s ? (100 * s.memUsed) / s.memTotal : null, pct),
    swap: noteLevel("swap", "swap-in", s?.swapInAvg != null ? s.swapInAvg / 1048576 : null, (v) => `${bytes(v * 1048576)}/s`),
    psiMem: noteLevel("psiMem", "memory pressure", s?.psi?.memory, (v) => v.toFixed(1)),
    load: noteLevel("load", "load", s?.load?.[0], (v) => v.toFixed(2)),
    cpuTemp: noteLevel("cpuTemp", "cpu temp 1 min avg", tp.cpuAvg, deg),
    gpuMem: noteLevel("gpuMem", "gpu memory", g && g.memTotal ? (100 * g.memUsed) / g.memTotal : null, pct),
    disk: noteLevel("disk", "disk /", d?.pct, pct),
    ...claudeLevels(),
  };
}

// One level per Claude usage window, keyed claude_<window>; a window that has reset since
// the last reading counts as ok.
function claudeLevels() {
  const out = {};
  for (const w of store.limits?.windows ?? []) {
    const gone = w.resets != null && w.resets <= Date.now();
    out[`claude_${w.key}`] = noteLevel(`claude_${w.key}`, `claude ${w.label}`, gone ? null : w.pct, pct, "claude");
  }
  return out;
}

function offenderText(k) {
  const s = store.sys; const g = store.gpu; const tp = store.temps ?? {}; const d = store.df;
  switch (k) {
    case "cpu": return `cpu ${pct(s?.cpuAvg)} 1 min`;
    case "mem": return `memory ${s ? pct((100 * s.memUsed) / s.memTotal) : "—"}`;
    case "swap": return `swap-in ${s?.swapInAvg != null ? bytes(s.swapInAvg) : "—"}/s`;
    case "psiMem": return `memory pressure ${f1(s?.psi?.memory)}`;
    case "load": return `load ${s?.load?.[0]?.toFixed(2) ?? "—"}`;
    case "cpuTemp": return `cpu ${deg(tp.cpuAvg)} 1 min`;
    case "gpuMem": return `gpu memory ${g?.memTotal ? pct((100 * g.memUsed) / g.memTotal) : "—"}`;
    case "disk": return `disk ${d ? d.pct + "%" : "—"}`;
    default: {
      const w = k.startsWith("claude_") && store.limits?.windows?.find((x) => `claude_${x.key}` === k);
      return w ? `claude ${w.label} ${pct(w.pct)}` : k;
    }
  }
}

const eventsMark = () => `${store.events.length}:${store.events[0]?.at ?? 0}`;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const f1 = (v) => (v == null ? "—" : v.toFixed(1));

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_e) { return fallback; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (_e) { /* best effort */ }
}

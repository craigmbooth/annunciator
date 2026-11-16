// Agent wall. Originally by Víctor Falcón (MIT, see LICENSE-agent-wall),
// github.com/victor-falcon/herdr-mods, commit 2f0a242. Reworked and vendored into annunciator:
//
// On: the whole window becomes a row of columns, one per running agent (every
// space), with a 1 px divider between them. Each column is a header (the "wall"
// role: everything a pane header shows, plus where it lives) over the agent's
// live terminal. At most VISIBLE columns show at once; moving focus past either
// edge slides the view by one.
// Off: the window comes back as it was, focused on the agent you were on.
// The original layout is kept in shared state, so a wall left on survives a
// restart and can still be undone.
//
// Commands (annunciator.wall, annunciator.left, annunciator.right) reach only
// copies that are shown, so the "nav" role, a 0 px block, takes them: the layouts
// put one in the top row, and the wall carries its own.

import { agents, focused, layout, notify, panes, run, setShared, shared } from "herdr";

const WALL_ID = "annunciator-wall";
const NAV_ID = "annunciator-nav";
const STATE_KEY = "annunciator.wall";
const VISIBLE = 4;      // columns on screen at once
const HEADER_PX = 34;   // two 16 px lines and a rule

const navBlock = () => ({ id: NAV_ID, type: "block", size: { px: 0 }, content: { mod: "annunciator", props: { role: "nav" } } });
const cellId = (address) => `${WALL_ID}-${address.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function wallNode(list, offset) {
  const column = (address, i) => ({
    id: `${cellId(address)}-col`,
    type: "column",
    children: [
      {
        id: `${cellId(address)}-head`,
        type: "block",
        size: { px: HEADER_PX },
        window_drag: true,
        content: { mod: "annunciator", props: { role: "wall", terminal: address, index: offset + i + 1, total: list.length } },
      },
      { id: cellId(address), type: "block", content: { terminal: address }, background: "background" },
    ],
  });
  return {
    id: WALL_ID,
    type: "column",
    children: [
      navBlock(),
      { id: `${WALL_ID}-row`, type: "row", divider: { width: 1, color: "border" }, children: list.slice(offset, offset + VISIBLE).map(column) },
    ],
  };
}

const isWall = (tree) => (tree?.children ?? []).some((c) => c.id === WALL_ID);
// The first offset that keeps column i on screen.
const offsetFor = (i, offset, n) => Math.max(0, Math.min(n - VISIBLE, i < offset ? i : i >= offset + VISIBLE ? i - VISIBLE + 1 : offset));

function toggle() {
  const tree = layout();
  if (!tree || typeof tree !== "object") throw new Error("No layout is shown.");
  const saved = shared(STATE_KEY);

  if (isWall(tree)) {
    if (!saved?.children) throw new Error("The saved layout was lost; switch layouts to recover.");
    const inWall = focused()?.terminal;
    const pane = panes().find((p) => inWall && p.terminal === inWall)?.pane ?? saved.pane;
    run("layout.set", { layout: { ...tree, children: saved.children } });
    setShared(STATE_KEY, null);
    if (pane) run("pane.focus", { pane });
    return;
  }

  const all = agents();
  if (all.length === 0) {
    notify({ title: "Agent wall", body: "No agents running.", level: "info" });
    return;
  }
  const list = all.map((a) => a.address);
  const start = Math.max(0, all.findIndex((a) => a.focused));
  const offset = offsetFor(start, 0, list.length);
  setShared(STATE_KEY, { children: tree.children, pane: focused()?.pane ?? null, list, offset });
  run("layout.set", { layout: { ...tree, children: [wallNode(list, offset)] } });
  run("pane.focus", { terminal: list[start] });
}

// Left/right on the wall: the next agent, sliding the view when it is off
// screen. Anywhere else: plain pane.go, as the keys did before.
function go(direction) {
  const tree = layout();
  const saved = shared(STATE_KEY);
  if (!isWall(tree) || !saved?.list) {
    run("pane.go", { direction });
    return;
  }
  const { list } = saved;
  const i = list.indexOf(focused()?.terminal);
  const j = i < 0 ? saved.offset : i + (direction === "right" ? 1 : -1);
  if (j < 0 || j >= list.length) return;
  const offset = offsetFor(j, saved.offset ?? 0, list.length);
  if (offset !== saved.offset) {
    setShared(STATE_KEY, { ...saved, offset });
    run("layout.set", { layout: { ...tree, children: [wallNode(list, offset)] } });
  }
  run("pane.focus", { terminal: list[j] });
}

const COMMANDS = { wall: toggle, left: () => go("left"), right: () => go("right") };

// Runs a wall command by name; returns false for any other command.
export function wallCommand(name) {
  const fn = COMMANDS[name];
  if (!fn) return false;
  try {
    fn();
  } catch (e) {
    notify({ title: "Agent wall", body: String(e?.message ?? e), level: "error" });
  }
  return true;
}

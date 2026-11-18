# Annunciator: brief for an agent picking this up

Annunciator is a single-screen dashboard for the Herdr desktop app. It shows every agent, terminal, space and container, plus the state of the machine, in one dense, terminal-like grid. The style follows U.S. Graphics Company (Berkeley Graphics) without its aerospace branding. Read this file, then `~/.config/herdr-app/AGENTS.md` (Herdr's own guide for agents), before changing anything.

The full design rules, with reasons, are in `DESIGN.md` at the root of this repository. A condensed version is in section 4 below.

---

## 1. What exists

| Path (under `~/.config/herdr-app/`) | What it is |
|---|---|
| `layouts/annunciator.json` | The main layout: a top bar, an agent tree above the terminals on the left, and a side column on the right |
| `layouts/annunciator-narrow.json` | The same without the SYSTEM panel, for smaller windows. `ctrl-shift-l` switches layouts. |
| `layouts/annunciator.svg`, `annunciator-narrow.svg` | Preview images. **Out of date:** they still show the flat agent list and no containers panel. |
| `mods/annunciator/main.js` | One mod drawing every region. The layout picks a region with `props.role`. |
| `mods/annunciator/data.js` | Shared state and probes: Herdr state joined into rows, plus `/proc`, `nvidia-smi`, `df`, `git` and `docker`. Module scope is shared by every copy of the mod, so each probe runs once per interval (`fresh(key, ms, fn)`). |
| `mods/annunciator/ui.js` | Drawing kit: `palette()`, `cell`, `row`, `header`, `title`, `toggle`, `glyph`, `stateBar`, `fit`/`fitted`, plus formatters (`bytes`, `pct`, `ago`, `clock`). |
| `mods/annunciator/config.json` | Settings. `temperature`: `"F"` or `"C"`, display only (`deg()` in `ui.js`; `LIMITS` stay in °C). Read once per load by `loadConfig()`; saving it reloads the mod. |
| `mods/annunciator/wall.js` | Agent Wall (MIT, by Víctor Falcón, github.com/victor-falcon/herdr-mods, commit 2f0a242), rewritten and vendored into annunciator. Keep `LICENSE-agent-wall` next to it. |
| `keys.json` | `alt-up` and `alt-down` → `annunciator.prev` and `annunciator.next`: step through every row of the agent tree, shells and mod panes included, in the order shown, wrapping at the ends. Only the `roster` copy listens, so the keys do nothing where the tree isn't shown (on the wall). `ctrl-shift-a` → `annunciator.wall`. `alt-left` and `alt-right` → `annunciator.left` and `annunciator.right`; outside the wall they fall back to `pane.go`. The `nav` copy takes these three. |

### Layout tree (`annunciator.json`)

```
root column (look: Berkeley Mono 12, titlebar none, colors below)
  top-row row 22px        → top (annunciator:top) + annunciator-nav (0px, annunciator:nav)
  body row (1px dividers)
    left column weight 2, min 480
      roster  (annunciator:roster)  fits its rows, cap 24
      main    {tab:"active"}  the live terminals; pane frame gap 1, radius 0, focus 2px grey, NO pane header
    side column weight 1, min 420
      system      (annunciator:system)      fixed 274px
      events      (annunciator:events)      weight 1: takes what's left
      repos       (annunciator:repos)       fits, cap 8
      containers  (annunciator:containers)  fits, cap 10
      limits      (annunciator:limits)      fits its windows
      procs       (annunciator:procs)       top 8 by cpu
  foot 20px (annunciator:foot)
```

The `px` sizes in the file change at runtime. Regions call `layout.resize` to fit their rows (`fitHeight()` in main.js), and Herdr writes the result back to the file.

## 2. The regions (roles in `mods/annunciator/main.js`)

| Role | Shows | Data, how often | Clicks |
|---|---|---|---|
| `top` | Only what needs you or has errored, with how long it's waited, plus machine warnings; empty when all is calm. A clock only in the narrow layout (otherwise the SYSTEM title has it). Window buttons. | Herdr state; system levels every 5 s | — |
| `roster` | **Agent tree.** For each space, a header line (name, branch, `+`), then every pane: `├─ 1` or `├─ 2.1` for a pane in a split tab. Agents get a full row: glyph, task, branch (blank when it matches the space's), for, ctx (% of the context window used, from the status line's `context_window`; amber at 80%, red at 95%, `LIMITS.context`; blank for anything that isn't Claude Code), cpu, mem, doing (or the question a blocked agent is asking). Shells (`$`) and mod panes (`·`) get one muted line. Sub-agents nest under their agent. Title: `N spaces · N agents`, then toggles `faults only`, `by urgency` (a flat triage list with a where column), `new space`. | `agents()`, `panes()`, `terminals()`, `spaces()`, `hc get`; `/proc` CPU every 5 s; screen read once when an agent becomes blocked; `~/.cache/annunciator/context/<claude pid>.json` every 5 s, for running `claude` processes only | A pane line focuses that pane; a space line selects the space; `+` runs `tab.new` in that space's working folder; clicking an agent's glyph folds its sub-agents; dragging a tab's line (any of its panes) moves it within its space (`tab.move`), dragging a space line moves the space (`space.move`, same machine only). A 2 px grey rule shows where it lands; leaving the tree cancels. Herdr has no command to move a tab to another space, so other spaces show no rule. |
| `events` | Time-ordered log: agent state changes, system thresholds crossed, container state changes. Newest first, filling whatever height the side column has left; older entries scroll. It is the side column's only flexible panel, so it shrinks first when the window is short. | Kept in memory; the last 500 saved to localStorage | Focuses the agent |
| `system` | Label/value table in TR-100 style: cpu, cores, load, pressure, memory, swap, GPU (NVIDIA, through `nvidia-smi`), temperatures, disk, disk and network I/O, with bars and sparklines | `/proc`, hwmon, `nvidia-smi`, `df`, every 2 s | — |
| `repos` | One row per git repo the terminals are in: branch, dirty, ahead, behind, number of agents, path | `git status --porcelain=v2`, every 30 s | — |
| `containers` | Docker. Problems first, one row each: restarting or unhealthy (red, with a bar), or failed in the last 24 h. Healthy containers fold into one row per compose project (`+ myproject ×6`) and unfold on click. Stopped containers are only counted in the title. | `docker inspect` every 10 s; `docker stats` every 15 s | A project row unfolds or folds; a container row selects the space working in that project's folder |
| `limits` | **Claude limits.** One row per plan usage window (`5 hour`, `7 day`, and a spend limit when the payload has one): % used, bar, reset time (weekday when over a day away), time until it resets. Amber at 80%, red at 95% (`LIMITS.claude`), with an event and a top-bar entry per window. A window whose reset has passed shows `—` and `reset` until a new reading. Title: how old the reading is. | `~/.cache/annunciator/claude-limits.json`, every 10 s. The user's Claude Code status line script writes it from the `rate_limits` field of its stdin payload (see the root README, Install step 4); nothing reads credentials | — |
| `procs` | Top 8 processes by CPU, with the agent that started each (found by walking parent pids); clicking the agent focuses its pane, a sub-agent's goes to its parent | `/proc/*/stat` deltas, every 5 s | — |
| `foot` | Key hints in plain words, the layout name, counts | `keys()` | — |
| `wall` | Two-line header over each column of Agent Wall: glyph, n/N, task, where, agent, folder, branch, time in state; then what the agent is doing | Same as roster, every 5 s | Focuses that terminal |
| `nav` | Draws nothing (0 px). Takes the Agent Wall commands `annunciator.wall`, `.left` and `.right` (`wall.js`) | — | — |
| `pane` | Pane header. **Not used in any layout now** (the agent tree already says everything it did), but kept. | | |

Docker rules (`ctKind()` in data.js), worst first:

- **restarting:** the state is `restarting`, or the restart count rose since the last probe (so a crash loop doesn't flicker).
- **unhealthy** and **starting:** from the health check.
- **stopped:** exit code 0, 137 or 143; state `created`; **or any exit under the `always` or `unless-stopped` restart policies.** Docker would have restarted those, so a person stopped them, and Docker keeps the last crash's exit code.
- **failed:** any other non-zero exit.

The probes only read. There are no start, stop or restart buttons.

A failed read never blanks the panel. The last good list stays up, and after three failures in a row (about 30 s) the title adds a red `docker is not answering, last read Ns ago`. A partial read (a container removed between `ps` and `inspect`) counts as good. The last list is kept in localStorage (`ctLast`) and shown immediately after a reload or restart.

## 3. Agent Wall

- **On** (`ctrl-shift-a`): the whole window becomes one column per running agent, across all spaces, with 1 px dividers. At most 4 columns are visible. Each column is a 34 px `annunciator:wall` header over the agent's live terminal.
- **Moving:** `alt-left` and `alt-right` move between agents. Moving past either edge slides the view by one.
- **Off:** the same key restores the saved layout and focuses the agent that was focused on the wall.
- **How it works:** `wall.js`. The original children are kept in shared state (`annunciator.wall`), so a wall left open survives a restart. The 0 px `annunciator-nav` block (`annunciator:nav`) receives the key commands, and the wall carries its own copy; it must stay in an always-visible place, because `<mod>.<command>` only reaches copies that are shown.
- **Constraints:** the terminals block must keep the id `main`, and the tree must stay shallow (`layout.set` refuses nesting deeper than 16 levels). `layout.set` only works on personal layouts.

## 4. Design principles (condensed; the full version is in `design-principles.md`)

1. **Density is the point.** Rows are 16 px, titles 18 px. No cards, padding or gaps. Everything is visible without opening anything.
2. **Character grid.** One character is 7.2 px. Columns are fixed widths in characters; numbers are right-aligned. Text is cut short with `…` and never wraps. Columns drop out whole, in a stated order; spare width goes to the longest content (task, then branch).
3. **One typeface, one size:** Berkeley Mono 12, Regular and Bold only.
   - **Bold** = region names, or an agent or container in trouble. Nothing else.
   - UPPERCASE = region names; lowercase = column headers.
   - *Oblique* = a state Herdr inferred from the screen.
   - Underline = focused.
4. **Color has meaning.** Everything is grey unless it answers a question.
   - **Amber `#ffb700`** = needs you.
   - **Red `#ff4136`** = error or failing.
   - **Green `#3fbf74`** = done, not yet seen.
   - **Blue-grey** = structure only: lines `#2b3442`, header text `#8494a8`, header rule `#465263`.
   - Healthy and running stay grey.
   - Color goes on the state word, the 3 px left bar and the title count, never the whole row.
   - Test: the screen must work with all color removed, and any color added must name a state.
5. **Grey ladder, three steps:**
   - foreground `#d8d8d8` = values
   - muted `#9a9a9a` = secondary values
   - dim `#5f5f5f` = labels, paths, times, zeros, tree lines
   - background `#0b0b0b`; selected `#1e1e1e`; hover `#1a1a1a`
6. **Focus has no hue:** a 2 px grey frame, a neutral tint and an underline. (A blue focus outline was tried and rejected.)
7. **Every state also has a shape:**
   - working `▖▘▝▗` (turning), needs you `■`, error `×`, done `•`, idle `–`, exited `ø`, shell `$`, mod pane `·`
   - There's no state column; the glyph is the state.
   - Use only glyphs Berkeley Mono contains. It **lacks** `○ ◦ □ ▪ ◇ ✕ ✗ ∅ ⋅ ▸`.
8. **Show exceptions, count the normal:** problems on top, healthy things collapsed.
9. **Time in state beside every state.**
10. **Each fact appears once:**
    - The spaces panel was merged into the agent tree.
    - The where column and the pane header row were dropped.
    - An inherited branch is left blank.
11. **Blank vs `—` vs `0`:**
    - blank = doesn't apply, or is inherited
    - `—` = should have a value but doesn't
    - dim `0` = a real zero
12. **Plain, short words** (`needs you`, `restarting`). No codes, invented abbreviations or NASA flavor.
13. **Regions fit their content,** with a cap. Only the event log takes leftover height. No fixed-height panels holding two rows, and no clipped columns.
14. **Lines separate, bars signal.** No rounded corners, shadows, icons or gradients.
15. **Hierarchy is drawn as a `tree`:** `├─ └─ │`, drawn dim.
16. **Read first, act gently.**
    - Clicks only navigate, create or reorder.
    - No kill, stop or close buttons; destructive actions stay on keys.
    - No mod that reads credentials, downloads binaries or spends tokens.
17. **Only the working spinner moves.**
18. **Be honest about the data:**
    - Inferred states are oblique.
    - A failed probe keeps its last value.
    - Don't fake values Herdr doesn't expose (tokens, cost, context).

**Checklist for a new panel:**
- Does it show something new?
- Is every column a fixed width in characters, with a drop order?
- Is it grey when everything is fine?
- Does every color name a state?
- Is focus shown without hue?
- Do problems come first, with healthy things collapsed?
- Is there a time in state?
- Does it fit its rows, with a cap?
- Is it read-only?
- Are its glyphs all in the font?
- Are its labels plain words?

## 5. How to work on it

- **Check:** `herdr-app check ~/.config/herdr-app/mods/annunciator` loads the mod once, but only in its default role (`roster`). To check another role, copy the folder to scratch and pin the role:
  ```sh
  cp -r ~/.config/herdr-app/mods/annunciator /tmp/role/annunciator
  sed -i 's/this.role = ROLES.includes(role) ? role : "roster";/this.role = "containers";/' /tmp/role/annunciator/main.js
  herdr-app check /tmp/role/annunciator
  ```
- **Status:** `herdr-app status` must show `"errors": []`. Saved files hot-reload in the running window.
- **Look at it:** `herdr-app shot file.png`, then crop the region you changed (with Python and Pillow) and look. Verify visually every time; a passing check doesn't prove the layout is right.
- **Drive it:** `herdr-app do <command> '<json>'` (for example `herdr-app do annunciator.wall`). `herdr-app commands` lists every command and its arguments.
- **Adding a role:**
  1. Add it to `ROLES`.
  2. Write a method `name(c)` returning a `v_flex`: `title()`, then `header()`, then a scrolling list.
  3. Start any probe in `init` with `every(ms, …)`.
  4. Call `this.fitHeight(id, rows)`.
  5. Add a block `{id, type:"block", content:{mod:"annunciator", props:{role}}, size:{px}, min:52}` to **both** layouts.
- **Editing files:** Herdr may rewrite the layout files (sizes). Edit them with a JSON load and dump in Python, not by hand-matching text.

### Herdr quirks found while building this

- In `init(p, cx)` the first argument doesn't carry the layout props; use `props()`.
- `terminals()` gives `status_ms: null` and `records` as an object. `hc get <terminal> --json` has the real `status_ms`.
- `writeTextFile(path, text, null)` fails if the file exists (it only creates).
- `ps` `pcpu` is an average over the process's whole life, so per-process CPU uses `/proc/*/stat` deltas instead.
- `keys()` can repeat a modifier (`ctrl-shift-shift-p`), so the footer deduplicates.
- `tab.new` defaults to the *focused* terminal's folder. Pass `folder` explicitly.
- `layout.set`: personal layouts only, at most 16 levels of nesting, and it rewrites the file.

### Working rules

- Never edit `AGENTS.md` or the `.d.ts` files.
- Never edit shipped mods or layouts; clone them first.
- On a name clash, rename; never overwrite.
- Ask before replacing a key binding someone already uses.
- Before installing any gallery mod, read every file and say whether it reaches the network, runs programs (`exec`, `hc`) or reads files outside its own folder.
- Back up a file before a structural change.
- Hold every change to `DESIGN.md`: density, plain words, color only with meaning, no duplicated information, no empty space. Check each change with a screenshot and say plainly what wasn't tested.

## 6. Open items

- **Never dragged:** drag-to-reorder in the agent tree has only been checked with `herdr-app check`, a screenshot, and `tab.move` run by hand. The mouse handling itself (`draggable`, `dragOver`, `drop` in main.js) hasn't been tried with a real pointer yet.
- **Never clicked:** the click actions in the agent tree and containers panel (space select, pane focus, `+` new tab, `new space`, unfolding a project) have never been clicked. Only their command arguments were checked against `herdr-app commands`.
- **Never seen on screen:** the `by urgency` flat view.
- **Previews out of date:** `annunciator.svg` and `annunciator-narrow.svg`.
- **Ideas not yet built:**
  - a read-only listening-ports panel, attributing each port to an agent
  - PR and checks columns on REPOS (via `gh`, which reaches GitHub)
  - a recent-commits panel
  - a context-size column in the agent list

# Annunciator design principles

These are the rules behind the annunciator layout for Herdr. They're written out so a new panel, column or mod can be checked against them, rather than against memory of how the others look.

The starting point is U.S. Graphics Company's own description of its TR-100 machine report: *tabular, short, clear and concise*. Monochrome by default, fixed label columns, values cut short instead of wrapped, hairline rules. We keep that discipline and leave out the aerospace costume: no mission branding, no codes, no abbreviations a person has to learn.

---

## 1. Density is the point

**Rule.** Everything that matters is visible at once, on one screen, without opening anything.

- Every table row is exactly **16 px**. A region title is 18 px. Nothing is taller than it has to be.
- No cards, no tiles, no padding beyond one character, no gaps between panes (gap 1 px, radius 0).
- A region earns its space by the rows it shows. An empty region doesn't get a fixed height (see 13).

**Why.** You watch many agents and a whole machine at once. Every pixel of chrome is a row of information you can't see.

## 2. Everything sits on a character grid

**Rule.** Layout is measured in characters, not pixels: one character is **7.2 px** (Berkeley Mono at 12 px, a 0.6 em advance).

- Every column has a fixed width in characters. Numbers are right-aligned, text is left-aligned.
- Text never wraps. It is cut short with `…`.
- When a table is too narrow, whole columns drop out in a stated priority order. A column never gets squeezed.
- When a table has room to spare, the column whose content is longest grows first (the task name, then the branch), up to a cap.

**Why.** Fixed columns let your eye run straight down a column and compare values without reading. Wrapping breaks the grid and makes row heights vary.

## 3. One typeface, one size

**Rule.** Everything is **Berkeley Mono, 12 px**. Hierarchy comes from weight, case and grey level, never from size.

| Device | Means | Used for |
|---|---|---|
| **Bold** | look here | Region names, and the name of an agent or container that is in trouble. Nothing else. |
| UPPERCASE | a region | `AGENTS`, `SYSTEM`, `EVENTS`, `REPOS`, `CONTAINERS`, `PROCESSES` |
| lowercase | a column | `task`, `branch`, `for`, `cpu`, `mem` |
| *Oblique* | not first-hand | A state Herdr inferred from the screen rather than one the agent reported |
| Underline | focused | The task of the terminal you're in, and toggles that are on |

**Why.** One size keeps the grid exact. If bold means "trouble" every time, a bold word is an alarm you can trust.

## 4. Color has meaning

**Rule.** A color appears only when it answers a question. Everything else is grey.

| Color | Hex | Means | Never used for |
|---|---|---|---|
| Amber | `#ffb700` | **Needs you**: an agent is waiting on a person | warnings about the machine you can ignore |
| Red | `#ff4136` | **Error**: something failed or is failing (an agent errored, a container is restarting or unhealthy, a metric is critical) | emphasis, deleting, closing |
| Green | `#3fbf74` | **Done, not yet seen**: finished work you haven't looked at | "OK", healthy, running |
| Blue-grey | `#2b3442` lines, `#8494a8` header text, `#465263` header rule | **Structure**: dividers, rules, region names, column headers | data, focus, state |

The tests:

- **Remove the hue.** The screen must still work, because shape, position and weight carry the same message (see 7).
- **Add a hue.** It must name a state from the table above. If it doesn't, it's decoration, so take it out.
- **Healthy is grey.** Running, idle and OK make no noise. Only change from normal gets color.
- **Color the change, not the row.** In the event log, only the word for the new state is colored. In a table, the state word, the 3 px bar on the left and the count in the title are colored, and the rest of the row stays grey.

**Why.** If color is rare, you see it from across the room. A palette used for decoration or branding trains you to ignore it.

## 5. Grey is a ladder with three steps

| Step | Hex | Used for |
|---|---|---|
| Foreground | `#d8d8d8` | Values: the thing you came to read |
| Muted | `#9a9a9a` | Secondary values: branch, memory, what an agent is doing |
| Dim | `#5f5f5f` | Labels, paths, timestamps, inherited fields, zeros, tree lines |

The background is `#0b0b0b`. A selected row is `#1e1e1e`, and hovering a row tints it `#1a1a1a`.

**Rule.** Three steps, no more. Something less important moves one step down the ladder. It doesn't get smaller or lighter weight.

## 6. Focus and selection have no hue

**Rule.** Where you are is shown by weight and tone, never by color:

- the focused terminal's frame is a **2 px grey rule**, and every other frame is 1 px;
- the focused row gets a **neutral grey tint** and an **underlined** task name;
- a toggle that is on is full-strength and underlined, and one that is off is dim.

**Why.** Focus changes all the time. If it were blue, blue would stop meaning anything, and it would compete with the state colors. (A blue focus outline was tried and dropped for exactly this reason.)

## 7. Every state also has a shape

**Rule.** Each state has its own glyph, so color is never the only signal.

| State | Glyph | Color |
|---|---|---|
| working | `▖ ▘ ▝ ▗` (turning) | foreground |
| needs you | `■` | amber |
| error | `×` | red |
| done, not seen | `•` | green |
| idle | `–` | dim |
| exited | `ø` | dim |
| shell (not an agent) | `$` | dim |
| mod pane | `·` | dim |

There's no separate state column. The glyph is the state.

Use only glyphs Berkeley Mono contains. It has `─ ├ └ │ ┬ ■ • · × – — ° ø ≡ ═ ▁ ▔ ░ █ ▌ ▐ ▶ → › …`. It lacks `○ ◦ □ ▪ ◇ ✕ ✗ ∅ ⋅ ▸`, so don't use those.

## 8. Show exceptions, count the normal

**Rule.** Problems get their own rows at the top. Healthy things get a count or one summary row.

- Containers: each restarting, unhealthy or recently failed container gets its own row. Healthy ones fold into one row per project.
- The event log: it fills whatever height is left and older entries scroll, so a busy hour shows more, not a count. The title says how many happened in the last 10 minutes, in grey: activity, not a fault.
- `faults only` hides everything calm, and `by urgency` sorts what needs you to the top.
- Stopped containers, idle states and zero counts appear only as numbers in a title.

**Why.** On a calm day the screen should be quiet, so the one thing that isn't stands out. This follows alarm-management practice: flooding the operator is a failure of the display, not of the operator.

## 9. Time in state, beside every state

**Rule.** Wherever a state is shown, show how long it has held (`for`: `7h53`, `2d02`, `17s`).

**Why.** It's the most useful number on the screen. State detection can be wrong: an agent can look idle while a question has sat on its screen for twenty minutes. The duration, beside the last line of the screen, is what catches that.

## 10. Each fact appears once

**Rule.** If two places show the same thing, merge them or drop one.

- The spaces tree and the agent list became one tree (space → tab → pane).
- The where column went away because the tree already shows it.
- An agent's branch is left blank when it matches its space's branch.
- The pane header row was removed because the agent list already says everything it did.

**Why.** Repetition costs space and makes you check whether the two copies disagree.

## 11. Blank, dash and zero mean different things

| Shown | Means |
|---|---|
| (blank) | Doesn't apply here, or is inherited from the row above |
| `—` | Should have a value but doesn't (unknown, not reported) |
| `0`, dim | A real zero |

## 12. Plain words, short

**Rule.** Labels are ordinary words a person would say: `needs you`, `working`, `restarting`, `top 8 by cpu`, `new space`. Common short words like `cpu`, `mem` and `pid` are fine. Codes and invented abbreviations are not.

## 13. Regions fit their content

**Rule.** A list region sizes itself to its rows, up to a cap, then scrolls. The event log, an open-ended stream, takes whatever height is left.

| Region | Fits | Cap |
|---|---|---|
| Agent tree | its rows | 24 |
| Containers | its rows | 10 |
| Repos | its rows | 8 |
| Processes | top 8 by cpu | 8 |
| System | fixed | — |
| Events | the rest | — |

**Why.** A fixed-height panel holding two rows is mostly empty space, and a fixed-width one clips its last column. Both were tried, and both were rejected.

## 14. Lines separate, bars signal

- **1 px blue-grey hairlines** separate regions and sit under titles and column headers.
- **A 3 px bar** on a row's left edge is a state signal (amber, red or green), never decoration.
- **A 2 px grey rule** marks focus.
- No rounded corners, shadows, gradients, icons or illustrations.

## 15. Hierarchy is drawn as a tree

**Rule.** Nesting uses the `tree` command's lines (`├─`, `└─`, `│`), drawn dim, with labels like `1` for a tab and `2.1` for a pane in a split tab. Groups fold and unfold with a click.

## 16. Read first, act gently

**Rule.** Panels show things. Clicking a row goes to it: it focuses a terminal or selects a space. The only other actions create things (`+` for a tab, `new space`).

- No kill, stop, restart, close or delete buttons in a panel. Destructive actions stay on keys, where they're deliberate.
- No mod that reads credentials, downloads binaries or spends tokens on its own.

**Why.** A dense screen gets clicked by accident. Nothing on it should be able to do damage.

## 17. Motion is information

**Rule.** The only thing that moves is the working spinner. Nothing fades, slides or pulses.

**Why.** Movement pulls the eye harder than color does, so it's reserved for "this is alive right now".

## 18. Be honest about the data

- A state Herdr inferred from the screen is set in oblique.
- A failed probe keeps its last value. It doesn't flash or go blank.
- Values that aren't available (tokens, cost, context) aren't faked or estimated.
- A count that climbs is believed over a snapshot. For example, a container whose restart count rose is treated as restarting even if the probe caught it during a moment of "running".

---

## Checklist for a new panel

1. Does it show something not already on screen? (10)
2. Is every column a fixed width in characters, with a drop order? (2)
3. Is it grey when everything is fine? (4, 8)
4. Does every color name a state from the table, and is that color only on the state word, the left bar and the title count? (4)
5. Is focus shown without hue? (6)
6. Do problems sort to the top, and do healthy things collapse? (8)
7. Is there a time in state? (9)
8. Does it fit its rows, with a cap? (13)
9. Is it read-only, with clicks that only navigate or create? (16)
10. Are its glyphs all in Berkeley Mono? (7)
11. Are its labels plain words? (12)

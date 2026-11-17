# Annunciator

A single-screen dashboard for the [Herdr](https://herdr.dev) desktop app. It shows every agent, terminal, space and Docker container, plus the state of the machine, in one dense, terminal-like grid of fixed character columns. Everything is grey until something needs you.

The look follows U.S. Graphics Company's machine reports, *tabular, short, clear and concise*, without their aerospace branding. The rules are in [DESIGN.md](DESIGN.md).

```
AGENTS  3 spaces · 3 agents                                        faults only  by urgency  new space
     task                               branch                for   age  cpu   mem  doing
api                                     main                                                    +
├─ 1 ■  Migrate the billing tables                            12m   2h04  0%  310M  Run the migration? (y/n)
└─ 2 $  bash  ~/src/api
web                                                                                             +
└─ 1 ▖  Fix the login redirect                                 3m   41m   9%  702M  Editing src/auth.ts
```

## What's on screen

| Region | Shows |
|---|---|
| **Agent tree** (above the terminals) | Every space, then every pane in it: `├─ 1` for a tab, `├─ 2.1` for a pane in a split tab. Agents get a full row: state symbol, task, branch, time in state, age, cpu, memory, and what they're doing (or the question they're asking). Shells and other panes get one muted line. Click a row to go to it. Drag a tab's row to reorder tabs within its space, or a space's name line to reorder spaces. `+` opens a tab in that space's folder. |
| **Terminals** | The shown tab, framed with 1 px rules, without a pane header. |
| **System** | CPU, cores, load, pressure, memory, swap, NVIDIA GPU, temperatures, disk, disk and network I/O, as a label/value table with bars and sparklines. Holds the clock. |
| **Events** | Every agent state change, system threshold crossed and container state change, newest first. |
| **Repos** | One row per git repo the terminals are in: branch, dirty, ahead, behind, agents. |
| **Containers** | Docker. Containers that are restarting, unhealthy or recently failed come first, in red. Healthy ones fold into one row per compose project. |
| **Claude limits** | Each Claude plan usage window (5 hour, 7 day) with % used, a bar, when it resets and how long until then. Amber at 80%, red at 95%. |
| **Processes** | Top 8 by CPU, each with the agent that started it. A process using more than one whole core (over 100%) shows its cpu in amber. Click the agent to go to its terminal. |
| **Top bar** | Only what needs you or has errored, plus machine warnings. Empty when all is calm. |
| **Bottom bar** | Key hints. |

**State symbols:**

| Symbol | State |
|---|---|
| `■` amber | needs you |
| `×` red | error |
| `▖▘▝▗` turning | working |
| `•` green | done, not seen |
| `–` | idle |
| `ø` | exited |
| `$` | a shell |

`annunciator-narrow` is the same layout without the System panel, for smaller windows.

It also includes a reworked **Agent Wall**: one key turns the whole window into one column per running agent, across every space, with at most 4 on screen at once.

## Install

Requires the Herdr desktop app on **Linux**. The system panel reads `/proc` and `/sys`.

- **Optional:** `nvidia-smi` for the GPU rows, `git` for Repos, and `docker` for Containers. Without one, its rows stay blank (Containers says "docker is not installed").
- **Font:** Berkeley Mono, a commercial font. Without it, Herdr falls back to its bundled JetBrains Mono.

1. **Copy the files** into your Herdr home. Don't overwrite a mod or layout you already have with the same name; rename one of them instead.
   ```sh
   cp -r mods/annunciator ~/.config/herdr-app/mods/
   cp layouts/annunciator*.json layouts/annunciator*.svg ~/.config/herdr-app/layouts/
   ```
2. **Add the key bindings** from `keys.json` to the `global` section of `~/.config/herdr-app/keys.json`. Check first for keys you already use: these replace `alt-up`/`alt-down` (next/previous agent) and `alt-left`/`alt-right` (move between panes).
3. **Show the layout:**
   ```sh
   herdr-app do layout.switch '{"name":"annunciator"}'
   ```
   `herdr-app status` should show `"errors": []`.
4. **Claude limits (optional):** Claude Code passes your plan's usage windows to its status line command as JSON on stdin (`rate_limits`). Add this to your status line script (`statusLine` in `~/.claude/settings.json`) so it saves just that part for the panel. It needs `jq`. If your script already reads stdin, pipe that same JSON through the `jq` line instead.
   ```sh
   limits="$HOME/.cache/annunciator/claude-limits.json"
   mkdir -p "${limits%/*}"
   jq -c 'select(.rate_limits != null) | {at: now, rate_limits}' 2>/dev/null >"$limits.tmp" \
     && [ -s "$limits.tmp" ] && mv "$limits.tmp" "$limits" || rm -f "$limits.tmp"
   ```
   The reading is as fresh as the last time a Claude Code session refreshed its status line; the panel title says how old it is.

**Settings** are in `~/.config/herdr-app/mods/annunciator/config.json`. Saving it reloads the mod.

| Setting | Values |
|---|---|
| `temperature` | `"F"` or `"C"`: the unit temperatures are shown in. Thresholds are set in °C either way. |

## Keys

| Key | Does |
|---|---|
| `alt-up`, `alt-down` | Previous or next row of the agent tree, shells included, wrapping at the ends |
| `ctrl-shift-a` | Agent Wall on or off |
| `alt-left`, `alt-right` | On the wall: previous or next agent, sliding the view. Elsewhere: move between panes. |

## What it runs

Mods are trusted code in Herdr, so here is everything this one does outside Herdr's own API:

- **Runs programs:**
  - `sh` to read `/proc` and `/sys` (CPU, memory, load, pressure, network, disk I/O, hwmon temperatures)
  - `nvidia-smi`
  - `df -Pk /`
  - `git rev-parse` and `git status` in each terminal's folder
  - `docker ps`, `docker inspect` and `docker stats --no-stream`
  - `hc get` and `hc read` (Herdr's own core: agent timing, and the last line of a blocked agent's screen)
- **Network:** none.
- **Files:** reads `/proc`, `/sys` and `~/.cache/annunciator/claude-limits.json` (written by your status line, see Install), and writes nothing outside Herdr's per-mod storage.
- **Actions:** clicks only navigate, create or reorder (focus a pane, select a space, new tab, new space, drag a tab or space to a new position). There are no kill, stop, restart or close buttons.

Agent Wall uses only Herdr's API.

## For agents working on this

[mods/annunciator/README.md](mods/annunciator/README.md) is a brief for a coding agent covering:
- how the mod is built (one mod, several regions chosen by `props.role`)
- the data sources
- how to check each region
- the Herdr quirks found while building it
- open items

Read it, then Herdr's own `~/.config/herdr-app/AGENTS.md`, before changing anything.

## Credits

Agent Wall is based on [victor-falcon/herdr-mods](https://github.com/victor-falcon/herdr-mods) (MIT, commit 2f0a242), rewritten and built into the annunciator mod. Its license is in [mods/annunciator/LICENSE-agent-wall](mods/annunciator/LICENSE-agent-wall).

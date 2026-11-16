// annunciator: data — live Herdr state joined into rows, plus cheap system probes.
// Module scope is shared by every copy of this mod: probes run once per interval
// no matter how many regions ask (see `fresh`). No host calls at module top level.

import { exec, hc, agents, panes, terminals, spaces, home, readTextFile } from "herdr";

// ── shared cache ────────────────────────────────────────────────────────────
export const store = {
  sys: null,          // latest system sample (derived)
  sysPrev: null,      // previous raw counters, for rates
  hist: { cpu: [], net: [], gpu: [], temp: [], disk: [], swapIn: [] },
  gpu: null,
  temps: null,
  df: null,
  ps: [],             // [{pid, ppid, cpu, mem, rss, etimes, comm}]
  repos: [],          // [{path, repo, branch, dirty, ahead, behind}]
  containers: null,   // null until read; [] when docker answers with none; {error} when it can't
  dstats: {},         // container name -> {cpu, mem} from `docker stats`
  ctSeen: {},         // container name -> {kind, restarts}: for events
  ctFails: 0,         // failed docker reads in a row; the last good list stays shown meanwhile
  ctError: null,      // why the last read failed
  screens: {},        // address -> {at: status_ms, line}
  events: [],         // newest first: {at, where, from, to, detail, level}
  seenStatus: {},     // address -> {s, at}
  levels: {},         // metric -> "ok" | "warn" | "crit"
  core: {},           // address -> {status_ms, records, msg} from `hc get`
  inflight: {},
  stamp: {},
};

// Runs `fetch` when `key` is older than `ms` and not already running. Resolves when fresh.
export async function fresh(key, ms, fetch) {
  const now = Date.now();
  if (store.inflight[key]) return store.inflight[key];
  if (store.stamp[key] && now - store.stamp[key] < ms) return;
  store.inflight[key] = (async () => {
    try { await fetch(); } catch (_e) { /* a failed probe leaves the last value; shown as stale */ }
    store.stamp[key] = Date.now();
    store.inflight[key] = null;
  })();
  return store.inflight[key];
}

const push = (arr, v, n = 60) => { arr.push(v); if (arr.length > n) arr.shift(); };
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// ── thresholds (tuned for one workstation: adjust LIMITS for yours) ──────────
export const LIMITS = {
  // swap is judged by swap-in rate (MB/s, 10 s average), not by how full it is:
  // the kernel parks cold pages in swap and leaves them there, so a full swap
  // with free RAM is normal. Pages coming back in is what makes things slow.
  // cpu and cpuTemp are judged on a 1-minute average (cpuAvg, cpuTemp avg), so a burst of
  // work doesn't trip them. This CPU calls 85 °C "high" and 105 °C critical, and runs in
  // the 90s under load, so it warns only when it stays hot.
  cpu: [90, 98], mem: [80, 90], swap: [2, 20], disk: [90, 95],
  psiMem: [10, 25], cpuTemp: [95, 100], gpuMem: [85, 95], load: [16, 20],
  // every Claude usage window (5 hour, 7 day, …), as % used
  claude: [80, 95],
};
export const level = (key, v) => {
  const l = LIMITS[key];
  if (v == null || !l) return "ok";
  return v >= l[1] ? "crit" : v >= l[0] ? "warn" : "ok";
};

// ── system: procfs batch every 2 s ──────────────────────────────────────────
const PROC_SCRIPT = [
  "echo @stat; cat /proc/stat",
  "echo @mem; cat /proc/meminfo",
  "echo @load; cat /proc/loadavg",
  "echo @net; cat /proc/net/dev",
  "echo @disk; cat /proc/diskstats",
  "echo @vm; grep -E '^pswp(in|out) ' /proc/vmstat",
  "for p in cpu io memory; do echo @psi_$p; cat /proc/pressure/$p 2>/dev/null; done",
].join("; ");

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@")) { cur = line.slice(1).trim(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

const PAGE = 4096; // /proc/vmstat pswpin/pswpout count pages

const SKIP_IF = /^(lo|docker\d*|br-|veth|virbr|tun|tap)/;

export function probeSystem() {
  return fresh("proc", 1800, async () => {
    const r = await exec("sh", ["-c", PROC_SCRIPT], { timeout: 5000 });
    const s = sections(r.stdout);
    const now = Date.now();
    const raw = { at: now, cores: [] };
    for (const l of s.stat ?? []) {
      const m = l.match(/^cpu(\d*)\s+(.*)$/);
      if (!m) continue;
      const v = m[2].trim().split(/\s+/).map(Number);
      const idle = v[3] + (v[4] || 0);
      const total = v.reduce((a, b) => a + b, 0);
      if (m[1] === "") raw.cpu = { idle, total };
      else raw.cores[Number(m[1])] = { idle, total };
    }
    const mem = {};
    for (const l of s.mem ?? []) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mem[m[1]] = Number(m[2]) * 1024; }
    const load = (s.load?.[0] ?? "").split(/\s+/).slice(0, 3).map(Number);
    let rx = 0, tx = 0; const ifs = [];
    for (const l of (s.net ?? []).slice(2)) {
      const m = l.trim().match(/^([^:]+):\s*(.*)$/);
      if (!m || SKIP_IF.test(m[1])) continue;
      const v = m[2].split(/\s+/).map(Number);
      rx += v[0]; tx += v[8]; if (v[0] + v[8] > 0) ifs.push(m[1]);
    }
    let rd = 0, wr = 0;
    for (const l of s.disk ?? []) {
      const v = l.trim().split(/\s+/);
      if (/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+)$/.test(v[2])) { rd += Number(v[5]) * 512; wr += Number(v[9]) * 512; }
    }
    const psi = {};
    for (const k of ["cpu", "io", "memory"]) {
      const m = (s[`psi_${k}`]?.[0] ?? "").match(/avg10=([\d.]+)/);
      psi[k] = m ? Number(m[1]) : null;
    }
    const vm = {};
    for (const l of s.vm ?? []) { const [k, v] = l.trim().split(/\s+/); if (v) vm[k] = Number(v) * PAGE; }
    Object.assign(raw, { rx, tx, rd, wr, swin: vm.pswpin ?? 0, swout: vm.pswpout ?? 0 });
    const p = store.sysPrev;
    const pct = (a, b) => (b && a && a.total > b.total ? 100 * (1 - (a.idle - b.idle) / (a.total - b.total)) : null);
    const dt = p ? (now - p.at) / 1000 : null;
    const rate = (k) => (p && dt > 0 ? Math.max(0, (raw[k] - p[k]) / dt) : null);
    const cpu = pct(raw.cpu, p?.cpu);
    const sample = {
      at: now,
      cpu,
      cores: raw.cores.map((c, i) => pct(c, p?.cores?.[i])),
      load,
      psi,
      memTotal: mem.MemTotal, memUsed: mem.MemTotal - mem.MemAvailable,
      swapTotal: mem.SwapTotal, swapUsed: mem.SwapTotal - mem.SwapFree,
      rx: rate("rx"), tx: rate("tx"), rd: rate("rd"), wr: rate("wr"),
      swapIn: rate("swin"), swapOut: rate("swout"),
      ifs,
    };
    store.sysPrev = raw;
    if (cpu != null) push(store.hist.cpu, cpu);
    sample.cpuAvg = mean(store.hist.cpu.slice(-30)); // 30 × 2 s = 1 min
    if (sample.rx != null) push(store.hist.net, sample.rx + sample.tx);
    if (sample.rd != null) push(store.hist.disk, sample.rd + sample.wr);
    if (sample.swapIn != null) push(store.hist.swapIn, sample.swapIn);
    const recent = store.hist.swapIn.slice(-5);
    sample.swapInAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    store.sys = sample;
  });
}

// ── gpu + temperatures every 5 s ────────────────────────────────────────────
const HW_SCRIPT = 'for d in /sys/class/hwmon/hwmon*; do n=$(cat $d/name 2>/dev/null); for f in $d/temp*_input; do [ -r "$f" ] && echo "$n $(cat ${f%_input}_label 2>/dev/null | tr " " _) $(cat $f)"; done; done';

export function probeSensors() {
  return fresh("sensors", 4800, async () => {
    try {
      const r = await exec("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { timeout: 4000 });
      const v = r.stdout.trim().split("\n")[0]?.split(",").map((x) => x.trim());
      if (r.code === 0 && v?.length >= 5) {
        const num = (x) => (/^[\d.]+$/.test(x) ? Number(x) : null);
        store.gpu = { name: v[0], util: num(v[1]), memUsed: num(v[2]) * 1048576, memTotal: num(v[3]) * 1048576, temp: num(v[4]), power: num(v[5] ?? "") };
        if (store.gpu.util != null) push(store.hist.gpu, store.gpu.util);
      }
    } catch (_e) { store.gpu = null; }
    const r = await exec("sh", ["-c", HW_SCRIPT], { timeout: 4000 });
    const temps = {};
    for (const l of r.stdout.split("\n")) {
      const [name, label, val] = l.trim().split(/\s+/);
      if (!val) continue;
      const c = Number(val) / 1000;
      if (name === "coretemp" && (label === "Package_id_0" || temps.cpu == null)) temps.cpu = c;
      if (name === "k10temp" && temps.cpu == null) temps.cpu = c;
      if (name === "nvme" && temps.nvme == null) temps.nvme = c;
    }
    if (temps.cpu != null) push(store.hist.temp, temps.cpu);
    temps.cpuAvg = mean(store.hist.temp.slice(-12)); // 12 × 5 s = 1 min
    store.temps = temps;
  });
}

// ── Claude usage limits every 10 s ──────────────────────────────────────────
// Claude Code hands its status line command the plan's usage windows (rate_limits); the
// status line script saves just that part here. Nothing reads credentials.
export const LIMITS_FILE = ".cache/annunciator/claude-limits.json";
const WINDOW_NAMES = { five_hour: "5 hour", seven_day: "7 day", spend_limit: "spend" };
const when = (v) => (v == null ? null : typeof v === "number" ? v * 1000 : Date.parse(v) || null);

export function probeLimits() {
  return fresh("limits", 9800, async () => {
    const text = await readTextFile(`${home()}/${LIMITS_FILE}`);
    if (!text) { store.limits = null; return; }
    const d = JSON.parse(text);
    const windows = [];
    for (const [key, v] of Object.entries(d.rate_limits ?? {})) {
      if (!v || typeof v !== "object") continue;
      const label = WINDOW_NAMES[key] ?? key.replace(/_/g, " ");
      if (v.used_percentage != null) windows.push({ key, label, pct: Number(v.used_percentage), resets: when(v.resets_at) });
      else if (v.used_usd != null && v.limit_usd) {
        windows.push({ key, label: v.period ? `${label} ${v.period}` : label, pct: (100 * v.used_usd) / v.limit_usd, resets: when(v.resets_at) });
      }
    }
    store.limits = { at: when(d.at), windows };
  });
}

// ── disk usage every 60 s ───────────────────────────────────────────────────
export function probeDf() {
  return fresh("df", 59000, async () => {
    const r = await exec("df", ["-Pk", "/"], { timeout: 5000 });
    const v = r.stdout.trim().split("\n").pop().split(/\s+/);
    store.df = { total: Number(v[1]) * 1024, used: Number(v[2]) * 1024, pct: Number(v[4].replace("%", "")) };
  });
}

// ── processes every 5 s (shared by the roster's cpu/mem and the process table) ─
export function probePs() {
  return fresh("ps", 4800, async () => {
    // Current cpu%, from utime+stime deltas between polls (ps's pcpu is a lifetime average).
    const r = await exec("sh", ["-c", "cat /proc/uptime; cat /proc/[0-9]*/stat 2>/dev/null"], { timeout: 5000 });
    const lines = r.stdout.split("\n");
    const uptime = Number(lines[0].split(" ")[0]);
    const now = Date.now();
    const prev = store.psPrev;
    const dt = prev ? (now - prev.at) / 1000 : null;
    const ticks = new Map();
    const out = [];
    for (const l of lines.slice(1)) {
      const close = l.lastIndexOf(")");
      if (close < 0) continue;
      const pid = Number(l.slice(0, l.indexOf(" ")));
      const comm = l.slice(l.indexOf("(") + 1, close);
      const f = l.slice(close + 2).split(" ");   // f[0] = state (field 3)
      const ppid = Number(f[1]);
      const cpuTicks = Number(f[11]) + Number(f[12]);  // utime + stime
      const start = Number(f[19]) / 100;
      const rss = Number(f[21]) * 4096;
      ticks.set(pid, cpuTicks);
      const before = prev?.ticks.get(pid);
      const cpu = dt && before != null ? Math.max(0, (cpuTicks - before) / dt) : 0; // ticks are 1/100 s → %
      out.push({ pid, ppid, cpu, rss, etimes: Math.max(0, uptime - start), comm });
    }
    store.psPrev = { at: now, ticks };
    store.ps = out;
  });
}

// Sum of cpu% and rss over a process and all its descendants.
export function treeUsage(pid) {
  const kids = new Map();
  for (const p of store.ps) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const self = store.ps.find((p) => p.pid === pid);
  let cpu = self?.cpu ?? 0, rss = self?.rss ?? 0;
  const stack = [pid]; const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue; seen.add(id);
    for (const k of kids.get(id) ?? []) { cpu += k.cpu; rss += k.rss; stack.push(k.pid); }
  }
  return { cpu, rss, found: Boolean(self) };
}

// Which agent (terminal address) a process belongs to, by walking ppid upward.
export function ownerOf(pid, roots) {
  const byPid = new Map(store.ps.map((p) => [p.pid, p]));
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    if (roots.has(cur)) return roots.get(cur);
    cur = byPid.get(cur)?.ppid ?? 0;
  }
  return null;
}

// ── core detail every 5 s: terminals() leaves status_ms empty, `hc get` has it ─
export function probeCore() {
  return fresh("core", 4800, async () => {
    const live = terminals().filter((t) => t.state === "live");
    await Promise.all(live.map(async (t) => {
      const r = await hc(["get", t.address, "--json"]).catch(() => null);
      if (!r || r.code !== 0) return;
      try {
        const j = JSON.parse(r.stdout);
        store.core[t.address] = { status_ms: j.status_ms ?? null, records: j.records ?? null, msg: j.status?.msg ?? null };
      } catch (_e) { /* keep the last one */ }
    }));
  });
}

const recordList = (r) => (Array.isArray(r) ? r : r && typeof r === "object" ? Object.values(r) : []);

// When a terminal entered its current state: the core's stamp, else the first time we saw it there.
function sinceOf(address, t, status) {
  const core = t?.status_ms ?? store.core[address]?.status_ms;
  if (core) return core;
  const seen = store.seenStatus[address];
  return seen && seen.s === status ? seen.at : null;
}

// ── repos every 30 s ────────────────────────────────────────────────────────
export function probeRepos(folders) {
  return fresh("repos", 29000, async () => {
    const out = [];
    const seen = new Set();
    for (const f of folders) {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: f, timeout: 3000 }).catch(() => null);
      const root = top?.code === 0 ? top.stdout.trim() : null;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const r = await exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: root, timeout: 5000 }).catch(() => null);
      if (!r || r.code !== 0) continue;
      let branch = "—", ahead = 0, behind = 0, dirty = 0;
      for (const l of r.stdout.split("\n")) {
        if (l.startsWith("# branch.head ")) branch = l.slice(14);
        else if (l.startsWith("# branch.ab ")) { const m = l.match(/\+(\d+) -(\d+)/); if (m) { ahead = +m[1]; behind = +m[2]; } }
        else if (l && !l.startsWith("#")) dirty++;
      }
      out.push({ path: root, repo: root.split("/").pop(), branch, dirty, ahead, behind });
    }
    store.repos = out;
  });
}

// ── containers: Docker, read-only (`docker inspect` and `docker stats`, never start/stop) ──
const CT_FORMAT = '{"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},' +
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"restarts":{{.RestartCount}},' +
  '"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}},"exit":{{.State.ExitCode}},"policy":{{json .HostConfig.RestartPolicy.Name}},' +
  '"project":{{json (index .Config.Labels "com.docker.compose.project")}},' +
  '"service":{{json (index .Config.Labels "com.docker.compose.service")}},' +
  '"dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ports":{{json .NetworkSettings.Ports}}}';
// Exit codes from a deliberate stop (0, SIGKILL after a timeout, SIGTERM) aren't failures.
// Nor is any exit under "always" / "unless-stopped": Docker would have restarted it, so a
// person stopped it (docker keeps the last crash's exit code when you stop a crash loop).
const CLEAN_EXIT = new Set([0, 137, 143]);

// One word for what a container is doing, worst first. A climbing restart count counts as
// restarting even if the probe caught it in its brief "running" moment, so a loop doesn't flap.
function ctKind(x, prev) {
  if (x.status === "restarting" || (prev && x.restarts > prev.restarts && x.status !== "exited")) return "restarting";
  if (x.status === "running" && x.health === "unhealthy") return "unhealthy";
  if (x.status === "running" && x.health === "starting") return "starting";
  if (x.status === "running") return "running";
  if (x.status === "paused") return "paused";
  if (x.status === "created") return "stopped";
  if (x.status === "exited" || x.status === "dead") return CLEAN_EXIT.has(x.exit) || x.policy === "always" || x.policy === "unless-stopped" ? "stopped" : "failed";
  return x.status;
}

export function probeContainers() {
  return fresh("containers", 9000, async () => {
    const r = await exec("sh", ["-c", `ids=$(docker ps -aq) || exit 3; [ -z "$ids" ] && exit 0; docker inspect -f '${CT_FORMAT}' $ids`], { timeout: 8000 })
      .catch((e) => ({ code: -1, stderr: String(e) }));
    // `docker inspect` exits 1 when a container vanished between `ps` and `inspect` (compose
    // down/up), but still prints the rest: use what it printed. Only a read with nothing in it
    // counts as a failure, and a failure never replaces the last good list.
    if (r.code !== 0 && !(r.stdout ?? "").trim()) {
      store.ctFails++;
      store.ctError = r.code === 127 || /not found/.test(r.stderr ?? "") ? "docker is not installed" : "docker is not answering";
      return;
    }
    store.ctFails = 0;
    store.ctError = null;
    const out = [];
    for (const l of r.stdout.split("\n")) {
      if (!l.trim()) continue;
      let x; try { x = JSON.parse(l); } catch (_e) { continue; }
      x.name = x.name.replace(/^\//, "");
      const t = (iso) => { const v = Date.parse(iso); return v > 0 ? v : null; };
      x.started = t(x.started); x.finished = t(x.finished);
      x.hostPorts = [...new Set(Object.values(x.ports ?? {}).flat().filter(Boolean).map((b) => b.HostPort))].sort((a, b) => a - b);
      const prev = store.ctSeen[x.name];
      x.kind = ctKind(x, prev);
      x.since = x.kind === "stopped" || x.kind === "failed" ? x.finished : x.started;
      if (prev && prev.kind !== x.kind) {
        const bad = (k) => k === "restarting" || k === "unhealthy" || k === "failed";
        addEvent({ at: Date.now(), where: `docker ${x.name}`, from: prev.kind, to: x.kind, system: true,
          tone: bad(x.kind) ? "red" : null, detail: x.kind === "failed" ? `exit ${x.exit}` : x.kind === "restarting" ? `${x.restarts} restarts` : "" });
      }
      store.ctSeen[x.name] = { kind: x.kind, restarts: x.restarts };
      out.push(x);
    }
    store.containers = out;
    store.stamp.containersOk = Date.now();
  });
}

const UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
export function probeDockerStats() {
  return fresh("dstats", 14000, async () => {
    const r = await exec("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"], { timeout: 8000 }).catch(() => null);
    if (!r || r.code !== 0) return;
    const out = {};
    for (const l of r.stdout.split("\n")) {
      const [name, cpu, mem] = l.split("\t");
      if (!name) continue;
      const m = (mem ?? "").match(/([\d.]+)\s*([A-Za-z]+)/);
      out[name] = { cpu: parseFloat(cpu), mem: m ? parseFloat(m[1]) * (UNIT[m[2].toUpperCase()] ?? 1) : null };
    }
    store.dstats = out;
  });
}

// ── screens: the question a blocked agent is asking ─────────────────────────
const CHROME = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║▔▁▏▕╌╍>❯$#%·•\-_=*]*$/;
const NOISE = /(auto mode|shift\+tab|esc to|ctrl\+|for shortcuts|\? for|bypass permissions|^\s*\S+@\S+:|tokens|context left)/i;

export function lastLine(text) {
  const lines = (text ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !CHROME.test(l) && !NOISE.test(l));
  // Prefer a question if one is on screen.
  const q = [...lines].reverse().find((l) => /\?\s*$/.test(l));
  return (q ?? lines.at(-1) ?? "").replace(/^[\s│┃|>❯⏺●•·]+/, "").trim();
}

export function probeScreen(address, statusMs) {
  const cur = store.screens[address];
  if (cur && cur.at === statusMs && Date.now() - (cur.read ?? 0) < 5000) return Promise.resolve();
  return fresh(`screen:${address}`, 4500, async () => {
    const r = await hc(["read", address, "--json", "--lines", "0"]);
    const j = JSON.parse(r.stdout || "{}");
    store.screens[address] = { at: statusMs, read: Date.now(), line: lastLine(j.text) };
  });
}

// ── the joined roster ───────────────────────────────────────────────────────
const statusWord = (t) => (typeof t?.status === "string" ? t.status : t?.status?.state ?? null);
const reportOf = (t) => t?.report ?? (typeof t?.status === "object" ? t.status : null);

export function shortPath(p) {
  if (!p) return "";
  const h = home();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}
const base = (p) => (p ? (p === home() ? "~" : p.split("/").filter(Boolean).pop() ?? "/") : "");

export const RANK = { blocked: 5, error: 4, done: 3, working: 2, idle: 1, exited: 0 };

// One row per agent, with sub-agents (hc-run children and in-process records) under it.
export function roster() {
  const list = agents();
  const ts = terminals();
  const byAddr = new Map(ts.map((t) => [t.address, t]));
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, { tab, space: s }])));
  const listed = new Set(list.map((a) => a.address));

  const kids = (addr, depth) => ts.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => {
    const st = statusWord(k);
    const row = {
      sub: true, depth, address: k.address, term: k,
      task: k.name || k.template || k.program?.name || k.address,
      status: st === "error" ? "error" : st === "done" ? "idle" : st || "idle",
      since: sinceOf(k.address, k, st === "error" ? "error" : st === "done" ? "idle" : st || "idle"), created: k.created_ms ?? null,
      turn: k.turn ?? null, pid: k.foreground?.pid ?? k.pid ?? null,
      kept: listed.has(k.address),
    };
    return [row, ...kids(k.address, depth + 1)];
  });

  const rows = [];
  for (const a of list) {
    const t = byAddr.get(a.address) ?? {};
    // A kept sub-agent shows under its parent, not twice.
    if (t.parent && byAddr.get(t.parent)?.state === "live" && listed.has(t.parent)) continue;
    const p = byPane.get(a.pane);
    const ctx = tabs.get(a.tab);
    const rep = reportOf(t);
    const records = recordList(t.records).length ? recordList(t.records) : recordList(store.core[a.address]?.records);
    const exited = t.state && t.state !== "live";
    const status = exited ? (t.exit_code ? "error" : "exited") : a.status;
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const sub = kids(a.address, 1);
    const recRows = records.map((r, i) => ({
      sub: true, record: true, depth: 1, address: `${a.address}#${i}`,
      task: r.title || r.app || "sub-agent",
      status: r.state === "error" ? "error" : r.state === "done" ? "idle" : r.state || "idle",
      since: null, created: null, turn: null, pid: null,
    }));
    rows.push({
      address: a.address, pane: a.pane, tab: a.tab, space: a.space, term: t,
      task: taskOf(a, ctx),
      agent: a.program?.key === "program" ? (a.app ?? "agent") : a.program?.key ?? a.app ?? "agent",
      where: `${machine ? machine + ":" : ""}${a.space_name} / ${a.tab_name}`,
      folder: base(p?.cwd ?? t.foreground?.cwd ?? t.cwd),
      cwd: p?.cwd ?? t.foreground?.cwd ?? t.cwd ?? null,
      branch: p?.branch ?? null,
      status,
      inferred: !a.app,
      since: sinceOf(a.address, t, status),
      created: t.created_ms ?? null,
      finished: t.finished_ms ?? null,
      exitCode: t.exit_code ?? null,
      turn: t.turn ?? null,
      pid: t.foreground?.pid ?? t.pid ?? null,
      msg: rep?.msg ?? store.core[a.address]?.msg ?? null,
      progress: rep?.progress ?? null,
      pinned: a.pinned, focused: a.focused,
      subs: sub.length + recRows.length,
      children: [...sub, ...recRows],
      urgency: Math.max(RANK[status] ?? 0, ...sub.map((s) => RANK[s.status] ?? 0)),
      seq: a.seq,
    });
  }
  return rows;
}

function taskOf(a, ctx) {
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
  const title = clean(a.title);
  const useful = title && title.toLowerCase() !== a.program?.key && title !== a.program?.name && !/^[~/]/.test(title) && !title.includes("@");
  if (ctx?.tab?.named) return ctx.tab.name;
  return useful ? title : a.program?.name || a.tab_name;
}

// ── events: status changes, stamped with the core's own time ────────────────
export function trackEvents(rows) {
  let changed = false;
  for (const r of rows) {
    for (const x of [r, ...r.children.filter((c) => !c.record)]) {
      const prev = store.seenStatus[x.address];
      const s = x.status;
      if (prev?.s === s) continue;
      // The core's stamp when it is newer than what we saw; else now (done → idle is a view change).
      const at = x.since && (!prev || x.since > (prev.at ?? 0)) ? x.since : Date.now();
      store.seenStatus[x.address] = { s, at };
      if (!prev) continue; // first sight: no transition to report
      const detail = s === "blocked" ? (store.screens[x.address]?.line || r.msg || "") : s === "error" ? (x.exitCode != null ? `exit ${x.exitCode}` : "") : (x.turn != null ? `turn ${x.turn}` : "");
      addEvent({ at, where: x.sub ? `${r.where} › ${x.task}` : r.where, from: prev.s, to: s, detail, task: x.task, address: x.address });
      changed = true;
    }
  }
  return changed;
}

export function addEvent(e) {
  store.events.unshift(e);
  store.events.sort((a, b) => b.at - a.at);
  if (store.events.length > 500) store.events.length = 500;
}

// Metric crossing a threshold → an event (only on change of level).
export function noteLevel(key, label, v, fmt, limitKey = key) {
  const l = level(limitKey, v);
  const prev = store.levels[key];
  store.levels[key] = l;
  if (prev && prev !== l) addEvent({ at: Date.now(), where: "system", from: prev, to: l, detail: `${label} ${fmt(v)}`, system: true });
  return l;
}

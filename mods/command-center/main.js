// Command Center: a mecha-anime tactical HUD for Herdr.
// Roles (props.role): topbar, units (agent roster; props.compact for sidebars), sectors (spaces/tabs),
// alert (blocked strip / mission complete), pane (pane header with tab strip), palette (accent picker popup).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, spaces, panes, props, run, theme, window as appWindow, shared, setShared,
  setAgentOrder, hc, appHome, readTextFile, writeTextFile, openOverlay, closeOverlay, notify } from "herdr";

const ASSET = "mods/command-center/";
const UI = "Chakra Petch", MONO = "JetBrains Mono";
const STILL_KEY = "command-center.still", ACCENT_KEY = "command-center.accent", ART_KEY = "command-center.art";
const STATUS = {
  blocked: { en: "ALERT", glyph: "▲" },
  working: { en: "SORTIE", glyph: "■" },
  done: { en: "CLEAR", glyph: "◆" },
  idle: { en: "STANDBY", glyph: "□" },
};
const COLS = [["UNIT", 140], ["STATUS", 84], ["OPERATION", 0], ["SECTOR", 150], ["FRAME / CTX", 150], ["T+", 72], ["COMMS", 0]];
const LAYOUTS = [["TOP", "command-center"], ["DOWN", "command-center-down"], ["LEFT", "command-center-left"], ["RIGHT", "command-center-side"]];
// Pilot callsigns, each with its own squadron color.
const CALLSIGNS = [
  ["FALCON", "#ff8a1f"], ["KESTREL", "#ffc23d"], ["LANCER", "#4c8dff"], ["ORCA", "#35d0e6"],
  ["SPECTER", "#a879ff"], ["VALKYRIE", "#ff4fa8"], ["NOMAD", "#c9a46a"], ["HALBERD", "#5be08a"],
  ["RAVEN", "#8e9bff"], ["ZEPHYR", "#7fe3d0"], ["TALON", "#ff6b4a"], ["AEGIS", "#e6e6e6"],
  ["CORSAIR", "#d97cff"], ["WRAITH", "#9fb4c8"], ["BANSHEE", "#ff5d7d"], ["GRIFFIN", "#e0d050"],
];
// Accent presets. `done` moves off green when the accent itself is green.
const PALETTE = [
  { name: "ORANGE", accent: "#ff8a1f" }, { name: "AMBER", accent: "#ffc23d" },
  { name: "VIOLET", accent: "#a879ff" }, { name: "CYAN", accent: "#35d0e6" },
  { name: "BLUE", accent: "#4c8dff" }, { name: "GREEN", accent: "#5be08a", done: "#35d0e6" },
  { name: "MAGENTA", accent: "#ff4fa8" }, { name: "WHITE", accent: "#e6e6e6" },
];
const MISSION_MS = 8000;
const INK = "#0b0b0c";

const win = () => appWindow() ?? { active: false };
const motion = () => shared(STILL_KEY) !== true && win().active === true;
const tone = status => theme()[status] ?? theme().dim;
const pad2 = n => String(n).padStart(2, "0");
const focusUnit = a => run("agent.focus", { terminal: a.address });
// A stable pilot callsign and color per terminal address.
function pilot(address) {
  let hash = 2166136261;
  for (const ch of String(address)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const [name, color] = CALLSIGNS[hash % CALLSIGNS.length];
  return { name, color };
}

function t(value, { size = 12, color, font = UI, weight } = {}) {
  const el = div().text_size(size).font_family(font).text_color(color ?? theme().foreground).child(String(value));
  return weight ? el.font_weight(weight) : el;
}
const badge = (status, size = 11) => t(STATUS[status].en, { size, color: tone(status), weight: 700 }).flex_none();
// The callsign as a filled squadron tag.
function callTag(address, size = 9) {
  const p = pilot(address);
  return div().h(size + 6).px(5).flex_none().flex().items_center().bg(p.color)
    .child(t(p.name, { size, weight: 700, color: INK }));
}
function glyph(a) {
  const s = STATUS[a.status], el = t(s.glyph, { size: 11, font: MONO, color: tone(a.status) }).w(12).flex_none();
  if (motion() && (a.status === "working" || a.status === "blocked")) {
    el.id(`glyph-${a.address}`).loop("opacity", { from: 0.25, to: 1, period: a.status === "blocked" ? 700 : 1400 });
  }
  return el;
}
function button(id, label, click, { active = false, color } = {}) {
  const c = theme();
  return div().id(id).h(24).px(9).flex_none().flex().items_center()
    .border(1).border_color(active ? color ?? c.accent : c.border)
    .when(active, el => el.bg(color ?? c.accent))
    .text_size(11).font_family(UI).font_weight(600)
    .text_color(active ? c.accent_foreground : c.muted)
    .cursor_pointer().hover(s => s.border_color(color ?? c.accent))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); click(cx); })
    .child(label);
}
// HUD corner brackets around a relative panel.
function corners(color, len = 10) {
  const bar = () => div().absolute().bg(color);
  return [
    bar().left(0).top(0).w(len).h(2), bar().left(0).top(0).w(2).h(len),
    bar().right(0).top(0).w(len).h(2), bar().right(0).top(0).w(2).h(len),
    bar().left(0).bottom(0).w(len).h(2), bar().left(0).bottom(0).w(2).h(len),
    bar().right(0).bottom(0).w(len).h(2), bar().right(0).bottom(0).w(2).h(len),
  ];
}
// Panel backdrop: faint hex grid, plus the edge-traced Unicorn Gundam in the roster's corner.
function backdrop(hero) {
  const c = theme();
  const layers = [svg(ASSET + "hexgrid.svg").absolute().left(0).top(0).w(1600).h(900).text_color(c.border)];
  if (hero && shared(ART_KEY) !== false) {
    layers.push(image(ASSET + "gundam-lines.png").absolute().right(12).bottom(-24).w(300).h(313).opacity(0.42));
  }
  return layers;
}
// Segmented context gauge: real "NN% used" from the agent's statusline.
function gauge(pct) {
  const c = theme(), filled = Math.round(Math.min(100, Math.max(0, pct)) / 10);
  const col = pct >= 85 ? c.blocked : pct >= 60 ? "#ffc23d" : c.accent;
  return h_flex().gap(1).flex_none().items_center()
    .children(Array.from({ length: 10 }, (_, i) => div().w(4).h(9).bg(i < filled ? col : c.border)));
}
function frameCell(comm) {
  const c = theme();
  if (!comm || (comm.ctx == null && !comm.model)) return t("—", { size: 10, font: MONO, color: c.dim });
  return h_flex().gap(6).items_center().flex_none()
    .when(Boolean(comm.model), el => el.child(t(String(comm.model).toUpperCase(), { size: 10, weight: 600, color: c.muted }).flex_none()))
    .when(comm.ctx != null, el => el.child(gauge(comm.ctx)).child(t(`${comm.ctx}%`, { size: 10, font: MONO, color: c.muted }).flex_none()));
}

// One tab as a clickable chip; the shown tab of the shown space is filled.
function tabChip(space, tab, idPrefix, size = 20) {
  const c = theme(), on = space.active && tab.active;
  return div().id(`${idPrefix}-${tab.id}`).h(size).min_w(size + 2).px(6).flex_none().flex().items_center().justify_center()
    .border(1).border_color(on ? c.accent : tab.status ? tone(tab.status) : c.border)
    .when(on, el => el.bg(c.accent))
    .text_size(11).font_family(MONO).text_color(on ? c.accent_foreground : tab.settled ? c.dim : c.foreground)
    .cursor_pointer().hover(st => st.border_color(c.accent))
    .tooltip(`${space.name} / ${tab.name}${tab.status ? ` · ${STATUS[tab.status].en}` : ""}${tab.settled ? " · settled" : ""}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); })
    .child(tab.name);
}
function newTabChip(space, idPrefix, size = 20) {
  const c = theme();
  return div().id(`${idPrefix}-new-${space.id}`).h(size).w(size + 2).flex_none().flex().items_center().justify_center()
    .border(1).border_color(c.border).text_size(12).font_family(MONO).text_color(c.dim)
    .cursor_pointer().hover(st => st.border_color(c.accent)).tooltip(`New tab in ${space.name}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("tab.new", { space: space.id }); })
    .child("+");
}

// Screen text arrives with escape sequences; strip them before reading lines.
function stripEscapes(value) {
  return String(value ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
// Agent TUIs end their screen with chrome: rules, the input prompt, a status/footer line.
const CHROME = [
  /^[\s─━═│┃╭╮╰╯┌┐└┘\-_=|]*$/,
  /^\s*❯/,
  /^\s*[>›»$%#]\s*\S{0,3}\s*$/,
  /shift\+tab|bypass permissions|accept edits|plan mode|\? for shortcuts|esc to interrupt|ctrl\+[a-z] to/i,
  /\|\s*(Opus|Sonnet|Haiku|Fable|gpt|claude)\b.*\|/i,
  /\d+% (used|context)/i,
];
// Last meaningful line, plus model and context use when the statusline shows them.
function readScreen(value) {
  const lines = stripEscapes(value).split(/\r?\n|\r/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = [...lines].reverse().find(l => !CHROME.some(re => re.test(l))) ?? lines[lines.length - 1] ?? "";
  const status = [...lines].reverse().find(l => /\d{1,3}% (used|context)/i.test(l)) ?? "";
  const ctx = status.match(/(\d{1,3})% (?:used|context)/i);
  const model = (status || lines.join(" ")).match(/\b(Opus|Sonnet|Haiku|Fable)\s*\d+(?:\.\d+)?/i);
  return { text, ctx: ctx ? Number(ctx[1]) : null, model: model ? model[0] : null };
}

function clockSince(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > now) return "--:--";
  const s = Math.floor((now - ms) / 1000);
  if (s >= 100 * 3600) return `${Math.floor(s / 86400)}d`;
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}
// Blocked units first, then the app's own space/tab/pane order.
function roster() {
  return agents().filter(a => STATUS[a.status]).map((a, i) => ({ a, i }))
    .sort((x, y) => (x.a.status === "blocked" ? 0 : 1) - (y.a.status === "blocked" ? 0 : 1) || x.i - y.i)
    .map(x => x.a);
}

// Mixes hex `a` toward `b` by `k` (0..1).
function mix(a, b, k) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * k + y[i] * (1 - k)).toString(16).padStart(2, "0")).join("");
}
// Writes the accent into the layout theme, so pane borders, cursor and buttons follow it.
async function applyAccent(preset) {
  const path = `${appHome()}/themes/command-center.json`;
  const before = await readTextFile(path);
  if (before == null) throw new Error("themes/command-center.json is missing");
  const data = JSON.parse(before), base = data.background ?? INK, a = preset.accent;
  data.cursor = a;
  data.selection = mix(a, base, 0.3);
  data.colors = { ...data.colors, accent: a, solid: a, working: a, done: preset.done ?? "#7fcf8a",
    border: mix(a, base, 0.22), input: mix(a, base, 0.42), selected: mix(a, base, 0.16), hover: mix(a, base, 0.1) };
  await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", before);
  setShared(ACCENT_KEY, preset.name);
}

export default class CommandCenter extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "units";
    this.since = new Map();   // address -> { status, at }: when the current state began
    this.comms = new Map();   // address -> { text, ctx, model }: screen facts, memory only
    this.prev = null;         // address -> status, for mission-complete detection
    this.mission = null;
    this.reading = false;
    this.closed = false;
    if (this.role === "topbar" || this.role === "units") {
      cx.timer.every(1000, cx => { if (win().active === true) cx.notify(); });
    }
    if (this.role === "units" || this.role === "pane") {
      cx.timer.every(5000, cx => this.pollComms(cx));
      this.pollComms(cx);
    }
    if (this.role === "alert") {
      cx.timer.every(1000, cx => {
        if (this.mission && Date.now() - this.mission.at > MISSION_MS) { this.mission = null; cx.notify(); }
      });
    }
  }
  close() { this.closed = true; }

  // Reads screens serially, one batch at a time, only while the window is active.
  // Pane headers read their own terminal only.
  pollComms(cx) {
    if (this.reading || this.closed || win().active !== true) return;
    const own = this.role === "pane" ? panes().find(x => x.pane === props()?.pane) : null;
    const list = this.role === "pane" ? (own?.status && own.terminal ? [{ address: own.terminal }] : []) : roster().slice(0, 16);
    if (!list.length) return;
    this.reading = true;
    cx.spawn(async cx => {
      try {
        for (const a of list) {
          if (this.closed || win().active !== true) break;
          try {
            const reply = await hc(["read", a.address, "--lines", "24"]);
            if (reply.code === 0) this.comms.set(a.address, readScreen(reply.stdout));
          } catch (_) { /* keep the previous reading */ }
        }
      } finally {
        this.reading = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  stateStart(a, now, raw) {
    const prev = this.since.get(a.address);
    if (prev && prev.status === a.status) return prev.at;
    let at = now;
    if (!prev) {
      // First sighting: the newest of the app's own clocks.
      const tab = spaces().find(s => s.id === a.space)?.tabs.find(x => x.id === a.tab);
      const ok = v => Number.isFinite(v) && v > 0 && v <= now;
      const clocks = a.status === "working" ? [raw.get(a.address)?.status_ms, tab?.working_since]
        : [raw.get(a.address)?.status_ms, tab?.changed_at];
      const valid = clocks.filter(ok);
      if (valid.length) at = Math.max(...valid);
    }
    this.since.set(a.address, { status: a.status, at });
    return at;
  }

  topbar() {
    const c = theme(), list = agents(), now = new Date();
    const count = s => list.filter(a => a.status === s).length;
    const alerts = count("blocked"), sorties = count("working");
    const stat = (id, label, value, color, blink = false) => {
      const num = t(pad2(value), { size: 17, font: MONO, weight: 700, color }).line_height("19px");
      if (blink && motion()) num.id(`stat-${id}`).loop("opacity", { from: 0.3, to: 1, period: 900 });
      return v_flex().flex_none().child(t(label, { size: 9, color: c.dim, weight: 600 })).child(num);
    };
    const [condition, condColor] = alerts ? ["RED", c.blocked] : sorties ? ["YELLOW", "#ffc23d"] : ["GREEN", "#7fcf8a"];
    const cond = h_flex().id("cc-condition").h(26).px(10).gap(6).items_center().flex_none().bg(condColor)
      .child(t("CONDITION", { size: 10, weight: 600, color: INK }))
      .child(t(condition, { size: 13, weight: 700, color: INK }));
    if (alerts && motion()) cond.loop("opacity", { from: 0.55, to: 1, period: 900 });
    const radar = svg(ASSET + "radar.svg").id("cc-radar").size(26).flex_none().text_color(sorties ? c.accent : c.dim);
    if (sorties && motion()) radar.spin(2400);
    const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const date = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
    return h_flex().id("cc-topbar").size_full().pl(win().platform === "macos" ? 84 : 16).pr(12).gap(14)
      .items_center().bg(c.chrome)
      .child(h_flex().gap(10).items_center().flex_none()
        .child(svg(ASSET + "emblem.svg").size(30).flex_none().text_color(c.accent))
        .child(v_flex()
          .child(t("COMMAND CENTER", { size: 16, weight: 700 }).line_height("18px"))
          .child(t("TACTICAL AGENT OPERATIONS", { size: 9, color: c.muted, weight: 600 }))))
      .child(radar)
      .child(div().w(1).h(26).bg(c.border))
      .child(stat("sectors", "SECTORS", spaces().length, c.foreground))
      .child(stat("units", "UNITS", list.length, c.foreground))
      .child(stat("sortie", "SORTIE", sorties, c.working))
      .child(stat("clear", "CLEAR", count("done"), c.done))
      .child(stat("alert", "ALERT", alerts, alerts ? c.blocked : c.dim, alerts > 0))
      .child(cond)
      .child(div().flex_1())
      .child(v_flex().items_end().flex_none()
        .child(t(time, { size: 17, font: MONO, weight: 700 }).line_height("19px"))
        .child(t(date, { size: 9, font: MONO, color: c.dim })))
      .child(h_flex().flex_none().gap(2).items_center()
        .child(t("HUD", { size: 9, color: c.dim, weight: 600 }).pr(4))
        .children(LAYOUTS.map(([label, name]) => button(`cc-layout-${label}`, label,
          () => run("layout.switch", { name }), { active: shared("layout") === name }))))
      .child(button("cc-color", "COLOR", () => openOverlay({ mod: "command-center", props: { role: "palette" },
        kind: "popup", width: 300, height: 178 })))
      .child(button("cc-art", shared(ART_KEY) === false ? "ART OFF" : "ART ON",
        () => setShared(ART_KEY, shared(ART_KEY) === false)))
      .child(button("cc-motion", shared(STILL_KEY) === true ? "MOTION OFF" : "MOTION ON",
        () => setShared(STILL_KEY, shared(STILL_KEY) !== true)))
      .child(button("cc-cmd", "CMD", () => run("app.palette")))
      .when(win().buttons === true, el => el.children([
        button("cc-min", "_", () => run("window.minimize")),
        button("cc-max", "□", () => run("window.maximize")),
        button("cc-close", "×", () => run("window.close"))]));
  }

  palette() {
    const c = theme(), current = shared(ACCENT_KEY) ?? "ORANGE";
    return v_flex().size_full().p(12).gap(10).bg(c.popover)
      .child(h_flex().items_center()
        .child(t("ACCENT COLOR", { size: 12, weight: 700, color: c.accent }))
        .child(div().flex_1())
        .child(t("panels, borders, cursor", { size: 9, color: c.dim })))
      .child(h_flex().flex_wrap().gap(6).children(PALETTE.map(p => v_flex().id(`swatch-${p.name}`).w(62).gap(3)
        .p(3).border(1).border_color(p.name === current ? c.foreground : c.border)
        .cursor_pointer().hover(s => s.border_color(p.accent))
        .on_click(() => {
          const overlay = props()?.overlay;
          applyAccent(p).then(() => closeOverlay(overlay))
            .catch(e => notify({ title: "Accent not applied", body: String(e?.message ?? e), level: "error" }));
        })
        .child(div().h(18).bg(p.accent))
        .child(t(p.name, { size: 9, weight: 600, color: p.name === current ? c.foreground : c.muted })))));
  }

  row(a, now, raw) {
    const c = theme(), s = STATUS[a.status], comm = this.comms.get(a.address);
    return h_flex().id(`unit-${a.address}`).h(26).flex_none().pl(11).pr(14).gap(12).items_center()
      .border_l(3).border_color(a.status === "idle" ? c.border : tone(a.status))
      .when(a.status === "blocked", el => el.bg("#ff3b301c"))
      .when(a.focused, el => el.bg(c.selected))
      .hover(st => st.bg(c.hover)).cursor_pointer()
      .tooltip(`${a.address} · ${pilot(a.address).name} · ${s.en}\n${a.title}\n${a.space_name} / ${a.tab_name}`)
      .on_click(() => focusUnit(a))
      .child(h_flex().w(140).flex_none().gap(8).items_center()
        .child(t(a.address, { size: 12, font: MONO, color: a.focused ? c.accent : c.muted }).w(30).flex_none())
        .child(callTag(a.address)))
      .child(h_flex().w(84).flex_none().gap(6).items_center().child(glyph(a)).child(badge(a.status)))
      .child(t(a.title || a.program?.name || a.address, { size: 13, weight: 500 }).flex_1().min_w(0).truncate())
      .child(t(`${a.space_name} / ${a.tab_name}`, { size: 11, color: c.muted }).w(150).flex_none().truncate())
      .child(div().w(150).flex_none().overflow_hidden().child(frameCell(comm)))
      .child(t(clockSince(this.stateStart(a, now, raw), now), { size: 12, font: MONO, color: c.muted }).w(72).flex_none().text_right())
      .child(t(comm ? comm.text || "(silent)" : "…", { size: 11, font: MONO, color: c.dim }).flex_1().min_w(0).truncate());
  }

  // Sidebar rows: three short lines instead of one wide row.
  rowCompact(a, now, raw) {
    const c = theme(), s = STATUS[a.status], comm = this.comms.get(a.address);
    return v_flex().id(`unit-${a.address}`).flex_none().py(6).pl(11).pr(12).gap(3)
      .border_l(3).border_color(a.status === "idle" ? c.border : tone(a.status)).border_b(1)
      .when(a.status === "blocked", el => el.bg("#ff3b301c"))
      .when(a.focused, el => el.bg(c.selected))
      .hover(st => st.bg(c.hover)).cursor_pointer()
      .tooltip(`${a.address} · ${pilot(a.address).name} · ${s.en}\n${a.title}\n${a.space_name} / ${a.tab_name}`)
      .on_click(() => focusUnit(a))
      .child(h_flex().gap(8).items_center()
        .child(glyph(a))
        .child(t(a.address, { size: 12, font: MONO, color: a.focused ? c.accent : c.muted }).flex_none())
        .child(callTag(a.address))
        .child(badge(a.status))
        .child(div().flex_1())
        .child(t(`T+ ${clockSince(this.stateStart(a, now, raw), now)}`, { size: 11, font: MONO, color: c.muted }).flex_none()))
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(t(a.title || a.program?.name || a.address, { size: 13, weight: 600 }).flex_1().min_w(0).truncate())
        .child(t(`${a.space_name} / ${a.tab_name}`, { size: 10, color: c.muted }).flex_none().max_w(140).truncate()))
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(frameCell(comm))
        .child(t(comm ? comm.text || "(silent)" : "…", { size: 10, font: MONO, color: c.dim }).flex_1().min_w(0).truncate()));
  }

  units() {
    const compact = props()?.compact === true;
    const c = theme(), list = roster(), now = Date.now();
    const raw = new Map(terminals().map(x => [x.address, x]));
    setAgentOrder(list.map(a => a.address));
    const live = new Set(list.map(a => a.address));
    for (const k of [...this.since.keys()]) if (!live.has(k)) this.since.delete(k);
    for (const k of [...this.comms.keys()]) if (!live.has(k)) this.comms.delete(k);
    const head = h_flex().h(30).px(14).gap(10).items_center().flex_none()
      .child(div().w(3).h(14).bg(c.accent))
      .child(t("UNIT ROSTER", { size: 12, weight: 700, color: c.accent }))
      .child(div().flex_1())
      .child(t(`${pad2(list.length)} DEPLOYED`, { size: 10, color: c.dim, weight: 600 }));
    const cols = h_flex().h(20).px(14).gap(12).items_center().flex_none().border_b(1).border_color(c.border)
      .children(COLS.map(([label, w]) => {
        const el = t(label, { size: 9, color: c.dim, weight: 600 });
        return w ? el.w(w).flex_none().when(label === "T+", x => x.text_right()) : el.flex_1().min_w(0);
      }));
    const body = list.length
      ? v_flex().id("unit-rows").flex_1().min_h(0).overflow_y_scrollbar()
          .children(list.map(a => compact ? this.rowCompact(a, now, raw) : this.row(a, now, raw)))
      : v_flex().flex_1().items_center().justify_center().gap(4)
          .child(t("NO UNITS DEPLOYED", { size: 14, weight: 700, color: c.dim }))
          .child(t("Start an agent from CMD or a sector's + tab.", { size: 11, color: c.dim }));
    return v_flex().id("cc-units").relative().size_full().bg(c.canvas).overflow_hidden()
      .children(backdrop(true))
      .child(head).when(!compact, el => el.child(cols)).when(compact, el => el.border_b(1).border_color(c.border))
      .child(body).children(corners(c.accent));
  }

  sector(s, i) {
    const c = theme(), col = s.status ? tone(s.status) : c.dim;
    const chips = [...s.tabs.map(tab => tabChip(s, tab, "sec-tab")), newTabChip(s, "sec-tab")];
    return h_flex().id(`sector-${s.id}`).flex_none().min_h(34).py(5).pl(8).pr(8).gap(8).items_center().border_l(3)
      .border_color(s.active ? c.accent : col).bg(s.active ? c.surface : c.canvas)
      .child(t(`S${pad2(i + 1)}`, { size: 10, font: MONO, color: c.dim }).flex_none())
      .child(v_flex().id(`sector-head-${s.id}`).flex_1().min_w(0).cursor_pointer()
        .tooltip(`${s.name}${s.machine ? ` @ ${s.machine}` : ""}${s.branch ? `\n⎇ ${s.branch}` : ""}`)
        .on_click(() => run("space.select", { id: s.id }))
        .child(t(s.name.toUpperCase(), { size: 12, weight: 700, color: s.active ? c.foreground : c.muted }).truncate())
        .when(Boolean(s.branch || s.machine), el => el.child(
          t(`${s.machine ? `${s.machine} ` : ""}${s.branch ? `⎇ ${s.branch}` : ""}`, { size: 9, font: MONO, color: c.dim }).truncate())))
      .child(h_flex().flex_none().gap(3).children(chips))
      .when(Boolean(s.status && STATUS[s.status]), el => el.child(badge(s.status, 10).w(52).text_right()));
  }

  sectors() {
    const c = theme(), all = spaces();
    return v_flex().id("cc-sectors").relative().size_full().bg(c.canvas).overflow_hidden()
      .children(backdrop(false))
      .child(h_flex().h(30).px(14).gap(10).items_center().flex_none()
        .child(div().w(3).h(14).bg(c.accent))
        .child(t("SECTORS", { size: 12, weight: 700, color: c.accent }))
        .child(div().flex_1())
        .child(button("cc-new-sector", "+ SECTOR", () => run("space.new", {}))))
      .child(v_flex().id("sector-list").flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(10).gap(4)
        .children(all.map((s, i) => this.sector(s, i)))
        .when(!all.length, el => el.child(t("No sectors. + SECTOR opens one.", { size: 11, color: c.dim }))))
      .children(corners(c.border));
  }

  // Remembers who just finished a sortie, for the mission-complete banner.
  watchMissions() {
    const now = new Map(agents().map(a => [a.address, a]));
    if (this.prev) {
      for (const [address, a] of now) {
        if (this.prev.get(address) === "working" && (a.status === "done" || a.status === "idle")) {
          this.mission = { address, title: a.title, where: `${a.space_name} / ${a.tab_name}`, at: Date.now() };
        }
      }
    }
    this.prev = new Map([...now].map(([k, a]) => [k, a.status]));
  }

  alert() {
    this.watchMissions();
    const c = theme(), list = roster().filter(a => a.status === "blocked");
    const space = spaces().find(s => s.active), tab = space?.tabs.find(x => x.active);
    const channel = t(space && tab ? `CH ▸ ${space.name} / ${tab.name}` : "CH ▸ —", { size: 11, font: MONO, color: c.muted })
      .flex_none().max_w(320).truncate();
    const stripes = (id, file = "hazard.svg") => div().id(id).relative().w(44).h(30).flex_none().overflow_hidden()
      .child(image(ASSET + file).absolute().left(0).top(0).w(2400).h(30));
    if (!list.length && this.mission) {
      const m = this.mission;
      const tag = h_flex().id("mission-tag").h(30).px(10).gap(6).items_center().flex_none().bg(c.done)
        .child(t("◆", { size: 11, font: MONO, color: INK }))
        .child(t("MISSION COMPLETE", { size: 12, color: INK, weight: 700 }));
      if (motion()) tag.loop("opacity", { from: 0.7, to: 1, period: 1200 });
      return h_flex().id("cc-alert").size_full().gap(10).items_center().bg(c.chrome)
        .child(tag).child(stripes("ok-l", "hazard-done.svg"))
        .child(h_flex().id("mission-unit").flex_1().min_w(0).gap(8).items_center().cursor_pointer()
          .on_click(() => focusUnit(m))
          .child(t(m.address, { size: 12, font: MONO, weight: 700 }).flex_none())
          .child(callTag(m.address, 10))
          .child(t("RETURNING TO BASE", { size: 11, weight: 600, color: c.muted }).flex_none())
          .child(t(`— ${m.title} @ ${m.where}`, { size: 11 }).flex_1().min_w(0).truncate()))
        .child(channel).child(div().w(4));
    }
    if (!list.length) {
      return h_flex().id("cc-alert").size_full().px(14).gap(10).items_center().bg(c.chrome)
        .child(div().w(8).h(8).bg(c.done))
        .child(t("ALL UNITS NOMINAL", { size: 11, weight: 700, color: c.muted }))
        .child(t("· NO CONTACT", { size: 10, color: c.dim, weight: 600 }))
        .child(div().flex_1()).child(channel);
    }
    const first = list[0];
    const tag = h_flex().id("alert-tag").h(30).px(10).gap(6).items_center().flex_none().bg(c.blocked)
      .child(t("▲", { size: 11, font: MONO, color: INK }))
      .child(t("WARNING", { size: 12, color: INK, weight: 700 }));
    if (motion()) tag.loop("opacity", { from: 0.55, to: 1, period: 900 });
    const message = h_flex().id("alert-first").flex_1().min_w(0).gap(8).items_center().cursor_pointer()
      .tooltip(`${first.title}\n${first.space_name} / ${first.tab_name}`)
      .on_click(() => focusUnit(first))
      .child(t(first.address, { size: 12, font: MONO, weight: 700 }).flex_none())
      .child(callTag(first.address, 10))
      .child(t("REQUESTS COMMAND INPUT", { size: 11, weight: 700, color: c.blocked }).flex_none())
      .child(t(`— ${first.title} @ ${first.space_name} / ${first.tab_name}`, { size: 11 }).flex_1().min_w(0).truncate());
    const others = list.slice(1, 5).map(a => button(`alert-${a.address}`, `▲ ${a.address}`, () => focusUnit(a)));
    return h_flex().id("cc-alert").size_full().gap(10).items_center().bg("#1a0907")
      .child(tag).child(stripes("stripes-l")).child(message)
      .when(list.length > 5, el => el.child(t(`+${list.length - 5}`, { size: 11, font: MONO, color: c.blocked })))
      .children(others)
      .child(button("alert-respond", "RESPOND ▸", () => focusUnit(first), { active: true, color: c.blocked }))
      .child(channel).child(stripes("stripes-r"));
  }

  pane() {
    const c = theme(), id = props()?.pane, p = panes().find(x => x.pane === id);
    if (!p) return div().size_full().bg(c.chrome);
    const n = panes().filter(x => x.tab === p.tab).findIndex(x => x.pane === p.pane) + 1;
    const space = n === 1 ? spaces().find(s => s.tabs.some(x => x.id === p.tab)) : null;
    const comm = p.terminal ? this.comms.get(p.terminal) : null;
    const strip = space && h_flex().flex_none().gap(3).items_center().pl(6).border_l(1).border_color(c.border)
      .child(t("TAB", { size: 9, color: c.dim, weight: 600 }).pr(2))
      .children(space.tabs.map(tab => tabChip(space, tab, `ph-tab-${p.pane}`, 18)))
      .child(newTabChip(space, `ph-tab-${p.pane}`, 18));
    return h_flex().id(`ph-${p.pane}`).size_full().pr(10).gap(10).items_center().bg(c.chrome).cursor_pointer()
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .child(div().h(24).px(8).flex().items_center().flex_none().bg(p.focused ? c.accent : c.raised)
        .child(t(`CH-${pad2(n)}`, { size: 11, font: MONO, weight: 700, color: p.focused ? c.accent_foreground : c.muted })))
      .child(t(p.terminal ?? p.mod ?? "", { size: 11, font: MONO, color: c.muted }).flex_none())
      .when(Boolean(p.status && p.terminal), el => el.child(callTag(p.terminal)))
      .child(t(p.title || p.program?.name || "TERMINAL", { size: 12, weight: 600 }).flex_1().min_w(0).truncate())
      .when(Boolean(comm && (comm.ctx != null || comm.model)), el => el.child(frameCell(comm)))
      .when(Boolean(p.branch), el => el.child(t(`⎇ ${p.branch}`, { size: 10, font: MONO, color: c.dim }).max_w(160).truncate()))
      .when(Boolean(strip), el => el.child(strip))
      .child(p.status && STATUS[p.status] ? badge(p.status) : t("SHELL", { size: 10, color: c.dim, weight: 600 }).flex_none());
  }

  render() {
    switch (this.role) {
      case "topbar": return this.topbar();
      case "sectors": return this.sectors();
      case "alert": return this.alert();
      case "pane": return this.pane();
      case "palette": return this.palette();
      default: return this.units();
    }
  }
}

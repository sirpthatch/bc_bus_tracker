"use strict";

const REFRESH_MS = 10000;
const METER_MINUTES = 30; // the meter spans the last 30 minutes before arrival

const CONFIG_KEY = "busTracker.config.v1";

let status = null;
let historyRows = [];
let clockOffset = 0; // server time minus local time
let map, busMarker, trailLine, stopLayer, fitted = false;
let showTable = false;
let cfg = null; // { stop: number, walk: number } chosen by this viewer

const $ = (id) => document.getElementById(id);
const now = () => new Date(Date.now() + clockOffset);
const fmt = (iso, seconds = false) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hourCycle: "h23" });
const minutesUntil = (iso) => (new Date(iso) - now()) / 60000;
const text = (id, value) => { $(id).textContent = value; };

/* ---------- per-viewer settings (this browser only) ---------- */

const validConfig = (c) =>
  c && Number.isInteger(c.stop) && c.stop > 0 && Number.isFinite(c.walk) && c.walk >= 0 && c.walk <= 60;

function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY));
    return validConfig(c) ? c : null;
  } catch {
    return null;
  }
}

function saveConfig(c) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    // Private mode or storage blocked: settings last for this visit only.
  }
}

// A shared link like ?stop=7&walk=5 sets up a new device in one tap.
function configFromUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.has("stop")) return null;
  const c = { stop: Number(p.get("stop")), walk: Number(p.get("walk") ?? 10) };
  history.replaceState(null, "", location.pathname);
  return validConfig(c) ? c : null;
}

const leaveByMs = (s) => new Date(s.eta).getTime() - cfg.walk * 60000;

function openSettings() {
  const s = status;
  const select = $("cfg-stop");
  select.replaceChildren();
  for (const stop of s.route) {
    const opt = document.createElement("option");
    opt.value = stop.num;
    opt.textContent = `${stop.num}. ${stop.name} (${stop.scheduled})`;
    select.appendChild(opt);
  }
  select.value = cfg.stop;
  $("cfg-walk").value = cfg.walk;
  $("cfg-copied").hidden = true;
  $("settings").showModal();
}

function readSettingsForm() {
  return { stop: Number($("cfg-stop").value), walk: Math.round(Number($("cfg-walk").value)) };
}

$("settings-btn").addEventListener("click", () => status && openSettings());
$("cfg-cancel").addEventListener("click", () => $("settings").close());
$("settings-form").addEventListener("submit", (evt) => {
  evt.preventDefault();
  const c = readSettingsForm();
  if (!validConfig(c)) return;
  $("settings").close();
  applyConfig(c);
});
$("cfg-copy").addEventListener("click", async () => {
  const c = readSettingsForm();
  const url = `${location.origin}${location.pathname}?stop=${c.stop}&walk=${c.walk}`;
  try {
    await navigator.clipboard.writeText(url);
    $("cfg-copied").textContent = "Link copied. Anyone who opens it gets these settings.";
  } catch {
    $("cfg-copied").textContent = url;
  }
  $("cfg-copied").hidden = false;
});

function applyConfig(c) {
  const stopChanged = !cfg || cfg.stop !== c.stop;
  cfg = c;
  saveConfig(c);
  if (stopChanged) {
    status = null;
    fitted = false;
    historyRows = [];
  }
  refresh().then(() => stopChanged && loadHistory());
}

// Minutes since midnight in the stop's timezone, anchored on the scheduled time so the
// viewer's own timezone doesn't matter.
function schedMinutes(s) {
  const [h, m] = s.stop.scheduled.split(":").map(Number);
  return h * 60 + m;
}
const toStopMinutes = (s, iso) => schedMinutes(s) + (new Date(iso) - new Date(s.scheduled)) / 60000;

/* ---------- map ---------- */

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  trailLine = L.polyline([], { color: getComputedStyle(document.documentElement).getPropertyValue("--series").trim(), weight: 3, opacity: 0.9 }).addTo(map);
  stopLayer = L.layerGroup().addTo(map);
}

function drawStops(s) {
  stopLayer.clearLayers();
  for (const stop of s.route) {
    if (stop.num === s.stop.num) continue;
    L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({ className: "", html: `<div class="m-route">${stop.num}</div>`, iconSize: [18, 18] }),
    }).bindTooltip(`${stop.num}. ${stop.name} · ${stop.scheduled}`).addTo(stopLayer);
  }
  L.marker([s.stop.lat, s.stop.lon], {
    icon: L.divIcon({ className: "", html: '<div class="m-stop"></div>', iconSize: [14, 14] }),
    zIndexOffset: 500,
  }).bindTooltip(`Your stop: ${s.stop.num}. ${s.stop.name} · ${s.stop.scheduled}`).addTo(stopLayer);
  map.fitBounds(s.route.map((r) => [r.lat, r.lon]), { padding: [20, 20] });
}

function updateMap(s) {
  trailLine.setLatLngs(s.trail);
  if (s.bus) {
    const pos = [s.bus.lat, s.bus.lon];
    if (!busMarker) {
      busMarker = L.marker(pos, {
        icon: L.divIcon({ className: "", html: '<div class="m-bus"></div>', iconSize: [16, 16] }),
        zIndexOffset: 1000,
      }).bindTooltip("Bus").addTo(map);
    }
    busMarker.setLatLng(pos);
    if (!fitted) {
      map.fitBounds([pos, [s.stop.lat, s.stop.lon]], { padding: [50, 50], maxZoom: 16 });
      fitted = true;
    }
  } else if (busMarker) {
    busMarker.remove();
    busMarker = null;
  }
}

/* ---------- live summary ---------- */

const PILL = {
  tracking: ["live", "Live"],
  waiting: ["warn", "Awaiting GPS"],
  ended: ["", "Share ended"],
  arrived: ["", "Arrived"],
  off_hours: ["", "Off hours"],
};

function setLeave(level, icon, label, title, sub) {
  $("leave").className = `card leave ${level}`;
  text("leave-icon", icon);
  text("leave-label", label);
  text("leave-title", title);
  text("leave-sub", sub);
}

function setMeter(minutesLeft) {
  const frac = minutesLeft == null ? 0 : 1 - Math.min(Math.max(minutesLeft, 0), METER_MINUTES) / METER_MINUTES;
  $("meter-dot").style.left = `${frac * 100}%`;
  $("meter-fill").style.width = `${frac * 100}%`;
  $("meter-dot").classList.toggle("idle", minutesLeft == null);
}

function renderLive() {
  const s = status;
  if (!s) return;
  text("clock", now().toLocaleTimeString([], { hourCycle: "h23" }));
  const walk = cfg.walk;
  const [pillCls, pillLabel] = PILL[s.state] || ["", s.state];
  $("pill").className = `pill ${pillCls}`;
  text("pill-label", pillLabel);

  if (s.state === "arrived") {
    const dev = (new Date(s.arrived_at) - new Date(s.scheduled)) / 60000;
    text("hero-label", "Arrived");
    text("hero-big", fmt(s.arrived_at));
    text("hero-unit", "");
    text("hero-sub", `${Charts.signed(dev)} min vs schedule`);
    setMeter(0);
    setLeave("", "✓", "Complete", fmt(s.arrived_at, true), "Bus reached the stop today.");
    return;
  }

  if (s.state === "off_hours" || s.state === "ended") {
    const day = new Date(s.scheduled).toLocaleDateString([], { weekday: "short" });
    const isToday = new Date(s.scheduled).toDateString() === now().toDateString();
    text("hero-label", s.state === "ended" ? "Scheduled arrival" : "Next scheduled arrival");
    text("hero-big", fmt(s.scheduled));
    text("hero-unit", isToday ? "today" : day);
    text("hero-sub", s.state === "ended"
      ? "Location share ended; no live data."
      : `Live tracking ${s.track_window[0]}–${s.track_window[1]} on school days.`);
    setMeter(null);
    setLeave("", "–", s.state === "ended" ? "No live data" : "Scheduled",
      `Leave ${fmt(leaveByMs(s))}`, `Printed schedule minus ${walk}-min walk.`);
    return;
  }

  const mins = minutesUntil(s.eta);
  const leaveBy = leaveByMs(s);
  const leaveIn = minutesUntil(leaveBy);
  const live = s.state === "tracking";
  const model = s.eta_source === "history" ? `historical model, n=${s.trips_used}` : "printed schedule";
  const range = s.eta_source === "history" && fmt(s.eta_low) !== fmt(s.eta_high)
    ? ` · IQR ${fmt(s.eta_low)}–${fmt(s.eta_high)}` : "";

  text("hero-label", live ? "Estimated arrival" : "Scheduled arrival · awaiting GPS");
  if (mins <= 0.5) {
    text("hero-big", "Due");
    text("hero-unit", "");
    text("hero-sub", `ETA ${fmt(s.eta)}${mins < -1 ? ` · ${Math.round(-mins)} min overdue` : ""} · ${model}`);
  } else {
    text("hero-big", String(Math.ceil(mins)));
    text("hero-unit", "min");
    text("hero-sub", `ETA ${fmt(s.eta)}${range} · ${model}`);
  }
  setMeter(live ? mins : null);

  if (walk > 0 && mins < walk) {
    setLeave("critical", "!", "Hurry", `Bus in ${Math.max(0, Math.ceil(mins))} min`, `Your walk takes ${walk} min.`);
  } else if (leaveIn <= 0) {
    setLeave("critical", "!", "Leave now", "Leave now", `Target departure was ${fmt(leaveBy)}.`);
  } else if (leaveIn <= 5) {
    setLeave("warning", "!", "Prepare to leave", `Leave in ${Math.ceil(leaveIn)} min`, `Depart by ${fmt(leaveBy)}.`);
  } else {
    setLeave("good", "✓", "On track", `Leave ${fmt(leaveBy)}`, `In ${Math.ceil(leaveIn)} min.`);
  }
}

function renderKpis(s) {
  if (s.bus) {
    const ago = Math.max(0, Math.round((now() - new Date(s.bus.at)) / 1000));
    text("kpi-fix", ago < 60 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`);
    text("kpi-fix-sub", fmt(s.bus.at, true));
    text("kpi-speed", s.bus.speed_mph ?? "–");
  } else {
    text("kpi-fix", "–");
    text("kpi-fix-sub", s.error ? "Glympse unreachable" : "No signal");
    text("kpi-speed", "–");
  }
  if (s.last_stop) {
    const dev = (new Date(s.last_stop.at) - new Date(s.last_stop.scheduled)) / 60000;
    text("kpi-stop", `#${s.last_stop.num} · ${fmt(s.last_stop.at)}`);
    text("kpi-stop-sub", s.last_stop.name);
    text("kpi-dev", `${Charts.signed(dev, 0)} min`);
  } else {
    text("kpi-stop", "–");
    text("kpi-stop-sub", " ");
    text("kpi-dev", "–");
  }

  let source;
  if (s.eta_source === "history") {
    source = `Current estimate uses ${s.trips_used} past mornings that passed the bus's current position.`;
  } else if (s.eta_source === "arrived") {
    source = "The bus reached the stop today.";
  } else if (s.history_trips < s.min_history_trips) {
    source = `Using the printed schedule: ${s.history_trips} of ${s.min_history_trips} mornings needed for the historical model have been recorded.`;
  } else {
    source = "Using the printed schedule until the bus reaches a position covered by past mornings.";
  }
  if (s.error) source += ` Last Glympse error: ${s.error}`;
  text("source", source);
  text("min-trips", s.min_history_trips);
  text("walk-max", cfg.walk);
  text("stop-name", s.stop.name);
  text("subtitle", `Stop ${s.stop.num} of ${s.route.length} · scheduled ${s.stop.scheduled} · ${cfg.walk}-min walk`);
}

/* ---------- distribution ---------- */

function renderDistribution() {
  const s = status;
  if (!s) return;
  const empty = historyRows.length === 0;
  $("dist-empty").hidden = !empty;
  $("dist-body").hidden = empty;
  $("table-toggle").hidden = empty;
  if (empty) return;

  const sched = schedMinutes(s);
  const rows = historyRows.map((r) => ({
    m: sched + r.minutes_vs_schedule,
    label: new Date(`${r.date}T12:00`).toLocaleDateString([], { month: "short", day: "numeric" }),
  }));
  const liveEta = s.state === "tracking" || s.state === "waiting";
  const refs = {
    sched,
    eta: liveEta ? toStopMinutes(s, s.eta) : null,
    etaLow: liveEta && s.eta_source === "history" ? toStopMinutes(s, s.eta_low) : null,
    etaHigh: liveEta && s.eta_source === "history" ? toStopMinutes(s, s.eta_high) : null,
  };
  text("dist-caption", `Arrival at ${s.stop.name}, ${rows.length} recorded morning${rows.length === 1 ? "" : "s"}` +
    (refs.eta != null ? ". Shaded band: today's ETA range." : "."));
  Charts.statTiles($("dist-stats"), Charts.stats(rows.map((r) => r.m), sched), sched);
  Charts.histogram($("hist"), rows, refs);
  Charts.ecdf($("ecdf"), rows, refs);

  const body = $("dist-table");
  body.replaceChildren();
  for (const r of historyRows) {
    const tr = document.createElement("tr");
    const date = new Date(`${r.date}T12:00`).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    for (const v of [date, fmt(r.arrived, true), `${Charts.signed(r.minutes_vs_schedule)} min`]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

$("table-toggle").addEventListener("click", () => {
  showTable = !showTable;
  $("table-toggle").setAttribute("aria-pressed", String(showTable));
  $("dist-table-wrap").hidden = !showTable;
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderDistribution, 150);
});

/* ---------- data ---------- */

async function loadHistory() {
  try {
    const stopNum = cfg.stop;
    const rows = await (await fetch(`api/history?stop=${stopNum}`, { cache: "no-store" })).json();
    if (stopNum !== cfg.stop) return;
    historyRows = rows;
    renderDistribution();
  } catch (e) {
    console.warn("history failed", e);
  }
}

async function refresh() {
  if (!cfg) return;
  try {
    const res = await fetch(`api/status?stop=${cfg.stop}`, { cache: "no-store" });
    if (res.status === 404) {
      // Saved stop no longer exists on the route; fall back to the default and ask again.
      cfg = null;
      status = null;
      return start(true);
    }
    const s = await res.json();
    if (s.stop.num !== cfg.stop) return; // response for a stop the viewer just switched away from
    clockOffset = new Date(s.now) - Date.now();
    if (!status) drawStops(s);
    const etaChanged = !status || status.eta !== s.eta || status.state !== s.state;
    status = s;
    updateMap(s);
    renderKpis(s);
    renderLive();
    if (etaChanged) renderDistribution();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

async function start(askForSettings) {
  if (!cfg) {
    // First visit: show the default stop behind the settings dialog.
    const s = await (await fetch("api/status", { cache: "no-store" })).json();
    cfg = { stop: s.stop.num, walk: s.default_walk_minutes };
  }
  await refresh();
  loadHistory();
  if (askForSettings && status) openSettings();
}

initMap();
const fromUrl = configFromUrl();
if (fromUrl) saveConfig(fromUrl);
cfg = fromUrl || loadConfig();
start(!cfg);
setInterval(refresh, REFRESH_MS);
setInterval(renderLive, 1000);
setInterval(loadHistory, 10 * 60000);

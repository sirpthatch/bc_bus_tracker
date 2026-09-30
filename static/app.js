"use strict";

const REFRESH_MS = 10000;
const TRACK_MINUTES = 30; // the kid track spans the last 30 minutes before the bus arrives

let status = null;
let clockOffset = 0; // server time minus local time
let map, busMarker, trailLine, fitted = false;

const $ = (id) => document.getElementById(id);
const now = () => new Date(Date.now() + clockOffset);
const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/i, "");
const minutesUntil = (iso) => (new Date(iso) - now()) / 60000;

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  trailLine = L.polyline([], { color: "#e0a800", weight: 6, opacity: 0.85 }).addTo(map);
}

function drawStaticMap(s) {
  for (const stop of s.route.slice(0, -1)) {
    L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({ className: "", html: `<div class="route-dot">${stop.num}</div>`, iconSize: [22, 22] }),
    }).bindTooltip(`${stop.num}. ${stop.name} · ${stop.scheduled}`).addTo(map);
  }
  L.marker([s.stop.lat, s.stop.lon], {
    icon: L.divIcon({ className: "stop-marker", html: "🏠", iconSize: [34, 34] }),
    zIndexOffset: 500,
  }).bindTooltip(`Our stop: ${s.stop.name}`).addTo(map);
  map.fitBounds(s.route.map((r) => [r.lat, r.lon]), { padding: [20, 20] });
}

function updateMap(s) {
  trailLine.setLatLngs(s.trail);
  if (s.bus) {
    const pos = [s.bus.lat, s.bus.lon];
    if (!busMarker) {
      busMarker = L.marker(pos, {
        icon: L.divIcon({ className: "bus-marker", html: "🚌", iconSize: [34, 34] }),
        zIndexOffset: 1000,
      }).addTo(map);
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

function setHero(cls, label, big, sub) {
  $("hero").className = `hero ${cls}`;
  $("hero-label").textContent = label;
  $("hero-big").textContent = big;
  $("hero-sub").textContent = sub;
}

function setLeave(cls, emoji, title, sub) {
  $("leave").className = `leave ${cls}`;
  $("leave-emoji").textContent = emoji;
  $("leave-title").textContent = title;
  $("leave-sub").textContent = sub;
}

function setTrack(minutesLeft) {
  const frac = minutesLeft == null ? 0 : 1 - Math.min(Math.max(minutesLeft, 0), TRACK_MINUTES) / TRACK_MINUTES;
  // Bus travels from 8% to just short of the house.
  $("track-bus").style.left = `${8 + frac * 76}%`;
}

function etaText(s) {
  if (s.eta_source !== "history") return `at ${fmtTime(s.eta)}`;
  const lo = fmtTime(s.eta_low), hi = fmtTime(s.eta_high);
  return lo === hi ? `at ${fmtTime(s.eta)}` : `at ${fmtTime(s.eta)}  (${lo}–${hi})`;
}

function renderLive() {
  const s = status;
  if (!s) return;
  $("clock").textContent = now().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const [walkMin, walkMax] = s.walk_minutes;

  if (s.state === "arrived") {
    setHero("done", "The bus came!", "🎒", `at ${fmtTime(s.arrived_at)}`);
    setLeave("done", "👋", "Have a great day!", `Bus reached ${s.stop.name} at ${fmtTime(s.arrived_at)}.`);
    setTrack(0);
    return;
  }

  if (s.state === "off_hours") {
    const day = new Date(s.scheduled).toLocaleDateString([], { weekday: "long" });
    const isToday = new Date(s.scheduled).toDateString() === now().toDateString();
    setHero("off", `Next bus${isToday ? " today" : ` ${day}`}`, fmtTime(s.scheduled), "😴 The bus is sleeping");
    setLeave("off", "🕢", `Leave home by ${fmtTime(s.leave_by)}`,
      `Live tracking starts at ${s.track_window[0]}.`);
    setTrack(null);
    return;
  }

  const mins = minutesUntil(s.eta);
  const leaveIn = minutesUntil(s.leave_by);
  const waiting = s.state !== "tracking";

  if (s.state === "ended") {
    setHero("off", "Tracking stopped", fmtTime(s.scheduled), "The bus stopped sharing its location");
    setLeave("off", "🤷", "No live location", `Scheduled pickup is ${fmtTime(s.scheduled)}.`);
    setTrack(null);
    return;
  }

  if (mins <= 0.5) {
    setHero("", waiting ? "Scheduled for" : "The bus is", waiting ? fmtTime(s.eta) : "Almost here!",
      waiting ? "Waiting for the bus to show up…" : "Any minute now");
  } else {
    setHero("", waiting ? "Scheduled in" : "Bus comes in", `${Math.ceil(mins)} min`, etaText(s));
  }
  setTrack(waiting ? null : mins);

  if (mins < walkMin) {
    setLeave("go", "🏃", "Hurry!", `The walk takes ${walkMin}–${walkMax} minutes.`);
  } else if (leaveIn <= 0) {
    setLeave("go", "🏃", "Time to go!", `Walk to ${s.stop.name} now.`);
  } else if (leaveIn <= 5) {
    setLeave("soon", "👟", "Shoes on!", `Leave in ${Math.ceil(leaveIn)} min (by ${fmtTime(s.leave_by)}).`);
  } else {
    setLeave("calm", "🥣", `Leave by ${fmtTime(s.leave_by)}`, `That's in ${Math.ceil(leaveIn)} minutes. Plenty of time.`);
  }
}

function renderDetails(s) {
  const bits = [];
  if (s.bus) {
    const ago = Math.max(0, Math.round((now() - new Date(s.bus.at)) / 1000));
    bits.push(`Bus seen ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago` +
      (s.bus.speed_mph != null ? `, going ${s.bus.speed_mph} mph` : ""));
  } else if (s.state === "waiting") {
    bits.push("The bus hasn't shared its location yet.");
  }
  if (s.last_stop) {
    const diff = Math.round((new Date(s.last_stop.at) - new Date(s.last_stop.scheduled)) / 60000);
    const vs = diff === 0 ? "on time" : diff > 0 ? `${diff} min late` : `${-diff} min early`;
    bits.push(`Passed stop ${s.last_stop.num} (${s.last_stop.name}) at ${fmtTime(s.last_stop.at)}: ${vs}`);
  }
  if (s.error) bits.push(`⚠️ Having trouble reaching Glympse: ${s.error}`);
  $("bus-detail").textContent = bits.join(" · ") || `Our stop: ${s.stop.name}`;

  let source;
  if (s.eta_source === "history") {
    source = `Estimate based on ${s.trips_used} past mornings when the bus was at this same spot.`;
  } else if (s.eta_source === "arrived") {
    source = "The bus reached our stop today.";
  } else if (s.history_trips < s.min_history_trips) {
    source = `Using the printed schedule (${fmtTime(s.scheduled)}). Predictions start after ${s.min_history_trips} recorded mornings. So far: ${s.history_trips}.`;
  } else {
    source = `Using the printed schedule (${fmtTime(s.scheduled)}) until the bus is somewhere we've seen it before.`;
  }
  $("source").textContent = source;
}

async function loadHistory() {
  try {
    const rows = await (await fetch("api/history")).json();
    if (!rows.length) return;
    $("history").innerHTML = "";
    for (const r of rows.slice(0, 10)) {
      const li = document.createElement("li");
      const day = new Date(r.date + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      const m = r.minutes_vs_schedule;
      const cls = m > 1 ? "late" : m < -1 ? "early" : "";
      const vs = Math.abs(m) < 0.5 ? "on time" : m > 0 ? `${Math.round(m)} min late` : `${Math.round(-m)} min early`;
      li.innerHTML = `<span>${day}</span><span>${fmtTime(r.arrived)} <span class="${cls}">${vs}</span></span>`;
      $("history").appendChild(li);
    }
  } catch (e) {
    console.warn("history failed", e);
  }
}

async function refresh() {
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    const s = await res.json();
    clockOffset = new Date(s.now) - Date.now();
    if (!status) drawStaticMap(s);
    status = s;
    updateMap(s);
    renderDetails(s);
    renderLive();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

initMap();
refresh();
loadHistory();
setInterval(refresh, REFRESH_MS);
setInterval(renderLive, 1000);
setInterval(loadHistory, 10 * 60000);

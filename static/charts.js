"use strict";

// Arrival-time distribution charts. Times are minutes since midnight (local to the stop).
const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const tooltip = () => document.getElementById("tooltip");

  const pad2 = (n) => String(n).padStart(2, "0");
  // Truncate to the minute, matching how clock times are shown elsewhere on the page.
  function clock(m) {
    const r = Math.floor(m + 1e-9);
    return `${pad2(Math.floor(r / 60))}:${pad2(r % 60)}`;
  }
  const signed = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x).toFixed(d);

  function el(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function showTip(evt, strong, lines) {
    const tip = tooltip();
    tip.replaceChildren();
    const s = document.createElement("strong");
    s.textContent = strong;
    tip.appendChild(s);
    for (const line of lines) {
      const d = document.createElement("div");
      d.className = "tt-sub";
      d.textContent = line;
      tip.appendChild(d);
    }
    tip.hidden = false;
    let x, y;
    if (evt.clientX != null && evt.type.startsWith("pointer")) {
      x = evt.clientX; y = evt.clientY;
    } else {
      const r = evt.target.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.top;
    }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8)}px`;
    tip.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
  }
  const hideTip = () => { tooltip().hidden = true; };

  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function stats(values, sched) {
    const s = [...values].sort((a, b) => a - b);
    const n = s.length;
    const mean = s.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return {
      n, mean, sd,
      median: quantile(s, 0.5), p10: quantile(s, 0.1), p90: quantile(s, 0.9),
      onTime: s.filter((v) => v <= sched).length,
    };
  }

  function domain(values, refs) {
    const all = [...values, ...refs.filter((r) => r != null)];
    let lo = Math.floor(Math.min(...all)) - 1, hi = Math.floor(Math.max(...all)) + 2;
    while (hi - lo < 12) { lo -= 1; if (hi - lo < 12) hi += 1; }
    return [lo, hi];
  }

  function xTicks(lo, hi, width) {
    const maxTicks = Math.max(2, Math.floor(width / 56));
    const step = [1, 2, 5, 10, 15, 30].find((s) => (hi - lo) / s <= maxTicks) || 60;
    const out = [];
    for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) out.push(m);
    return out;
  }

  function frame(container, height, margin) {
    container.replaceChildren();
    const width = container.clientWidth;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, height });
    container.appendChild(svg);
    return { svg, width, pw: width - margin.l - margin.r, ph: height - margin.t - margin.b };
  }

  // Vertical reference lines (schedule, today's ETA) with labels that avoid each other.
  function references(svg, x, top, bottom, refs) {
    let lastLabelRight = -Infinity;
    const g = el("g", {}, svg);
    if (refs.etaLow != null && refs.etaHigh != null && refs.etaHigh > refs.etaLow) {
      el("rect", { class: "eta-band", x: x(refs.etaLow), y: top, width: x(refs.etaHigh) - x(refs.etaLow), height: bottom - top }, g);
    }
    const items = [{ m: refs.sched, cls: "ref", text: `Sched ${clock(refs.sched)}` }];
    if (refs.eta != null) items.push({ m: refs.eta, cls: "eta", text: `ETA ${clock(refs.eta)}` });
    items.sort((a, b) => a.m - b.m);
    for (const it of items) {
      const px = x(it.m);
      el("line", { class: it.cls, x1: px, x2: px, y1: top - 4, y2: bottom }, g);
      // The second label drops to a lower row when it would overlap the first.
      const row = px + 4 < lastLabelRight + 6 ? 1 : 0;
      const t = el("text", { class: "ref-label", x: px + 4, y: top - 19 + row * 13 }, g);
      t.textContent = it.text;
      const w = t.getComputedTextLength();
      if (px + 4 + w > svg.viewBox.baseVal.width) {
        t.setAttribute("x", px - 4);
        t.setAttribute("text-anchor", "end");
      }
      lastLabelRight = px + 4 + w;
    }
  }

  function xAxis(svg, x, lo, hi, width, y) {
    el("line", { class: "baseline", x1: x(lo), x2: x(hi), y1: y, y2: y }, svg);
    for (const m of xTicks(lo, hi, width)) {
      const t = el("text", { x: x(m), y: y + 15, "text-anchor": "middle" }, svg);
      t.textContent = clock(m);
    }
  }

  function histogram(container, rows, refs) {
    const margin = { l: 30, r: 10, t: 34, b: 22 };
    const { svg, width, pw, ph } = frame(container, 190, margin);
    const values = rows.map((r) => r.m);
    const [lo, hi] = domain(values, [refs.sched, refs.etaLow, refs.etaHigh]);
    const x = (m) => margin.l + ((m - lo) / (hi - lo)) * pw;
    const bins = [];
    for (let m = lo; m < hi; m++) bins.push({ m, rows: [] });
    for (const r of rows) bins[Math.floor(r.m) - lo]?.rows.push(r);
    const maxC = Math.max(1, ...bins.map((b) => b.rows.length));
    const step = Math.max(1, Math.ceil(maxC / 4));
    const yMax = Math.ceil(maxC / step) * step;
    const y = (c) => margin.t + ph - (c / yMax) * ph;

    for (let c = 0; c <= yMax; c += step) {
      if (c > 0) el("line", { class: "gridline", x1: margin.l, x2: margin.l + pw, y1: y(c), y2: y(c) }, svg);
      const t = el("text", { x: margin.l - 6, y: y(c) + 4, "text-anchor": "end" }, svg);
      t.textContent = c;
    }
    references(svg, x, margin.t, margin.t + ph, refs);

    const band = pw / (hi - lo);
    const barW = Math.max(1, Math.min(24, band - 2));
    for (const b of bins) {
      const c = b.rows.length;
      const bx = x(b.m) + (band - barW) / 2;
      let bar = null;
      if (c) {
        const top = y(c), base = y(0), r = Math.min(4, barW / 2, base - top);
        bar = el("path", {
          class: "bar",
          d: `M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${base}Z`,
        }, svg);
      }
      const hit = el("rect", { class: "hit", x: x(b.m), y: margin.t, width: band, height: ph, tabindex: c ? 0 : -1 }, svg);
      const label = `${c} morning${c === 1 ? "" : "s"}`;
      const range = `${clock(b.m)}–${clock(b.m + 1)} (${signed(b.m - refs.sched, 0)} min vs schedule)`;
      hit.setAttribute("aria-label", `${range}: ${label}`);
      const dates = b.rows.map((r) => r.label);
      const enter = (evt) => {
        if (bar) bar.style.opacity = 0.75;
        const lines = [range];
        if (dates.length) lines.push(dates.slice(0, 6).join(", ") + (dates.length > 6 ? `, +${dates.length - 6} more` : ""));
        showTip(evt, label, lines);
      };
      const leave = () => { if (bar) bar.style.opacity = ""; hideTip(); };
      hit.addEventListener("pointermove", enter);
      hit.addEventListener("focus", enter);
      hit.addEventListener("pointerleave", leave);
      hit.addEventListener("blur", leave);
    }
    xAxis(svg, x, lo, hi, width, margin.t + ph);
  }

  function ecdf(container, rows, refs) {
    const margin = { l: 38, r: 10, t: 34, b: 22 };
    const { svg, width, pw, ph } = frame(container, 190, margin);
    const s = rows.map((r) => r.m).sort((a, b) => a - b);
    const n = s.length;
    const [lo, hi] = domain(s, [refs.sched, refs.etaLow, refs.etaHigh]);
    const x = (m) => margin.l + ((m - lo) / (hi - lo)) * pw;
    const y = (p) => margin.t + ph - p * ph;
    const F = (t) => s.filter((v) => v <= t).length;

    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      if (p > 0) el("line", { class: "gridline", x1: margin.l, x2: margin.l + pw, y1: y(p), y2: y(p) }, svg);
      const t = el("text", { x: margin.l - 6, y: y(p) + 4, "text-anchor": "end" }, svg);
      t.textContent = `${p * 100}%`;
    }
    references(svg, x, margin.t, margin.t + ph, refs);

    let d = `M${x(lo)},${y(0)}`;
    s.forEach((v, i) => { d += `H${x(v)}V${y((i + 1) / n)}`; });
    d += `H${x(hi)}`;
    el("path", { class: "area", d: `${d}V${y(0)}Z` }, svg);
    el("path", { class: "line", d }, svg);

    // Direct label: share arrived by the scheduled time.
    const pSched = F(refs.sched) / n;
    el("circle", { class: "cross-dot", cx: x(refs.sched), cy: y(pSched), r: 4 }, svg);
    const lbl = el("text", { class: "ref-label", x: x(refs.sched) - 6, y: y(pSched) - 8, "text-anchor": "end" }, svg);
    lbl.textContent = `${Math.round(pSched * 100)}% by ${clock(refs.sched)}`;

    const cross = el("line", { class: "crosshair", y1: margin.t, y2: margin.t + ph, visibility: "hidden" }, svg);
    const dot = el("circle", { class: "cross-dot", r: 4, visibility: "hidden" }, svg);
    const overlay = el("rect", { class: "hit", x: margin.l, y: margin.t, width: pw, height: ph, tabindex: 0 }, svg);
    overlay.setAttribute("aria-label", "Cumulative share of mornings arrived by time. Use arrow keys to step through minutes.");
    let cur = Math.round(refs.sched);
    const show = (evt) => {
      const k = F(cur);
      cross.setAttribute("x1", x(cur)); cross.setAttribute("x2", x(cur));
      dot.setAttribute("cx", x(cur)); dot.setAttribute("cy", y(k / n));
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      showTip(evt, `${Math.round((k / n) * 100)}%`, [`arrived by ${clock(cur)} (${k} of ${n})`]);
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); };
    overlay.addEventListener("pointermove", (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * width;
      cur = Math.min(hi, Math.max(lo, Math.round(lo + ((px - margin.l) / pw) * (hi - lo))));
      show(evt);
    });
    overlay.addEventListener("focus", show);
    overlay.addEventListener("keydown", (evt) => {
      if (evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
      evt.preventDefault();
      cur = Math.min(hi, Math.max(lo, cur + (evt.key === "ArrowRight" ? 1 : -1)));
      show(evt);
    });
    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("blur", hide);
    xAxis(svg, x, lo, hi, width, margin.t + ph);
  }

  function statTiles(container, st, sched) {
    const tiles = [
      ["Mornings", String(st.n), "recorded"],
      ["Median", clock(st.median), `${signed(st.median - sched)} min`],
      ["Mean", clock(st.mean), `${signed(st.mean - sched)} min`],
      ["Std dev", `${st.sd.toFixed(1)} min`, "sample"],
      ["P10 – P90", `${clock(st.p10)}–${clock(st.p90)}`, `${(st.p90 - st.p10).toFixed(1)} min spread`],
      [`By ${clock(sched)}`, `${Math.round((st.onTime / st.n) * 100)}%`, `${st.onTime} of ${st.n}`],
    ];
    container.replaceChildren();
    for (const [label, value, sub] of tiles) {
      const d = document.createElement("div");
      d.className = "stat";
      for (const [cls, text] of [["label", label], ["stat-value num", value], ["stat-sub num", sub]]) {
        const e = document.createElement("div");
        e.className = cls;
        e.textContent = text;
        d.appendChild(e);
      }
      container.appendChild(d);
    }
  }

  return { histogram, ecdf, stats, statTiles, clock, signed };
})();

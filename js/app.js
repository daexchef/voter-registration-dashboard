/* Eligible (VEP 2024) vs Registered (2026) Dashboard — map + live pipeline */
(function () {
  "use strict";

  const POLL_MS = 20000; // auto-refresh poll
  const API_STATES = "/api/states";
  const API_STATUS = "/api/status";
  const API_REFRESH = "/api/refresh";
  const API_GEO = "/api/geo/us-states";
  const FALLBACK_JSON = "data/states.json";

  const state = {
    data: null,
    filtered: [],
    sortKey: "state",
    sortDir: 1,
    selected: null,
    chartMode: "both",
    chart: null,
    rateChart: null,
    revision: null,
    map: null,
    geoLayer: null,
    geojson: null,
    mapMetric: "rate", // rate | vep | registered | gap
    byName: {},
    pollTimer: null,
    pipeline: null,
  };

  const el = {
    clock: document.getElementById("clock"),
    kpiVep: document.getElementById("kpi-vep"),
    kpiReg: document.getElementById("kpi-reg"),
    kpiRate: document.getElementById("kpi-rate"),
    kpiGap: document.getElementById("kpi-gap"),
    kpiOver: document.getElementById("kpi-over"),
    kpiStates: document.getElementById("kpi-states"),
    search: document.getElementById("search"),
    sortSelect: document.getElementById("sort-select"),
    filterRate: document.getElementById("filter-rate"),
    tbody: document.getElementById("table-body"),
    tableMeta: document.getElementById("table-meta"),
    chartMeta: document.getElementById("chart-meta"),
    detail: document.getElementById("detail-panel"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    toast: document.getElementById("toast"),
    pipelineStatus: document.getElementById("pipeline-status"),
    pipelineDetail: document.getElementById("pipeline-detail"),
    mapMeta: document.getElementById("map-meta"),
    btnRefresh: document.getElementById("btn-pipeline-refresh"),
  };

  function fmt(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return new Intl.NumberFormat("en-US").format(Math.round(n));
  }

  function fmtM(n) {
    if (n == null) return "—";
    return (n / 1e6).toFixed(1) + "M";
  }

  function fmtPct(r) {
    if (r == null) return "N/A";
    return (r * 100).toFixed(1) + "%";
  }

  function rateClass(r) {
    if (r == null) return "rate-na";
    if (r > 1) return "rate-over";
    if (r >= 0.95) return "rate-high";
    if (r >= 0.85) return "rate-mid";
    return "rate-low";
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("show"), 2800);
  }

  function tickClock() {
    const now = new Date();
    el.clock.textContent =
      "Local " +
      now.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      });
  }

  function indexByName(states) {
    const map = {};
    for (const s of states) {
      map[s.state] = s;
      // PublicaMundi geojson uses full names; handle DC if ever present
      map[s.state.toLowerCase()] = s;
    }
    state.byName = map;
  }

  function computeAggregates(rows) {
    let vep = 0;
    let reg = 0;
    let over = 0;
    let rateSum = 0;
    let rateN = 0;
    for (const s of rows) {
      vep += s.vep2024 || 0;
      if (!s.noRegistration) {
        reg += s.registered2026 || 0;
        if (s.rate != null) {
          rateSum += s.rate;
          rateN += 1;
          if (s.rate > 1) over += 1;
        }
      }
    }
    return {
      count: rows.length,
      vep,
      reg,
      gap: vep - reg,
      overall: vep > 0 ? reg / vep : null,
      avgRate: rateN ? rateSum / rateN : null,
      over,
    };
  }

  function updateKpis(agg) {
    el.kpiVep.textContent = fmtM(agg.vep);
    el.kpiVep.title = fmt(agg.vep) + " eligible voters (VEP 2024)";
    el.kpiReg.textContent = fmtM(agg.reg);
    el.kpiReg.title = fmt(agg.reg) + " registered (2026 est.)";
    el.kpiRate.textContent = fmtPct(agg.overall);
    el.kpiGap.textContent = fmtM(agg.gap);
    el.kpiGap.title = fmt(agg.gap) + " eligible not on rolls (approx.)";
    el.kpiOver.textContent = String(agg.over);
    el.kpiStates.textContent = String(agg.count);
  }

  function updatePipelineUi(pipeline, meta) {
    state.pipeline = pipeline || null;
    if (!el.pipelineStatus) return;

    const running = pipeline && pipeline.running;
    const err = pipeline && pipeline.last_error;
    const rev =
      (meta && meta.data_revision) ||
      (pipeline && pipeline.data_revision) ||
      state.revision ||
      "—";
    const last =
      (pipeline && (pipeline.last_success || pipeline.last_run_finished)) ||
      (meta && meta.last_pipeline_run) ||
      null;

    let badgeClass = "live-badge";
    let label = "Pipeline idle";
    if (running) {
      badgeClass += " running";
      label = "Scraping sources…";
    } else if (err) {
      badgeClass += " error";
      label = "Pipeline error";
    } else if (last) {
      badgeClass += " ok";
      label = "Auto-refresh on";
    }

    el.pipelineStatus.className = badgeClass;
    el.pipelineStatus.innerHTML = `<span class="dot"></span> ${label}`;

    const parts = [];
    parts.push(`rev ${rev}`);
    if (last) {
      try {
        parts.push("last OK " + new Date(last).toLocaleTimeString());
      } catch {
        parts.push("last " + last);
      }
    }
    if (pipeline && pipeline.sources) {
      const s = pipeline.sources;
      const flags = [];
      if (s.wpr) flags.push(s.wpr.ok ? "WPR✓" : "WPR✗");
      if (s.usafacts) flags.push(s.usafacts.ok ? "USAFacts✓" : "USAFacts✗");
      if (s.electproject) flags.push(s.electproject.ok ? "Elect✓" : "Elect✗");
      if (flags.length) parts.push(flags.join(" "));
    }
    if (pipeline && pipeline.changes && pipeline.changes.registered_updated != null) {
      parts.push(`Δreg ${pipeline.changes.registered_updated}`);
    }
    if (err) parts.push(String(err).slice(0, 80));
    if (el.pipelineDetail) el.pipelineDetail.textContent = parts.join(" · ");
  }

  function applyFilters() {
    if (!state.data) return;
    const q = (el.search.value || "").trim().toLowerCase();
    const rateFilter = el.filterRate.value;
    let rows = state.data.states.slice();

    if (q) {
      rows = rows.filter(
        (s) =>
          s.state.toLowerCase().includes(q) || s.abbr.toLowerCase().includes(q)
      );
    }

    if (rateFilter === "over100") {
      rows = rows.filter((s) => s.rate != null && s.rate > 1);
    } else if (rateFilter === "high") {
      rows = rows.filter((s) => s.rate != null && s.rate >= 0.95 && s.rate <= 1);
    } else if (rateFilter === "mid") {
      rows = rows.filter((s) => s.rate != null && s.rate >= 0.85 && s.rate < 0.95);
    } else if (rateFilter === "low") {
      rows = rows.filter((s) => s.rate != null && s.rate < 0.85);
    } else if (rateFilter === "na") {
      rows = rows.filter((s) => s.rate == null || s.noRegistration);
    }

    const key = state.sortKey;
    const dir = state.sortDir;
    rows.sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (key === "gap") {
        av = (a.vep2024 || 0) - (a.registered2026 || 0);
        bv = (b.vep2024 || 0) - (b.registered2026 || 0);
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });

    state.filtered = rows;
    updateKpis(computeAggregates(rows));
    renderTable();
    renderCharts();
    colorMap();
    el.tableMeta.textContent = `${rows.length} state${rows.length === 1 ? "" : "s"} shown`;
    el.chartMeta.textContent = `Filtered view · ${rows.length} states`;
  }

  function renderTable() {
    const frag = document.createDocumentFragment();
    for (const s of state.filtered) {
      const tr = document.createElement("tr");
      if (s.noRegistration) tr.classList.add("na");
      if (state.selected && state.selected.abbr === s.abbr) tr.classList.add("selected");
      const gap = (s.vep2024 || 0) - (s.registered2026 || 0);
      tr.innerHTML = `
        <td><strong>${s.state}</strong> <span style="color:var(--text-dim)">${s.abbr}</span></td>
        <td>${fmt(s.vep2024)}</td>
        <td>${fmt(s.registered2026)}${s.noRegistration ? "*" : ""}</td>
        <td>${fmt(gap)}</td>
        <td><span class="rate-pill ${rateClass(s.rate)}">${fmtPct(s.rate)}</span></td>
      `;
      tr.addEventListener("click", () => selectState(s));
      frag.appendChild(tr);
    }
    el.tbody.innerHTML = "";
    if (!state.filtered.length) {
      el.tbody.innerHTML = `<tr><td colspan="5" class="empty">No states match your filters.</td></tr>`;
      return;
    }
    el.tbody.appendChild(frag);
  }

  function selectState(s) {
    state.selected = s;
    renderTable();
    openDetail(s);
    colorMap();
    if (state.chart) {
      const idx = state.filtered.findIndex((x) => x.abbr === s.abbr);
      if (idx >= 0) {
        state.chart.setActiveElements([
          { datasetIndex: 0, index: idx },
          { datasetIndex: 1, index: idx },
        ]);
        state.chart.update();
      }
    }
    // Pan map slightly by re-fitting is noisy; just style highlight
  }

  function openDetail(s) {
    const meta = state.data.meta;
    const gap = (s.vep2024 || 0) - (s.registered2026 || 0);
    const rate = s.rate;
    el.detail.classList.add("open");
    el.detailTitle.textContent = `${s.state} (${s.abbr}) — drill-down`;
    el.detailBody.innerHTML = `
      <div class="detail-grid">
        <div class="detail-stat">
          <div class="label">Eligible (VEP 2024)</div>
          <div class="value" style="color:var(--vep)">${fmt(s.vep2024)}</div>
        </div>
        <div class="detail-stat">
          <div class="label">Registered (2026 est.)</div>
          <div class="value" style="color:var(--registered)">${fmt(s.registered2026)}${s.noRegistration ? "*" : ""}</div>
        </div>
        <div class="detail-stat">
          <div class="label">Gap (VEP − Reg)</div>
          <div class="value">${fmt(gap)}</div>
        </div>
        <div class="detail-stat">
          <div class="label">Registration rate</div>
          <div class="value"><span class="rate-pill ${rateClass(rate)}">${fmtPct(rate)}</span></div>
        </div>
      </div>
      ${
        s.notes
          ? `<div class="caveats"><strong>State note</strong><p style="margin:0.35rem 0 0">${s.notes}</p></div>`
          : ""
      }
      <h3 style="margin:1.1rem 0 0.5rem;font-size:0.95rem">Source lineage</h3>
      <ul class="source-list">
        <li>
          <strong>${meta.sources.vep.name}</strong>
          <p>${meta.sources.vep.description}</p>
          <div class="links">
            <a href="${meta.sources.vep.url}" target="_blank" rel="noopener">Elect Project (VEP)</a>
            <span style="color:var(--text-dim)">vep2024 = ${s.vep2024}</span>
          </div>
        </li>
        <li>
          <strong>${meta.sources.registered.name}</strong>
          <p>${meta.sources.registered.description}</p>
          <div class="links">
            <a href="${meta.sources.registered.scrape_url || "https://worldpopulationreview.com/state-rankings/registered-voters-by-state"}" target="_blank" rel="noopener">WPR / IVP live source</a>
            <a href="${meta.sources.usafacts.url}" target="_blank" rel="noopener">USAFacts</a>
            <span style="color:var(--text-dim)">registered2026 = ${s.registered2026}</span>
          </div>
        </li>
        <li>
          <strong>${meta.sources.stateSos.name}</strong>
          <p>${meta.sources.stateSos.description}</p>
          <div class="links">
            <a href="${meta.sources.stateSos.url}" target="_blank" rel="noopener">State election office</a>
            <a href="/data/states.json" target="_blank" rel="noopener">Raw JSON</a>
            <a href="/api/states" target="_blank" rel="noopener">API /api/states</a>
          </div>
        </li>
      </ul>
    `;
    el.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------- Charts ---------- */
  function chartColors() {
    return {
      vep: "rgba(56, 189, 248, 0.85)",
      reg: "rgba(167, 139, 250, 0.85)",
      rate: "rgba(52, 211, 153, 0.95)",
      gap: "rgba(251, 191, 36, 0.85)",
      grid: "rgba(148, 163, 184, 0.12)",
      text: "#93a4c3",
    };
  }

  function renderCharts() {
    if (typeof Chart === "undefined") return;
    const rows = state.filtered;
    const labels = rows.map((s) => s.abbr);
    const vep = rows.map((s) => s.vep2024);
    const reg = rows.map((s) => s.registered2026);
    const rates = rows.map((s) => (s.rate == null ? null : +(s.rate * 100).toFixed(1)));
    const gaps = rows.map((s) => s.vep2024 - s.registered2026);
    const c = chartColors();
    const ctx = document.getElementById("main-chart");
    if (!ctx) return;

    const datasets = [];
    if (state.chartMode === "both") {
      datasets.push({
        type: "bar",
        label: "Eligible (VEP 2024)",
        data: vep,
        backgroundColor: c.vep,
        borderRadius: 3,
        order: 2,
        yAxisID: "y",
      });
      datasets.push({
        type: "bar",
        label: "Registered (2026 est.)",
        data: reg,
        backgroundColor: c.reg,
        borderRadius: 3,
        order: 2,
        yAxisID: "y",
      });
      datasets.push({
        type: "line",
        label: "Registration rate %",
        data: rates,
        borderColor: c.rate,
        backgroundColor: c.rate,
        yAxisID: "y1",
        tension: 0.25,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 2,
        order: 1,
        spanGaps: true,
      });
    } else if (state.chartMode === "gap") {
      datasets.push({
        type: "bar",
        label: "Gap (VEP − Registered)",
        data: gaps,
        backgroundColor: c.gap,
        borderRadius: 3,
        yAxisID: "y",
      });
    } else {
      datasets.push({
        type: "bar",
        label: "Registration rate %",
        data: rates,
        backgroundColor: rates.map((r) => {
          if (r == null) return "rgba(248,113,113,0.5)";
          if (r > 100) return c.reg;
          if (r >= 95) return c.rate;
          if (r >= 85) return c.vep;
          return c.gap;
        }),
        borderRadius: 3,
        yAxisID: "y",
      });
    }

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        if (rows[idx]) selectState(rows[idx]);
      },
      plugins: {
        legend: { labels: { color: c.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              return rows[i] ? `${rows[i].state} (${rows[i].abbr})` : "";
            },
            label: (item) => {
              const label = item.dataset.label || "";
              const v = item.raw;
              if (v == null) return `${label}: N/A`;
              if (label.includes("rate") || state.chartMode === "rate") return `${label}: ${v}%`;
              return `${label}: ${fmt(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: c.text,
            maxRotation: 90,
            autoSkip: rows.length > 30,
            font: { size: 10 },
          },
          grid: { color: c.grid },
        },
        y: {
          position: "left",
          ticks: {
            color: c.text,
            callback: (v) =>
              state.chartMode === "rate" ? v + "%" : fmtM(v),
          },
          grid: { color: c.grid },
          title: {
            display: true,
            text:
              state.chartMode === "rate"
                ? "Registration rate %"
                : state.chartMode === "gap"
                  ? "Eligible − Registered"
                  : "Voters",
            color: c.text,
            font: { size: 11 },
          },
        },
        y1: {
          display: state.chartMode === "both",
          position: "right",
          min: 60,
          max: 120,
          ticks: { color: c.rate, callback: (v) => v + "%" },
          grid: { drawOnChartArea: false },
          title: {
            display: state.chartMode === "both",
            text: "Rate %",
            color: c.rate,
            font: { size: 11 },
          },
        },
      },
    };

    if (state.chart) {
      state.chart.data.labels = labels;
      state.chart.data.datasets = datasets;
      state.chart.options = options;
      state.chart.update("none");
    } else {
      state.chart = new Chart(ctx, { type: "bar", data: { labels, datasets }, options });
    }
    renderNationalBars();
  }

  function renderNationalBars() {
    if (typeof Chart === "undefined" || !state.data) return;
    const ctx = document.getElementById("national-chart");
    if (!ctx) return;
    const all = computeAggregates(state.data.states);
    const meta = state.data.meta.national;
    const c = chartColors();
    const data = {
      labels: ["VEP 2024 (sum)", "Registered IVP 2026", "USAFacts national"],
      datasets: [
        {
          label: "National totals",
          data: [
            all.vep,
            all.reg,
            (meta.registeredUsafactsApproxMillions || 0) * 1e6,
          ],
          backgroundColor: [c.vep, c.reg, "rgba(148,163,184,0.55)"],
          borderRadius: 6,
        },
      ],
    };
    const options = {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => fmt(item.raw) + " (" + fmtM(item.raw) + ")",
          },
        },
      },
      scales: {
        x: {
          ticks: { color: c.text, callback: (v) => fmtM(v) },
          grid: { color: c.grid },
        },
        y: { ticks: { color: c.text }, grid: { display: false } },
      },
    };
    if (state.rateChart) {
      state.rateChart.data = data;
      state.rateChart.options = options;
      state.rateChart.update("none");
    } else {
      state.rateChart = new Chart(ctx, { type: "bar", data, options });
    }
  }

  /* ---------- Map ---------- */
  function metricValue(s) {
    if (!s) return null;
    if (state.mapMetric === "rate") return s.rate == null ? null : s.rate * 100;
    if (state.mapMetric === "vep") return s.vep2024;
    if (state.mapMetric === "registered") return s.registered2026;
    if (state.mapMetric === "gap") return s.vep2024 - s.registered2026;
    return null;
  }

  function colorForMetric(val) {
    if (val == null) return "#334155";
    if (state.mapMetric === "rate") {
      // 60% → 115%
      if (val > 100) return "#a78bfa";
      if (val >= 95) return "#34d399";
      if (val >= 90) return "#2dd4bf";
      if (val >= 85) return "#38bdf8";
      if (val >= 75) return "#fbbf24";
      return "#f87171";
    }
    // sequential for absolute metrics using filtered max
    const rows = state.filtered.length ? state.filtered : state.data.states;
    let max = 1;
    for (const s of rows) {
      const v = metricValue(s);
      if (v != null && v > max) max = v;
    }
    const t = Math.max(0, Math.min(1, val / max));
    // interpolate sky → violet
    const r = Math.round(56 + t * (167 - 56));
    const g = Math.round(189 + t * (139 - 189));
    const b = Math.round(248 + t * (250 - 248));
    return `rgb(${r},${g},${b})`;
  }

  function lookupState(feature) {
    const name = feature.properties && (feature.properties.name || feature.properties.NAME);
    if (!name) return null;
    return state.byName[name] || state.byName[name.toLowerCase()] || null;
  }

  function styleFeature(feature) {
    const s = lookupState(feature);
    const filtered =
      !s ||
      !state.filtered.length ||
      state.filtered.some((x) => x.abbr === s.abbr);
    const selected = state.selected && s && state.selected.abbr === s.abbr;
    const val = s ? metricValue(s) : null;
    return {
      fillColor: filtered ? colorForMetric(val) : "#1e293b",
      weight: selected ? 2.5 : 1,
      opacity: 1,
      color: selected ? "#f8fafc" : "#0f172a",
      fillOpacity: filtered ? 0.88 : 0.25,
    };
  }

  function onEachFeature(feature, layer) {
    layer.on({
      mouseover: (e) => {
        const ly = e.target;
        ly.setStyle({ weight: 2, color: "#e2e8f0", fillOpacity: 0.95 });
        ly.bringToFront();
      },
      mouseout: (e) => {
        if (state.geoLayer) state.geoLayer.resetStyle(e.target);
      },
      click: () => {
        const s = lookupState(feature);
        if (s) selectState(s);
      },
    });
    const s = lookupState(feature);
    if (s) {
      const gap = s.vep2024 - s.registered2026;
      layer.bindTooltip(
        `<strong>${s.state}</strong><br/>
         Rate: ${fmtPct(s.rate)}<br/>
         VEP: ${fmt(s.vep2024)}<br/>
         Reg: ${fmt(s.registered2026)}<br/>
         Gap: ${fmt(gap)}`,
        { sticky: true, className: "map-tooltip" }
      );
    } else {
      const name = feature.properties && feature.properties.name;
      layer.bindTooltip(name || "—", { sticky: true, className: "map-tooltip" });
    }
  }

  function colorMap() {
    if (!state.geoLayer) return;
    state.geoLayer.setStyle(styleFeature);
    if (el.mapMeta) {
      const labels = {
        rate: "Registration rate %",
        vep: "Eligible (VEP 2024)",
        registered: "Registered 2026",
        gap: "Gap (VEP − Reg)",
      };
      el.mapMeta.textContent = labels[state.mapMetric] || state.mapMetric;
    }
    updateMapLegend();
  }

  function updateMapLegend() {
    const box = document.getElementById("map-legend");
    if (!box) return;
    if (state.mapMetric === "rate") {
      box.innerHTML = `
        <span><i style="background:#f87171"></i>&lt;75%</span>
        <span><i style="background:#fbbf24"></i>75–85%</span>
        <span><i style="background:#38bdf8"></i>85–90%</span>
        <span><i style="background:#2dd4bf"></i>90–95%</span>
        <span><i style="background:#34d399"></i>95–100%</span>
        <span><i style="background:#a78bfa"></i>&gt;100%</span>
        <span><i style="background:#334155"></i>N/A</span>
      `;
    } else {
      box.innerHTML = `
        <span><i style="background:rgb(56,189,248)"></i>Lower</span>
        <span><i style="background:rgb(111,164,249)"></i>Mid</span>
        <span><i style="background:rgb(167,139,250)"></i>Higher</span>
      `;
    }
  }

  async function initMap() {
    if (typeof L === "undefined") {
      console.warn("Leaflet not loaded");
      return;
    }
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    state.map = L.map("map", {
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 8,
    }).setView([39.5, -98.35], 4);

    // Dark basemap (no key)
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(state.map);

    let geo;
    try {
      const res = await fetch(API_GEO);
      if (!res.ok) throw new Error("geo " + res.status);
      geo = await res.json();
    } catch (err) {
      // CDN fallback if API not up yet
      console.warn("API geo failed, trying CDN", err);
      const res = await fetch(
        "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
      );
      geo = await res.json();
    }
    state.geojson = geo;
    state.geoLayer = L.geoJSON(geo, {
      style: styleFeature,
      onEachFeature,
    }).addTo(state.map);

    try {
      state.map.fitBounds(state.geoLayer.getBounds(), { padding: [12, 12] });
    } catch {
      /* ignore */
    }
    colorMap();
    setTimeout(() => state.map && state.map.invalidateSize(), 200);
  }

  /* ---------- Data load / poll ---------- */
  async function fetchStates() {
    let res;
    try {
      res = await fetch(API_STATES, { cache: "no-store" });
      if (!res.ok) throw new Error("API " + res.status);
    } catch {
      res = await fetch(FALLBACK_JSON, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load state data");
    }
    return res.json();
  }

  async function fetchStatus() {
    try {
      const res = await fetch(API_STATUS, { cache: "no-store" });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function applyDataset(payload, opts) {
    const prevRev = state.revision;
    state.data = payload;
    indexByName(payload.states || []);
    const rev =
      (payload.meta && payload.meta.data_revision) ||
      (payload.pipeline && payload.pipeline.data_revision) ||
      null;
    state.revision = rev;
    updatePipelineUi(payload.pipeline || state.pipeline, payload.meta);
    applyFilters();
    if (opts && opts.notify && prevRev != null && rev != null && rev !== prevRev) {
      showToast(`Data refreshed · revision ${rev}`);
    }
  }

  async function loadOrPoll(notify) {
    try {
      const [data, status] = await Promise.all([fetchStates(), fetchStatus()]);
      if (status) {
        data.pipeline = data.pipeline || status;
        state.pipeline = status;
      }
      const rev =
        (data.meta && data.meta.data_revision) ||
        (status && status.data_revision);
      if (notify && state.revision != null && rev != null && rev === state.revision) {
        updatePipelineUi(status || data.pipeline, data.meta);
        return; // no change
      }
      applyDataset(data, { notify: !!notify });
    } catch (err) {
      console.error(err);
      if (!state.data) {
        showToast("Failed to load data: " + err.message);
      }
    }
  }

  async function triggerRefresh() {
    if (el.btnRefresh) el.btnRefresh.disabled = true;
    showToast("Running scrape pipeline…");
    try {
      const res = await fetch(API_REFRESH, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        showToast("Pipeline already running");
      } else if (!res.ok && !body.ok) {
        showToast("Refresh failed: " + (body.message || res.status));
      } else {
        const ch = body.status && body.status.changes;
        const n = ch ? ch.registered_updated : "?";
        showToast(`Pipeline finished · ${n} states updated`);
      }
      await loadOrPoll(true);
    } catch (err) {
      showToast("API not available — serve via backend (uvicorn)");
      console.error(err);
    } finally {
      if (el.btnRefresh) el.btnRefresh.disabled = false;
    }
  }

  function setSort(key) {
    if (state.sortKey === key) state.sortDir *= -1;
    else {
      state.sortKey = key;
      state.sortDir = key === "state" ? 1 : -1;
    }
    document.querySelectorAll("table.data thead th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === key);
    });
    if (el.sortSelect) el.sortSelect.value = key;
    applyFilters();
  }

  function exportCsv() {
    const headers = ["state", "abbr", "vep2024", "registered2026", "gap", "rate", "notes"];
    const lines = [headers.join(",")];
    for (const s of state.filtered) {
      const gap = (s.vep2024 || 0) - (s.registered2026 || 0);
      lines.push(
        [
          s.state,
          s.abbr,
          s.vep2024,
          s.registered2026,
          gap,
          s.rate == null ? "" : (s.rate * 100).toFixed(1) + "%",
          s.notes ? `"${String(s.notes).replace(/"/g, '""')}"` : "",
        ].join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vep-vs-registered-by-state.csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV exported for current filter.");
  }

  function wireUi() {
    el.search.addEventListener("input", applyFilters);
    el.filterRate.addEventListener("change", applyFilters);
    el.sortSelect.addEventListener("change", () => {
      state.sortKey = el.sortSelect.value;
      state.sortDir = state.sortKey === "state" ? 1 : -1;
      applyFilters();
    });

    document.querySelectorAll("table.data thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => setSort(th.dataset.sort));
    });

    document.querySelectorAll("[data-chart-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.chartMode = btn.dataset.chartMode;
        document.querySelectorAll("[data-chart-mode]").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderCharts();
      });
    });

    document.querySelectorAll("[data-map-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mapMetric = btn.dataset.mapMetric;
        document.querySelectorAll("[data-map-metric]").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        colorMap();
      });
    });

    document.getElementById("btn-export").addEventListener("click", exportCsv);
    document.getElementById("btn-reset").addEventListener("click", () => {
      el.search.value = "";
      el.filterRate.value = "all";
      state.sortKey = "state";
      state.sortDir = 1;
      state.selected = null;
      el.detail.classList.remove("open");
      applyFilters();
      showToast("Filters reset.");
    });

    document.getElementById("btn-close-detail")?.addEventListener("click", () => {
      el.detail.classList.remove("open");
      state.selected = null;
      renderTable();
      colorMap();
    });

    if (el.btnRefresh) {
      el.btnRefresh.addEventListener("click", triggerRefresh);
    }
  }

  async function init() {
    tickClock();
    setInterval(tickClock, 1000);
    wireUi();

    await loadOrPoll(false);
    await initMap();

    // Auto-refresh poll (pipeline writes new revision → UI updates)
    state.pollTimer = setInterval(() => loadOrPoll(true), POLL_MS);

    showToast("Dashboard live · map + pipeline auto-refresh every 20s");
  }

  init();
})();

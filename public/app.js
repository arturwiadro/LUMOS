const navButtons = document.querySelectorAll(".nav-btn");
const tabs = document.querySelectorAll(".tab");

let currentConfig = null;
let currentDeviceStatus = null;
let currentCycle = null;
let currentDashboard = null;
let currentHistoryRows = [];
let currentReportCycles = [];
let currentReportDetails = null;

let mapInstance = null;
let markerInstance = null;
let selectedReportCycleKey = null;

let refreshTimer = null;
const FAST_REFRESH_MS = 1000;
const SLOW_REFRESH_MS = 15000;
const HISTORY_PAGE_SIZE = 300;

navButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      navButtons.forEach((b) => b.classList.remove("active"));
      tabs.forEach((t) => t.classList.remove("active"));

      btn.classList.add("active");

      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) {
        targetTab.classList.add("active");
      }

      if (btn.dataset.tab === "mapTab" && mapInstance) {
        setTimeout(() => {
          mapInstance.invalidateSize();
        }, 200);
      }

      if (btn.dataset.tab === "data") {
        await loadHistory();
      }

      if (btn.dataset.tab === "report") {
        await loadReportCycles();
        await loadSelectedReportCycle();
      }
    } catch (error) {
      console.error("Błąd przełączania zakładki:", error);
    }
  });
});

function isAlarm(type) {
  return type === "alarm_brak_zalaczenia" || type === "alarm_brak_wylaczenia";
}

function formatValue(value, fallback = "—") {
  return value === undefined || value === null || value === "" ? fallback : value;
}

function formatSecondsToReadable(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return "—";
  }

  const raw = Number(seconds);
  const sign = raw < 0 ? "-" : "";
  const total = Math.abs(raw);

  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);

  if (minutes === 0) {
    return `${sign}${secs} s`;
  }

  return `${sign}${minutes} min ${secs.toString().padStart(2, "0")} s`;
}

function formatLuxValue(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) {
    return "—";
  }

  return `${Number(value).toFixed(2)} lx`;
}

function formatOffsetValue(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return "0 min";
  }

  if (num > 0) {
    return `+${num} min`;
  }

  return `${num} min`;
}

function mapWindowStatus(rawStatus) {
  switch (rawStatus) {
    case "okno_pomiarowe":
      return "W oknie pomiarowym";
    case "poza_oknem":
      return "Poza oknem";
    case "unknown":
      return "Brak aktualizacji";
    case null:
    case undefined:
    case "":
      return "Brak danych";
    default:
      return rawStatus;
  }
}

function buildQuery(params) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, value);
    }
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

function setText(id, value, fallback = "—") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value === undefined || value === null || value === "" ? fallback : value;
}

async function fetchJson(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Błąd ${res.status} dla ${url}`);
  }

  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Błąd ${res.status} dla ${url}`);
  }

  return res.json();
}

function getCurrentStatusState() {
  return currentDeviceStatus?.state ?? currentDashboard?.latest?.state ?? null;
}

function hasActiveAlarm() {
  return Boolean(currentDashboard?.alarm_status?.has_active_alarm);
}

function updateTopbar() {
  const latest = currentDashboard?.latest || null;
  const currentState = getCurrentStatusState();

  setText(
    "deviceId",
    currentDeviceStatus?.device_id ||
      currentCycle?.device_id ||
      latest?.device_id ||
      "SSO-1"
  );

  const statusEl = document.getElementById("currentStatus");
  if (!statusEl) return;

  statusEl.className = "status-badge";

  if (hasActiveAlarm()) {
    statusEl.textContent = "ALARM";
    statusEl.classList.add("status-alarm");
  } else if (currentState === 1) {
    statusEl.textContent = "ON";
    statusEl.classList.add("status-on");
  } else if (currentState === 0) {
    statusEl.textContent = "OFF";
    statusEl.classList.add("status-off");
  } else {
    statusEl.textContent = "—";
    statusEl.classList.add("status-off");
  }

  setText("workMode", currentDeviceStatus?.mode || currentConfig?.mode || "—");
  setText("windowStatus", mapWindowStatus(currentDeviceStatus?.window_status), "Brak danych");
}

function updateDashboardSection() {
  const latest = currentDashboard?.latest || null;
  const stats = currentDashboard?.stats || {};
  const alarms = currentDashboard?.alarms || [];

  setText("plannedOn", currentCycle?.planned_on || currentDeviceStatus?.planned_on);
  setText("plannedOff", currentCycle?.planned_off || currentDeviceStatus?.planned_off);

  setText("actualOn", currentCycle?.actual_on);
  setText("actualOff", currentCycle?.actual_off);

  setText("luxOn", formatLuxValue(currentCycle?.lux_on));
  setText("luxOff", formatLuxValue(currentCycle?.lux_off));

  setText("diffOn", formatSecondsToReadable(currentCycle?.diff_on_s));
  setText("diffOff", formatSecondsToReadable(currentCycle?.diff_off_s));

  setText("liveState", currentDeviceStatus?.state ?? latest?.state);
  setText("liveLux", formatLuxValue(currentDeviceStatus?.lux ?? latest?.lux));
  setText("liveTime", currentDeviceStatus?.timestamp_real || latest?.timestamp_real);

  setText("statTotal", stats.total ?? 0, "0");
  setText("statPomiar", stats.pomiar ?? 0, "0");
  setText("statOn", stats.zmiana_on ?? 0, "0");
  setText("statOff", stats.zmiana_off ?? 0, "0");
  setText("statAlarmOn", stats.alarm_brak_zalaczenia ?? 0, "0");
  setText("statAlarmOff", stats.alarm_brak_wylaczenia ?? 0, "0");

  const alarmsList = document.getElementById("alarmsList");
  if (!alarmsList) return;

  alarmsList.innerHTML = "";

  if (!alarms.length) {
    alarmsList.innerHTML = `<div class="alarm-item">Brak alarmów.</div>`;
    return;
  }

  alarms.forEach((alarm) => {
    const div = document.createElement("div");
    div.className = "alarm-item";
    div.innerHTML = `
      <div><strong>${formatValue(alarm.type)}</strong></div>
      <div>Czas: ${formatValue(alarm.timestamp_real)}</div>
      <div>Plan ON: ${formatValue(alarm.planned_on)}</div>
      <div>Plan OFF: ${formatValue(alarm.planned_off)}</div>
      <div>Stan: ${formatValue(alarm.state)}</div>
      <div>Różnica: ${formatSecondsToReadable(alarm.difference_s)}</div>
    `;
    alarmsList.appendChild(div);
  });
}

function renderHistoryTable() {
  const tbody = document.getElementById("dataTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  currentHistoryRows.forEach((row) => {
    const tr = document.createElement("tr");

    if (isAlarm(row.type)) {
      tr.classList.add("alarm-row");
    }

    tr.innerHTML = `
      <td>${formatValue(row.timestamp_real)}</td>
      <td>${formatValue(row.type)}</td>
      <td>${formatLuxValue(row.lux)}</td>
      <td>${formatValue(row.state)}</td>
      <td>${formatValue(row.planned_on)}</td>
      <td>${formatValue(row.planned_off)}</td>
      <td>${formatSecondsToReadable(row.difference_s)}</td>
    `;

    tbody.appendChild(tr);
  });

  if (!currentHistoryRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7">Brak danych dla wybranych filtrów.</td>`;
    tbody.appendChild(tr);
  }
}

function updateMapPanel() {
  const latest = currentDashboard?.latest || null;

  setText(
    "mapDeviceId",
    currentDeviceStatus?.device_id ||
      currentCycle?.device_id ||
      latest?.device_id ||
      "szafa_01"
  );

  setText("mapLat", currentConfig?.lat);
  setText("mapLon", currentConfig?.lon);
  setText("mapMode", currentDeviceStatus?.mode || currentConfig?.mode || "—");
  setText("mapState", currentDeviceStatus?.state ?? latest?.state);
  setText("mapLastRead", currentDeviceStatus?.timestamp_real || latest?.timestamp_real);
}

function updateOffsetPanel() {
  const offsetOnInput = document.getElementById("offsetOnMin");
  const offsetOffInput = document.getElementById("offsetOffMin");

  if (offsetOnInput) {
    offsetOnInput.value = currentConfig?.offset_on_min ?? 0;
  }

  if (offsetOffInput) {
    offsetOffInput.value = currentConfig?.offset_off_min ?? 0;
  }

  setText("currentOffsetOn", formatOffsetValue(currentConfig?.offset_on_min ?? 0));
  setText("currentOffsetOff", formatOffsetValue(currentConfig?.offset_off_min ?? 0));
}

function initOrUpdateMap() {
  if (!currentConfig) return;

  const lat = Number(currentConfig.lat);
  const lon = Number(currentConfig.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  if (!mapInstance) {
    mapInstance = L.map("map").setView([lat, lon], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(mapInstance);

    markerInstance = L.marker([lat, lon]).addTo(mapInstance);
    markerInstance.bindPopup("SSO / szafa").openPopup();
  } else {
    mapInstance.setView([lat, lon], 13);

    if (markerInstance) {
      markerInstance.setLatLng([lat, lon]);
    }
  }

  setTimeout(() => {
    mapInstance.invalidateSize();
  }, 200);
}

function getCurrentCycleKey() {
  if (!currentCycle?.planned_on || !currentCycle?.planned_off) return null;
  return `${currentCycle.planned_on}|${currentCycle.planned_off}`;
}

function updateReportCycleSelect() {
  const select = document.getElementById("reportCycleSelect");
  if (!select) return;

  const previousValue = selectedReportCycleKey;
  select.innerHTML = "";

  if (!currentReportCycles.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Brak danych";
    select.appendChild(option);
    selectedReportCycleKey = null;
    return;
  }

  currentReportCycles.forEach((cycle) => {
    const option = document.createElement("option");
    option.value = cycle.key;
    option.textContent = `${cycle.planned_on} → ${cycle.planned_off}`;
    select.appendChild(option);
  });

  const currentCycleKey = getCurrentCycleKey();
  const existsPrevious = currentReportCycles.some((cycle) => cycle.key === previousValue);
  const existsCurrent = currentReportCycles.some((cycle) => cycle.key === currentCycleKey);

  if (existsPrevious) {
    selectedReportCycleKey = previousValue;
  } else if (existsCurrent) {
    selectedReportCycleKey = currentCycleKey;
  } else {
    selectedReportCycleKey = currentReportCycles[0].key;
  }

  select.value = selectedReportCycleKey;
}

function setStatsBlock(prefix, stats) {
  setText(`${prefix}Min`, formatLuxValue(stats?.min));
  setText(`${prefix}Max`, formatLuxValue(stats?.max));
  setText(`${prefix}Avg`, formatLuxValue(stats?.avg));
  setText(`${prefix}Count`, stats?.count ?? 0, "0");
}

function setBarValue(fillId, valueId, value, maxValue) {
  const fillEl = document.getElementById(fillId);
  const valueEl = document.getElementById(valueId);

  if (!fillEl || !valueEl) return;

  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
    fillEl.style.width = "0%";
    valueEl.textContent = "—";
    return;
  }

  const width = Math.max(6, Math.round((value / maxValue) * 100));
  fillEl.style.width = `${Math.min(width, 100)}%`;
  valueEl.textContent = formatLuxValue(value);
}

function updateReportSection() {
  const report = currentReportDetails;

  if (!report) {
    setText("reportPlannedOn", "—");
    setText("reportPlannedOff", "—");
    setText("reportActualOn", "—");
    setText("reportActualOff", "—");
    setText("reportDiffOn", "—");
    setText("reportDiffOff", "—");
    setText("reportLuxOn", "—");
    setText("reportLuxOff", "—");

    setStatsBlock("beforeOn", { min: null, max: null, avg: null, count: 0 });
    setStatsBlock("afterOn", { min: null, max: null, avg: null, count: 0 });
    setStatsBlock("beforeOff", { min: null, max: null, avg: null, count: 0 });
    setStatsBlock("afterOff", { min: null, max: null, avg: null, count: 0 });

    setBarValue("chartBeforeOn", "chartBeforeOnValue", null, null);
    setBarValue("chartAfterOn", "chartAfterOnValue", null, null);
    setBarValue("chartBeforeOff", "chartBeforeOffValue", null, null);
    setBarValue("chartAfterOff", "chartAfterOffValue", null, null);
    return;
  }

  const summary = report.summary || {};
  const analytics = report.analytics || {};

  setText("reportPlannedOn", summary.planned_on);
  setText("reportPlannedOff", summary.planned_off);
  setText("reportActualOn", summary.actual_on);
  setText("reportActualOff", summary.actual_off);
  setText("reportDiffOn", formatSecondsToReadable(summary.diff_on_s));
  setText("reportDiffOff", formatSecondsToReadable(summary.diff_off_s));
  setText("reportLuxOn", formatLuxValue(summary.lux_on));
  setText("reportLuxOff", formatLuxValue(summary.lux_off));

  setStatsBlock("beforeOn", analytics.before_on);
  setStatsBlock("afterOn", analytics.after_on);
  setStatsBlock("beforeOff", analytics.before_off);
  setStatsBlock("afterOff", analytics.after_off);

  const maxOnAvg = Math.max(
    Number(analytics.before_on?.avg) || 0,
    Number(analytics.after_on?.avg) || 0
  );

  const maxOffAvg = Math.max(
    Number(analytics.before_off?.avg) || 0,
    Number(analytics.after_off?.avg) || 0
  );

  setBarValue("chartBeforeOn", "chartBeforeOnValue", Number(analytics.before_on?.avg), maxOnAvg);
  setBarValue("chartAfterOn", "chartAfterOnValue", Number(analytics.after_on?.avg), maxOnAvg);
  setBarValue("chartBeforeOff", "chartBeforeOffValue", Number(analytics.before_off?.avg), maxOffAvg);
  setBarValue("chartAfterOff", "chartAfterOffValue", Number(analytics.after_off?.avg), maxOffAvg);
}

async function loadConfig() {
  try {
    currentConfig = await fetchJson("/api/config");

    const configLat = document.getElementById("configLat");
    const configLon = document.getElementById("configLon");
    const configMode = document.getElementById("configMode");
    const manualOn = document.getElementById("manualOn");
    const manualOff = document.getElementById("manualOff");

    if (configLat) configLat.value = currentConfig?.lat ?? "";
    if (configLon) configLon.value = currentConfig?.lon ?? "";
    if (configMode) configMode.value = currentConfig?.mode ?? "AUTO";
    if (manualOn) manualOn.value = currentConfig?.manual_on ?? "19:50";
    if (manualOff) manualOff.value = currentConfig?.manual_off ?? "05:00";

    updateOffsetPanel();

    setText("locationStatus", `Aktualna lokalizacja: ${currentConfig?.lat}, ${currentConfig?.lon}`);
    setText("modeStatus", `Aktualny tryb: ${currentConfig?.mode}`);

    updateMapPanel();
    initOrUpdateMap();
  } catch (error) {
    console.error("Błąd loadConfig:", error);
  }
}

async function loadDashboard() {
  try {
    currentDashboard = await fetchJson("/api/dashboard");
    currentDeviceStatus = currentDashboard?.device_status || null;
    currentCycle = currentDashboard?.current_cycle || null;

    updateTopbar();
    updateDashboardSection();
    updateMapPanel();
  } catch (error) {
    console.error("Błąd loadDashboard:", error);
  }
}

async function loadHistory() {
  try {
    const typeFilterEl = document.getElementById("typeFilter");
    const onlyAlarmsEl = document.getElementById("onlyAlarms");

    const typeFilter = typeFilterEl ? typeFilterEl.value : "all";
    const onlyAlarms = onlyAlarmsEl ? onlyAlarmsEl.checked : false;

    const query = buildQuery({
      type: typeFilter === "all" ? "" : typeFilter,
      only_alarms: onlyAlarms ? "true" : "",
      limit: HISTORY_PAGE_SIZE,
      offset: 0
    });

    const response = await fetchJson(`/api/history${query}`);
    currentHistoryRows = response.rows || [];
    renderHistoryTable();
  } catch (error) {
    console.error("Błąd loadHistory:", error);
    currentHistoryRows = [];
    renderHistoryTable();
  }
}

async function loadReportCycles() {
  try {
    const response = await fetchJson("/api/report-cycles?limit=200");
    currentReportCycles = response.rows || [];
    updateReportCycleSelect();
  } catch (error) {
    console.error("Błąd loadReportCycles:", error);
    currentReportCycles = [];
    updateReportCycleSelect();
  }
}

async function loadSelectedReportCycle() {
  try {
    if (!selectedReportCycleKey) {
      currentReportDetails = null;
      updateReportSection();
      return;
    }

    const query = buildQuery({
      cycle_key: selectedReportCycleKey
    });

    currentReportDetails = await fetchJson(`/api/report-cycle${query}`);
    updateReportSection();
  } catch (error) {
    console.error("Błąd loadSelectedReportCycle:", error);
    currentReportDetails = null;
    updateReportSection();
  }
}

function updateRealtimeClock() {
  const now = new Date();

  const formatted = now.toLocaleString("pl-PL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const clockEl = document.getElementById("realtimeClock");
  if (clockEl) {
    clockEl.textContent = formatted;
  }
}

function getRefreshIntervalMs() {
  return currentDeviceStatus?.window_status === "okno_pomiarowe"
    ? FAST_REFRESH_MS
    : SLOW_REFRESH_MS;
}

function scheduleAdaptiveRefresh() {
  const nextMs = getRefreshIntervalMs();

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(async () => {
    try {
      await loadDashboard();

      const activeTab = document.querySelector(".tab.active")?.id || "dashboard";

      if (activeTab === "data") {
        await loadHistory();
      }

      if (activeTab === "report") {
        await loadReportCycles();
        await loadSelectedReportCycle();
      }
    } catch (error) {
      console.error("Błąd adaptive refresh:", error);
    } finally {
      scheduleAdaptiveRefresh();
    }
  }, nextMs);
}

const typeFilterEl = document.getElementById("typeFilter");
if (typeFilterEl) {
  typeFilterEl.addEventListener("change", async () => {
    await loadHistory();
  });
}

const onlyAlarmsEl = document.getElementById("onlyAlarms");
if (onlyAlarmsEl) {
  onlyAlarmsEl.addEventListener("change", async () => {
    await loadHistory();
  });
}

const reportCycleSelectEl = document.getElementById("reportCycleSelect");
if (reportCycleSelectEl) {
  reportCycleSelectEl.addEventListener("change", async (event) => {
    selectedReportCycleKey = event.target.value || null;
    await loadSelectedReportCycle();
  });
}

const checkBtnEl = document.getElementById("checkBtn");
if (checkBtnEl) {
  checkBtnEl.addEventListener("click", async () => {
    try {
      const result = await fetchJson("/api/check-status");

      if (result.latest) {
        alert(
          `Ostatni znany stan:\nStan: ${result.latest.state}\nLux: ${result.latest.lux}\nCzas: ${result.latest.timestamp_real}`
        );
      } else {
        alert("Brak danych do sprawdzenia.");
      }
    } catch (error) {
      console.error(error);
      alert("Nie udało się pobrać statusu.");
    }
  });
}

const saveLocationBtnEl = document.getElementById("saveLocationBtn");
if (saveLocationBtnEl) {
  saveLocationBtnEl.addEventListener("click", async () => {
    try {
      const lat = parseFloat(document.getElementById("configLat").value);
      const lon = parseFloat(document.getElementById("configLon").value);

      await postJson("/api/config", { lat, lon });
      await loadConfig();
      await loadDashboard();

      alert("Zapisano lokalizację.");
    } catch (error) {
      console.error(error);
      alert("Nie udało się zapisać lokalizacji.");
    }
  });
}

const saveModeBtnEl = document.getElementById("saveModeBtn");
if (saveModeBtnEl) {
  saveModeBtnEl.addEventListener("click", async () => {
    try {
      const mode = document.getElementById("configMode").value;

      await postJson("/api/config", { mode });
      await loadConfig();
      await loadDashboard();

      alert("Zapisano tryb pracy.");
    } catch (error) {
      console.error(error);
      alert("Nie udało się zapisać trybu.");
    }
  });
}

const saveManualPlanBtnEl = document.getElementById("saveManualPlanBtn");
if (saveManualPlanBtnEl) {
  saveManualPlanBtnEl.addEventListener("click", async () => {
    try {
      const manual_on = document.getElementById("manualOn").value;
      const manual_off = document.getElementById("manualOff").value;

      await postJson("/api/config", { manual_on, manual_off });
      await loadConfig();
      await loadDashboard();

      alert("Zapisano plan ręczny.");
    } catch (error) {
      console.error(error);
      alert("Nie udało się zapisać planu ręcznego.");
    }
  });
}

const saveOffsetsBtnEl = document.getElementById("saveOffsetsBtn");
if (saveOffsetsBtnEl) {
  saveOffsetsBtnEl.addEventListener("click", async () => {
    try {
      const offsetOnInput = document.getElementById("offsetOnMin");
      const offsetOffInput = document.getElementById("offsetOffMin");

      const offset_on_min = Number.parseInt(offsetOnInput?.value ?? "0", 10);
      const offset_off_min = Number.parseInt(offsetOffInput?.value ?? "0", 10);

      if (!Number.isInteger(offset_on_min) || !Number.isInteger(offset_off_min)) {
        alert("Korekta musi być liczbą całkowitą w minutach.");
        return;
      }

      await postJson("/api/config", {
        offset_on_min,
        offset_off_min
      });

      await loadConfig();
      await loadDashboard();

      setText(
        "offsetStatus",
        `Zapisano korekty: ON ${formatOffsetValue(offset_on_min)}, OFF ${formatOffsetValue(offset_off_min)}`
      );

      alert("Zapisano korekty czasu.");
    } catch (error) {
      console.error(error);
      alert("Nie udało się zapisać korekt czasu.");
    }
  });
}

const forceOnBtnEl = document.getElementById("forceOnBtn");
if (forceOnBtnEl) {
  forceOnBtnEl.addEventListener("click", async () => {
    try {
      const result = await postJson("/api/force", { state: 1 });

      setText("forceStatus", `Status testu: dodano rekord ${result.entry.type} / stan 1`);

      await loadDashboard();
      await loadHistory();
      await loadReportCycles();
      await loadSelectedReportCycle();
    } catch (error) {
      console.error(error);
      alert("Nie udało się wymusić ON.");
    }
  });
}

const forceOffBtnEl = document.getElementById("forceOffBtn");
if (forceOffBtnEl) {
  forceOffBtnEl.addEventListener("click", async () => {
    try {
      const result = await postJson("/api/force", { state: 0 });

      setText("forceStatus", `Status testu: dodano rekord ${result.entry.type} / stan 0`);

      await loadDashboard();
      await loadHistory();
      await loadReportCycles();
      await loadSelectedReportCycle();
    } catch (error) {
      console.error(error);
      alert("Nie udało się wymusić OFF.");
    }
  });
}

async function initApp() {
  updateRealtimeClock();

  await loadConfig();
  await loadDashboard();
  await loadReportCycles();
  await loadSelectedReportCycle();
  await loadHistory();

  scheduleAdaptiveRefresh();
}

initApp().catch((error) => {
  console.error("Błąd initApp:", error);
});

setInterval(() => {
  updateRealtimeClock();
}, 1000);

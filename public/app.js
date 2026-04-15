const navButtons = document.querySelectorAll(".nav-btn");
const tabs = document.querySelectorAll(".tab");

let allData = [];
let currentConfig = null;
let currentDeviceStatus = null;
let currentCycle = null;
let mapInstance = null;
let markerInstance = null;
let selectedReportCycleKey = null;

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    navButtons.forEach((b) => b.classList.remove("active"));
    tabs.forEach((t) => t.classList.remove("active"));

    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "mapTab" && mapInstance) {
      setTimeout(() => {
        mapInstance.invalidateSize();
      }, 200);
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

  const numericSeconds = Math.abs(Number(seconds));
  const h = Math.floor(numericSeconds / 3600);
  const m = Math.floor((numericSeconds % 3600) / 60);
  const s = Math.floor(numericSeconds % 60);

  if (h > 0) {
    return `${h} h ${m.toString().padStart(2, "0")} min ${s.toString().padStart(2, "0")} s`;
  }

  if (m > 0) {
    return `${m} min ${s.toString().padStart(2, "0")} s`;
  }

  return `${s} s`;
}

function formatLuxValue(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) {
    return "—";
  }

  return `${Number(value).toFixed(2)} lx`;
}

function parseDateTime(value) {
  if (typeof value !== "string") return null;

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  const parsed = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function getLatestPlannedValue(fieldName) {
  if (!Array.isArray(allData) || !allData.length) return null;

  for (let i = allData.length - 1; i >= 0; i -= 1) {
    const value = allData[i]?.[fieldName];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
}

function getResolvedPlannedOn() {
  return (
    currentCycle?.planned_on ||
    currentDeviceStatus?.planned_on ||
    getLatestPlannedValue("planned_on") ||
    null
  );
}

function getResolvedPlannedOff() {
  return (
    currentCycle?.planned_off ||
    currentDeviceStatus?.planned_off ||
    getLatestPlannedValue("planned_off") ||
    null
  );
}

function getResolvedLiveTimestamp(latest) {
  return currentDeviceStatus?.timestamp_real || latest?.timestamp_real || null;
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

function getCycleKeyFromRow(row) {
  if (!row?.planned_on || !row?.planned_off) return null;
  return `${row.planned_on}|${row.planned_off}`;
}

function buildCycleMapFromData() {
  const cycleMap = new Map();

  allData.forEach((row) => {
    const cycleKey = getCycleKeyFromRow(row);
    if (!cycleKey) return;

    if (!cycleMap.has(cycleKey)) {
      cycleMap.set(cycleKey, {
        key: cycleKey,
        planned_on: row.planned_on,
        planned_off: row.planned_off,
        rows: []
      });
    }

    cycleMap.get(cycleKey).rows.push(row);
  });

  const cycles = Array.from(cycleMap.values());

  cycles.sort((a, b) => {
    const dateA = parseDateTime(a.planned_on);
    const dateB = parseDateTime(b.planned_on);

    if (dateA && dateB) {
      return dateB.getTime() - dateA.getTime();
    }

    return String(b.planned_on).localeCompare(String(a.planned_on));
  });

  return cycles;
}

function getSelectedReportCycle() {
  const cycles = buildCycleMapFromData();
  if (!cycles.length) return null;

  if (selectedReportCycleKey) {
    const selected = cycles.find((cycle) => cycle.key === selectedReportCycleKey);
    if (selected) return selected;
  }

  return cycles[0];
}

function calculateLuxStats(rows) {
  const numericLux = rows
    .map((row) => Number(row.lux))
    .filter((value) => Number.isFinite(value));

  if (!numericLux.length) {
    return {
      min: null,
      max: null,
      avg: null,
      count: 0
    };
  }

  const min = Math.min(...numericLux);
  const max = Math.max(...numericLux);
  const avg = numericLux.reduce((sum, value) => sum + value, 0) / numericLux.length;

  return {
    min,
    max,
    avg,
    count: numericLux.length
  };
}

function setStatsBlock(prefix, stats) {
  document.getElementById(`${prefix}Min`).textContent = formatLuxValue(stats.min);
  document.getElementById(`${prefix}Max`).textContent = formatLuxValue(stats.max);
  document.getElementById(`${prefix}Avg`).textContent = formatLuxValue(stats.avg);
  document.getElementById(`${prefix}Count`).textContent = stats.count ?? 0;
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

function updateReportCycleSelect() {
  const select = document.getElementById("reportCycleSelect");
  const cycles = buildCycleMapFromData();

  const previousValue = selectedReportCycleKey;
  select.innerHTML = "";

  if (!cycles.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Brak danych";
    select.appendChild(option);
    selectedReportCycleKey = null;
    return;
  }

  cycles.forEach((cycle) => {
    const option = document.createElement("option");
    option.value = cycle.key;
    option.textContent = `${cycle.planned_on} → ${cycle.planned_off}`;
    select.appendChild(option);
  });

  const exists = cycles.some((cycle) => cycle.key === previousValue);
  selectedReportCycleKey = exists ? previousValue : cycles[0].key;
  select.value = selectedReportCycleKey;
}

function updateReportAnalytics() {
  updateReportCycleSelect();

  const selectedCycle = getSelectedReportCycle();

  if (!selectedCycle) {
    document.getElementById("reportPlannedOn").textContent = "—";
    document.getElementById("reportPlannedOff").textContent = "—";
    document.getElementById("reportActualOn").textContent = "—";
    document.getElementById("reportActualOff").textContent = "—";
    document.getElementById("reportDiffOn").textContent = "—";
    document.getElementById("reportDiffOff").textContent = "—";
    document.getElementById("reportLuxOn").textContent = "—";
    document.getElementById("reportLuxOff").textContent = "—";

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

  const plannedOn = parseDateTime(selectedCycle.planned_on);
  const plannedOff = parseDateTime(selectedCycle.planned_off);

  const cycleRows = selectedCycle.rows
    .slice()
    .sort((a, b) => {
      const da = parseDateTime(a.timestamp_real);
      const db = parseDateTime(b.timestamp_real);

      if (da && db) return da.getTime() - db.getTime();
      return 0;
    });

  const actualOnRow = cycleRows.find(
    (row) => row.type === "zmiana_on" && row.planned_on === selectedCycle.planned_on
  ) || cycleRows.find((row) => row.type === "zmiana_on");

  const actualOffRow = cycleRows.find(
    (row) => row.type === "zmiana_off" && row.planned_off === selectedCycle.planned_off
  ) || cycleRows.find((row) => row.type === "zmiana_off");

  document.getElementById("reportPlannedOn").textContent = formatValue(selectedCycle.planned_on);
  document.getElementById("reportPlannedOff").textContent = formatValue(selectedCycle.planned_off);
  document.getElementById("reportActualOn").textContent = formatValue(actualOnRow?.timestamp_real);
  document.getElementById("reportActualOff").textContent = formatValue(actualOffRow?.timestamp_real);
  document.getElementById("reportDiffOn").textContent = formatSecondsToReadable(actualOnRow?.difference_s);
  document.getElementById("reportDiffOff").textContent = formatSecondsToReadable(actualOffRow?.difference_s);
  document.getElementById("reportLuxOn").textContent = formatValue(actualOnRow?.lux);
  document.getElementById("reportLuxOff").textContent = formatValue(actualOffRow?.lux);

  const beforeOnRows = plannedOn
    ? cycleRows.filter((row) => {
        const rowDate = parseDateTime(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= addHours(plannedOn, -1) && rowDate <= plannedOn;
      })
    : [];

  const afterOnRows = plannedOn
    ? cycleRows.filter((row) => {
        const rowDate = parseDateTime(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= plannedOn && rowDate <= addHours(plannedOn, 1);
      })
    : [];

  const beforeOffRows = plannedOff
    ? cycleRows.filter((row) => {
        const rowDate = parseDateTime(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= addHours(plannedOff, -1) && rowDate <= plannedOff;
      })
    : [];

  const afterOffRows = plannedOff
    ? cycleRows.filter((row) => {
        const rowDate = parseDateTime(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= plannedOff && rowDate <= addHours(plannedOff, 1);
      })
    : [];

  const beforeOnStats = calculateLuxStats(beforeOnRows);
  const afterOnStats = calculateLuxStats(afterOnRows);
  const beforeOffStats = calculateLuxStats(beforeOffRows);
  const afterOffStats = calculateLuxStats(afterOffRows);

  setStatsBlock("beforeOn", beforeOnStats);
  setStatsBlock("afterOn", afterOnStats);
  setStatsBlock("beforeOff", beforeOffStats);
  setStatsBlock("afterOff", afterOffStats);

  const maxOnAvg = Math.max(beforeOnStats.avg || 0, afterOnStats.avg || 0);
  const maxOffAvg = Math.max(beforeOffStats.avg || 0, afterOffStats.avg || 0);

  setBarValue("chartBeforeOn", "chartBeforeOnValue", beforeOnStats.avg, maxOnAvg);
  setBarValue("chartAfterOn", "chartAfterOnValue", afterOnStats.avg, maxOnAvg);
  setBarValue("chartBeforeOff", "chartBeforeOffValue", beforeOffStats.avg, maxOffAvg);
  setBarValue("chartAfterOff", "chartAfterOffValue", afterOffStats.avg, maxOffAvg);
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

function updateDashboard(latest, stats, alarms) {
  const resolvedTimestamp = getResolvedLiveTimestamp(latest);
  const resolvedPlannedOn = getResolvedPlannedOn();
  const resolvedPlannedOff = getResolvedPlannedOff();

  document.getElementById("deviceId").textContent =
    currentDeviceStatus?.device_id ||
    currentCycle?.device_id ||
    latest?.device_id ||
    "SSO-1";

  document.getElementById("liveState").textContent =
    formatValue(currentDeviceStatus?.state ?? latest?.state);

  document.getElementById("liveLux").textContent =
    formatValue(currentDeviceStatus?.lux ?? latest?.lux);

  document.getElementById("liveTime").textContent =
    formatValue(resolvedTimestamp);

  const statusEl = document.getElementById("currentStatus");
  statusEl.className = "status-badge";

  const currentState = currentDeviceStatus?.state ?? latest?.state ?? null;

  if (latest && isAlarm(latest.type)) {
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

  document.getElementById("workMode").textContent =
    currentDeviceStatus?.mode ||
    currentConfig?.mode ||
    "—";

  document.getElementById("windowStatus").textContent =
    mapWindowStatus(currentDeviceStatus?.window_status);

  document.getElementById("plannedOn").textContent =
    formatValue(resolvedPlannedOn);

  document.getElementById("plannedOff").textContent =
    formatValue(resolvedPlannedOff);

  document.getElementById("actualOn").textContent =
    formatValue(currentCycle?.actual_on);

  document.getElementById("actualOff").textContent =
    formatValue(currentCycle?.actual_off);

  document.getElementById("luxOn").textContent =
    formatValue(currentCycle?.lux_on);

  document.getElementById("luxOff").textContent =
    formatValue(currentCycle?.lux_off);

  document.getElementById("diffOn").textContent =
    formatSecondsToReadable(currentCycle?.diff_on_s);

  document.getElementById("diffOff").textContent =
    formatSecondsToReadable(currentCycle?.diff_off_s);

  document.getElementById("statTotal").textContent = stats?.total ?? 0;
  document.getElementById("statPomiar").textContent = stats?.pomiar ?? 0;
  document.getElementById("statOn").textContent = stats?.zmiana_on ?? 0;
  document.getElementById("statOff").textContent = stats?.zmiana_off ?? 0;
  document.getElementById("statAlarmOn").textContent = stats?.alarm_brak_zalaczenia ?? 0;
  document.getElementById("statAlarmOff").textContent = stats?.alarm_brak_wylaczenia ?? 0;

  const alarmsList = document.getElementById("alarmsList");
  alarmsList.innerHTML = "";

  if (!alarms?.length) {
    alarmsList.innerHTML = `<div class="alarm-item">Brak alarmów.</div>`;
  } else {
    alarms
      .slice(-10)
      .reverse()
      .forEach((alarm) => {
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
}

function renderTable() {
  const tbody = document.getElementById("dataTableBody");
  const typeFilter = document.getElementById("typeFilter").value;
  const onlyAlarms = document.getElementById("onlyAlarms").checked;

  let filtered = [...allData].reverse();

  if (typeFilter !== "all") {
    filtered = filtered.filter((item) => item.type === typeFilter);
  }

  if (onlyAlarms) {
    filtered = filtered.filter((item) => isAlarm(item.type));
  }

  tbody.innerHTML = "";

  filtered.forEach((row) => {
    const tr = document.createElement("tr");

    if (isAlarm(row.type)) {
      tr.classList.add("alarm-row");
    }

    tr.innerHTML = `
      <td>${formatValue(row.timestamp_real)}</td>
      <td>${formatValue(row.type)}</td>
      <td>${formatValue(row.lux)}</td>
      <td>${formatValue(row.state)}</td>
      <td>${formatValue(row.planned_on)}</td>
      <td>${formatValue(row.planned_off)}</td>
      <td>${formatSecondsToReadable(row.difference_s)}</td>
    `;

    tbody.appendChild(tr);
  });
}

function updateMapPanel() {
  const latest = allData.length ? allData[allData.length - 1] : null;

  document.getElementById("mapDeviceId").textContent =
    currentDeviceStatus?.device_id ||
    currentCycle?.device_id ||
    latest?.device_id ||
    "szafa_01";

  document.getElementById("mapLat").textContent =
    currentConfig?.lat ?? "—";

  document.getElementById("mapLon").textContent =
    currentConfig?.lon ?? "—";

  document.getElementById("mapMode").textContent =
    currentDeviceStatus?.mode ||
    currentConfig?.mode ||
    "—";

  document.getElementById("mapState").textContent =
    formatValue(currentDeviceStatus?.state ?? latest?.state);

  document.getElementById("mapLastRead").textContent =
    formatValue(getResolvedLiveTimestamp(latest));
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
    markerInstance.bindPopup("SSO / szafa_01").openPopup();
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

async function loadConfig() {
  try {
    currentConfig = await fetchJson("/api/config");

    document.getElementById("configLat").value = currentConfig?.lat ?? "";
    document.getElementById("configLon").value = currentConfig?.lon ?? "";
    document.getElementById("configMode").value = currentConfig?.mode ?? "AUTO";
    document.getElementById("manualOn").value = currentConfig?.manual_on ?? "19:50";
    document.getElementById("manualOff").value = currentConfig?.manual_off ?? "05:00";

    document.getElementById("locationStatus").textContent =
      `Aktualna lokalizacja: ${currentConfig?.lat}, ${currentConfig?.lon}`;

    document.getElementById("modeStatus").textContent =
      `Aktualny tryb: ${currentConfig?.mode}`;

    updateMapPanel();
    initOrUpdateMap();
  } catch (error) {
    console.error("Błąd loadConfig:", error);
  }
}

async function loadDeviceStatus() {
  try {
    currentDeviceStatus = await fetchJson("/api/device-status");
  } catch (error) {
    console.error("Błąd loadDeviceStatus:", error);
  }
}

async function loadCurrentCycle() {
  try {
    currentCycle = await fetchJson("/api/current-cycle");
  } catch (error) {
    console.error("Błąd loadCurrentCycle:", error);
  }
}

async function loadData() {
  try {
    const [data, latest, alarms, stats] = await Promise.all([
      fetchJson("/api/data"),
      fetchJson("/api/data/latest").catch(() => null),
      fetchJson("/api/alarms"),
      fetchJson("/api/stats")
    ]);

    allData = data;
    updateDashboard(latest, stats, alarms);
    renderTable();
    updateMapPanel();
    updateReportAnalytics();
  } catch (error) {
    console.error("Błąd loadData:", error);
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

document.getElementById("typeFilter").addEventListener("change", renderTable);
document.getElementById("onlyAlarms").addEventListener("change", renderTable);

document.getElementById("reportCycleSelect").addEventListener("change", (event) => {
  selectedReportCycleKey = event.target.value || null;
  updateReportAnalytics();
});

document.getElementById("checkBtn").addEventListener("click", async () => {
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

document.getElementById("saveLocationBtn").addEventListener("click", async () => {
  try {
    const lat = parseFloat(document.getElementById("configLat").value);
    const lon = parseFloat(document.getElementById("configLon").value);

    await postJson("/api/config", { lat, lon });
    await loadConfig();
    await loadDeviceStatus();
    await loadCurrentCycle();
    await loadData();

    alert("Zapisano lokalizację.");
  } catch (error) {
    console.error(error);
    alert("Nie udało się zapisać lokalizacji.");
  }
});

document.getElementById("saveModeBtn").addEventListener("click", async () => {
  try {
    const mode = document.getElementById("configMode").value;

    await postJson("/api/config", { mode });
    await loadConfig();
    await loadDeviceStatus();
    await loadCurrentCycle();
    await loadData();

    alert("Zapisano tryb pracy.");
  } catch (error) {
    console.error(error);
    alert("Nie udało się zapisać trybu.");
  }
});

document.getElementById("saveManualPlanBtn").addEventListener("click", async () => {
  try {
    const manual_on = document.getElementById("manualOn").value;
    const manual_off = document.getElementById("manualOff").value;

    await postJson("/api/config", { manual_on, manual_off });
    await loadConfig();
    await loadDeviceStatus();
    await loadCurrentCycle();
    await loadData();

    alert("Zapisano plan ręczny.");
  } catch (error) {
    console.error(error);
    alert("Nie udało się zapisać planu ręcznego.");
  }
});

document.getElementById("forceOnBtn").addEventListener("click", async () => {
  try {
    const result = await postJson("/api/force", { state: 1 });

    document.getElementById("forceStatus").textContent =
      `Status testu: dodano rekord ${result.entry.type} / stan 1`;

    await loadDeviceStatus();
    await loadCurrentCycle();
    await loadData();
  } catch (error) {
    console.error(error);
    alert("Nie udało się wymusić ON.");
  }
});

document.getElementById("forceOffBtn").addEventListener("click", async () => {
  try {
    const result = await postJson("/api/force", { state: 0 });

    document.getElementById("forceStatus").textContent =
      `Status testu: dodano rekord ${result.entry.type} / stan 0`;

    await loadDeviceStatus();
    await loadCurrentCycle();
    await loadData();
  } catch (error) {
    console.error(error);
    alert("Nie udało się wymusić OFF.");
  }
});

async function initApp() {
  updateRealtimeClock();
  await loadConfig();
  await loadDeviceStatus();
  await loadCurrentCycle();
  await loadData();
}

initApp();

setInterval(async () => {
  await loadDeviceStatus();
  await loadCurrentCycle();
  await loadData();
}, 5000);

setInterval(() => {
  updateRealtimeClock();
}, 1000);

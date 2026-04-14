const navButtons = document.querySelectorAll(".nav-btn");
const tabs = document.querySelectorAll(".tab");

let allData = [];
let currentConfig = null;
let currentDeviceStatus = null;
let currentCycle = null;
let mapInstance = null;
let markerInstance = null;

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

// 🔥 NOWA FUNKCJA
function formatSecondsToReadable(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "—";

  seconds = Math.abs(Number(seconds));

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h} h ${m.toString().padStart(2, "0")} min ${s.toString().padStart(2, "0")} s`;
  if (m > 0) return `${m} min ${s.toString().padStart(2, "0")} s`;

  return `${s} s`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Błąd ${res.status} dla ${url}`);
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

  if (!res.ok) throw new Error(`Błąd ${res.status} dla ${url}`);
  return res.json();
}

function updateDashboard(latest, stats, alarms) {
  document.getElementById("deviceId").textContent =
    currentDeviceStatus?.device_id ||
    currentCycle?.device_id ||
    latest?.device_id ||
    "SSO-1";

  document.getElementById("lastTimestamp").textContent =
    currentDeviceStatus?.timestamp_real ||
    latest?.timestamp_real ||
    "—";

  document.getElementById("liveState").textContent =
    currentDeviceStatus?.state ?? latest?.state ?? "—";

  document.getElementById("liveLux").textContent =
    currentDeviceStatus?.lux ?? latest?.lux ?? "—";

  document.getElementById("liveTime").textContent =
    currentDeviceStatus?.timestamp_real ||
    latest?.timestamp_real ||
    "—";

  const statusEl = document.getElementById("currentStatus");
  statusEl.className = "status-badge";

  const currentState = currentDeviceStatus?.state ?? latest?.state ?? null;

  if (latest && isAlarm(latest.type)) {
    statusEl.textContent = "ALARM";
    statusEl.classList.add("status-alarm");
  } else if (currentState === 1) {
    statusEl.textContent = "ON";
    statusEl.classList.add("status-on");
  } else {
    statusEl.textContent = "OFF";
    statusEl.classList.add("status-off");
  }

  document.getElementById("workMode").textContent =
    currentDeviceStatus?.mode ||
    currentConfig?.mode ||
    "—";

  document.getElementById("windowStatus").textContent =
    currentDeviceStatus?.window_status || "—";

  document.getElementById("plannedOn").textContent =
    currentCycle?.planned_on ||
    currentDeviceStatus?.planned_on ||
    "—";

  document.getElementById("plannedOff").textContent =
    currentCycle?.planned_off ||
    currentDeviceStatus?.planned_off ||
    "—";

  document.getElementById("actualOn").textContent =
    currentCycle?.actual_on || "—";

  document.getElementById("actualOff").textContent =
    currentCycle?.actual_off || "—";

  document.getElementById("luxOn").textContent =
    formatValue(currentCycle?.lux_on);

  document.getElementById("luxOff").textContent =
    formatValue(currentCycle?.lux_off);

  // 🔥 ZMIANA
  document.getElementById("diffOn").textContent =
    formatSecondsToReadable(currentCycle?.diff_on_s);

  document.getElementById("diffOff").textContent =
    formatSecondsToReadable(currentCycle?.diff_off_s);

  document.getElementById("reportPlannedOn").textContent =
    currentCycle?.planned_on ||
    currentDeviceStatus?.planned_on ||
    "—";

  document.getElementById("reportPlannedOff").textContent =
    currentCycle?.planned_off ||
    currentDeviceStatus?.planned_off ||
    "—";

  document.getElementById("reportActualOn").textContent =
    currentCycle?.actual_on || "—";

  document.getElementById("reportActualOff").textContent =
    currentCycle?.actual_off || "—";

  // 🔥 ZMIANA
  document.getElementById("reportDiffOn").textContent =
    formatSecondsToReadable(currentCycle?.diff_on_s);

  document.getElementById("reportDiffOff").textContent =
    formatSecondsToReadable(currentCycle?.diff_off_s);

  document.getElementById("reportLuxOn").textContent =
    formatValue(currentCycle?.lux_on);

  document.getElementById("reportLuxOff").textContent =
    formatValue(currentCycle?.lux_off);

  document.getElementById("statTotal").textContent = stats.total ?? 0;
  document.getElementById("statPomiar").textContent = stats.pomiar ?? 0;
  document.getElementById("statOn").textContent = stats.zmiana_on ?? 0;
  document.getElementById("statOff").textContent = stats.zmiana_off ?? 0;
  document.getElementById("statAlarmOn").textContent = stats.alarm_brak_zalaczenia ?? 0;
  document.getElementById("statAlarmOff").textContent = stats.alarm_brak_wylaczenia ?? 0;

  const alarmsList = document.getElementById("alarmsList");
  alarmsList.innerHTML = "";

  if (!alarms.length) {
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
    if (isAlarm(row.type)) tr.classList.add("alarm-row");

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

  document.getElementById("mapLat").textContent = currentConfig?.lat ?? "—";
  document.getElementById("mapLon").textContent = currentConfig?.lon ?? "—";

  document.getElementById("mapMode").textContent =
    currentDeviceStatus?.mode ||
    currentConfig?.mode ||
    "—";

  document.getElementById("mapState").textContent =
    currentDeviceStatus?.state ??
    latest?.state ??
    "—";

  document.getElementById("mapLastRead").textContent =
    currentDeviceStatus?.timestamp_real ||
    latest?.timestamp_real ||
    "—";
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

    document.getElementById("configLat").value = currentConfig.lat ?? "";
    document.getElementById("configLon").value = currentConfig.lon ?? "";
    document.getElementById("configMode").value = currentConfig.mode ?? "AUTO";
    document.getElementById("manualOn").value = currentConfig.manual_on ?? "19:50";
    document.getElementById("manualOff").value = currentConfig.manual_off ?? "05:00";

    document.getElementById("locationStatus").textContent =
      `Aktualna lokalizacja: ${currentConfig.lat}, ${currentConfig.lon}`;

    document.getElementById("modeStatus").textContent =
      `Aktualny tryb: ${currentConfig.mode}`;

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
  } catch (error) {
    console.error(error);
  }
}

document.getElementById("typeFilter").addEventListener("change", renderTable);
document.getElementById("onlyAlarms").addEventListener("change", renderTable);

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
}, 15000);

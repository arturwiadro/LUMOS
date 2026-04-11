const navButtons = document.querySelectorAll(".nav-btn");
const tabs = document.querySelectorAll(".tab");

let allData = [];
let currentConfig = null;
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

function findLastByType(type) {
  return [...allData].reverse().find((item) => item.type === type) || null;
}

function findLatestRecordWithPlan() {
  return [...allData].reverse().find(
    (item) => item.planned_on || item.planned_off
  ) || null;
}

function updateDashboard(latest, stats, alarms) {
  document.getElementById("deviceId").textContent = latest?.device_id || "SSO-1";
  document.getElementById("lastTimestamp").textContent = latest?.timestamp_real || "—";
  document.getElementById("liveState").textContent = latest?.state ?? "—";
  document.getElementById("liveLux").textContent = latest?.lux ?? "—";
  document.getElementById("liveTime").textContent = latest?.timestamp_real || "—";

  const latestPlanRecord = findLatestRecordWithPlan();
  const lastOn = findLastByType("zmiana_on");
  const lastOff = findLastByType("zmiana_off");

  const statusEl = document.getElementById("currentStatus");
  statusEl.className = "status-badge";

  if (latest && isAlarm(latest.type)) {
    statusEl.textContent = "ALARM";
    statusEl.classList.add("status-alarm");
  } else if (latest?.state === 1) {
    statusEl.textContent = "ON";
    statusEl.classList.add("status-on");
  } else {
    statusEl.textContent = "OFF";
    statusEl.classList.add("status-off");
  }

  // Na ten moment tryb w nagłówku pokazuje tylko ustawienie z panelu,
  // a nie potwierdzony tryb pracy ESP32.
  document.getElementById("workMode").textContent = currentConfig?.mode || "—";

  // Planowane godziny pobieramy tylko z danych przychodzących z ESP32
  document.getElementById("plannedOn").textContent = latestPlanRecord?.planned_on || "—";
  document.getElementById("plannedOff").textContent = latestPlanRecord?.planned_off || "—";

  document.getElementById("actualOn").textContent = lastOn?.timestamp_real || "—";
  document.getElementById("actualOff").textContent = lastOff?.timestamp_real || "—";
  document.getElementById("luxOn").textContent = lastOn?.lux ?? "—";
  document.getElementById("luxOff").textContent = lastOff?.lux ?? "—";
  document.getElementById("diffOn").textContent = lastOn?.difference_s ?? "—";
  document.getElementById("diffOff").textContent = lastOff?.difference_s ?? "—";

  // Raport - też tylko z danych z ESP32
  document.getElementById("reportPlannedOn").textContent = latestPlanRecord?.planned_on || "—";
  document.getElementById("reportPlannedOff").textContent = latestPlanRecord?.planned_off || "—";
  document.getElementById("reportActualOn").textContent = lastOn?.timestamp_real || "—";
  document.getElementById("reportActualOff").textContent = lastOff?.timestamp_real || "—";
  document.getElementById("reportDiffOn").textContent = lastOn?.difference_s ?? "—";
  document.getElementById("reportDiffOff").textContent = lastOff?.difference_s ?? "—";
  document.getElementById("reportLuxOn").textContent = lastOn?.lux ?? "—";
  document.getElementById("reportLuxOff").textContent = lastOff?.lux ?? "—";

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
          <div>Różnica [s]: ${formatValue(alarm.difference_s)}</div>
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
      <td>${formatValue(row.difference_s)}</td>
    `;

    tbody.appendChild(tr);
  });
}

function updateMapPanel() {
  const latest = allData.length ? allData[allData.length - 1] : null;

  document.getElementById("mapDeviceId").textContent = latest?.device_id || "szafa_01";
  document.getElementById("mapLat").textContent = currentConfig?.lat ?? "—";
  document.getElementById("mapLon").textContent = currentConfig?.lon ?? "—";
  document.getElementById("mapMode").textContent = currentConfig?.mode ?? "—";
  document.getElementById("mapState").textContent = latest?.state ?? "—";
  document.getElementById("mapLastRead").textContent = latest?.timestamp_real || "—";
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
    await loadData();
  } catch (error) {
    console.error(error);
    alert("Nie udało się wymusić OFF.");
  }
});

async function initApp() {
  await loadData();
  await loadConfig();
  await loadData();
}

initApp();
setInterval(loadData, 15000);

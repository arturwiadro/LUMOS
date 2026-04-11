const navButtons = document.querySelectorAll(".nav-btn");
const tabs = document.querySelectorAll(".tab");

let allData = [];

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    navButtons.forEach((b) => b.classList.remove("active"));
    tabs.forEach((t) => t.classList.remove("active"));

    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
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

function findLastByType(type) {
  const filtered = [...allData].reverse().find((item) => item.type === type);
  return filtered || null;
}

function updateDashboard(latest, stats, alarms) {
  document.getElementById("deviceId").textContent = latest?.device_id || "SSO-1";
  document.getElementById("lastTimestamp").textContent = latest?.timestamp_real || "—";
  document.getElementById("liveState").textContent = latest?.state ?? "—";
  document.getElementById("liveLux").textContent = latest?.lux ?? "—";
  document.getElementById("liveTime").textContent = latest?.timestamp_real || "—";

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

  const lastOn = findLastByType("zmiana_on");
  const lastOff = findLastByType("zmiana_off");

  document.getElementById("plannedOn").textContent = latest?.planned_on || "—";
  document.getElementById("plannedOff").textContent = latest?.planned_off || "—";
  document.getElementById("actualOn").textContent = lastOn?.timestamp_real || "—";
  document.getElementById("actualOff").textContent = lastOff?.timestamp_real || "—";
  document.getElementById("luxOn").textContent = lastOn?.lux ?? "—";
  document.getElementById("luxOff").textContent = lastOff?.lux ?? "—";
  document.getElementById("diffOn").textContent = lastOn?.difference_s ?? "—";
  document.getElementById("diffOff").textContent = lastOff?.difference_s ?? "—";

  document.getElementById("reportPlannedOn").textContent = latest?.planned_on || "—";
  document.getElementById("reportPlannedOff").textContent = latest?.planned_off || "—";
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

loadData();
setInterval(loadData, 15000);

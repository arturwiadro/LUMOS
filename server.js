const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let data = [];

let config = {
  lat: 53.6967,
  lon: 19.9646,
  mode: "AUTO",
  manual_on: "19:50",
  manual_off: "05:00"
};

// bieżący status urządzenia - nadpisywany przez ESP
let deviceStatus = {
  device_id: "szafa_01",
  mode: "AUTO",
  planned_on: null,
  planned_off: null,
  window_status: "unknown",
  state: null,
  lux: null,
  timestamp_real: null,
  updated_at: null
};

// bieżący cykl nocny - dane robocze do dashboardu i raportu
let currentCycle = {
  device_id: "szafa_01",
  cycle_date: null,

  planned_on: null,
  planned_off: null,

  actual_on: null,
  actual_off: null,

  lux_on: null,
  lux_off: null,

  diff_on_s: null,
  diff_off_s: null,

  alarm_on: false,
  alarm_off: false,

  updated_at: null
};

function resetCurrentCycle() {
  currentCycle = {
    device_id: deviceStatus.device_id || "szafa_01",
    cycle_date: null,

    planned_on: null,
    planned_off: null,

    actual_on: null,
    actual_off: null,

    lux_on: null,
    lux_off: null,

    diff_on_s: null,
    diff_off_s: null,

    alarm_on: false,
    alarm_off: false,

    updated_at: new Date().toISOString()
  };
}

function extractCycleDate(timestampReal) {
  if (!timestampReal || typeof timestampReal !== "string") return null;
  return timestampReal.slice(0, 10);
}

function updateCurrentCycleFromEntry(entry) {
  const isRelevantType =
    entry.type === "zmiana_on" ||
    entry.type === "zmiana_off" ||
    entry.type === "alarm_brak_zalaczenia" ||
    entry.type === "alarm_brak_wylaczenia";

  if (!isRelevantType) return;

  const cycleDate = extractCycleDate(entry.timestamp_real);

  // jeżeli zaczyna się nowy dzień/cykl, aktualizujemy cycle_date
  if (!currentCycle.cycle_date && cycleDate) {
    currentCycle.cycle_date = cycleDate;
  }

  // planowane godziny zawsze możemy odświeżać z najnowszego rekordu
  if (entry.planned_on) currentCycle.planned_on = entry.planned_on;
  if (entry.planned_off) currentCycle.planned_off = entry.planned_off;

  if (entry.type === "zmiana_on") {
    currentCycle.actual_on = entry.timestamp_real || null;
    currentCycle.lux_on = entry.lux ?? null;
    currentCycle.diff_on_s = entry.difference_s ?? null;
  }

  if (entry.type === "zmiana_off") {
    currentCycle.actual_off = entry.timestamp_real || null;
    currentCycle.lux_off = entry.lux ?? null;
    currentCycle.diff_off_s = entry.difference_s ?? null;
  }

  if (entry.type === "alarm_brak_zalaczenia") {
    currentCycle.alarm_on = true;
    if (entry.planned_on) currentCycle.planned_on = entry.planned_on;
  }

  if (entry.type === "alarm_brak_wylaczenia") {
    currentCycle.alarm_off = true;
    if (entry.planned_off) currentCycle.planned_off = entry.planned_off;
  }

  currentCycle.updated_at = new Date().toISOString();
}

// odbiór danych z ESP32
app.post("/api/data", (req, res) => {
  const entry = {
    received_at: new Date().toISOString(),
    ...req.body
  };

  data.push(entry);
  updateCurrentCycleFromEntry(entry);

  res.json({ status: "ok" });
});

// bieżący status z ESP
app.post("/api/device-status", (req, res) => {
  deviceStatus = {
    ...deviceStatus,
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // planowane godziny odświeżamy też w bieżącym cyklu
  if (req.body.planned_on) currentCycle.planned_on = req.body.planned_on;
  if (req.body.planned_off) currentCycle.planned_off = req.body.planned_off;
  if (!currentCycle.device_id && req.body.device_id) currentCycle.device_id = req.body.device_id;
  currentCycle.updated_at = new Date().toISOString();

  res.json({
    status: "ok",
    deviceStatus
  });
});

app.get("/api/device-status", (req, res) => {
  res.json(deviceStatus);
});

// bieżący cykl nocny
app.get("/api/current-cycle", (req, res) => {
  res.json(currentCycle);
});

// ręczny reset bieżącego cyklu
app.post("/api/current-cycle/reset", (req, res) => {
  resetCurrentCycle();
  res.json({
    status: "ok",
    message: "Bieżący cykl został zresetowany.",
    currentCycle
  });
});

app.get("/api/data", (req, res) => {
  res.json(data);
});

app.get("/api/data/latest", (req, res) => {
  if (!data.length) {
    return res.status(404).json({ error: "Brak danych" });
  }
  res.json(data[data.length - 1]);
});

app.get("/api/alarms", (req, res) => {
  const alarms = data.filter(
    (item) =>
      item.type === "alarm_brak_zalaczenia" ||
      item.type === "alarm_brak_wylaczenia"
  );
  res.json(alarms);
});

app.get("/api/stats", (req, res) => {
  const stats = {
    total: data.length,
    pomiar: data.filter((x) => x.type === "pomiar").length,
    zmiana_on: data.filter((x) => x.type === "zmiana_on").length,
    zmiana_off: data.filter((x) => x.type === "zmiana_off").length,
    zmiana_poza_oknem: data.filter((x) => x.type === "zmiana_poza_oknem").length,
    alarm_brak_zalaczenia: data.filter((x) => x.type === "alarm_brak_zalaczenia").length,
    alarm_brak_wylaczenia: data.filter((x) => x.type === "alarm_brak_wylaczenia").length,
    test_manual: data.filter((x) => x.type === "test_manual").length
  };

  res.json(stats);
});

app.get("/api/check-status", (req, res) => {
  const latest = data[data.length - 1] || null;

  res.json({
    ok: true,
    mode: "manual_check_mock",
    message: "Na tym etapie endpoint zwraca ostatni znany stan z backendu.",
    latest
  });
});

app.get("/api/config", (req, res) => {
  res.json(config);
});

app.post("/api/config", (req, res) => {
  const { lat, lon, mode, manual_on, manual_off } = req.body;

  if (lat !== undefined) config.lat = Number(lat);
  if (lon !== undefined) config.lon = Number(lon);
  if (mode !== undefined) config.mode = mode;
  if (manual_on !== undefined) config.manual_on = manual_on;
  if (manual_off !== undefined) config.manual_off = manual_off;

  res.json({
    status: "ok",
    config
  });
});

app.post("/api/force", (req, res) => {
  const { state } = req.body;

  if (state !== 0 && state !== 1) {
    return res.status(400).json({ error: "Nieprawidłowy stan. Użyj 0 lub 1." });
  }

  const now = new Date();
  const timestamp =
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")} ` +
    `${String(now.getHours()).padStart(2, "0")}:` +
    `${String(now.getMinutes()).padStart(2, "0")}:` +
    `${String(now.getSeconds()).padStart(2, "0")}`;

  const entry = {
    device_id: "szafa_01",
    timestamp_real: timestamp,
    type: "test_manual",
    lux: null,
    state,
    planned_on: config.manual_on,
    planned_off: config.manual_off,
    difference_s: null,
    received_at: new Date().toISOString()
  };

  data.push(entry);

  res.json({
    status: "ok",
    message: "Dodano rekord testowy",
    entry
  });
});

app.post("/api/admin/clear-data", (req, res) => {
  data = [];
  resetCurrentCycle();

  res.json({
    status: "ok",
    message: "Wyczyszczono dane historyczne i zresetowano bieżący cykl."
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server działa na porcie ${PORT}`);
});

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

// testowe dane startowe
data.push(
  {
    device_id: "szafa_01",
    timestamp_real: "2026-04-11 19:50:12",
    type: "zmiana_on",
    lux: 42.5,
    state: 1,
    planned_on: "2026-04-11 19:50:00",
    planned_off: "2026-04-12 05:00:00",
    difference_s: 12
  },
  {
    device_id: "szafa_01",
    timestamp_real: "2026-04-12 05:00:31",
    type: "zmiana_off",
    lux: 18.2,
    state: 0,
    planned_on: "2026-04-11 19:50:00",
    planned_off: "2026-04-12 05:00:00",
    difference_s: 31
  }
);

// odbiór danych z ESP32
app.post("/api/data", (req, res) => {
  const entry = {
    received_at: new Date().toISOString(),
    ...req.body
  };

  data.push(entry);
  res.json({ status: "ok" });
});

// wszystkie dane
app.get("/api/data", (req, res) => {
  res.json(data);
});

// ostatni rekord
app.get("/api/data/latest", (req, res) => {
  if (!data.length) {
    return res.status(404).json({ error: "Brak danych" });
  }
  res.json(data[data.length - 1]);
});

// tylko alarmy
app.get("/api/alarms", (req, res) => {
  const alarms = data.filter(
    (item) =>
      item.type === "alarm_brak_zalaczenia" ||
      item.type === "alarm_brak_wylaczenia"
  );
  res.json(alarms);
});

// podstawowe statystyki
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

// przycisk "sprawdź" - na razie wersja mock
app.get("/api/check-status", (req, res) => {
  const latest = data[data.length - 1] || null;

  res.json({
    ok: true,
    mode: "manual_check_mock",
    message: "Na tym etapie endpoint zwraca ostatni znany stan z backendu.",
    latest
  });
});

// konfiguracja
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

// wymuszenie stanu do testów
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

// frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server działa na porcie ${PORT}`);
});

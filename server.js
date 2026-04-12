const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

let config = {
  lat: 53.6967,
  lon: 19.9646,
  mode: "AUTO",
  manual_on: "19:50",
  manual_off: "05:00"
};

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

  if (!currentCycle.cycle_date && cycleDate) {
    currentCycle.cycle_date = cycleDate;
  }

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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lighting_logs (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT,
      timestamp_real TEXT,
      type TEXT,
      lux DOUBLE PRECISION,
      state INTEGER,
      planned_on TEXT,
      planned_off TEXT,
      difference_s INTEGER,
      received_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("PostgreSQL OK - tabela lighting_logs gotowa");
}

app.post("/api/data", async (req, res) => {
  try {
    const entry = {
      received_at: new Date().toISOString(),
      ...req.body
    };

    await pool.query(
      `
      INSERT INTO lighting_logs
      (device_id, timestamp_real, type, lux, state, planned_on, planned_off, difference_s, received_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        entry.device_id ?? null,
        entry.timestamp_real ?? null,
        entry.type ?? null,
        entry.lux ?? null,
        entry.state ?? null,
        entry.planned_on ?? null,
        entry.planned_off ?? null,
        entry.difference_s ?? null,
        entry.received_at
      ]
    );

    updateCurrentCycleFromEntry(entry);

    res.json({ status: "ok" });
  } catch (error) {
    console.error("POST /api/data error:", error);
    res.status(500).json({ error: "Błąd zapisu do bazy danych." });
  }
});

app.post("/api/device-status", (req, res) => {
  deviceStatus = {
    ...deviceStatus,
    ...req.body,
    updated_at: new Date().toISOString()
  };

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

app.get("/api/current-cycle", (req, res) => {
  res.json(currentCycle);
});

app.post("/api/current-cycle/reset", (req, res) => {
  resetCurrentCycle();
  res.json({
    status: "ok",
    message: "Bieżący cykl został zresetowany.",
    currentCycle
  });
});

app.get("/api/data", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        device_id,
        timestamp_real,
        type,
        lux,
        state,
        planned_on,
        planned_off,
        difference_s,
        received_at
      FROM lighting_logs
      ORDER BY id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/data error:", error);
    res.status(500).json({ error: "Błąd odczytu z bazy danych." });
  }
});

app.get("/api/data/latest", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        device_id,
        timestamp_real,
        type,
        lux,
        state,
        planned_on,
        planned_off,
        difference_s,
        received_at
      FROM lighting_logs
      ORDER BY id DESC
      LIMIT 1
    `);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Brak danych" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET /api/data/latest error:", error);
    res.status(500).json({ error: "Błąd odczytu ostatniego rekordu." });
  }
});

app.get("/api/alarms", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        device_id,
        timestamp_real,
        type,
        lux,
        state,
        planned_on,
        planned_off,
        difference_s,
        received_at
      FROM lighting_logs
      WHERE type IN ('alarm_brak_zalaczenia', 'alarm_brak_wylaczenia')
      ORDER BY id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/alarms error:", error);
    res.status(500).json({ error: "Błąd odczytu alarmów." });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const totalResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs`);
    const pomiarResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'pomiar'`);
    const onResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'zmiana_on'`);
    const offResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'zmiana_off'`);
    const pozaResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'zmiana_poza_oknem'`);
    const alarmOnResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'alarm_brak_zalaczenia'`);
    const alarmOffResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'alarm_brak_wylaczenia'`);
    const testResult = await pool.query(`SELECT COUNT(*)::int AS count FROM lighting_logs WHERE type = 'test_manual'`);

    res.json({
      total: totalResult.rows[0].count,
      pomiar: pomiarResult.rows[0].count,
      zmiana_on: onResult.rows[0].count,
      zmiana_off: offResult.rows[0].count,
      zmiana_poza_oknem: pozaResult.rows[0].count,
      alarm_brak_zalaczenia: alarmOnResult.rows[0].count,
      alarm_brak_wylaczenia: alarmOffResult.rows[0].count,
      test_manual: testResult.rows[0].count
    });
  } catch (error) {
    console.error("GET /api/stats error:", error);
    res.status(500).json({ error: "Błąd statystyk." });
  }
});

app.get("/api/check-status", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        device_id,
        timestamp_real,
        type,
        lux,
        state,
        planned_on,
        planned_off,
        difference_s,
        received_at
      FROM lighting_logs
      ORDER BY id DESC
      LIMIT 1
    `);

    const latest = result.rows.length ? result.rows[0] : null;

    res.json({
      ok: true,
      mode: "manual_check_mock",
      message: "Na tym etapie endpoint zwraca ostatni znany stan z backendu.",
      latest
    });
  } catch (error) {
    console.error("GET /api/check-status error:", error);
    res.status(500).json({ error: "Błąd sprawdzania statusu." });
  }
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

app.post("/api/force", async (req, res) => {
  try {
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

    await pool.query(
      `
      INSERT INTO lighting_logs
      (device_id, timestamp_real, type, lux, state, planned_on, planned_off, difference_s, received_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        entry.device_id,
        entry.timestamp_real,
        entry.type,
        entry.lux,
        entry.state,
        entry.planned_on,
        entry.planned_off,
        entry.difference_s,
        entry.received_at
      ]
    );

    res.json({
      status: "ok",
      message: "Dodano rekord testowy",
      entry
    });
  } catch (error) {
    console.error("POST /api/force error:", error);
    res.status(500).json({ error: "Błąd dodawania rekordu testowego." });
  }
});

app.post("/api/admin/clear-data", async (req, res) => {
  try {
    await pool.query(`TRUNCATE TABLE lighting_logs RESTART IDENTITY`);
    resetCurrentCycle();

    res.json({
      status: "ok",
      message: "Wyczyszczono dane historyczne i zresetowano bieżący cykl."
    });
  } catch (error) {
    console.error("POST /api/admin/clear-data error:", error);
    res.status(500).json({ error: "Błąd czyszczenia danych." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server działa na porcie ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Błąd inicjalizacji PostgreSQL:", error);
    process.exit(1);
  });

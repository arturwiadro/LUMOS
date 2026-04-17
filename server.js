const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const WINDOW_BEFORE_MIN = 60;
const WINDOW_AFTER_MIN = 60;
const REPORT_PADDING_HOURS = 1;
const HISTORY_DEFAULT_LIMIT = 300;
const HISTORY_MAX_LIMIT = 5000;
const DASHBOARD_ALARMS_LIMIT = 10;
const REPORT_CYCLES_LIMIT = 200;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function formatWarsawDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatWarsawDateOnly(date = new Date()) {
  return formatWarsawDateTime(date).slice(0, 10);
}

function extractCycleDate(timestampReal) {
  if (!timestampReal || typeof timestampReal !== "string") return null;
  return timestampReal.slice(0, 10);
}

function deriveCycleDateFromPlannedOn(plannedOn) {
  if (isFullDateTime(plannedOn)) {
    return plannedOn.slice(0, 10);
  }
  return null;
}

function addDaysToDateString(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function isFullDateTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
}

function isTimeOnly(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (stringValue.includes('"') || stringValue.includes(",") || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIntWithinRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function toBoolean(value) {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return false;
}

function sanitizeTypeFilter(value) {
  const allowed = new Set([
    "pomiar",
    "zmiana_on",
    "zmiana_off",
    "zmiana_poza_oknem",
    "alarm_brak_zalaczenia",
    "alarm_brak_wylaczenia",
    "test_manual"
  ]);

  if (!value || value === "all") return null;
  if (allowed.has(value)) return value;
  return null;
}

function buildReportFileName(cycleDate) {
  const safeDate = cycleDate || formatWarsawDateOnly();
  return `lumos_raport_${safeDate}.csv`;
}

function toBase64Utf8(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function parseTimestampString(value) {
  if (!isFullDateTime(value)) return null;

  const [datePart, timePart] = value.split(" ");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);

  const parsed = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getMinutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinWrappedWindow(nowMinutes, eventMinutes, beforeMinutes, afterMinutes) {
  const start = eventMinutes - beforeMinutes;
  const end = eventMinutes + afterMinutes;

  if (start >= 0 && end < 1440) {
    return nowMinutes >= start && nowMinutes <= end;
  }

  if (start < 0) {
    return nowMinutes >= 1440 + start || nowMinutes <= end;
  }

  if (end >= 1440) {
    return nowMinutes >= start || nowMinutes <= end - 1440;
  }

  return false;
}

function calculateWindowStatusFromPlan(plannedOn, plannedOff, nowString = formatWarsawDateTime()) {
  const now = parseTimestampString(nowString);
  if (!now) return "unknown";

  const parsedPlannedOn = parseTimestampString(plannedOn);
  const parsedPlannedOff = parseTimestampString(plannedOff);

  if (parsedPlannedOn && parsedPlannedOff) {
    const inOnWindow =
      now >= addMinutes(parsedPlannedOn, -WINDOW_BEFORE_MIN) &&
      now <= addMinutes(parsedPlannedOn, WINDOW_AFTER_MIN);

    const inOffWindow =
      now >= addMinutes(parsedPlannedOff, -WINDOW_BEFORE_MIN) &&
      now <= addMinutes(parsedPlannedOff, WINDOW_AFTER_MIN);

    return inOnWindow || inOffWindow ? "okno_pomiarowe" : "poza_oknem";
  }

  if (isTimeOnly(plannedOn) && isTimeOnly(plannedOff)) {
    const nowMin = getMinutesOfDay(now);
    const [onHour, onMinute] = plannedOn.split(":").map(Number);
    const [offHour, offMinute] = plannedOff.split(":").map(Number);
    const onMin = onHour * 60 + onMinute;
    const offMin = offHour * 60 + offMinute;

    const inOnWindow = isWithinWrappedWindow(nowMin, onMin, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN);
    const inOffWindow = isWithinWrappedWindow(nowMin, offMin, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN);

    return inOnWindow || inOffWindow ? "okno_pomiarowe" : "poza_oknem";
  }

  return "unknown";
}

function normalizeWindowStatus(rawValue) {
  if (rawValue === "okno_pomiarowe" || rawValue === "poza_oknem") {
    return rawValue;
  }

  if (!rawValue || rawValue === "unknown") {
    return "unknown";
  }

  return rawValue;
}

function getCycleIdentity(plannedOn, plannedOff) {
  const hasOn = typeof plannedOn === "string" && plannedOn.trim() !== "";
  const hasOff = typeof plannedOff === "string" && plannedOff.trim() !== "";

  if (!hasOn && !hasOff) return null;

  return `${plannedOn || ""}|${plannedOff || ""}`;
}

function compareCycleOrder(plannedOnA, plannedOnB) {
  const a = parseTimestampString(plannedOnA);
  const b = parseTimestampString(plannedOnB);

  if (a && b) {
    if (a.getTime() < b.getTime()) return -1;
    if (a.getTime() > b.getTime()) return 1;
    return 0;
  }

  if (plannedOnA && plannedOnB) {
    if (plannedOnA < plannedOnB) return -1;
    if (plannedOnA > plannedOnB) return 1;
    return 0;
  }

  return 0;
}

function shouldApplyEntryToCurrentCycle(entry) {
  const entryCycleId = getCycleIdentity(entry.planned_on, entry.planned_off);
  const currentCycleId = getCycleIdentity(currentCycle.planned_on, currentCycle.planned_off);

  if (!currentCycleId) return true;
  if (!entryCycleId) return true;
  if (entryCycleId === currentCycleId) return true;

  const order = compareCycleOrder(entry.planned_on, currentCycle.planned_on);

  if (order > 0) return true;
  if (order < 0) return false;

  return true;
}

function overwriteCurrentCycleFromEntryBase(entry) {
  currentCycle = {
    device_id: entry.device_id || deviceStatus.device_id || "szafa_01",
    cycle_date:
      deriveCycleDateFromPlannedOn(entry.planned_on) ||
      extractCycleDate(entry.timestamp_real) ||
      null,
    planned_on: entry.planned_on || null,
    planned_off: entry.planned_off || null,
    actual_on: null,
    actual_off: null,
    lux_on: null,
    lux_off: null,
    diff_on_s: null,
    diff_off_s: null,
    alarm_on: false,
    alarm_off: false,
    active_alarm_on: false,
    active_alarm_off: false,
    on_finalized: false,
    off_finalized: false,
    updated_at: new Date().toISOString()
  };
}

function buildMailText(report) {
  const summary = report.summary;

  return [
    "Raport LUMOS / SSO",
    "",
    `Urządzenie: ${summary.device_id || "-"}`,
    `Data cyklu: ${summary.cycle_date || "-"}`,
    "",
    `Planowane załączenie: ${summary.planned_on || "-"}`,
    `Fizyczne załączenie: ${summary.actual_on || "-"}`,
    `Różnica ON [s]: ${summary.diff_on_s ?? "-"}`,
    `Lux przy załączeniu: ${summary.lux_on ?? "-"}`,
    "",
    `Planowane wyłączenie: ${summary.planned_off || "-"}`,
    `Fizyczne wyłączenie: ${summary.actual_off || "-"}`,
    `Różnica OFF [s]: ${summary.diff_off_s ?? "-"}`,
    `Lux przy wyłączeniu: ${summary.lux_off ?? "-"}`,
    "",
    `Alarm brak załączenia: ${summary.alarm_on ? "TAK" : "NIE"}`,
    `Alarm brak wyłączenia: ${summary.alarm_off ? "TAK" : "NIE"}`,
    "",
    `Liczba rekordów w raporcie: ${report.rows.length}`,
    `Zakres danych: ${report.range.start} -> ${report.range.end}`,
    "",
    "W załączniku znajduje się plik CSV do porównania z danymi SSO."
  ].join("\n");
}

function buildMailHtml(report) {
  const summary = report.summary;

  return `
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8" />
  <title>Raport LUMOS / SSO</title>
</head>
<body style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
  <h2>Raport LUMOS / SSO</h2>
  <p><strong>Urządzenie:</strong> ${summary.device_id || "-"}</p>
  <p><strong>Data cyklu:</strong> ${summary.cycle_date || "-"}</p>

  <h3>Załączenie</h3>
  <p><strong>Planowane:</strong> ${summary.planned_on || "-"}</p>
  <p><strong>Fizyczne:</strong> ${summary.actual_on || "-"}</p>
  <p><strong>Różnica ON [s]:</strong> ${summary.diff_on_s ?? "-"}</p>
  <p><strong>Lux przy załączeniu:</strong> ${summary.lux_on ?? "-"}</p>

  <h3>Wyłączenie</h3>
  <p><strong>Planowane:</strong> ${summary.planned_off || "-"}</p>
  <p><strong>Fizyczne:</strong> ${summary.actual_off || "-"}</p>
  <p><strong>Różnica OFF [s]:</strong> ${summary.diff_off_s ?? "-"}</p>
  <p><strong>Lux przy wyłączeniu:</strong> ${summary.lux_off ?? "-"}</p>

  <h3>Alarmy</h3>
  <p><strong>Brak załączenia:</strong> ${summary.alarm_on ? "TAK" : "NIE"}</p>
  <p><strong>Brak wyłączenia:</strong> ${summary.alarm_off ? "TAK" : "NIE"}</p>

  <h3>Zakres raportu</h3>
  <p><strong>Zakres danych:</strong> ${report.range.start} → ${report.range.end}</p>
  <p><strong>Liczba rekordów:</strong> ${report.rows.length}</p>

  <p>W załączniku znajduje się plik CSV do porównania z danymi SSO.</p>
</body>
</html>
  `.trim();
}

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
  active_alarm_on: false,
  active_alarm_off: false,
  on_finalized: false,
  off_finalized: false,
  updated_at: null
};

let lastAutoReportKey = null;

function refreshDeviceShadowDerivedFields() {
  if (!deviceStatus.device_id) {
    deviceStatus.device_id = currentCycle.device_id || "szafa_01";
  }

  if (!deviceStatus.mode) {
    deviceStatus.mode = config.mode || "AUTO";
  }

  if (!deviceStatus.planned_on) {
    deviceStatus.planned_on = currentCycle.planned_on || null;
  }

  if (!deviceStatus.planned_off) {
    deviceStatus.planned_off = currentCycle.planned_off || null;
  }

  const normalizedWindowStatus = normalizeWindowStatus(deviceStatus.window_status);

  if (normalizedWindowStatus === "unknown") {
    deviceStatus.window_status = calculateWindowStatusFromPlan(
      deviceStatus.planned_on,
      deviceStatus.planned_off
    );
  } else {
    deviceStatus.window_status = normalizedWindowStatus;
  }

  deviceStatus.updated_at = new Date().toISOString();
}

function syncDeviceStatusWithCurrentCycle() {
  deviceStatus.device_id = currentCycle.device_id || deviceStatus.device_id || "szafa_01";
  deviceStatus.mode = config.mode || deviceStatus.mode || "AUTO";
  deviceStatus.planned_on = currentCycle.planned_on || deviceStatus.planned_on || null;
  deviceStatus.planned_off = currentCycle.planned_off || deviceStatus.planned_off || null;
  deviceStatus.window_status = calculateWindowStatusFromPlan(
    deviceStatus.planned_on,
    deviceStatus.planned_off
  );
  deviceStatus.updated_at = new Date().toISOString();
}

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
    active_alarm_on: false,
    active_alarm_off: false,
    on_finalized: false,
    off_finalized: false,
    updated_at: new Date().toISOString()
  };
}

function applyConfigToDeviceShadow() {
  deviceStatus.mode = config.mode;

  if (config.mode === "MANUAL") {
    deviceStatus.planned_on = config.manual_on;
    deviceStatus.planned_off = config.manual_off;
    currentCycle.planned_on = config.manual_on;
    currentCycle.planned_off = config.manual_off;
    currentCycle.cycle_date = null;
  }

  currentCycle.updated_at = new Date().toISOString();
  refreshDeviceShadowDerivedFields();
}

function finalizeCycleParts() {
  const nowString = formatWarsawDateTime(new Date());
  const now = parseTimestampString(nowString);

  if (!now) return;

  let changed = false;

  if (!currentCycle.on_finalized && currentCycle.planned_on) {
    const plannedOn = parseTimestampString(currentCycle.planned_on);
    if (plannedOn) {
      const onWindowEnd = addHours(plannedOn, 1);
      if (now >= onWindowEnd) {
        currentCycle.on_finalized = true;
        changed = true;
      }
    }
  }

  if (!currentCycle.off_finalized && currentCycle.planned_off) {
    const plannedOff = parseTimestampString(currentCycle.planned_off);
    if (plannedOff) {
      const offWindowEnd = addHours(plannedOff, 1);
      if (now >= offWindowEnd) {
        currentCycle.off_finalized = true;
        changed = true;
      }
    }
  }

  if (changed) {
    currentCycle.updated_at = new Date().toISOString();
  }

  syncDeviceStatusWithCurrentCycle();
}

function updateCurrentCycleFromEntry(entry) {
  const isRelevantType =
    entry.type === "zmiana_on" ||
    entry.type === "zmiana_off" ||
    entry.type === "alarm_brak_zalaczenia" ||
    entry.type === "alarm_brak_wylaczenia";

  if (!isRelevantType) return;

  const shouldApply = shouldApplyEntryToCurrentCycle(entry);
  if (!shouldApply) return;

  const entryCycleId = getCycleIdentity(entry.planned_on, entry.planned_off);
  const currentCycleId = getCycleIdentity(currentCycle.planned_on, currentCycle.planned_off);

  if (!currentCycleId || (entryCycleId && entryCycleId !== currentCycleId)) {
    overwriteCurrentCycleFromEntryBase(entry);
  }

  if (entry.device_id) {
    currentCycle.device_id = entry.device_id;
  }

  if (entry.planned_on) {
    currentCycle.planned_on = entry.planned_on;
    currentCycle.cycle_date =
      deriveCycleDateFromPlannedOn(entry.planned_on) ||
      currentCycle.cycle_date;
  }

  if (entry.planned_off) {
    currentCycle.planned_off = entry.planned_off;
  }

  if (!currentCycle.cycle_date && entry.timestamp_real) {
    currentCycle.cycle_date = extractCycleDate(entry.timestamp_real);
  }

  if (entry.type === "zmiana_on") {
    currentCycle.actual_on = entry.timestamp_real || null;
    currentCycle.lux_on = entry.lux ?? null;
    currentCycle.diff_on_s = entry.difference_s ?? null;
    currentCycle.active_alarm_on = false;
  }

  if (entry.type === "zmiana_off") {
    currentCycle.actual_off = entry.timestamp_real || null;
    currentCycle.lux_off = entry.lux ?? null;
    currentCycle.diff_off_s = entry.difference_s ?? null;
    currentCycle.active_alarm_off = false;
  }

  if (entry.type === "alarm_brak_zalaczenia") {
    currentCycle.alarm_on = true;
    currentCycle.active_alarm_on = true;
  }

  if (entry.type === "alarm_brak_wylaczenia") {
    currentCycle.alarm_off = true;
    currentCycle.active_alarm_off = true;
  }

  currentCycle.updated_at = new Date().toISOString();
  syncDeviceStatusWithCurrentCycle();
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT,
      cycle_date TEXT,
      report_type TEXT,
      email_to TEXT,
      planned_on TEXT,
      planned_off TEXT,
      actual_on TEXT,
      actual_off TEXT,
      diff_on_s INTEGER,
      diff_off_s INTEGER,
      lux_on DOUBLE PRECISION,
      lux_off DOUBLE PRECISION,
      alarm_on BOOLEAN DEFAULT FALSE,
      alarm_off BOOLEAN DEFAULT FALSE,
      record_count INTEGER DEFAULT 0,
      range_start TEXT,
      range_end TEXT,
      csv_content TEXT,
      provider_message_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE daily_reports
    ADD COLUMN IF NOT EXISTS provider_message_id TEXT
  `);

  console.log("PostgreSQL OK - tabele lighting_logs i daily_reports gotowe");
}

function resolveReportRange({ cycleDate, plannedOn, plannedOff }) {
  if (isFullDateTime(plannedOn) && isFullDateTime(plannedOff)) {
    const onDate = parseTimestampString(plannedOn);
    const offDate = parseTimestampString(plannedOff);

    if (onDate && offDate) {
      return {
        start: formatWarsawDateTime(addHours(onDate, -REPORT_PADDING_HOURS)),
        end: formatWarsawDateTime(addHours(offDate, REPORT_PADDING_HOURS))
      };
    }
  }

  const effectiveCycleDate = cycleDate || formatWarsawDateOnly();
  const nextDay = addDaysToDateString(effectiveCycleDate, 1);

  if (isTimeOnly(plannedOn) && isTimeOnly(plannedOff)) {
    const onDate = parseTimestampString(`${effectiveCycleDate} ${plannedOn}:00`);
    const offDate = parseTimestampString(`${nextDay} ${plannedOff}:00`);

    if (onDate && offDate) {
      return {
        start: formatWarsawDateTime(addHours(onDate, -REPORT_PADDING_HOURS)),
        end: formatWarsawDateTime(addHours(offDate, REPORT_PADDING_HOURS))
      };
    }
  }

  return {
    start: `${effectiveCycleDate} 00:00:00`,
    end: `${nextDay} 23:59:59`
  };
}

async function getLogsForRange(range, deviceId) {
  const params = [range.start, range.end];
  let query = `
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
    WHERE timestamp_real IS NOT NULL
      AND timestamp_real >= $1
      AND timestamp_real <= $2
  `;

  if (deviceId) {
    params.push(deviceId);
    query += " AND device_id = $3 ";
  }

  query += " ORDER BY timestamp_real ASC, id ASC ";

  const result = await pool.query(query, params);
  return result.rows;
}

async function countLogsForCycleWindow({ plannedOn, plannedOff, deviceId }) {
  if (!isFullDateTime(plannedOn) || !isFullDateTime(plannedOff)) {
    return null;
  }

  const range = resolveReportRange({
    cycleDate: deriveCycleDateFromPlannedOn(plannedOn),
    plannedOn,
    plannedOff
  });

  const params = [plannedOn, plannedOff, range.start, range.end];
  let query = `
    SELECT COUNT(*)::int AS count
    FROM lighting_logs
    WHERE planned_on = $1
      AND planned_off = $2
      AND timestamp_real IS NOT NULL
      AND timestamp_real >= $3
      AND timestamp_real <= $4
  `;

  if (deviceId) {
    params.push(deviceId);
    query += " AND device_id = $5 ";
  }

  const result = await pool.query(query, params);
  return result.rows[0]?.count ?? 0;
}

function pickBestCycleEvent(rows, targetType, plannedFieldName, plannedValue) {
  const matchingType = rows.filter((row) => row.type === targetType);

  if (!matchingType.length) return null;

  const exactPlanMatch = matchingType.filter((row) => row[plannedFieldName] === plannedValue);
  if (exactPlanMatch.length) {
    return exactPlanMatch[0];
  }

  return matchingType[0];
}

function buildReportSummary(rows, baseCycle) {
  const summary = {
    device_id: baseCycle.device_id || deviceStatus.device_id || "szafa_01",
    cycle_date:
      baseCycle.cycle_date ||
      deriveCycleDateFromPlannedOn(baseCycle.planned_on) ||
      formatWarsawDateOnly(),
    planned_on: baseCycle.planned_on || null,
    planned_off: baseCycle.planned_off || null,
    actual_on: baseCycle.actual_on || null,
    actual_off: baseCycle.actual_off || null,
    lux_on: baseCycle.lux_on ?? null,
    lux_off: baseCycle.lux_off ?? null,
    diff_on_s: baseCycle.diff_on_s ?? null,
    diff_off_s: baseCycle.diff_off_s ?? null,
    alarm_on: Boolean(baseCycle.alarm_on),
    alarm_off: Boolean(baseCycle.alarm_off),
    active_alarm_on: Boolean(baseCycle.active_alarm_on),
    active_alarm_off: Boolean(baseCycle.active_alarm_off),
    on_finalized: Boolean(baseCycle.on_finalized),
    off_finalized: Boolean(baseCycle.off_finalized)
  };

  if (!summary.planned_on) {
    const firstWithPlanOn = rows.find((row) => row.planned_on);
    if (firstWithPlanOn) summary.planned_on = firstWithPlanOn.planned_on;
  }

  if (!summary.planned_off) {
    const firstWithPlanOff = rows.find((row) => row.planned_off);
    if (firstWithPlanOff) summary.planned_off = firstWithPlanOff.planned_off;
  }

  if (!summary.cycle_date && summary.planned_on) {
    summary.cycle_date = deriveCycleDateFromPlannedOn(summary.planned_on);
  }

  if (!summary.actual_on) {
    const onRow = pickBestCycleEvent(rows, "zmiana_on", "planned_on", summary.planned_on);
    if (onRow) {
      summary.actual_on = onRow.timestamp_real || null;
      summary.lux_on = onRow.lux ?? null;
      summary.diff_on_s = onRow.difference_s ?? null;
    }
  }

  if (!summary.actual_off) {
    const offRow = pickBestCycleEvent(rows, "zmiana_off", "planned_off", summary.planned_off);
    if (offRow) {
      summary.actual_off = offRow.timestamp_real || null;
      summary.lux_off = offRow.lux ?? null;
      summary.diff_off_s = offRow.difference_s ?? null;
    }
  }

  if (!summary.alarm_on) {
    summary.alarm_on = rows.some(
      (row) =>
        row.type === "alarm_brak_zalaczenia" &&
        (!summary.planned_on || row.planned_on === summary.planned_on)
    );
  }

  if (!summary.alarm_off) {
    summary.alarm_off = rows.some(
      (row) =>
        row.type === "alarm_brak_wylaczenia" &&
        (!summary.planned_off || row.planned_off === summary.planned_off)
    );
  }

  if (summary.actual_on) {
    summary.active_alarm_on = false;
  }

  if (summary.actual_off) {
    summary.active_alarm_off = false;
  }

  return summary;
}

function buildReportCsv(report) {
  const summary = report.summary;
  const lines = [];

  lines.push("sekcja,klucz,wartosc");
  lines.push(`podsumowanie,device_id,${csvEscape(summary.device_id)}`);
  lines.push(`podsumowanie,cycle_date,${csvEscape(summary.cycle_date)}`);
  lines.push(`podsumowanie,planned_on,${csvEscape(summary.planned_on)}`);
  lines.push(`podsumowanie,actual_on,${csvEscape(summary.actual_on)}`);
  lines.push(`podsumowanie,diff_on_s,${csvEscape(summary.diff_on_s)}`);
  lines.push(`podsumowanie,lux_on,${csvEscape(summary.lux_on)}`);
  lines.push(`podsumowanie,planned_off,${csvEscape(summary.planned_off)}`);
  lines.push(`podsumowanie,actual_off,${csvEscape(summary.actual_off)}`);
  lines.push(`podsumowanie,diff_off_s,${csvEscape(summary.diff_off_s)}`);
  lines.push(`podsumowanie,lux_off,${csvEscape(summary.lux_off)}`);
  lines.push(`podsumowanie,alarm_on,${csvEscape(summary.alarm_on ? 1 : 0)}`);
  lines.push(`podsumowanie,alarm_off,${csvEscape(summary.alarm_off ? 1 : 0)}`);
  lines.push(`podsumowanie,active_alarm_on,${csvEscape(summary.active_alarm_on ? 1 : 0)}`);
  lines.push(`podsumowanie,active_alarm_off,${csvEscape(summary.active_alarm_off ? 1 : 0)}`);
  lines.push(`podsumowanie,on_finalized,${csvEscape(summary.on_finalized ? 1 : 0)}`);
  lines.push(`podsumowanie,off_finalized,${csvEscape(summary.off_finalized ? 1 : 0)}`);
  lines.push(`podsumowanie,range_start,${csvEscape(report.range.start)}`);
  lines.push(`podsumowanie,range_end,${csvEscape(report.range.end)}`);
  lines.push(`podsumowanie,record_count,${csvEscape(report.rows.length)}`);
  if (report.expected_cycle_window_count !== undefined && report.expected_cycle_window_count !== null) {
    lines.push(`podsumowanie,expected_cycle_window_count,${csvEscape(report.expected_cycle_window_count)}`);
  }
  lines.push("");

  lines.push("id,device_id,timestamp_real,type,lux,state,planned_on,planned_off,difference_s,received_at");

  for (const row of report.rows) {
    lines.push([
      csvEscape(row.id),
      csvEscape(row.device_id),
      csvEscape(row.timestamp_real),
      csvEscape(row.type),
      csvEscape(row.lux),
      csvEscape(row.state),
      csvEscape(row.planned_on),
      csvEscape(row.planned_off),
      csvEscape(row.difference_s),
      csvEscape(row.received_at)
    ].join(","));
  }

  return lines.join("\n");
}

async function findReportCycleAnchor({ cycleDate = null, deviceId = null } = {}) {
  const params = [];
  let paramIndex = 1;

  let query = `
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
    WHERE planned_on IS NOT NULL
      AND planned_on <> ''
      AND planned_off IS NOT NULL
      AND planned_off <> ''
  `;

  if (deviceId) {
    query += ` AND device_id = $${paramIndex} `;
    params.push(deviceId);
    paramIndex += 1;
  }

  if (cycleDate) {
    query += ` AND planned_on LIKE $${paramIndex} `;
    params.push(`${cycleDate}%`);
    paramIndex += 1;
  }

  query += `
    ORDER BY
      planned_on DESC,
      CASE type
        WHEN 'zmiana_on' THEN 1
        WHEN 'zmiana_off' THEN 2
        WHEN 'alarm_brak_zalaczenia' THEN 3
        WHEN 'alarm_brak_wylaczenia' THEN 4
        WHEN 'pomiar' THEN 5
        ELSE 99
      END ASC,
      timestamp_real DESC,
      id DESC
    LIMIT 1
  `;

  const result = await pool.query(query, params);
  if (!result.rows.length) return null;

  const row = result.rows[0];

  return {
    id: row.id,
    device_id: row.device_id || deviceId || currentCycle.device_id || deviceStatus.device_id || "szafa_01",
    planned_on: row.planned_on,
    planned_off: row.planned_off,
    cycle_date: deriveCycleDateFromPlannedOn(row.planned_on) || cycleDate || formatWarsawDateOnly(),
    source_type: row.type,
    timestamp_real: row.timestamp_real
  };
}

async function createReportFromDatabaseCycle(options = {}) {
  const preferredDeviceId =
    options.deviceId ||
    currentCycle.device_id ||
    deviceStatus.device_id ||
    "szafa_01";

  const anchor = await findReportCycleAnchor({
    cycleDate: options.cycleDate || null,
    deviceId: preferredDeviceId
  });

  if (anchor) {
    const range = resolveReportRange({
      cycleDate: anchor.cycle_date,
      plannedOn: anchor.planned_on,
      plannedOff: anchor.planned_off
    });

    const rows = await getLogsForRange(range, anchor.device_id);
    const expectedCycleWindowCount = await countLogsForCycleWindow({
      plannedOn: anchor.planned_on,
      plannedOff: anchor.planned_off,
      deviceId: anchor.device_id
    });

    const summary = buildReportSummary(rows, {
      device_id: anchor.device_id,
      cycle_date: anchor.cycle_date,
      planned_on: anchor.planned_on,
      planned_off: anchor.planned_off,
      actual_on: null,
      actual_off: null,
      lux_on: null,
      lux_off: null,
      diff_on_s: null,
      diff_off_s: null,
      alarm_on: false,
      alarm_off: false,
      active_alarm_on: Boolean(currentCycle.active_alarm_on && currentCycle.planned_on === anchor.planned_on),
      active_alarm_off: Boolean(currentCycle.active_alarm_off && currentCycle.planned_off === anchor.planned_off),
      on_finalized: Boolean(currentCycle.on_finalized && currentCycle.planned_on === anchor.planned_on),
      off_finalized: Boolean(currentCycle.off_finalized && currentCycle.planned_off === anchor.planned_off)
    });

    const report = {
      generated_at: new Date().toISOString(),
      source: "database_cycle_anchor",
      anchor,
      range,
      summary,
      rows,
      expected_cycle_window_count: expectedCycleWindowCount
    };

    report.csv = buildReportCsv(report);
    report.fileName = buildReportFileName(summary.cycle_date);

    return report;
  }

  const baseCycle = { ...currentCycle };

  const selectedCycleDate =
    options.cycleDate ||
    baseCycle.cycle_date ||
    deriveCycleDateFromPlannedOn(baseCycle.planned_on) ||
    extractCycleDate(baseCycle.planned_on) ||
    formatWarsawDateOnly();

  const plannedOn = options.plannedOn || baseCycle.planned_on || deviceStatus.planned_on || null;
  const plannedOff = options.plannedOff || baseCycle.planned_off || deviceStatus.planned_off || null;
  const deviceId = preferredDeviceId;

  const range = resolveReportRange({
    cycleDate: selectedCycleDate,
    plannedOn,
    plannedOff
  });

  const rows = await getLogsForRange(range, deviceId);
  const expectedCycleWindowCount = await countLogsForCycleWindow({
    plannedOn,
    plannedOff,
    deviceId
  });

  const summary = buildReportSummary(rows, {
    ...baseCycle,
    cycle_date: selectedCycleDate,
    planned_on: plannedOn,
    planned_off: plannedOff,
    device_id: deviceId
  });

  const report = {
    generated_at: new Date().toISOString(),
    source: "current_cycle_fallback",
    anchor: null,
    range,
    summary,
    rows,
    expected_cycle_window_count: expectedCycleWindowCount
  };

  report.csv = buildReportCsv(report);
  report.fileName = buildReportFileName(summary.cycle_date);

  return report;
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

function buildReportAnalytics(rows, plannedOn, plannedOff) {
  const parsedPlannedOn = parseTimestampString(plannedOn);
  const parsedPlannedOff = parseTimestampString(plannedOff);

  const beforeOnRows = parsedPlannedOn
    ? rows.filter((row) => {
        const rowDate = parseTimestampString(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= addHours(parsedPlannedOn, -1) && rowDate <= parsedPlannedOn;
      })
    : [];

  const afterOnRows = parsedPlannedOn
    ? rows.filter((row) => {
        const rowDate = parseTimestampString(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= parsedPlannedOn && rowDate <= addHours(parsedPlannedOn, 1);
      })
    : [];

  const beforeOffRows = parsedPlannedOff
    ? rows.filter((row) => {
        const rowDate = parseTimestampString(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= addHours(parsedPlannedOff, -1) && rowDate <= parsedPlannedOff;
      })
    : [];

  const afterOffRows = parsedPlannedOff
    ? rows.filter((row) => {
        const rowDate = parseTimestampString(row.timestamp_real);
        return row.type === "pomiar" && rowDate && rowDate >= parsedPlannedOff && rowDate <= addHours(parsedPlannedOff, 1);
      })
    : [];

  return {
    before_on: calculateLuxStats(beforeOnRows),
    after_on: calculateLuxStats(afterOnRows),
    before_off: calculateLuxStats(beforeOffRows),
    after_off: calculateLuxStats(afterOffRows)
  };
}

async function saveReportToDatabase(report, emailTo, reportType = "manual_send", providerMessageId = null) {
  const summary = report.summary;

  const result = await pool.query(
    `
    INSERT INTO daily_reports
    (
      device_id,
      cycle_date,
      report_type,
      email_to,
      planned_on,
      planned_off,
      actual_on,
      actual_off,
      diff_on_s,
      diff_off_s,
      lux_on,
      lux_off,
      alarm_on,
      alarm_off,
      record_count,
      range_start,
      range_end,
      csv_content,
      provider_message_id
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id, created_at
    `,
    [
      summary.device_id,
      summary.cycle_date,
      reportType,
      emailTo || null,
      summary.planned_on,
      summary.planned_off,
      summary.actual_on,
      summary.actual_off,
      toNumberOrNull(summary.diff_on_s),
      toNumberOrNull(summary.diff_off_s),
      toNumberOrNull(summary.lux_on),
      toNumberOrNull(summary.lux_off),
      Boolean(summary.alarm_on),
      Boolean(summary.alarm_off),
      report.rows.length,
      report.range.start,
      report.range.end,
      report.csv,
      providerMessageId
    ]
  );

  return result.rows[0];
}

async function sendReportEmailViaBrevoApi(report, emailTo) {
  const apiKey = process.env.BREVO_API_KEY || process.env.SMTP_PASS;
  const from = process.env.REPORT_EMAIL_FROM;
  const fromName = process.env.REPORT_EMAIL_FROM_NAME || "LUMOS";
  const toAddress = emailTo || process.env.REPORT_EMAIL_TO;

  if (!apiKey) {
    throw new Error("Brak BREVO_API_KEY. Ustaw BREVO_API_KEY w Railway.");
  }

  if (!from) {
    throw new Error("Brak REPORT_EMAIL_FROM. Ustaw REPORT_EMAIL_FROM w Railway.");
  }

  if (!toAddress) {
    throw new Error("Brak adresu odbiorcy raportu.");
  }

  const payload = {
    sender: {
      name: fromName,
      email: from
    },
    to: [
      {
        email: toAddress
      }
    ],
    subject: `LUMOS / SSO raport ${report.summary.cycle_date || ""} [${report.summary.device_id || "urzadzenie"}]`,
    htmlContent: buildMailHtml(report),
    textContent: buildMailText(report),
    attachment: [
      {
        name: report.fileName,
        content: toBase64Utf8(report.csv)
      }
    ]
  };

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const details =
      data?.message ||
      data?.code ||
      data?.raw ||
      `Brevo API error ${response.status}`;

    throw new Error(details);
  }

  return data;
}

async function generateAndSendReport({
  emailTo,
  reportType = "manual_send",
  resetCycleAfterSend = false,
  cycleDate = null
} = {}) {
  finalizeCycleParts();

  const finalEmail = emailTo || process.env.REPORT_EMAIL_TO;

  const report = await createReportFromDatabaseCycle({
    cycleDate
  });

  const providerResponse = await sendReportEmailViaBrevoApi(report, finalEmail);
  const providerMessageId = providerResponse?.messageId || null;
  const saved = await saveReportToDatabase(report, finalEmail, reportType, providerMessageId);

  if (resetCycleAfterSend) {
    resetCurrentCycle();
    applyConfigToDeviceShadow();
  }

  return {
    report,
    saved,
    providerResponse,
    email_to: finalEmail
  };
}

function startAutoReportScheduler() {
  const enabled = String(process.env.AUTO_REPORT_ENABLED || "true").toLowerCase() !== "false";

  if (!enabled) {
    console.log("Auto-raport 10:00 wyłączony przez AUTO_REPORT_ENABLED=false");
    return;
  }

  setInterval(async () => {
    try {
      finalizeCycleParts();

      const nowWarsaw = formatWarsawDateTime(new Date());
      const datePart = nowWarsaw.slice(0, 10);
      const hourPart = nowWarsaw.slice(11, 13);
      const minutePart = nowWarsaw.slice(14, 16);
      const autoKey = `${datePart} ${hourPart}:${minutePart}`;

      if (hourPart === "10" && minutePart === "00" && lastAutoReportKey !== autoKey) {
        lastAutoReportKey = autoKey;

        console.log(`[AUTO REPORT] Start ${autoKey}`);

        try {
          const result = await generateAndSendReport({
            emailTo: process.env.REPORT_EMAIL_TO,
            reportType: "auto_10_00",
            resetCycleAfterSend: true
          });

          console.log(
            `[AUTO REPORT] Wysłano raport ID=${result.saved.id} na ${result.email_to || "-"}`
          );
        } catch (sendError) {
          console.error("[AUTO REPORT] Błąd generowania lub wysyłki raportu:", sendError);
        }
      }
    } catch (error) {
      console.error("[AUTO REPORT] Błąd schedulera:", error);
    }
  }, 30000);
}

async function getLatestLogEntry(deviceId = null) {
  const params = [];
  let query = `
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
  `;

  if (deviceId) {
    params.push(deviceId);
    query += ` WHERE device_id = $1 `;
  }

  query += ` ORDER BY id DESC LIMIT 1 `;

  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

async function getAlarmRows(limit = DASHBOARD_ALARMS_LIMIT, deviceId = null) {
  const safeLimit = toIntWithinRange(limit, DASHBOARD_ALARMS_LIMIT, 1, 100);
  const params = [];
  let query = `
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
  `;

  if (deviceId) {
    params.push(deviceId);
    query += ` AND device_id = $${params.length} `;
  }

  params.push(safeLimit);
  query += ` ORDER BY id DESC LIMIT $${params.length} `;

  const result = await pool.query(query, params);
  return result.rows;
}

async function getStats(deviceId = null) {
  const buildCountQuery = (type = null) => {
    const params = [];
    let query = "SELECT COUNT(*)::int AS count FROM lighting_logs";
    const conditions = [];

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }

    if (deviceId) {
      params.push(deviceId);
      conditions.push(`device_id = $${params.length}`);
    }

    if (conditions.length) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    return { query, params };
  };

  const totalQ = buildCountQuery();
  const pomiarQ = buildCountQuery("pomiar");
  const onQ = buildCountQuery("zmiana_on");
  const offQ = buildCountQuery("zmiana_off");
  const pozaQ = buildCountQuery("zmiana_poza_oknem");
  const alarmOnQ = buildCountQuery("alarm_brak_zalaczenia");
  const alarmOffQ = buildCountQuery("alarm_brak_wylaczenia");
  const testQ = buildCountQuery("test_manual");

  const [
    totalResult,
    pomiarResult,
    onResult,
    offResult,
    pozaResult,
    alarmOnResult,
    alarmOffResult,
    testResult
  ] = await Promise.all([
    pool.query(totalQ.query, totalQ.params),
    pool.query(pomiarQ.query, pomiarQ.params),
    pool.query(onQ.query, onQ.params),
    pool.query(offQ.query, offQ.params),
    pool.query(pozaQ.query, pozaQ.params),
    pool.query(alarmOnQ.query, alarmOnQ.params),
    pool.query(alarmOffQ.query, alarmOffQ.params),
    pool.query(testQ.query, testQ.params)
  ]);

  return {
    total: totalResult.rows[0].count,
    pomiar: pomiarResult.rows[0].count,
    zmiana_on: onResult.rows[0].count,
    zmiana_off: offResult.rows[0].count,
    zmiana_poza_oknem: pozaResult.rows[0].count,
    alarm_brak_zalaczenia: alarmOnResult.rows[0].count,
    alarm_brak_wylaczenia: alarmOffResult.rows[0].count,
    test_manual: testResult.rows[0].count
  };
}

async function getHistoryRows({
  deviceId = null,
  type = null,
  onlyAlarms = false,
  cycleKey = null,
  limit = HISTORY_DEFAULT_LIMIT,
  offset = 0
} = {}) {
  const safeLimit = toIntWithinRange(limit, HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT);
  const safeOffset = toIntWithinRange(offset, 0, 0, 1000000);

  const params = [];
  const conditions = [];

  let query = `
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
  `;

  if (deviceId) {
    params.push(deviceId);
    conditions.push(`device_id = $${params.length}`);
  }

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  if (onlyAlarms) {
    conditions.push(`type IN ('alarm_brak_zalaczenia', 'alarm_brak_wylaczenia')`);
  }

  if (cycleKey) {
    const [plannedOn = "", plannedOff = ""] = String(cycleKey).split("|");
    if (plannedOn && plannedOff) {
      params.push(plannedOn);
      conditions.push(`planned_on = $${params.length}`);
      params.push(plannedOff);
      conditions.push(`planned_off = $${params.length}`);
    }
  }

  if (conditions.length) {
    query += ` WHERE ${conditions.join(" AND ")} `;
  }

  params.push(safeLimit);
  params.push(safeOffset);

  query += `
    ORDER BY id DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  const rowsResult = await pool.query(query, params);

  const countParams = params.slice(0, -2);
  let countQuery = `SELECT COUNT(*)::int AS count FROM lighting_logs`;
  if (conditions.length) {
    countQuery += ` WHERE ${conditions.join(" AND ")} `;
  }
  const countResult = await pool.query(countQuery, countParams);

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0]?.count ?? 0,
    limit: safeLimit,
    offset: safeOffset
  };
}

async function getReportCycles({ deviceId = null, limit = REPORT_CYCLES_LIMIT } = {}) {
  const safeLimit = toIntWithinRange(limit, REPORT_CYCLES_LIMIT, 1, 1000);
  const params = [];
  let query = `
    SELECT
      planned_on,
      planned_off,
      MAX(device_id) AS device_id,
      MAX(timestamp_real) AS latest_timestamp,
      COUNT(*)::int AS row_count
    FROM lighting_logs
    WHERE planned_on IS NOT NULL
      AND planned_on <> ''
      AND planned_off IS NOT NULL
      AND planned_off <> ''
  `;

  if (deviceId) {
    params.push(deviceId);
    query += ` AND device_id = $${params.length} `;
  }

  params.push(safeLimit);

  query += `
    GROUP BY planned_on, planned_off
    ORDER BY planned_on DESC, planned_off DESC
    LIMIT $${params.length}
  `;

  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    key: `${row.planned_on}|${row.planned_off}`,
    device_id: row.device_id,
    cycle_date: deriveCycleDateFromPlannedOn(row.planned_on),
    planned_on: row.planned_on,
    planned_off: row.planned_off,
    latest_timestamp: row.latest_timestamp,
    row_count: row.row_count
  }));
}

async function getCycleReportByKey(cycleKey, deviceId = null) {
  const [plannedOn = "", plannedOff = ""] = String(cycleKey || "").split("|");

  if (!plannedOn || !plannedOff) {
    throw new Error("Nieprawidłowy cycle_key.");
  }

  const cycleDate = deriveCycleDateFromPlannedOn(plannedOn) || formatWarsawDateOnly();
  const range = resolveReportRange({
    cycleDate,
    plannedOn,
    plannedOff
  });

  const rows = await getLogsForRange(range, deviceId || currentCycle.device_id || deviceStatus.device_id || "szafa_01");
  const filteredRows = rows.filter((row) => row.planned_on === plannedOn && row.planned_off === plannedOff);

  const summary = buildReportSummary(filteredRows.length ? filteredRows : rows, {
    device_id: deviceId || currentCycle.device_id || deviceStatus.device_id || "szafa_01",
    cycle_date: cycleDate,
    planned_on: plannedOn,
    planned_off: plannedOff,
    actual_on: null,
    actual_off: null,
    lux_on: null,
    lux_off: null,
    diff_on_s: null,
    diff_off_s: null,
    alarm_on: false,
    alarm_off: false,
    active_alarm_on: Boolean(currentCycle.active_alarm_on && currentCycle.planned_on === plannedOn),
    active_alarm_off: Boolean(currentCycle.active_alarm_off && currentCycle.planned_off === plannedOff),
    on_finalized: Boolean(currentCycle.on_finalized && currentCycle.planned_on === plannedOn),
    off_finalized: Boolean(currentCycle.off_finalized && currentCycle.planned_off === plannedOff)
  });

  const analytics = buildReportAnalytics(filteredRows.length ? filteredRows : rows, plannedOn, plannedOff);

  return {
    cycle_key: cycleKey,
    range,
    summary,
    analytics,
    rows: filteredRows.length ? filteredRows : rows,
    file_name: buildReportFileName(cycleDate)
  };
}

function getCurrentAlarmStatus() {
  let activeAlarmOn = Boolean(currentCycle.active_alarm_on);
  let activeAlarmOff = Boolean(currentCycle.active_alarm_off);

  if (deviceStatus && (deviceStatus.state === 0 || deviceStatus.state === 1)) {
    activeAlarmOn = false;
    activeAlarmOff = false;
  }

  return {
    active_alarm_on: activeAlarmOn,
    active_alarm_off: activeAlarmOff,
    has_active_alarm: Boolean(activeAlarmOn || activeAlarmOff)
  };
}

async function buildDashboardPayload(deviceId = null) {
  finalizeCycleParts();

  const [latest, stats, alarms] = await Promise.all([
    getLatestLogEntry(deviceId),
    getStats(deviceId),
    getAlarmRows(DASHBOARD_ALARMS_LIMIT, deviceId)
  ]);

  return {
    device_status: deviceStatus,
    current_cycle: currentCycle,
    alarm_status: getCurrentAlarmStatus(),
    latest,
    stats,
    alarms
  };
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

    if (entry.device_id) deviceStatus.device_id = entry.device_id;
    if (entry.timestamp_real) deviceStatus.timestamp_real = entry.timestamp_real;
    if (entry.state !== undefined) deviceStatus.state = entry.state;
    if (entry.lux !== undefined) deviceStatus.lux = entry.lux;

    finalizeCycleParts();

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

  if (req.body.planned_on) {
    currentCycle.planned_on = req.body.planned_on;
    currentCycle.cycle_date =
      deriveCycleDateFromPlannedOn(req.body.planned_on) ||
      currentCycle.cycle_date;
  }

  if (req.body.planned_off) currentCycle.planned_off = req.body.planned_off;
  if (req.body.device_id) currentCycle.device_id = req.body.device_id;

  if (!currentCycle.cycle_date && req.body.timestamp_real) {
    currentCycle.cycle_date = extractCycleDate(req.body.timestamp_real);
  }

  finalizeCycleParts();
  currentCycle.updated_at = new Date().toISOString();

  res.json({
    status: "ok",
    deviceStatus
  });
});

app.get("/api/device-status", (req, res) => {
  finalizeCycleParts();
  res.json(deviceStatus);
});

app.get("/api/current-cycle", (req, res) => {
  finalizeCycleParts();
  res.json(currentCycle);
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const payload = await buildDashboardPayload(req.query.device_id || null);
    res.json(payload);
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    res.status(500).json({ error: "Błąd pobierania danych dashboardu." });
  }
});

app.post("/api/current-cycle/reset", (req, res) => {
  resetCurrentCycle();
  applyConfigToDeviceShadow();

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

app.get("/api/history", async (req, res) => {
  try {
    const type = sanitizeTypeFilter(req.query.type);
    const onlyAlarms = toBoolean(req.query.only_alarms);
    const deviceId = req.query.device_id || null;
    const cycleKey = req.query.cycle_key || null;
    const limit = req.query.limit;
    const offset = req.query.offset;

    const result = await getHistoryRows({
      deviceId,
      type,
      onlyAlarms,
      cycleKey,
      limit,
      offset
    });

    res.json({
      status: "ok",
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      rows: result.rows
    });
  } catch (error) {
    console.error("GET /api/history error:", error);
    res.status(500).json({ error: "Błąd odczytu historii danych." });
  }
});

app.get("/api/data/latest", async (req, res) => {
  try {
    const latest = await getLatestLogEntry(req.query.device_id || null);

    if (!latest) {
      return res.status(404).json({ error: "Brak danych" });
    }

    res.json(latest);
  } catch (error) {
    console.error("GET /api/data/latest error:", error);
    res.status(500).json({ error: "Błąd odczytu ostatniego rekordu." });
  }
});

app.get("/api/alarms", async (req, res) => {
  try {
    const result = await getAlarmRows(1000, req.query.device_id || null);
    res.json(result.slice().reverse());
  } catch (error) {
    console.error("GET /api/alarms error:", error);
    res.status(500).json({ error: "Błąd odczytu alarmów." });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const stats = await getStats(req.query.device_id || null);
    res.json(stats);
  } catch (error) {
    console.error("GET /api/stats error:", error);
    res.status(500).json({ error: "Błąd statystyk." });
  }
});

app.get("/api/check-status", async (req, res) => {
  try {
    const latest = await getLatestLogEntry(req.query.device_id || null);

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

  applyConfigToDeviceShadow();

  res.json({
    status: "ok",
    config,
    deviceStatus,
    currentCycle
  });
});

app.post("/api/force", async (req, res) => {
  try {
    const { state } = req.body;

    if (state !== 0 && state !== 1) {
      return res.status(400).json({ error: "Nieprawidłowy stan. Użyj 0 lub 1." });
    }

    const timestamp = formatWarsawDateTime(new Date());

    const entry = {
      device_id: "szafa_01",
      timestamp_real: timestamp,
      type: "test_manual",
      lux: null,
      state,
      planned_on: config.mode === "MANUAL" ? config.manual_on : deviceStatus.planned_on,
      planned_off: config.mode === "MANUAL" ? config.manual_off : deviceStatus.planned_off,
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

    deviceStatus.device_id = entry.device_id;
    deviceStatus.timestamp_real = entry.timestamp_real;
    deviceStatus.state = entry.state;
    deviceStatus.lux = entry.lux;

    finalizeCycleParts();

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

app.get("/api/report-cycles", async (req, res) => {
  try {
    const cycles = await getReportCycles({
      deviceId: req.query.device_id || null,
      limit: req.query.limit
    });

    res.json({
      status: "ok",
      rows: cycles
    });
  } catch (error) {
    console.error("GET /api/report-cycles error:", error);
    res.status(500).json({ error: "Błąd pobierania listy cykli raportowych." });
  }
});

app.get("/api/report-cycle", async (req, res) => {
  try {
    const cycleKey = req.query.cycle_key || null;

    if (!cycleKey) {
      return res.status(400).json({ error: "Brak cycle_key." });
    }

    const report = await getCycleReportByKey(cycleKey, req.query.device_id || null);

    res.json({
      status: "ok",
      cycle_key: report.cycle_key,
      summary: report.summary,
      analytics: report.analytics,
      range: report.range,
      rows_count: report.rows.length,
      file_name: report.file_name
    });
  } catch (error) {
    console.error("GET /api/report-cycle error:", error);
    res.status(500).json({ error: "Błąd pobierania szczegółów cyklu raportowego." });
  }
});

app.get("/api/reports/preview", async (req, res) => {
  try {
    finalizeCycleParts();

    const cycleDate = req.query.cycle_date || null;
    const report = await createReportFromDatabaseCycle({ cycleDate });

    res.json({
      status: "ok",
      source: report.source,
      summary: report.summary,
      range: report.range,
      rows_count: report.rows.length,
      expected_cycle_window_count: report.expected_cycle_window_count,
      file_name: report.fileName
    });
  } catch (error) {
    console.error("GET /api/reports/preview error:", error);
    res.status(500).json({ error: "Błąd generowania podglądu raportu." });
  }
});

app.get("/api/reports/csv", async (req, res) => {
  try {
    finalizeCycleParts();

    const cycleDate = req.query.cycle_date || null;
    const report = await createReportFromDatabaseCycle({ cycleDate });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${report.fileName}"`);
    res.send(report.csv);
  } catch (error) {
    console.error("GET /api/reports/csv error:", error);
    res.status(500).json({ error: "Błąd generowania pliku CSV." });
  }
});

app.post("/api/reports/send-now", async (req, res) => {
  try {
    const emailTo = req.body?.email_to || process.env.REPORT_EMAIL_TO || null;
    const resetCycleAfterSend = req.body?.reset_cycle_after_send === true;
    const cycleDate = req.body?.cycle_date || null;

    const result = await generateAndSendReport({
      emailTo,
      reportType: "manual_send",
      resetCycleAfterSend,
      cycleDate
    });

    res.json({
      status: "ok",
      message: "Raport został wygenerowany i wysłany mailem.",
      email_to: result.email_to,
      report_id: result.saved.id,
      created_at: result.saved.created_at,
      provider_message_id: result.providerResponse?.messageId || null,
      source: result.report.source,
      summary: result.report.summary,
      range: result.report.range,
      rows_count: result.report.rows.length,
      expected_cycle_window_count: result.report.expected_cycle_window_count,
      file_name: result.report.fileName
    });
  } catch (error) {
    console.error("POST /api/reports/send-now error:", error);
    res.status(500).json({
      error: "Błąd generowania lub wysyłki raportu.",
      details: error.message
    });
  }
});

app.get("/api/reports/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        device_id,
        cycle_date,
        report_type,
        email_to,
        planned_on,
        planned_off,
        actual_on,
        actual_off,
        diff_on_s,
        diff_off_s,
        lux_on,
        lux_off,
        alarm_on,
        alarm_off,
        record_count,
        range_start,
        range_end,
        provider_message_id,
        created_at
      FROM daily_reports
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/reports/history error:", error);
    res.status(500).json({ error: "Błąd odczytu historii raportów." });
  }
});

app.get("/api/reports/history/:id/csv", async (req, res) => {
  try {
    const reportId = Number(req.params.id);

    if (!Number.isInteger(reportId)) {
      return res.status(400).json({ error: "Nieprawidłowe ID raportu." });
    }

    const result = await pool.query(
      `
      SELECT id, cycle_date, csv_content
      FROM daily_reports
      WHERE id = $1
      LIMIT 1
      `,
      [reportId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Nie znaleziono raportu." });
    }

    const row = result.rows[0];
    const fileName = buildReportFileName(row.cycle_date);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(row.csv_content || "");
  } catch (error) {
    console.error("GET /api/reports/history/:id/csv error:", error);
    res.status(500).json({ error: "Błąd pobierania archiwalnego CSV." });
  }
});

app.post("/api/admin/clear-data", async (req, res) => {
  try {
    await pool.query("TRUNCATE TABLE lighting_logs RESTART IDENTITY");
    resetCurrentCycle();
    applyConfigToDeviceShadow();

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
    applyConfigToDeviceShadow();
    startAutoReportScheduler();

    app.listen(PORT, () => {
      console.log(`Server działa na porcie ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Błąd inicjalizacji PostgreSQL:", error);
    process.exit(1);
  });

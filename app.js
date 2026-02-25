const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
const cron = require('node-cron');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const CABA_LAT = -34.61;
const CABA_LON = -58.38;

const CACHE_MAX_MINUTES = 65;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_PARAMS = {
  latitude: CABA_LAT,
  longitude: CABA_LON,
  hourly: 'weather_code,temperature_2m',
  forecast_days: 3,
  timezone: 'America/Argentina/Buenos_Aires',
};

let latestWeather = { xml: null, timestamp: null, isDegraded: false };
let refreshPromise = null;

function nowBA() {
  return DateTime.now().setZone('America/Argentina/Buenos_Aires');
}

function safeText(input) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 240 ? s.slice(0, 240).trim() : s;
}

function buildXmlFromSayLines(lines) {
  const root = xmlbuilder.create('Response');
  for (const line of lines) {
    const t = safeText(line);
    if (t) root.ele('Say', {}, t);
  }
  return root.end({ pretty: true });
}

function ensureDegradedXmlIfEmpty() {
  if (latestWeather?.xml && latestWeather.isDegraded === false) return;

  const t = nowBA().toFormat('HH:mm');
  latestWeather = {
    xml: buildXmlFromSayLines(['Capital Federal.', 'Clima no disponible por el momento.', `Actualizado ${t}.`]),
    timestamp: Date.now(),
    isDegraded: true,
  };
}

function weatherCodeToSpanish(code) {
  const c = Number(code);
  if (Number.isNaN(c)) return '';
  if (c === 0) return 'cielo despejado';
  if (c === 1) return 'mayormente despejado';
  if (c === 2) return 'parcialmente nublado';
  if (c === 3) return 'nublado';
  if (c === 45 || c === 48) return 'niebla';
  if (c === 51 || c === 53 || c === 55) return 'llovizna';
  if (c === 56 || c === 57) return 'llovizna helada';
  if (c === 61 || c === 63 || c === 65) return 'lluvia';
  if (c === 66 || c === 67) return 'lluvia helada';
  if (c === 71 || c === 73 || c === 75) return 'nieve';
  if (c === 77) return 'granizo';
  if (c === 80 || c === 81 || c === 82) return 'chaparrones';
  if (c === 85 || c === 86) return 'chaparrones de nieve';
  if (c === 95) return 'tormenta';
  if (c === 96 || c === 99) return 'tormenta con granizo';
  return '';
}

function pickMostFrequent(arr) {
  const freq = new Map();
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const k = String(n);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [k, c] of freq.entries()) {
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  return best !== null ? Number(best) : null;
}

function minMaxRounded(arr) {
  const nums = arr.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return { min: Math.round(Math.min(...nums)), max: Math.round(Math.max(...nums)) };
}

function dayParts() {
  return [
    { key: 'madrugada', from: 0, to: 6 },
    { key: 'mañana', from: 6, to: 12 },
    { key: 'tarde', from: 12, to: 18 },
    { key: 'noche', from: 18, to: 24 },
  ];
}

function currentPartKey(dt) {
  const h = dt.hour;
  if (h >= 0 && h < 6) return 'madrugada';
  if (h >= 6 && h < 12) return 'mañana';
  if (h >= 12 && h < 18) return 'tarde';
  return 'noche';
}

function weekdayEs(dt) {
  return dt.setLocale('es').toFormat('cccc').toLowerCase();
}

function dayHeaderForOffset(baseDay, offsetDays) {
  const dt = baseDay.plus({ days: offsetDays });
  const wd = weekdayEs(dt);
  if (offsetDays === 0) return `Hoy ${wd}.`;
  if (offsetDays === 1) return `El ${wd}.`;
  return `El ${wd}.`;
}

function segmentMomentLabel(segKey, isActual) {
  const needsLa = segKey === 'madrugada' || segKey === 'tarde' || segKey === 'noche';
  const base = needsLa ? `en la ${segKey}` : segKey;
  return isActual ? `${base} actual` : base;
}

function buildSegmentsForDay(targetDateISO, hourlyTime, hourlyCode, hourlyTemp) {
  const parts = dayParts();
  const out = [];

  for (const p of parts) {
    const codes = [];
    const temps = [];

    for (let i = 0; i < hourlyTime.length; i++) {
      const dt = DateTime.fromISO(String(hourlyTime[i]), { zone: 'America/Argentina/Buenos_Aires' });
      if (!dt.isValid) continue;
      if (dt.toISODate() !== targetDateISO) continue;
      const h = dt.hour;
      if (h >= p.from && h < p.to) {
        codes.push(hourlyCode[i]);
        temps.push(hourlyTemp[i]);
      }
    }

    const code = pickMostFrequent(codes);
    const desc = weatherCodeToSpanish(code);
    const mm = minMaxRounded(temps);

    if (!desc && !mm) continue;

    out.push({
      key: p.key,
      desc: desc || '',
      mm,
    });
  }

  return out;
}

async function refreshFromOpenMeteo() {
  const resp = await axios.get(OPEN_METEO_URL, {
    timeout: 10_000,
    params: OPEN_METEO_PARAMS,
  });

  const data = resp.data || {};
  const hourly = data.hourly || {};

  const hTime = Array.isArray(hourly.time) ? hourly.time : [];
  const hCode = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const hTemp = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];

  const baseDay = nowBA().startOf('day');
  const now = nowBA();
  const nowKey = currentPartKey(now);

  const parts = dayParts();
  const nowFrom = parts.find((p) => p.key === nowKey)?.from ?? 0;

  const lines = [];
  lines.push('Capital Federal.');

  for (let d = 0; d < 3; d++) {
    const dateISO = baseDay.plus({ days: d }).toISODate();
    const segments = buildSegmentsForDay(dateISO, hTime, hCode, hTemp);

    const filtered =
      d === 0
        ? segments.filter((s) => (parts.find((p) => p.key === s.key)?.from ?? 0) >= nowFrom)
        : segments;

    if (!filtered.length) continue;

    lines.push(dayHeaderForOffset(baseDay, d));

    for (const seg of filtered) {
      const isActual = d === 0 && seg.key === nowKey;
      const momentLabel = segmentMomentLabel(seg.key, isActual);

      const bits = [];
      bits.push(`${momentLabel}:`);
      if (seg.desc) bits.push(`${safeText(seg.desc)}.`);
      if (seg.mm) bits.push(`Entre ${seg.mm.min} y ${seg.mm.max} grados.`);
      lines.push(bits.join(' '));
    }
  }

  lines.push(`Actualizado ${nowBA().toFormat('HH:mm')}.`);

  latestWeather = { xml: buildXmlFromSayLines(lines), timestamp: Date.now(), isDegraded: false };
  return latestWeather;
}

async function refreshWithLock() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      return await refreshFromOpenMeteo();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

app.get('/', (_req, res) => res.status(200).send('ok'));

app.post('/weather/update', async (_req, res) => {
  try {
    await refreshWithLock();
    res.json({ ok: true, message: 'Weather refreshed.' });
  } catch (err) {
    ensureDegradedXmlIfEmpty();
    res.status(502).json({ ok: false, error: err?.message });
  }
});

app.get('/weather/voice', async (_req, res) => {
  const ageMin = latestWeather?.timestamp ? (Date.now() - latestWeather.timestamp) / 60000 : null;
  const shouldRefresh = !latestWeather?.xml || ageMin === null || ageMin > CACHE_MAX_MINUTES;

  if (shouldRefresh) {
    try {
      await refreshWithLock();
    } catch (_) {
      ensureDegradedXmlIfEmpty();
    }
  }

  res.type('application/xml').send(latestWeather.xml);
});

cron.schedule(
  '0 * * * *',
  async () => {
    try {
      await refreshWithLock();
    } catch (_) {
      ensureDegradedXmlIfEmpty();
    }
  },
  { timezone: 'America/Argentina/Buenos_Aires' }
);

app.listen(PORT, async () => {
  try {
    await refreshWithLock();
  } catch (_) {
    ensureDegradedXmlIfEmpty();
  }
});
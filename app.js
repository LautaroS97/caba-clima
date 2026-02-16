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
  hourly: 'weather_code,temperature_2m,relative_humidity_2m',
  forecast_days: 3,
  timezone: 'America/Argentina/Buenos_Aires',
};

let latestWeather = { xml: null, timestamp: null };
let refreshPromise = null;

function nowBA() {
  return DateTime.now().setZone('America/Argentina/Buenos_Aires');
}

function safeText(input) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 240 ? s.slice(0, 240).trim() : s;
}

function buildXml(text) {
  return xmlbuilder.create('Response').ele('Say', {}, safeText(text)).end({ pretty: true });
}

function ensureDegradedXml() {
  const t = nowBA().toFormat('HH:mm');
  latestWeather = {
    xml: buildXml(`Clima para Capital Federal no disponible por el momento. Actualizado ${t}.`),
    timestamp: Date.now(),
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

function roundNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
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

function avgRounded(arr) {
  const nums = arr.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round(sum / nums.length);
}

function dayLabel(i) {
  if (i === 0) return 'Hoy';
  if (i === 1) return 'Mañana';
  if (i === 2) return 'Pasado mañana';
  return null;
}

function dayParts() {
  return [
    { key: 'madrugada', from: 0, to: 6 },
    { key: 'mañana', from: 6, to: 12 },
    { key: 'tarde', from: 12, to: 18 },
    { key: 'noche', from: 18, to: 24 },
  ];
}

function buildSegmentsForDay(targetDateISO, hourlyTime, hourlyCode, hourlyTemp, hourlyHum) {
  const parts = dayParts();
  const out = [];

  for (const p of parts) {
    const codes = [];
    const temps = [];
    const hums = [];

    for (let i = 0; i < hourlyTime.length; i++) {
      const dt = DateTime.fromISO(String(hourlyTime[i]), { zone: 'America/Argentina/Buenos_Aires' });
      if (!dt.isValid) continue;
      const dateISO = dt.toISODate();
      if (dateISO !== targetDateISO) continue;
      const h = dt.hour;
      if (h >= p.from && h < p.to) {
        codes.push(hourlyCode[i]);
        temps.push(hourlyTemp[i]);
        hums.push(hourlyHum[i]);
      }
    }

    const code = pickMostFrequent(codes);
    const desc = weatherCodeToSpanish(code);
    const mm = minMaxRounded(temps);
    const hAvg = avgRounded(hums);

    if (!desc && !mm && hAvg === null) continue;

    out.push({
      key: p.key,
      desc: desc || '',
      mm,
      hum: hAvg,
    });
  }

  return out;
}

function formatDayLine(label, segments) {
  const segTexts = segments.map((s) => {
    const bits = [];
    bits.push(`${s.key}:`);
    if (s.desc) bits.push(`${safeText(s.desc)}.`);
    if (s.mm) bits.push(`Entre ${s.mm.min} y ${s.mm.max} grados.`);
    if (s.hum !== null && s.hum !== undefined) bits.push(`Humedad ${s.hum} por ciento.`);
    return bits.join(' ');
  });

  if (!segTexts.length) return '';
  return `${label}. ${segTexts.join(' ')}`;
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
  const hHum = Array.isArray(hourly.relative_humidity_2m) ? hourly.relative_humidity_2m : [];

  const baseDate = nowBA().startOf('day');
  const updatedAt = nowBA().toFormat('HH:mm');

  const dayLines = [];

  for (let d = 0; d < 3; d++) {
    const label = dayLabel(d);
    if (!label) continue;

    const dateISO = baseDate.plus({ days: d }).toISODate();
    const segments = buildSegmentsForDay(dateISO, hTime, hCode, hTemp, hHum);
    const line = formatDayLine(label, segments);
    if (line) dayLines.push(line);
  }

  const parts = [];
  parts.push('Capital Federal.');
  if (dayLines.length) parts.push(dayLines.join(' '));
  parts.push(`Actualizado ${updatedAt}.`);

  latestWeather = { xml: buildXml(parts.join(' ')), timestamp: Date.now() };
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
    ensureDegradedXml();
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
      ensureDegradedXml();
    }
  }

  res.type('application/xml').send(latestWeather.xml);
});

cron.schedule('0 * * * *', async () => {
  try {
    await refreshWithLock();
  } catch (_) {
    ensureDegradedXml();
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

app.listen(PORT, async () => {
  try {
    await refreshWithLock();
  } catch (_) {
    ensureDegradedXml();
  }
});

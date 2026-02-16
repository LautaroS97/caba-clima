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
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code',
  daily: 'temperature_2m_max,temperature_2m_min',
  forecast_days: 1,
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

function ensureDegradedXml(reason) {
  const t = nowBA().toFormat('HH:mm');
  const suffix = reason ? ` Motivo: ${safeText(reason)}.` : '';
  latestWeather = {
    xml: buildXml(`Clima para Capital Federal no disponible por el momento. Actualizado ${t}.${suffix}`),
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
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

async function refreshFromOpenMeteo() {
  console.log('[OPEN-METEO] fetching...', { lat: CABA_LAT, lon: CABA_LON });

  const resp = await axios.get(OPEN_METEO_URL, {
    timeout: 10_000,
    params: OPEN_METEO_PARAMS,
  });

  const data = resp.data || {};
  const current = data.current || {};
  const daily = data.daily || {};

  const hum = roundNum(current.relative_humidity_2m);
  const code = current.weather_code;
  const desc = weatherCodeToSpanish(code);

  const tMaxRaw = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
  const tMinRaw = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;

  const tMax = roundNum(tMaxRaw);
  const tMin = roundNum(tMinRaw);

  const updatedAt = nowBA().toFormat('HH:mm');

  console.log('[OPEN-METEO] success', { desc, tMax, tMin, hum, updatedAt });

  const parts = [];

  if (desc) parts.push(`Se espera ${safeText(desc)} en Capital Federal.`);
  else parts.push('Se espera un estado del tiempo variable en Capital Federal.');

  if (tMax !== null && tMin !== null) {
    parts.push(`La temperatura máxima para hoy es de ${tMax} grados y la mínima de ${tMin} grados.`);
  } else if (tMax !== null) {
    parts.push(`La temperatura máxima para hoy es de ${tMax} grados.`);
  } else if (tMin !== null) {
    parts.push(`La temperatura mínima para hoy es de ${tMin} grados.`);
  }

  if (hum !== null) parts.push(`Humedad ${hum} por ciento.`);
  parts.push(`Actualizado ${updatedAt}.`);

  latestWeather = { xml: buildXml(parts.join(' ')), timestamp: Date.now() };
  return latestWeather;
}

async function refreshWithLock() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      console.log('[REFRESH] starting refresh');
      const result = await refreshFromOpenMeteo();
      console.log('[REFRESH] completed');
      return result;
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = err?.message;

      console.error('[OPEN-METEO] failed', {
        status: status ?? null,
        message: msg,
        response: body ?? null,
      });

      ensureDegradedXml(status ? `Open-Meteo ${status}` : msg);
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

app.get('/', (_req, res) => {
  console.log('[HTTP] GET /');
  res.status(200).send('ok');
});

app.post('/weather/update', async (_req, res) => {
  console.log('[HTTP] POST /weather/update');
  try {
    await refreshWithLock();
    res.json({ ok: true, message: 'Weather refreshed.' });
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg = err?.message;
    res.status(502).json({
      ok: false,
      error: msg,
      upstream_status: status ?? null,
      upstream_body: body ?? null,
    });
  }
});

app.get('/weather/voice', async (_req, res) => {
  console.log('[HTTP] GET /weather/voice');

  const ageMin = latestWeather?.timestamp ? (Date.now() - latestWeather.timestamp) / 60000 : null;
  console.log('[CACHE] age minutes:', ageMin);

  const shouldRefresh = !latestWeather?.xml || ageMin === null || ageMin > CACHE_MAX_MINUTES;

  if (shouldRefresh) {
    console.log('[CACHE] refresh needed, attempting...');
    try {
      await refreshWithLock();
    } catch (_) {
      console.log('[CACHE] refresh failed, serving degraded or last known xml');
    }
  } else {
    console.log('[CACHE] serving cached xml');
  }

  res.type('application/xml').send(latestWeather.xml);
});

cron.schedule('0 * * * *', async () => {
  console.log('[CRON] hourly refresh triggered');
  try {
    await refreshWithLock();
  } catch (err) {
    console.error('[CRON] refresh failed:', err?.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

app.listen(PORT, async () => {
  console.log(`[BOOT] Listening on ${PORT}`);
  try {
    await refreshWithLock();
  } catch (err) {
    console.error('[BOOT] initial refresh failed:', err?.message);
  }
});

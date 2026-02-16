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
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code',
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
  return xmlbuilder
    .create('Response')
    .ele('Say', {}, safeText(text))
    .end({ pretty: true });
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

async function refreshFromOpenMeteo() {
  console.log('[OPEN-METEO] fetching...', { lat: CABA_LAT, lon: CABA_LON });

  const resp = await axios.get(OPEN_METEO_URL, {
    timeout: 10_000,
    params: OPEN_METEO_PARAMS,
  });

  const data = resp.data || {};
  const current = data.current || {};

  const temp = current.temperature_2m;
  const st = current.apparent_temperature;
  const hum = current.relative_humidity_2m;
  const code = current.weather_code;
  const timeStr = current.time;

  const desc = weatherCodeToSpanish(code);
  const sourceDt = timeStr
    ? DateTime.fromISO(String(timeStr)).setZone('America/Argentina/Buenos_Aires')
    : nowBA();

  console.log('[OPEN-METEO] success', { temp, st, hum, code, time: sourceDt.toISO() });

  const parts = [];
  parts.push('Capital Federal.');
  if (desc) parts.push(`${desc}.`);
  if (temp !== null && temp !== undefined) parts.push(`Temperatura ${safeText(temp)} grados.`);
  if (st !== null && st !== undefined) parts.push(`Sensación ${safeText(st)} grados.`);
  if (hum !== null && hum !== undefined) parts.push(`Humedad ${safeText(hum)} por ciento.`);
  parts.push(`Actualizado ${sourceDt.toFormat('HH:mm')}.`);

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

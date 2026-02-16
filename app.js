const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
const cron = require('node-cron');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || null;

const CABA_LAT = -34.61;
const CABA_LON = -58.38;

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

async function refreshFromOpenWeather() {
  if (!OPENWEATHER_API_KEY) throw new Error('Missing OPENWEATHER_API_KEY');

  const url = 'https://api.openweathermap.org/data/2.5/weather';
  console.log('[OPENWEATHER] fetching...', { lat: CABA_LAT, lon: CABA_LON });

  try {
    const resp = await axios.get(url, {
      timeout: 10_000,
      params: {
        lat: CABA_LAT,
        lon: CABA_LON,
        appid: OPENWEATHER_API_KEY,
        units: 'metric',
        lang: 'es',
      },
    });

    const data = resp.data || {};
    const name = safeText(data?.name || 'Capital Federal');
    const desc = safeText(data?.weather?.[0]?.description || '');
    const temp = data?.main?.temp;
    const st = data?.main?.feels_like;
    const hum = data?.main?.humidity;

    console.log('[OPENWEATHER] success', {
      name,
      desc,
      temp,
      feels_like: st,
      humidity: hum,
    });

    const parts = [];
    parts.push(`${name}.`);
    if (desc) parts.push(`${desc}.`);
    if (temp !== null && temp !== undefined) parts.push(`Temperatura ${safeText(temp)} grados.`);
    if (st !== null && st !== undefined) parts.push(`Sensación ${safeText(st)} grados.`);
    if (hum !== null && hum !== undefined) parts.push(`Humedad ${safeText(hum)} por ciento.`);
    parts.push(`Actualizado ${nowBA().toFormat('HH:mm')}.`);

    latestWeather = { xml: buildXml(parts.join(' ')), timestamp: Date.now() };
    return latestWeather;
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg = err?.message;

    console.error('[OPENWEATHER] failed', {
      status: status ?? null,
      message: msg,
      response: body ?? null,
    });

    throw err;
  }
}

async function refreshWithLock() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      console.log('[REFRESH] starting refresh');
      const result = await refreshFromOpenWeather();
      console.log('[REFRESH] completed');
      return result;
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = err?.message;
      ensureDegradedXml(status ? `OpenWeather ${status}` : msg);
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
  console.log('[CACHE] current age minutes:', ageMin);

  const shouldRefresh = !latestWeather?.xml || ageMin === null || ageMin > 65;

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
  console.log('[BOOT] OPENWEATHER_API_KEY present:', Boolean(OPENWEATHER_API_KEY));

  try {
    await refreshWithLock();
  } catch (err) {
    console.error('[BOOT] initial refresh failed:', err?.message);
  }
});

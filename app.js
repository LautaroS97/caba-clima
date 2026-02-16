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

function ensureDegradedXml() {
  if (latestWeather?.xml) return;
  const t = nowBA().toFormat('HH:mm');
  latestWeather = {
    xml: buildXml(`Clima para Capital Federal no disponible por el momento. Actualizado ${t}.`),
    timestamp: Date.now(),
  };
}

async function refreshFromOpenWeather() {
  if (!OPENWEATHER_API_KEY) throw new Error('Missing OPENWEATHER_API_KEY');

  const url = 'https://api.openweathermap.org/data/2.5/weather';
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

  const parts = [];
  parts.push(`${name}.`);
  if (desc) parts.push(`${desc}.`);
  if (temp !== null && temp !== undefined) parts.push(`Temperatura ${safeText(temp)} grados.`);
  if (st !== null && st !== undefined) parts.push(`Sensación ${safeText(st)} grados.`);
  if (hum !== null && hum !== undefined) parts.push(`Humedad ${safeText(hum)} por ciento.`);
  parts.push(`Actualizado ${nowBA().toFormat('HH:mm')}.`);

  latestWeather = { xml: buildXml(parts.join(' ')), timestamp: Date.now() };
  return latestWeather;
}

async function refreshWithLock() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      return await refreshFromOpenWeather();
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
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/weather/voice', async (_req, res) => {
  if (!latestWeather?.xml) {
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
  console.log(`[BOOT] Listening on ${PORT}`);
});

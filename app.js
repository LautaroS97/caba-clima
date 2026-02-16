const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
const cron = require('node-cron');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TWILIO_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL || null;

const SMN_URL = 'https://ws.smn.gob.ar/map_items/weather';
const TARGET_KEYWORDS = ['aeroparque', 'caba', 'capital', 'buenos aires'];
const MAX_DATA_AGE_MINUTES = 120;

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
  const root = xmlbuilder.create('Response').ele('Say', {}, safeText(text)).up();
  if (TWILIO_WEBHOOK_URL) {
    root.ele('Redirect', { method: 'POST' }, `${TWILIO_WEBHOOK_URL}?FlowEvent=return`).up();
  }
  return root.end({ pretty: true });
}

function norm(v) {
  return String(v ?? '').trim().toLowerCase();
}

function pickCabaStation(items) {
  if (!Array.isArray(items)) return null;

  const score = (rec) => {
    const name = norm(rec?.name ?? rec?.station ?? rec?.city ?? rec?.localidad ?? '');
    let s = 0;
    for (const k of TARGET_KEYWORDS) if (name.includes(k)) s += 1;
    if (name.includes('aeroparque')) s += 3;
    return s;
  };

  let best = null;
  let bestScore = 0;

  for (const rec of items) {
    const sc = score(rec);
    if (sc > bestScore) {
      bestScore = sc;
      best = rec;
    }
  }

  return bestScore > 0 ? best : null;
}

function parseTimestamp(rec) {
  const candidates = [
    rec?.updated,
    rec?.updated_at,
    rec?.last_update,
    rec?.timestamp,
    rec?.ts,
    rec?.fecha,
    rec?.hora,
    rec?.time,
    rec?.weather?.ts,
  ].filter(Boolean);

  for (const c of candidates) {
    const s = String(c).trim();
    const iso = DateTime.fromISO(s, { zone: 'America/Argentina/Buenos_Aires' });
    if (iso.isValid) return iso.setZone('America/Argentina/Buenos_Aires');

    const f1 = DateTime.fromFormat(s, 'dd/LL/yyyy HH:mm', { zone: 'America/Argentina/Buenos_Aires' });
    if (f1.isValid) return f1;

    const f2 = DateTime.fromFormat(s, 'dd/LL/yyyy HH:mm:ss', { zone: 'America/Argentina/Buenos_Aires' });
    if (f2.isValid) return f2;

    const f3 = DateTime.fromFormat(s, 'HH:mm', { zone: 'America/Argentina/Buenos_Aires' });
    if (f3.isValid) {
      const n = nowBA();
      return n.set({ hour: f3.hour, minute: f3.minute, second: 0, millisecond: 0 });
    }
  }

  return null;
}

function extractFields(rec) {
  const name = safeText(rec?.name ?? rec?.station ?? rec?.city ?? rec?.localidad ?? 'Capital Federal');

  const temp =
    rec?.weather?.temp ??
    rec?.weather?.temperature ??
    rec?.temp ??
    rec?.temperature ??
    rec?.t ??
    null;

  const st =
    rec?.weather?.st ??
    rec?.st ??
    rec?.sensacion ??
    rec?.feels_like ??
    null;

  const hum =
    rec?.weather?.humidity ??
    rec?.humidity ??
    rec?.humedad ??
    null;

  const desc =
    rec?.weather?.description ??
    rec?.weather?.weather ??
    rec?.description ??
    rec?.state ??
    rec?.icon_description ??
    null;

  return { name, temp, st, hum, desc };
}

function formatSpeak(rec, sourceDt) {
  const { name, temp, st, hum, desc } = extractFields(rec);
  const parts = [];

  parts.push(`${name}.`);
  if (desc) parts.push(`${safeText(desc)}.`);
  if (temp !== null && temp !== undefined && String(temp).trim() !== '') parts.push(`Temperatura ${safeText(temp)} grados.`);
  if (st !== null && st !== undefined && String(st).trim() !== '') parts.push(`Sensación ${safeText(st)} grados.`);
  if (hum !== null && hum !== undefined && String(hum).trim() !== '') parts.push(`Humedad ${safeText(hum)} por ciento.`);
  parts.push(`Actualizado ${sourceDt.toFormat('HH:mm')}.`);

  return parts.join(' ');
}

function ensureDegradedXml() {
  if (latestWeather?.xml) return;
  const t = nowBA().toFormat('HH:mm');
  latestWeather = {
    xml: buildXml(`Clima para Capital Federal no disponible por el momento. Actualizado ${t}.`),
    timestamp: Date.now(),
  };
}

async function refreshFromSMN() {
  const resp = await axios.get(SMN_URL, { timeout: 10_000 });
  const rec = pickCabaStation(resp.data);
  if (!rec) throw new Error('No encontré estación para CABA/Aeroparque en SMN.');

  const sourceDt = parseTimestamp(rec);
  if (!sourceDt) throw new Error('No pude determinar el timestamp del registro SMN.');

  const ageMin = nowBA().diff(sourceDt, 'minutes').minutes;
  if (ageMin > MAX_DATA_AGE_MINUTES) throw new Error(`Dato SMN viejo (${Math.round(ageMin)} min).`);
  if (ageMin < -10) throw new Error('Timestamp SMN inválido (en el futuro).');

  latestWeather = { xml: buildXml(formatSpeak(rec, sourceDt)), timestamp: Date.now() };
  return latestWeather;
}

async function refreshWithLock() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      return await refreshFromSMN();
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

cron.schedule('0 0 * * *', async () => {
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

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = 21222;

// Standardstandort (Fallback bei ungültigen Koordinaten)
const DEFAULT_STATION = {
  name: "06636 Freyburg/Unstrut",
  lat: 51.2183,
  lon: 11.7833
};

function normalizeStation(entry, idx) {
  const postcode = Array.isArray(entry.postcodes) && entry.postcodes.length
    ? entry.postcodes[0]
    : (entry.postcode || '');
  const cityBits = [entry.name, entry.admin1, entry.admin2, entry.admin3].filter(Boolean);
  const label = `${cityBits.join(' · ')}${postcode ? ` · PLZ ${postcode}` : ''}`.trim();
  return {
    id: `${idx}-${entry.latitude}-${entry.longitude}`,
    name: entry.name || 'Wetterstation',
    label: label || entry.name || 'Wetterstation',
    lat: Number(entry.latitude),
    lon: Number(entry.longitude),
    postcode
  };
}

function sanitizeQuery(raw) {
  return String(raw || '').trim();
}

function safeLocationName(raw) {
  return String(raw || '').trim().slice(0, 120);
}

function toValidCoordinate(value, min, max) {
  const num = Number(value);
  return Number.isFinite(num) && num >= min && num <= max ? num : null;
}

function activeStationFromQuery(req) {
  const lat = toValidCoordinate(req.query.lat, -90, 90);
  const lon = toValidCoordinate(req.query.lon, -180, 180);
  const name = safeLocationName(req.query.name);

  if (lat === null || lon === null) {
    return {
      name: DEFAULT_STATION.name,
      lat: DEFAULT_STATION.lat,
      lon: DEFAULT_STATION.lon,
      source: 'Standardstandort'
    };
  }

  return {
    name: name || 'Ausgewählte Station',
    lat,
    lon,
    source: 'Auswahl'
  };
}

function sortByRelevance(stations, query) {
  if (!query) return stations;
  const lower = String(query).toLowerCase();
  return stations.sort((a, b) => {
    const aExact = (a.postcode && a.postcode === query) ? 1 : 0;
    const bExact = (b.postcode && b.postcode === query) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    const aStarts = a.name.toLowerCase().includes(lower) ? 1 : 0;
    const bStarts = b.name.toLowerCase().includes(lower) ? 1 : 0;
    return bStarts - aStarts;
  });
}

function activeDWDStationFromQuery(req, fallbackStation) {
  const lat = toValidCoordinate(req.query.dwdLat, -90, 90);
  const lon = toValidCoordinate(req.query.dwdLon, -180, 180);
  const name = safeLocationName(req.query.dwdName);

  if (lat === null || lon === null) {
    return {
      name: 'Automatisch',
      lat: fallbackStation.lat,
      lon: fallbackStation.lon,
      source: 'Automatik'
    };
  }

  return {
    name: name || 'Ausgewählte DWD-Station',
    lat,
    lon,
    source: 'Auswahl'
  };
}

app.get('/api/stations', async (req, res) => {
  const query = sanitizeQuery(req.query.q);
  if (!query) {
    res.json({ stations: [] });
    return;
  }

  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '20'), 10) || 20, 5), 40);
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${limit}&language=de&format=json`;
  const geoResp = await fetchJSON(geoUrl);

  const hits = Array.isArray(geoResp.results) ? geoResp.results : [];
  const byCode = new Map();
  for (const hit of hits) {
    const station = normalizeStation(hit);
    if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
    const key = `${station.lat.toFixed(5)}|${station.lon.toFixed(5)}`;
    if (!byCode.has(key)) {
      byCode.set(key, station);
    }
  }

  const stations = sortByRelevance(Array.from(byCode.values()), query);
  res.json({ stations });
});

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'WeatherDashboard/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
    // Timeout after 10s
  }).then(r => r, e => ({ error: e.message }));
}

app.get('/api/weather', async (req, res) => {
  const activeLocation = activeStationFromQuery(req);
  const activeDwdStation = activeDWDStationFromQuery(req, activeLocation);
  const results = {};
  const LAT = activeLocation.lat;
  const LON = activeLocation.lon;
  const DWD_LAT = activeDwdStation.lat;
  const DWD_LON = activeDwdStation.lon;

  // 1. Open-Meteo - Agrarwetter (Hauptquelle)
  const omAgroUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,` +
    `shortwave_radiation,vapour_pressure_deficit,et0_fao_evapotranspiration,` +
    `soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm,` +
    `soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,` +
    `evapotranspiration,leaf_wetness_probability` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,` +
    `shortwave_radiation_sum,et0_fao_evapotranspiration,precipitation_probability_max` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,` +
    `precipitation,weather_code,surface_pressure,apparent_temperature` +
    `&timezone=Europe%2FBerlin&forecast_days=7`;

  // 2. Open-Meteo Air Quality
  const omAirUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}` +
    `&hourly=pm10,pm2_5,dust,grass_pollen,birch_pollen,alder_pollen,mugwort_pollen,ragweed_pollen` +
    `&timezone=Europe%2FBerlin&forecast_days=3`;

  // 3. Bright Sky / DWD
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const brightSkyUrl = `https://api.brightsky.dev/weather?lat=${DWD_LAT}&lon=${DWD_LON}&date=${dateStr}&tz=Europe/Berlin`;

  // 4. wttr.in
  const wttrUrl = `https://wttr.in/${LAT},${LON}?format=j1`;
  // 5. MET Norway locationforecast (Öffentlich)
  const metNoUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`;

  // Fetch all in parallel
  const [omAgro, omAir, brightSky, wttr, metNo] = await Promise.all([
    fetchJSON(omAgroUrl),
    fetchJSON(omAirUrl),
    fetchJSON(brightSkyUrl),
    fetchJSON(wttrUrl),
    fetchJSON(metNoUrl),
  ]);

  results.open_meteo_agro = omAgro;
  results.open_meteo_air = omAir;
  results.bright_sky = brightSky;
  results.wttr = wttr;
  results.met_no = metNo;
  results.fetchedAt = new Date().toISOString();
  results.location = {
    name: activeLocation.name || DEFAULT_STATION.name,
    lat: LAT,
    lon: LON,
    source: activeLocation.source
  };
  results.dwdLocation = {
    name: activeDwdStation.name,
    lat: DWD_LAT,
    lon: DWD_LON,
    source: activeDwdStation.source
  };

  res.json(results);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌤️  Wetter-Dashboard läuft auf http://localhost:${PORT}`);
});

const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");

const app = express();

const PORT = 3001;
const SETUP_FLAG = "/boot/mm-setup";
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const SPOTIFY_AUTH_BASE_URL =
  process.env.SPOTIFY_AUTH_BASE_URL ||
  "https://spotify-mirror-auth.mirrorsspotify.workers.dev";

const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const applyState = {
  running: false,
  step: "idle",
  message: "",
  updatedAt: null,
  lastError: null,
};

const HOLIDAY_CALENDAR_URLS = {
  au: "https://www.officeholidays.com/ics-clean/australia",
  at: "https://www.officeholidays.com/ics-clean/austria",
  be: "https://www.officeholidays.com/ics-clean/belgium",
  br: "https://www.officeholidays.com/ics-clean/brazil",
  ca: "https://www.officeholidays.com/ics-clean/canada",
  cn: "https://www.officeholidays.com/ics-clean/china",
  dk: "https://www.officeholidays.com/ics-clean/denmark",
  fi: "https://www.officeholidays.com/ics-clean/finland",
  fr: "https://www.officeholidays.com/ics-clean/france",
  de: "https://www.officeholidays.com/ics-clean/germany",
  gr: "https://www.officeholidays.com/ics-clean/greece",
  hk: "https://www.officeholidays.com/ics-clean/hong-kong",
  in: "https://www.officeholidays.com/ics-clean/india",
  ie: "https://www.officeholidays.com/ics-clean/ireland",
  it: "https://www.officeholidays.com/ics-clean/italy",
  jp: "https://www.officeholidays.com/ics-clean/japan",
  mx: "https://www.officeholidays.com/ics-clean/mexico",
  nl: "https://www.officeholidays.com/ics-clean/netherlands",
  nz: "https://www.officeholidays.com/ics-clean/new-zealand",
  no: "https://www.officeholidays.com/ics-clean/norway",
  pl: "https://www.officeholidays.com/ics-clean/poland",
  pt: "https://www.officeholidays.com/ics-clean/portugal",
  sg: "https://www.officeholidays.com/ics-clean/singapore",
  za: "https://www.officeholidays.com/ics-clean/south-africa",
  es: "https://www.officeholidays.com/ics-clean/spain",
  se: "https://www.officeholidays.com/ics-clean/sweden",
  ch: "https://www.officeholidays.com/ics-clean/switzerland",
  ae: "https://www.officeholidays.com/ics-clean/united-arab-emirates",
  gb: "https://www.officeholidays.com/ics-clean/united-kingdom",
  us: "https://www.officeholidays.com/ics-clean/united-states"
};

const geocodeCache = new Map();
const autocompleteCache = new Map();

function setApply(step, message, err = null) {
  applyState.running = step !== "idle" && step !== "done" && step !== "error";
  applyState.step = step;
  applyState.message = message || "";
  applyState.updatedAt = new Date().toISOString();
  applyState.lastError = err ? String(err) : (step === "error" ? applyState.lastError : null);
}

function normalizeCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Object.is(n, 0) || Object.is(n, -0)) return 0.0001;
  return Number(n.toFixed(6));
}

function defaultSettings() {
  return {
    wifi: { ssid: "", password: "" },
    location: { lat: null, lon: null },
    holidayCountryCode: "gb",
    calendarFeeds: [],
    newsFeeds: [],
    compliments: { morning: [], afternoon: [], evening: [], anytime: [] },
    traffic: {
      enabled: false,
      position: "top_right",
      interval: 300000,
      rotateInterval: 10000,
      displayMode: "rotate",
      showSymbol: true,
      firstLine: "{duration} mins",
      secondLine: "{trafficText} â€¢ +{delay} mins â€¢ via {route}",
      routes: []
    },
    spotify: {
      enabled: false,
      position: "middle_center",
      displayWhenEmpty: "none",
      mirrorId: crypto.randomUUID()
    }
  };
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings(), null, 2), "utf8");
  }
}

function sanitizeTrafficRoutes(routes, legacyTraffic = null) {
  let safeRoutes = Array.isArray(routes)
    ? routes
        .map((r) => ({
          id: String(r?.id || crypto.randomUUID()),
          name: String(r?.name || "").trim(),
          originAddress: String(r?.originAddress || "").trim(),
          destinationAddress: String(r?.destinationAddress || "").trim(),
          mode: ["driving", "walking", "cycling"].includes(r?.mode) ? r.mode : "driving"
        }))
        .filter((r) => r.name || r.originAddress || r.destinationAddress)
    : [];

  if (!safeRoutes.length && legacyTraffic) {
    const originAddress = String(legacyTraffic.originAddress || "").trim();
    const destinationAddress = String(legacyTraffic.destinationAddress || "").trim();
    const mode = ["driving", "walking", "cycling"].includes(legacyTraffic.mode)
      ? legacyTraffic.mode
      : "driving";

    if (originAddress || destinationAddress) {
      safeRoutes = [{
        id: crypto.randomUUID(),
        name: "Route 1",
        originAddress,
        destinationAddress,
        mode
      }];
    }
  }

  return safeRoutes;
}

function sanitizeSettings(input) {
  const defaults = defaultSettings();

  const safe = {
    ...defaults,
    ...(input || {}),
    wifi: { ...defaults.wifi, ...((input && input.wifi) || {}) },
    location: { ...defaults.location, ...((input && input.location) || {}) },
    compliments: { ...defaults.compliments, ...((input && input.compliments) || {}) },
    traffic: { ...defaults.traffic, ...((input && input.traffic) || {}) },
    spotify: { ...defaults.spotify, ...((input && input.spotify) || {}) }
  };

  safe.wifi.ssid = String(safe.wifi.ssid || "").trim();
  safe.wifi.password = String(safe.wifi.password || "");

  safe.location.lat = safe.location.lat === null || safe.location.lat === "" ? null : Number(safe.location.lat);
  safe.location.lon = safe.location.lon === null || safe.location.lon === "" ? null : Number(safe.location.lon);

  if (!Number.isFinite(safe.location.lat)) safe.location.lat = null;
  if (!Number.isFinite(safe.location.lon)) safe.location.lon = null;

  safe.holidayCountryCode = String(safe.holidayCountryCode || "gb").toLowerCase();

  safe.calendarFeeds = Array.isArray(safe.calendarFeeds)
    ? safe.calendarFeeds.map(v => String(v || "").trim()).filter(Boolean)
    : [];

  safe.newsFeeds = Array.isArray(safe.newsFeeds)
    ? safe.newsFeeds.map(v => String(v || "").trim()).filter(Boolean)
    : [];

  for (const key of ["morning", "afternoon", "evening", "anytime"]) {
    safe.compliments[key] = Array.isArray(safe.compliments[key])
      ? safe.compliments[key].map(v => String(v || "").trim()).filter(Boolean)
      : [];
  }

  safe.traffic.enabled = !!safe.traffic.enabled;
  safe.traffic.position = String(safe.traffic.position || "top_right");
  safe.traffic.interval = Number.isFinite(Number(safe.traffic.interval)) ? Number(safe.traffic.interval) : 300000;
  safe.traffic.rotateInterval = Number.isFinite(Number(safe.traffic.rotateInterval)) ? Number(safe.traffic.rotateInterval) : 10000;
  safe.traffic.displayMode = ["rotate", "list"].includes(safe.traffic.displayMode) ? safe.traffic.displayMode : "rotate";
  safe.traffic.showSymbol = !!safe.traffic.showSymbol;
  safe.traffic.firstLine = String(safe.traffic.firstLine || "{duration} mins").trim();
  safe.traffic.secondLine = String(safe.traffic.secondLine || "{trafficText} â€¢ +{delay} mins â€¢ via {route}").trim();
  safe.traffic.routes = sanitizeTrafficRoutes(safe.traffic.routes, safe.traffic);

  delete safe.traffic.originAddress;
  delete safe.traffic.destinationAddress;
  delete safe.traffic.mode;

  safe.spotify.enabled = !!safe.spotify.enabled;
  safe.spotify.position = String(safe.spotify.position || "middle_center");
  safe.spotify.displayWhenEmpty = ["logo", "none"].includes(safe.spotify.displayWhenEmpty)
    ? safe.spotify.displayWhenEmpty
    : "none";
  safe.spotify.mirrorId = String(safe.spotify.mirrorId || crypto.randomUUID()).trim();

  return safe;
}

function readSettings() {
  try {
    ensureDataFiles();
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return sanitizeSettings(raw);
  } catch {
    return defaultSettings();
  }
}

function writeSettings(data) {
  ensureDataFiles();
  const clean = sanitizeSettings(data);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

function execP(cmd, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || "").trim() || err.message));
        return;
      }
      resolve((stdout || "").trim());
    });
  });
}

function shQuote(s) {
  return `'${String(s ?? "").replace(/'/g, "'\\''")}'`;
}

function jsString(s) {
  return JSON.stringify(String(s ?? ""));
}

function getFeedTitle(url) {
  if (!url || typeof url !== "string") return "News";
  try {
    const domain = new URL(url.trim()).hostname.replace("www.", "");
    const parts = domain.split(".");
    const name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "News Feed";
  }
}

function httpsJsonRequest(urlString, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);

    const options = {
      method,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", chunk => {
        data += chunk;
      });

      res.on("end", () => {
        let parsed = null;

        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (err) {
          return reject(new Error(`Invalid JSON response from upstream service (${res.statusCode})`));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message =
            parsed?.error?.message ||
            parsed?.status ||
            res.statusMessage ||
            `HTTP ${res.statusCode}`;
          return reject(new Error(message));
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }

    req.end();
  });
}

function parseGoogleDurationToMinutes(value) {
  if (!value || typeof value !== "string") return null;
  const seconds = Number(value.replace("s", ""));
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.round(seconds / 60));
}

function getTrafficText(delayMinutes, mode) {
  if (mode !== "driving") {
    return "Route time";
  }

  if (!Number.isFinite(delayMinutes) || delayMinutes <= 2) {
    return "Clear traffic";
  }

  if (delayMinutes <= 10) {
    return "Moderate traffic";
  }

  return "Heavy traffic";
}

function googleTravelMode(mode) {
  if (mode === "walking") return "WALK";
  if (mode === "cycling") return "BICYCLE";
  return "DRIVE";
}

function ensureGoogleApiKey() {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error("GOOGLE_MAPS_API_KEY is not set on the server");
  }
}

function metersToMiles(meters) {
  if (!Number.isFinite(meters)) return null;
  return Number((meters / 1609.344).toFixed(1));
}

function metersToKm(meters) {
  if (!Number.isFinite(meters)) return null;
  return Number((meters / 1000).toFixed(1));
}

async function geocodeAddress(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) {
    throw new Error("Address is empty");
  }

  const cacheKey = trimmed.toLowerCase();
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  ensureGoogleApiKey();

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", trimmed);
  url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

  const json = await httpsJsonRequest(url.toString());

  if (json.status !== "OK" || !Array.isArray(json.results) || !json.results.length) {
    throw new Error(`Could not geocode address: ${trimmed}`);
  }

  const first = json.results[0];
  const result = {
    lat: first.geometry?.location?.lat,
    lng: first.geometry?.location?.lng,
    formattedAddress: first.formatted_address || trimmed
  };

  if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
    throw new Error(`Invalid geocode result for: ${trimmed}`);
  }

  geocodeCache.set(cacheKey, result);
  return result;
}

async function autocompleteAddress(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return [];

  const cacheKey = trimmed.toLowerCase();
  if (autocompleteCache.has(cacheKey)) {
    return autocompleteCache.get(cacheKey);
  }

  ensureGoogleApiKey();

  const json = await httpsJsonRequest(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "suggestions.placePrediction.place,suggestions.placePrediction.placeId,suggestions.placePrediction.text"
      },
      body: {
        input: trimmed,
        includedPrimaryTypes: ["street_address", "postal_code", "route", "premise", "locality"],
        languageCode: "en-GB",
        regionCode: "GB"
      }
    }
  );

  const suggestions = Array.isArray(json.suggestions)
    ? json.suggestions
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .map((p) => ({
          place: p.place || "",
          placeId: p.placeId || "",
          text: p.text?.text || ""
        }))
        .filter((p) => p.text)
        .slice(0, 6)
    : [];

  autocompleteCache.set(cacheKey, suggestions);
  return suggestions;
}

async function getRouteTraffic(routeConfig) {
  ensureGoogleApiKey();

  const name = String(routeConfig?.name || "").trim() || "Route";
  const mode = ["driving", "walking", "cycling"].includes(routeConfig?.mode)
    ? routeConfig.mode
    : "driving";

  const [origin, destination] = await Promise.all([
    geocodeAddress(routeConfig.originAddress),
    geocodeAddress(routeConfig.destinationAddress)
  ]);

  const body = {
    origin: {
      location: {
        latLng: {
          latitude: origin.lat,
          longitude: origin.lng
        }
      }
    },
    destination: {
      location: {
        latLng: {
          latitude: destination.lat,
          longitude: destination.lng
        }
      }
    },
    travelMode: googleTravelMode(mode),
    languageCode: "en-GB",
    units: "METRIC"
  };

  if (mode === "driving") {
    body.routingPreference = "TRAFFIC_AWARE";
  }

  const json = await httpsJsonRequest(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.description,routes.distanceMeters"
      },
      body
    }
  );

  const route = json?.routes?.[0];
  if (!route) {
    throw new Error(`No route returned for ${name}`);
  }

  const duration = parseGoogleDurationToMinutes(route.duration);
  const normalDuration = parseGoogleDurationToMinutes(route.staticDuration);
  const distanceMeters = Number(route.distanceMeters);

  if (!Number.isFinite(duration)) {
    throw new Error(`Route response did not contain a usable duration for ${name}`);
  }

  const delay =
    Number.isFinite(normalDuration) && mode === "driving"
      ? Math.max(0, duration - normalDuration)
      : 0;

  return {
    id: routeConfig.id || crypto.randomUUID(),
    name,
    duration,
    normalDuration: Number.isFinite(normalDuration) ? normalDuration : duration,
    delay,
    route: route.description || "",
    trafficText: getTrafficText(delay, mode),
    originAddress: origin.formattedAddress,
    destinationAddress: destination.formattedAddress,
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null,
    distanceMiles: metersToMiles(distanceMeters),
    distanceKm: metersToKm(distanceMeters),
    mode
  };
}

function buildConfigJs(settings) {
  const lat = normalizeCoordinate(settings.location?.lat);
  const lon = normalizeCoordinate(settings.location?.lon);
  const hasLatLon = Number.isFinite(lat) && Number.isFinite(lon);
  const holidayCalendarUrl = HOLIDAY_CALENDAR_URLS[settings.holidayCountryCode] || HOLIDAY_CALENDAR_URLS.gb;

  const customCalendars = (settings.calendarFeeds || [])
    .filter(u => typeof u === "string" && u.trim())
    .map(u => `          { symbol: "calendar-check", url: ${jsString(u.trim())} }`)
    .join(",\n");

  const feedObjects = (settings.newsFeeds || [])
    .filter(u => typeof u === "string" && u.trim().startsWith("http"))
    .map(u => `          { title: ${jsString(getFeedTitle(u))}, url: ${jsString(u.trim())} }`)
    .join(",\n");

  const weatherModules = hasLatLon ? `,
    {
      module: "weather", position: "top_right",
      config: { weatherProvider: "openmeteo", type: "current", lat: ${lat}, lon: ${lon} }
    },
    {
      module: "weather", position: "top_right", header: "Weather Forecast",
      config: { weatherProvider: "openmeteo", type: "forecast", lat: ${lat}, lon: ${lon} }
    }` : "";

  const trafficHasRoutes =
    settings.traffic?.enabled &&
    Array.isArray(settings.traffic.routes) &&
    settings.traffic.routes.some(r => r.originAddress && r.destinationAddress);

  const trafficModule = trafficHasRoutes
    ? `,
    {
      module: "MMM-Traffic",
      position: ${jsString(settings.traffic.position || "top_right")},
      config: {
        setupServerUrl: "http://127.0.0.1:3001",
        interval: ${Number(settings.traffic.interval || 300000)},
        rotateInterval: ${Number(settings.traffic.rotateInterval || 10000)},
        displayMode: ${jsString(settings.traffic.displayMode || "rotate")},
        showSymbol: ${settings.traffic.showSymbol ? "true" : "false"},
        firstLine: ${jsString(settings.traffic.firstLine || "{duration} mins")},
        secondLine: ${jsString(settings.traffic.secondLine || "{trafficText} â€¢ +{delay} mins â€¢ via {route}")}
      }
    }`
    : "";

  const spotifyModule =
    settings.spotify?.enabled &&
    settings.spotify.mirrorId &&
    SPOTIFY_AUTH_BASE_URL
      ? `,
    {
      module: "MMM-SimpleSpotifyNowPlaying",
      position: ${jsString(settings.spotify.position || "middle_center")},
      config: {
        authBaseUrl: ${jsString(SPOTIFY_AUTH_BASE_URL)},
        mirrorId: ${jsString(settings.spotify.mirrorId)},
        updateInterval: 10000,
        hideWhenNothingPlaying: ${settings.spotify.displayWhenEmpty === "none" ? "true" : "false"},
        showProgressBar: true,
        showAlbumArt: true
      }
    }`
      : "";

  return `
let config = {
  address: "0.0.0.0", port: 8080, basePath: "/",
  ipWhitelist: [], units: "metric", timeFormat: 24,
  modules: [
    { module: "alert" },
    { module: "clock", position: "top_left" },
    {
      module: "calendar",
      header: "Calendars",
      position: "top_left",
      config: {
        calendars: [
          { url: ${jsString(holidayCalendarUrl)} }${customCalendars ? `,\n${customCalendars}` : ""}
        ]
      }
    },
    {
      module: "compliments",
      position: "lower_third",
      config: {
        compliments: {
          morning: ${JSON.stringify(settings.compliments?.morning || [])},
          afternoon: ${JSON.stringify(settings.compliments?.afternoon || [])},
          evening: ${JSON.stringify(settings.compliments?.evening || [])},
          anytime: ${JSON.stringify(settings.compliments?.anytime || [])}
        }
      }
    }${weatherModules}${trafficModule}${spotifyModule},
    {
      module: "newsfeed",
      position: "bottom_bar",
      config: {
        feeds: [
          ${feedObjects || `{ title: "BBC", url: "https://feeds.bbci.co.uk/news/rss.xml" }`}
        ],
        showSourceTitle: true
      }
    }
  ]
};
if (typeof module !== "undefined") { module.exports = config; }`;
}

function saveMagicMirrorConfig(settings) {
  const mmDir = "/home/gurprit/MagicMirror";
  const configDir = path.join(mmDir, "config");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.js"), buildConfigJs(settings), "utf8");
}

app.get("/api/settings", (req, res) => {
  res.json(readSettings());
});

app.post("/api/settings", (req, res) => {
  try {
    const current = readSettings();
    const incoming = sanitizeSettings(req.body || {});

    const merged = sanitizeSettings({
      ...current,
      ...incoming,
      wifi: { ...current.wifi, ...incoming.wifi },
      location: { ...current.location, ...incoming.location },
      compliments: { ...current.compliments, ...incoming.compliments },
      traffic: { ...current.traffic, ...incoming.traffic },
      spotify: { ...current.spotify, ...incoming.spotify }
    });

    const saved = writeSettings(merged);
    saveMagicMirrorConfig(saved);

    res.json({ ok: true, settings: saved });
  } catch (err) {
    console.error("Failed to save settings:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/traffic/autocomplete", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) {
      return res.json({ ok: true, suggestions: [] });
    }

    const suggestions = await autocompleteAddress(q);
    res.json({ ok: true, suggestions });
  } catch (err) {
    console.error("Traffic autocomplete error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/traffic/current", async (req, res) => {
  try {
    const settings = readSettings();
    const traffic = settings.traffic || {};
    const routes = Array.isArray(traffic.routes) ? traffic.routes : [];

    if (!traffic.enabled) {
      return res.status(400).json({ ok: false, error: "Traffic module is disabled." });
    }

    const validRoutes = routes.filter((r) => r.originAddress && r.destinationAddress);
    if (!validRoutes.length) {
      return res.status(400).json({ ok: false, error: "At least one route must be configured." });
    }

    const results = await Promise.all(
      validRoutes.map(async (routeConfig) => {
        try {
          return await getRouteTraffic(routeConfig);
        } catch (err) {
          return {
            id: routeConfig.id || crypto.randomUUID(),
            name: routeConfig.name || "Route",
            mode: routeConfig.mode || "driving",
            error: err.message,
            duration: null,
            normalDuration: null,
            delay: null,
            route: "",
            trafficText: "Unavailable",
            originAddress: routeConfig.originAddress || "",
            destinationAddress: routeConfig.destinationAddress || "",
            distanceMeters: null,
            distanceMiles: null,
            distanceKm: null
          };
        }
      })
    );

    res.json({
      ok: true,
      routes: results,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("Traffic API error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/app-meta", (req, res) => {
  res.json({
    ok: true,
    spotifyAuthBaseUrl: SPOTIFY_AUTH_BASE_URL || ""
  });
});

app.get("/api/device/info", (req, res) => {
  const interfaces = os.networkInterfaces();
  let ip = null;

  for (const infos of Object.values(interfaces)) {
    if (!Array.isArray(infos)) continue;
    for (const info of infos) {
      if (info.family === "IPv4" && !info.internal) {
        ip = info.address;
        break;
      }
    }
    if (ip) break;
  }

  res.json({ ok: true, ip, hostname: os.hostname() });
});

app.get("/api/wifi/scan", (req, res) => {
  exec("sudo nmcli -t -f SSID,SIGNAL dev wifi list ifname wlan0", (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ ok: false, error: (stderr || err.message || "").trim() });
    }

    const seen = new Set();

    const networks = stdout
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const idx = line.lastIndexOf(":");
        if (idx === -1) return null;

        const ssid = line.slice(0, idx).replace(/\\:/g, ":").trim();
        const signal = Number(line.slice(idx + 1).trim());

        return { ssid, signal: Number.isFinite(signal) ? signal : 0 };
      })
      .filter(n => n && n.ssid && !seen.has(n.ssid) && seen.add(n.ssid))
      .sort((a, b) => b.signal - a.signal);

    res.json({ ok: true, networks });
  });
});

app.get("/api/apply/status", (req, res) => {
  res.json({ ok: true, ...applyState });
});

app.post("/api/apply", async (req, res) => {
  if (applyState.running) {
    return res.status(409).json({ ok: false, error: "Apply already in progress" });
  }

  const s = readSettings();
  res.json({ ok: true });

  setApply("starting", "Preparing update...");

  setTimeout(async () => {
    try {
      if (!s.wifi?.ssid || !s.wifi.ssid.trim()) {
        throw new Error("No WiFi SSID saved.");
      }

      const targetSsid = s.wifi.ssid.trim();
      const targetPassword = String(s.wifi.password || "");

      await execP("sudo nmcli radio wifi on");

      setApply("hotspot", "Stopping hotspot service...");
      try {
        await execP("sudo systemctl stop mm-hotspot");
      } catch {}

      setApply("hotspot", "Disconnecting hotspot connection...");
      try {
        await execP("sudo nmcli connection down Hotspot");
      } catch {}

      setApply("hotspot", "Disconnecting wlan0...");
      try {
        await execP("sudo nmcli device disconnect wlan0");
      } catch {}

      setApply("hotspot", "Waiting for wlan0 to settle...");
      await new Promise(resolve => setTimeout(resolve, 3000));

      setApply("hotspot", "Rescanning WiFi...");
      try {
        await execP("sudo nmcli device wifi rescan ifname wlan0");
      } catch {}

      await new Promise(resolve => setTimeout(resolve, 3000));

      setApply("wifi", `Connecting to ${targetSsid}...`);

      const connectErrors = [];

      if (targetPassword) {
        try {
          await execP(
            `sudo nmcli dev wifi connect ${shQuote(targetSsid)} password ${shQuote(targetPassword)} ifname wlan0`,
            45000
          );
        } catch (err) {
          connectErrors.push(`direct-connect-with-password failed: ${err.message}`);

          try {
            await execP(
              `sudo nmcli connection modify ${shQuote(targetSsid)} 802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.psk ${shQuote(targetPassword)}`,
              20000
            );
            await execP(`sudo nmcli connection up ${shQuote(targetSsid)}`, 45000);
          } catch (err2) {
            connectErrors.push(`modify-and-up failed: ${err2.message}`);
          }
        }
      } else {
        try {
          await execP(`sudo nmcli connection up ${shQuote(targetSsid)}`, 45000);
        } catch (err) {
          connectErrors.push(`saved-connection-up failed: ${err.message}`);

          try {
            await execP(
              `sudo nmcli dev wifi connect ${shQuote(targetSsid)} ifname wlan0`,
              45000
            );
          } catch (err2) {
            connectErrors.push(`open-network-connect failed: ${err2.message}`);
          }
        }
      }

      let activeSsid = "";
      try {
        const out = await execP("sudo nmcli -t -f ACTIVE,SSID dev wifi");
        const match = out.split("\n").find(line => line.startsWith("yes:"));
        if (match) {
          activeSsid = match.substring(4).replace(/\\:/g, ":").trim();
        }
      } catch (err) {
        connectErrors.push(`active-ssid-check failed: ${err.message}`);
      }

      if (activeSsid !== targetSsid) {
        throw new Error(
          [
            `Failed to connect to '${targetSsid}'.`,
            `Active SSID after attempt: '${activeSsid || "none"}'.`,
            ...connectErrors
          ].join(" ")
        );
      }

      setApply("config", "Finalizing config...");
      saveMagicMirrorConfig(s);

      setApply("done", "Connected successfully. Rebooting now...");
      try { await execP(`sudo rm -f ${shQuote(SETUP_FLAG)}`); } catch {}
      setTimeout(() => exec("sudo reboot"), 2000);

    } catch (e) {
      console.error("Apply failed:", e.message);
      setApply("error", "Failed. Restoring hotspot...", e.message);

      try {
        await execP("sudo systemctl restart mm-hotspot");
      } catch {}
    }
  }, 500);
});

ensureDataFiles();
app.listen(PORT, "0.0.0.0", () => console.log(`Server on ${PORT}`));

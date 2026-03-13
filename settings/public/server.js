const express = require("express");

const { exec } = require("child_process");

const fs = require("fs");

const path = require("path");

const https = require("https");

const os = require("os");



const app = express();



const PORT = 3001;

const SETUP_FLAG = "/boot/mm-setup";

const DATA_DIR = "/home/gurprit/mm-setup-data";

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");



app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));



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

  startedAt: null,

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



function setApply(step, message, err = null) {

  applyState.running = step !== "idle" && step !== "done" && step !== "error";

  applyState.step = step;

  applyState.message = message || "";

  applyState.updatedAt = new Date().toISOString();

  applyState.lastError = err ? String(err) : (step === "error" ? applyState.lastError : null);

  console.log(`[APPLY] ${step}: ${message}${err ? ` | ${err}` : ""}`);

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

    location: { lat: null, lon: null, source: null },

    holidayCountryCode: "gb",

    calendarFeeds: [],

    newsFeeds: [],

    compliments: {

      morning: [],

      afternoon: [],

      evening: [],

      anytime: []

    },

  };

}



function ensureDataFiles() {

  if (!fs.existsSync(DATA_DIR)) {

    fs.mkdirSync(DATA_DIR, { recursive: true });

  }



  if (!fs.existsSync(SETTINGS_PATH)) {

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings(), null, 2), "utf8");

  }

}



function readSettings() {

  try {

    ensureDataFiles();

    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));

    const defaults = defaultSettings();

    return {

      ...defaults,

      ...raw,

      wifi: { ...defaults.wifi, ...(raw.wifi || {}) },

      location: { ...defaults.location, ...(raw.location || {}) },

      compliments: { ...defaults.compliments, ...(raw.compliments || {}) }

    };

  } catch {

    return defaultSettings();

  }

}



function writeSettings(data) {

  ensureDataFiles();

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf8");

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



function httpsJson(url) {

  return new Promise((resolve, reject) => {

    https

      .get(url, (res) => {

        let data = "";



        res.on("data", (chunk) => {

          data += chunk;

        });



        res.on("end", () => {

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {

            return reject(new Error(`Location service error: ${res.statusCode} ${data.slice(0, 120)}`));

          }



          try {

            resolve(JSON.parse(data));

          } catch {

            reject(new Error(`Location service returned invalid JSON: ${data.slice(0, 120)}`));

          }

        });

      })

      .on("error", reject);

  });

}



async function autoLocate(force = false) {

  const settings = readSettings();



  const latMissing = !Number.isFinite(Number(settings.location?.lat));

  const lonMissing = !Number.isFinite(Number(settings.location?.lon));



  if (!force && !latMissing && !lonMissing) {

    return {

      didUpdate: false,

      lat: settings.location.lat,

      lon: settings.location.lon,

      source: settings.location.source || "user",

    };

  }



  const data = await httpsJson("https://ipapi.co/json/");

  const lat = normalizeCoordinate(data.latitude);

  const lon = normalizeCoordinate(data.longitude);



  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {

    throw new Error("Could not determine location");

  }



  settings.location = {

    lat,

    lon,

    source: "ip",

  };



  writeSettings(settings);



  return { didUpdate: true, lat, lon, source: "ip" };

}



async function waitForInternet() {

  for (let i = 0; i < 20; i++) {

    try {

      await execP("ping -c 1 8.8.8.8", 5000);

      await execP("ping -c 1 google.com", 5000);

      return true;

    } catch {

      await new Promise((resolve) => setTimeout(resolve, 1500));

    }

  }

  return false;

}



async function restartHotspot() {

  try {

    await execP("sudo systemctl restart mm-hotspot", 20000);

  } catch {}

}



async function deleteWifiProfilesForSsid(ssid) {

  const target = String(ssid || "").trim();

  if (!target) return;



  let out = "";

  try {

    out = await execP("sudo nmcli -t -f NAME,TYPE con show", 10000);

  } catch {

    return;

  }



  const lines = out.split("\n").filter(Boolean);

  for (const line of lines) {

    const [name, type] = line.split(":");

    if (type !== "802-11-wireless") continue;



    const n = name || "";

    const looksLikeTarget =

      n === target ||

      n.endsWith(`-${target}`) ||

      n.includes(target);



    if (!looksLikeTarget) continue;



    try {

      await execP(`sudo nmcli connection delete ${shQuote(n)}`, 10000);

    } catch {}

  }

}



function findMagicMirrorDir() {

  const home = os.homedir();

  const candidates = [

    path.join(home, "MagicMirror"),

    "/home/pi/MagicMirror",

    "/home/gurprit/MagicMirror",

    "/opt/MagicMirror",

  ];



  for (const p of candidates) {

    if (fs.existsSync(path.join(p, "config")) && fs.existsSync(path.join(p, "modules"))) {

      return p;

    }

  }



  return null;

}



function jsString(s) {

  return JSON.stringify(String(s ?? ""));

}



function getLocalIp() {

  const interfaces = os.networkInterfaces();



  if (interfaces.wlan0) {

    for (const info of interfaces.wlan0) {

      if (info.family === "IPv4" && !info.internal) {

        return info.address;

      }

    }

  }



  for (const infos of Object.values(interfaces)) {

    if (!Array.isArray(infos)) continue;

    for (const info of infos) {

      if (info.family === "IPv4" && !info.internal) {

        return info.address;

      }

    }

  }



  return null;

}



function getHolidayCalendarUrl(countryCode) {

  const code = String(countryCode || "gb").toLowerCase();

  return HOLIDAY_CALENDAR_URLS[code] || HOLIDAY_CALENDAR_URLS.gb;

}



function buildConfigJs(settings) {

  const lat = normalizeCoordinate(settings.location?.lat);

  const lon = normalizeCoordinate(settings.location?.lon);



  console.log("[CONFIG] Location from settings:", settings.location);

  console.log("[CONFIG] Normalized location:", { lat, lon });



  const hasLatLon =

    Number.isFinite(lat) &&

    Number.isFinite(lon);



  const holidayCountryCode = String(settings.holidayCountryCode || "gb").toLowerCase();

  const holidayCalendarUrl = getHolidayCalendarUrl(holidayCountryCode);



  const customCalendarFeeds = Array.isArray(settings.calendarFeeds) ? settings.calendarFeeds : [];

  const feeds = Array.isArray(settings.newsFeeds) ? settings.newsFeeds : [];

  const compliments = settings.compliments || {};



  const customCalendarObjects = customCalendarFeeds

    .filter((u) => typeof u === "string" && u.trim())

    .map((u) => `          {

            fetchInterval: 7 * 24 * 60 * 60 * 1000,

            symbol: "calendar-check",

            url: ${jsString(u.trim())}

          }`)

    .join(",\n");



  const allCalendarObjects = `          {

            fetchInterval: 7 * 24 * 60 * 60 * 1000,

            symbol: "calendar-check",

            url: ${jsString(holidayCalendarUrl)}

          }${customCalendarObjects ? `,\n${customCalendarObjects}` : ""}`;



  const feedObjects = feeds

    .filter((u) => typeof u === "string" && u.trim())

    .map((u, i) => `          { title: ${jsString(`Feed ${i + 1}`)}, url: ${jsString(u.trim())} }`)

    .join(",\n");



  const morning = Array.isArray(compliments.morning) ? compliments.morning : [];

  const afternoon = Array.isArray(compliments.afternoon) ? compliments.afternoon : [];

  const evening = Array.isArray(compliments.evening) ? compliments.evening : [];

  const anytime = Array.isArray(compliments.anytime) ? compliments.anytime : [];



  function toJsArray(arr, fallback) {

    const cleaned = arr

      .filter((c) => typeof c === "string" && c.trim())

      .map((c) => `            ${jsString(c.trim())}`)

      .join(",\n");

    return cleaned || fallback;

  }



  const complimentsModule = `{

      module: "compliments",

      position: "lower_third",

      config: {

        compliments: {

          morning: [

${toJsArray(morning, `            "Good morning, gorgeous."`)}

          ],

          afternoon: [

${toJsArray(afternoon, `            "Hope your day is going brilliantly."`)}

          ],

          evening: [

${toJsArray(evening, `            "You made it through the day."`)}

          ],

          anytime: [

${toJsArray(anytime, `            "You look fantastic today."`)}

          ]

        }

      }

    }`;



  const weatherModules = hasLatLon

    ? `,

    {

      module: "weather",

      position: "top_right",

      config: {

        weatherProvider: "openmeteo",

        type: "current",

        lat: ${lat},

        lon: ${lon}

      }

    },

    {

      module: "weather",

      position: "top_right",

      header: "Weather Forecast",

      config: {

        weatherProvider: "openmeteo",

        type: "forecast",

        lat: ${lat},

        lon: ${lon}

      }

    }`

    : "";



  return `/* Auto-generated by MagicMirror Setup

 * Generated: ${new Date().toISOString()}

 */

let config = {

  address: "0.0.0.0",

  port: 8080,

  basePath: "/",

  ipWhitelist: [],

  useHttps: false,

  httpsPrivateKey: "",

  httpsCertificate: "",



  language: "en",

  locale: "en-US",

  logLevel: ["INFO", "LOG", "WARN", "ERROR"],

  timeFormat: 24,

  units: "metric",



  modules: [

    {

      module: "alert"

    },

    {

      module: "updatenotification",

      position: "top_bar"

    },

    {

      module: "clock",

      position: "top_left"

    },

    {

      module: "calendar",

      header: "Calendars",

      position: "top_left",

      config: {

        calendars: [

${allCalendarObjects}

        ]

      }

    },

    ${complimentsModule}${weatherModules},

    {

      module: "newsfeed",

      position: "bottom_bar",

      config: {

        feeds: [

${feedObjects || `          { title: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml" }`}

        ],

        showSourceTitle: true,

        showPublishDate: true,

        broadcastNewsFeeds: true,

        broadcastNewsUpdates: true,

        updateInterval: 300000

      }

    }

  ]

};



if (typeof module !== "undefined") { module.exports = config; }

`;

}



function writeMagicMirrorConfig(settings) {

  const mmDir = findMagicMirrorDir();

  if (!mmDir) {

    throw new Error("MagicMirror directory not found.");

  }



  const configPath = path.join(mmDir, "config", "config.js");

  const js = buildConfigJs(settings);



  fs.writeFileSync(configPath, js, "utf8");

  return { mmDir, configPath };

}



app.get("/api/settings", (req, res) => {

  res.json(readSettings());

});



app.get("/api/device/info", (req, res) => {

  const ip = getLocalIp();

  res.json({

    ok: true,

    ip,

    hostname: os.hostname(),

    settingsUrl: ip ? `http://${ip}:${PORT}` : null,

    settingsPath: SETTINGS_PATH,

  });

});



app.post("/api/settings", (req, res) => {

  try {

    const current = readSettings();

    const next = { ...current, ...req.body };



    if (req.body?.wifi) {

      const incomingSsid = String(req.body.wifi.ssid || "").trim();

      const incomingPassword = String(req.body.wifi.password || "");



      next.wifi = {

        ssid: incomingSsid,

        password: incomingPassword !== "" ? incomingPassword : (current.wifi?.password || ""),

      };

    }



    if (req.body?.location) {

      const lat = normalizeCoordinate(req.body.location.lat);

      const lon = normalizeCoordinate(req.body.location.lon);



      next.location = {

        lat,

        lon,

        source: req.body.location.source || (lat != null && lon != null ? "user" : current.location?.source || null),

      };

    }



    if (req.body?.holidayCountryCode) {

      next.holidayCountryCode = String(req.body.holidayCountryCode || "gb").toLowerCase();

    }



    if (Array.isArray(req.body?.calendarFeeds)) {

      next.calendarFeeds = req.body.calendarFeeds;

    }



    if (Array.isArray(req.body?.newsFeeds)) {

      next.newsFeeds = req.body.newsFeeds;

    }



    if (req.body?.compliments && typeof req.body.compliments === "object") {

      next.compliments = {

        morning: Array.isArray(req.body.compliments.morning) ? req.body.compliments.morning : current.compliments?.morning || [],

        afternoon: Array.isArray(req.body.compliments.afternoon) ? req.body.compliments.afternoon : current.compliments?.afternoon || [],

        evening: Array.isArray(req.body.compliments.evening) ? req.body.compliments.evening : current.compliments?.evening || [],

        anytime: Array.isArray(req.body.compliments.anytime) ? req.body.compliments.anytime : current.compliments?.anytime || [],

      };

    }



    writeSettings(next);

    console.log("[SETTINGS] Saved settings:", JSON.stringify(next, null, 2));

    res.json({ ok: true, settings: next });

  } catch (e) {

    console.error("[SETTINGS SAVE ERROR]", e);

    res.status(500).json({ ok: false, error: e.message || "Could not save settings" });

  }

});



app.get("/api/wifi/scan", (req, res) => {

  exec("sudo nmcli -t -f SSID,SIGNAL dev wifi list ifname wlan0", (err, out) => {

    if (err) {

      return res.status(500).json({ ok: false, error: err.message });

    }



    const seen = new Set();

    const nets = out

      .split("\n")

      .filter(Boolean)

      .map((line) => {

        const [ssid, signal] = line.split(":");

        return { ssid: (ssid || "").trim(), signal: Number(signal || 0) };

      })

      .filter((n) => n.ssid.length > 0)

      .filter((n) => {

        if (seen.has(n.ssid)) return false;

        seen.add(n.ssid);

        return true;

      })

      .sort((a, b) => b.signal - a.signal);



    res.json({ ok: true, networks: nets });

  });

});



app.get("/api/apply/status", (req, res) => {

  res.json({ ok: true, ...applyState });

});



app.post("/api/apply", async (req, res) => {

  const settings = readSettings();

  const ssid = settings.wifi?.ssid?.trim();

  const password = settings.wifi?.password;



  if (!ssid || !password) {

    res.status(400).json({ ok: false, error: "Missing SSID or password" });

    return;

  }



  setApply("starting", "Starting update...");

  res.json({ ok: true });



  setTimeout(async () => {

    try {

      console.log("[APPLY SETTINGS SNAPSHOT]", JSON.stringify(settings, null, 2));



      setApply("wifi", `Switching WiFi to ${ssid}...`);



      await execP("sudo nmcli radio wifi on", 8000);



      try { await execP("sudo systemctl stop mm-hotspot", 15000); } catch (e) { console.log("[HOTSPOT STOP WARN]", e.message); }

      try { await execP("sudo nmcli con down Hotspot", 8000); } catch (e) { console.log("[HOTSPOT DOWN WARN]", e.message); }

      try { await execP("sudo nmcli connection delete Hotspot", 8000); } catch (e) { console.log("[HOTSPOT DELETE WARN]", e.message); }



      await deleteWifiProfilesForSsid(ssid);



      try { await execP("sudo nmcli dev disconnect wlan0", 8000); } catch (e) { console.log("[WLAN0 DISCONNECT WARN]", e.message); }



      await new Promise((resolve) => setTimeout(resolve, 3000));



      try { await execP("sudo nmcli dev wifi rescan ifname wlan0", 10000); } catch (e) { console.log("[WIFI RESCAN WARN]", e.message); }



      await new Promise((resolve) => setTimeout(resolve, 4000));



      const cmd = `sudo nmcli dev wifi connect ${shQuote(ssid)} password ${shQuote(password)} ifname wlan0`;

      setApply("wifi", `Connecting to ${ssid}...`);

      console.log("[WIFI CONNECT CMD]", cmd);



      const wifiOut = await execP(cmd, 45000);

      console.log("[WIFI CONNECT OUTPUT]", wifiOut);



      setApply("internet", "Checking internet...");

      const internet = await waitForInternet();

      if (!internet) {

        throw new Error("No internet");

      }



      const finalSettings = readSettings();

      console.log("[FINAL SETTINGS BEFORE CONFIG WRITE]", JSON.stringify(finalSettings, null, 2));



      setApply("config", "Writing MagicMirror config...");

      const info = writeMagicMirrorConfig(finalSettings);

      setApply("config", `Config written: ${info.configPath}`);



      setApply("finalizing", "Disabling setup hotspot mode...");

      try {

        await execP(`sudo rm -f ${SETUP_FLAG}`, 8000);

      } catch (e) {

        console.log("[SETUP FLAG REMOVE WARN]", e.message);

      }



      setApply("done", "MagicMirror successfully updated. Rebooting now...");



      setTimeout(() => {

        exec("sudo reboot");

      }, 2000);

    } catch (e) {

      console.error("[APPLY ERROR]", e);

      setApply("error", "Setup failed. Restoring hotspot...", e.message);

      await restartHotspot();

    }

  }, 300);

});



ensureDataFiles();



app.listen(PORT, "0.0.0.0", () => {

  console.log(`MagicMirror setup server running on port ${PORT}`);

  console.log(`[DATA] Using settings file: ${SETTINGS_PATH}`);

});
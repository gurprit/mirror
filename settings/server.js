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
  };
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings(), null, 2), "utf8");
  }
}

function readSettings() {
  try {
    ensureDataFiles();
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return { ...defaultSettings(), ...raw };
  } catch { return defaultSettings(); }
}

function writeSettings(data) {
  ensureDataFiles();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function execP(cmd, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) { reject(new Error((stderr || "").trim() || err.message)); return; }
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
  } catch (e) { return "News Feed"; }
}

function buildConfigJs(settings) {
  const lat = normalizeCoordinate(settings.location?.lat);
  const lon = normalizeCoordinate(settings.location?.lon);
  const hasLatLon = Number.isFinite(lat) && Number.isFinite(lon);
  const holidayCalendarUrl = HOLIDAY_CALENDAR_URLS[settings.holidayCountryCode] || HOLIDAY_CALENDAR_URLS.gb;
  
  const customCalendars = (settings.calendarFeeds || [])
    .filter(u => u.trim())
    .map(u => `          { symbol: "calendar-check", url: ${jsString(u.trim())} }`)
    .join(",\n");

  const feedObjects = (settings.newsFeeds || [])
    .filter(u => u.trim().startsWith("http"))
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
          morning: ${JSON.stringify(settings.compliments.morning)}, 
          afternoon: ${JSON.stringify(settings.compliments.afternoon)}, 
          evening: ${JSON.stringify(settings.compliments.evening)}, 
          anytime: ${JSON.stringify(settings.compliments.anytime)} 
        } 
      } 
    }${weatherModules},
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

app.get("/api/settings", (req, res) => res.json(readSettings()));
app.post("/api/settings", (req, res) => {
  writeSettings({ ...readSettings(), ...req.body });
  res.json({ ok: true });
});

app.get("/api/device/info", (req, res) => {
  const interfaces = os.networkInterfaces();
  let ip = null;
  for (const infos of Object.values(interfaces)) {
    for (const info of infos) {
      if (info.family === "IPv4" && !info.internal) { ip = info.address; break; }
    }
  }
  res.json({ ok: true, ip, hostname: os.hostname() });
});

app.get("/api/wifi/scan", (req, res) => {
  exec("sudo nmcli -t -f SSID,SIGNAL dev wifi list ifname wlan0", (err, stdout) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const seen = new Set();
    const networks = stdout.split("\n").filter(Boolean).map(line => {
      const [ssid, signal] = line.split(":");
      return { ssid: ssid.trim(), signal: Number(signal) };
    }).filter(n => n.ssid && !seen.has(n.ssid) && seen.add(n.ssid))
    .sort((a, b) => b.signal - a.signal);
    res.json({ ok: true, networks });
  });
});

app.get("/api/apply/status", (req, res) => res.json({ ok: true, ...applyState }));

app.post("/api/apply", async (req, res) => {
  const s = readSettings();
  res.json({ ok: true });
  setApply("starting", "Preparing update...");
  setTimeout(async () => {
    try {
      setApply("wifi", `Connecting to ${s.wifi.ssid}...`);
      await execP("sudo nmcli radio wifi on");
      try { await execP("sudo systemctl stop mm-hotspot"); } catch {}
      await execP(`sudo nmcli dev wifi connect ${shQuote(s.wifi.ssid)} password ${shQuote(s.wifi.password)} ifname wlan0`, 45000);
      
      setApply("config", "Finalizing config...");
      const mmDir = "/home/gurprit/MagicMirror";
      fs.writeFileSync(path.join(mmDir, "config", "config.js"), buildConfigJs(s), "utf8");
      
      setApply("done", "Success! Rebooting...");
      try { await execP("sudo rm -f /boot/mm-setup"); } catch {}
      setTimeout(() => exec("sudo reboot"), 2000);
    } catch (e) {
      setApply("error", "Failed. Restoring hotspot...", e.message);
      try { await execP("sudo systemctl restart mm-hotspot"); } catch {}
    }
  }, 500);
});

ensureDataFiles();
app.listen(PORT, "0.0.0.0", () => console.log(`Server on ${PORT}`));
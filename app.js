/* ==========================================================================
   Weather Dashboard — app.js (Vanilla JavaScript)

   Data sources — Open-Meteo (free, no API key required):
   1. Geocoding API : https://geocoding-api.open-meteo.com/v1/search
      -> City name search; returns coordinates for the selected city.
   2. Forecast API  : https://api.open-meteo.com/v1/forecast
      -> 10-day daily forecast (weather codes, temps, precipitation,
         UV index max, sunrise/sunset) + today's hourly UV index.
   3. Archive API   : https://archive-api.open-meteo.com/v1/archive
      -> Historical daily mean temperatures, used to compute the
         5-year averages shown in the "Historical Averages" card.
   ========================================================================== */

"use strict";

/* ------------------------------- Constants ------------------------------ */

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const FORECAST_DAYS = 10; // number of days in the forecast grid
const HISTORY_YEARS = 5; // number of past years to average
const SEARCH_DEBOUNCE_MS = 350;

/* --------------------------- localStorage -------------------------------
   The last selected location ({name, latitude, longitude, ...}) is saved as
   JSON under STORAGE_KEY so the dashboard automatically restores it on page
   refresh. If nothing valid is stored (first visit or cleared storage) we
   fall back to DEFAULT_LOCATION (London).                                  */
const STORAGE_KEY = "weather-dashboard-location";
const UNIT_STORAGE_KEY = "weather-dashboard-unit";
const THEME_STORAGE_KEY = "weather-dashboard-theme";
const THEMES = ["blueprint", "modern", "dark"];

const DEFAULT_LOCATION = {
  name: "London",
  admin1: "England",
  country: "United Kingdom",
  latitude: 51.5072,
  longitude: -0.1276,
};

/* WMO weather interpretation codes -> icon + description
   (documented at https://open-meteo.com/en/docs)

   Icons are single-stroke patent-drawing glyphs — inline SVG drawn with
   stroke="currentColor" so they inherit the theme ink and stay perfectly
   monochrome. (Emoji rendered off-palette blues and violets on the sepia
   paper, and CSS filters could not fully tame them.) */
const CLOUD_PATH = "M18 40a9 9 0 0 1 0-18a13 13 0 0 1 25-4a11.5 11.5 0 0 1 3 22Z";

function glyph(inner) {
  return (
    '<svg class="wx-glyph" viewBox="0 0 64 64" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    inner +
    "</svg>"
  );
}

// The base cloud, optionally lifted to leave room for precipitation ticks.
const cloud = (lift) =>
  `<g transform="translate(0 ${lift})"><path d="${CLOUD_PATH}"/></g>`;

const GLYPHS = {
  sun: glyph(
    '<circle cx="32" cy="32" r="10"/>' +
      '<path d="M32 11v6M32 47v6M11 32h6M47 32h6M17.2 17.2l4.3 4.3M42.5 42.5l4.3 4.3M46.8 17.2l-4.3 4.3M21.5 42.5l-4.3 4.3"/>'
  ),
  sunCloud: glyph(
    '<circle cx="45" cy="19" r="6"/>' +
      '<path d="M45 8v4M51 19h4M40.5 14.5l-2.9-2.9M49.5 14.5l2.9-2.9"/>' +
      `<g transform="translate(-4 10) scale(0.8)"><path d="${CLOUD_PATH}"/></g>`
  ),
  cloud: glyph(cloud(6)),
  fog: glyph(
    cloud(-5) + '<path d="M17 47h27M23 55h21" stroke-dasharray="7 5"/>'
  ),
  drizzle: glyph(
    cloud(-4) + '<path d="M24 45v6M32 48v6M40 45v6" stroke-dasharray="3 4"/>'
  ),
  rain: glyph(cloud(-4) + '<path d="M23 44l-2 10M33 46l-2 10M43 44l-2 10"/>'),
  heavyRain: glyph(
    cloud(-4) +
      '<path d="M20 44l-2 10M29 45l-2 10M38 45l-2 10M47 44l-2 10"/>'
  ),
  snow: glyph(
    cloud(-4) +
      '<path stroke-width="2.5" d="M25 43.5v11M19.9 46.4l10.2 5.9M19.9 52.6l10.2-5.9"/>' +
      '<path stroke-width="2.5" d="M33 48.5v11M27.9 51.4l10.2 5.9M27.9 57.6l10.2-5.9"/>' +
      '<path stroke-width="2.5" d="M41 43.5v11M35.9 46.4l10.2 5.9M35.9 52.6l10.2-5.9"/>'
  ),
  thunder: glyph(cloud(-4) + '<path d="M35 40l-8 12h6l-4 11 11-13h-6l5-10Z"/>'),
  unknown: glyph(
    '<circle cx="32" cy="32" r="15" stroke-dasharray="5 4"/>' +
      '<path d="M26.5 26.5a5.8 5.8 0 1 1 8.2 5.3c-1.9 1-2.7 2-2.7 4"/>' +
      '<path d="M32 42.5v.5"/>'
  ),
};

/* Small inline glyphs for the forecast meta rows (precip / UV / sunrise /
   sunset) — same currentColor treatment, drawn at text size. Sunrise and
   sunset rows have no text label, so their glyphs render one size up. */
function metaGlyph(inner, cls = "") {
  return (
    '<svg class="meta-glyph' +
    (cls ? " " + cls : "") +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    inner +
    "</svg>"
  );
}

const META_GLYPHS = {
  droplet: metaGlyph(
    '<path d="M12 3.5s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/>'
  ),
  uv: metaGlyph(
    '<circle cx="12" cy="12" r="4"/>' +
      '<path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'
  ),
  sunrise: metaGlyph(
    '<path d="M3.5 17.5h17M12 6v5.5M12 6L9 9M12 6l3 3M6.5 17.5a5.5 5.5 0 0 1 11 0"/>',
    "meta-glyph--lg"
  ),
  sunset: metaGlyph(
    '<path d="M3.5 17.5h17M12 11.5V6M12 11.5L9 8.5M12 11.5l3-3M6.5 17.5a5.5 5.5 0 0 1 11 0"/>',
    "meta-glyph--lg"
  ),
};

const WMO_CODES = {
  0: { icon: GLYPHS.sun, label: "Clear sky" },
  1: { icon: GLYPHS.sunCloud, label: "Mainly clear" },
  2: { icon: GLYPHS.sunCloud, label: "Partly cloudy" },
  3: { icon: GLYPHS.cloud, label: "Overcast" },
  45: { icon: GLYPHS.fog, label: "Fog" },
  48: { icon: GLYPHS.fog, label: "Depositing rime fog" },
  51: { icon: GLYPHS.drizzle, label: "Light drizzle" },
  53: { icon: GLYPHS.drizzle, label: "Moderate drizzle" },
  55: { icon: GLYPHS.drizzle, label: "Dense drizzle" },
  56: { icon: GLYPHS.drizzle, label: "Light freezing drizzle" },
  57: { icon: GLYPHS.drizzle, label: "Dense freezing drizzle" },
  61: { icon: GLYPHS.rain, label: "Slight rain" },
  63: { icon: GLYPHS.rain, label: "Moderate rain" },
  65: { icon: GLYPHS.heavyRain, label: "Heavy rain" },
  66: { icon: GLYPHS.rain, label: "Light freezing rain" },
  67: { icon: GLYPHS.heavyRain, label: "Heavy freezing rain" },
  71: { icon: GLYPHS.snow, label: "Slight snowfall" },
  73: { icon: GLYPHS.snow, label: "Moderate snowfall" },
  75: { icon: GLYPHS.snow, label: "Heavy snowfall" },
  77: { icon: GLYPHS.snow, label: "Snow grains" },
  80: { icon: GLYPHS.drizzle, label: "Slight rain showers" },
  81: { icon: GLYPHS.drizzle, label: "Moderate rain showers" },
  82: { icon: GLYPHS.thunder, label: "Violent rain showers" },
  85: { icon: GLYPHS.snow, label: "Slight snow showers" },
  86: { icon: GLYPHS.snow, label: "Heavy snow showers" },
  95: { icon: GLYPHS.thunder, label: "Thunderstorm" },
  96: { icon: GLYPHS.thunder, label: "Thunderstorm with slight hail" },
  99: { icon: GLYPHS.thunder, label: "Thunderstorm with heavy hail" },
};

/* ------------------------------ DOM refs -------------------------------- */

const els = {
  form: document.getElementById("search-form"),
  input: document.getElementById("search-input"),
  searchBtn: document.getElementById("search-btn"),
  results: document.getElementById("search-results"),
  errorBanner: document.getElementById("error-banner"),
  errorText: document.getElementById("error-text"),
  retryBtn: document.getElementById("retry-btn"),
  locationName: document.getElementById("location-name"),
  locationMeta: document.getElementById("location-meta"),
  locationDate: document.getElementById("location-date"),
  uvSummary: document.getElementById("uv-summary"),
  uvHours: document.getElementById("uv-hours"),
  historyContent: document.getElementById("historical-content"),
  historyCompare: document.getElementById("history-compare"),
  forecastGrid: document.getElementById("forecast-grid"),
  forecastUnit: document.getElementById("forecast-unit"),
  unitC: document.getElementById("unit-c"),
  unitF: document.getElementById("unit-f"),
  themeButtons: document.querySelectorAll(".theme-btn"),
  themePill: document.querySelector(".theme-pill"),
  unitPill: document.querySelector(".unit-pill"),
};

/* ------------------------------- State ---------------------------------- */

let activeLocation = null; // location currently displayed
let currentResults = []; // latest geocoding results
let searchTimer = null; // debounce handle for live search

let tempUnit = "c"; // "c" or "f"

// Latest fetched data, kept so the unit toggle can re-render instantly
// without hitting the APIs again. Temperatures are always stored in °C.
let lastForecast = null;
let lastHourlyUv = null;
let lastHistory = null;

/* ------------------------------- Helpers -------------------------------- */

const pad = (n) => String(n).padStart(2, "0");

const cToF = (c) => (c * 9) / 5 + 32;

const unitLabel = () => (tempUnit === "f" ? "°F" : "°C");

// Converts a Celsius API value to the active unit and formats it.
function formatTemp(celsius, decimals = 0) {
  if (celsius == null) return "–";
  const v = tempUnit === "f" ? cToF(celsius) : celsius;
  return v.toFixed(decimals);
}

// Arithmetic mean; returns null when there is no data at all.
const avg = (arr) =>
  arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

// "2026-08-23" -> "Sun, Aug 23" (noon anchor avoids timezone shifts)
function formatDate(dateStr) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Open-Meteo local times look like "2026-08-23T05:52" -> "05:52"
function formatIsoTime(iso) {
  return iso ? iso.split("T")[1] : "–";
}

// Shared fetch wrapper with basic error handling for non-2xx responses.
async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

function uvCategory(uv) {
  if (uv == null) return { label: "No data", cls: "" };
  if (uv < 3) return { label: "Low", cls: "uv-low" };
  if (uv < 6) return { label: "Moderate", cls: "uv-moderate" };
  if (uv < 8) return { label: "High", cls: "uv-high" };
  if (uv < 11) return { label: "Very high", cls: "uv-veryhigh" };
  return { label: "Extreme", cls: "uv-extreme" };
}

/* ------------------------- Error banner handling ------------------------ */

function showError(message) {
  els.errorText.textContent = message;
  els.errorBanner.classList.remove("hidden");
}

function hideError() {
  els.errorBanner.classList.add("hidden");
}

/* -------------------------- localStorage logic --------------------------
   saveLocation() persists the chosen place; getSavedLocation() reads it
   back on startup. Both are wrapped in try/catch because localStorage can
   throw (private browsing, disabled storage, corrupted JSON, etc.) and a
   storage failure should never crash the dashboard — we just fall back to
   the default location instead.                                           */

function saveLocation(location) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch (err) {
    console.warn("Could not save location to localStorage:", err);
  }
}

function getSavedLocation() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const loc = JSON.parse(raw);
      // Sanity check: we need coordinates to query the weather APIs.
      if (loc && typeof loc.latitude === "number" && typeof loc.longitude === "number") {
        return loc;
      }
    }
  } catch (err) {
    console.warn("Could not read location from localStorage:", err);
  }
  return DEFAULT_LOCATION;
}

function getSavedUnit() {
  try {
    const raw = localStorage.getItem(UNIT_STORAGE_KEY);
    if (raw === "c" || raw === "f") return raw;
  } catch (err) {
    console.warn("Could not read unit from localStorage:", err);
  }
  return "c";
}

/* --------------------- Geocoding (city search) -------------------------- */

// Calls the Open-Meteo Geocoding API and renders up to 5 matching cities.
async function doSearch(query) {
  if (!query || query.length < 2) return;

  els.searchBtn.disabled = true;
  els.searchBtn.textContent = "…";

  try {
    const params = new URLSearchParams({
      name: query,
      count: "5",
      language: "en",
      format: "json",
    });
    const data = await fetchJson(`${GEOCODING_URL}?${params}`, "Geocoding");
    currentResults = data.results ?? [];
    renderResults(currentResults);
  } catch (err) {
    console.error(err);
    showError("City search failed. Please check your connection and try again.");
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = "Search";
  }
}

function renderResults(results) {
  if (!results.length) {
    els.results.innerHTML = '<li class="no-results">No cities found</li>';
  } else {
    els.results.innerHTML = results
      .map(
        (r, i) => `
        <li role="option" tabindex="0" data-index="${i}">
          <span class="result-name">${escapeHtml(r.name)}</span>
          <span class="result-meta">
            ${escapeHtml([r.admin1, r.country].filter(Boolean).join(", "))}
          </span>
        </li>`
      )
      .join("");
  }
  els.results.classList.remove("hidden");
}

function hideResults() {
  els.results.classList.add("hidden");
  els.results.innerHTML = "";
}

// Called when the user picks a city from the dropdown.
function selectLocation(result) {
  hideResults();
  els.input.value = "";

  const location = {
    name: result.name,
    admin1: result.admin1,
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
  };

  saveLocation(location); // persist so refreshes restore this choice
  loadDashboard(location); // refresh every section with the new place
}

/* ---------------------------- Data fetching ----------------------------- */

/* Forecast API call: 10 days of daily data for the selected coordinates
   plus hourly temperatures and precipitation probabilities, used for the
   hover breakdown on each forecast card.
   timezone=auto makes Open-Meteo return times in the location's own
   timezone (sunrise/sunset etc.).                                         */
async function fetchForecast(location) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min," +
      "precipitation_probability_max,sunrise,sunset,uv_index_max",
    hourly: "temperature_2m,precipitation_probability",
    timezone: "auto",
    forecast_days: FORECAST_DAYS,
  });
  return fetchJson(`${FORECAST_URL}?${params}`, "Forecast");
}

/* Separate lightweight Forecast API call for today's HOURLY UV index,
   used to dynamically highlight the worst hours for UV exposure.          */
async function fetchHourlyUv(location) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    hourly: "uv_index",
    timezone: "auto",
    forecast_days: 1,
  });
  return fetchJson(`${FORECAST_URL}?${params}`, "UV");
}

/* -------------------- Historical averages (last 5 years) -----------------
   The Archive API provides past daily temperatures; this card shows the
   average of the daily HIGHS, plus each year's high/low for the hover
   tooltip on the "Avg. high on this date" item.

   Strategy: rather than one huge request spanning 5 years, we make one
   small request per past year, each covering only the CURRENT MONTH of
   that year. Those 5 responses are then reused twice:

     a) Day average   -> mean of temperature_2m_max on the same calendar
                         day (e.g. every Aug 23 across the past 5 years)
     b) Month average -> mean of every available daily high in that month

   For (a) we also keep each year's high/low so the tooltip can show them.

   We deliberately use the five FULL years before the current one because
   the archive lags a few days behind real time, so the current year's
   recent days would be missing and would bias a partial-month average.    */
async function fetchHistoricalAverages(location) {
  const now = new Date();
  const monthNum = now.getMonth() + 1; // 1–12
  const dayNum = now.getDate(); // 1–31
  const daysInMonth = new Date(now.getFullYear(), monthNum, 0).getDate();
  const currentYear = now.getFullYear();

  // e.g. in 2026 -> [2021, 2022, 2023, 2024, 2025]
  const years = Array.from({ length: HISTORY_YEARS }, (_, i) => currentYear - HISTORY_YEARS + i);

  // One request per year for the same month, fetched in parallel.
  const responses = await Promise.all(
    years.map(async (year) => {
      const startDate = `${year}-${pad(monthNum)}-01`;
      const endDate = `${year}-${pad(monthNum)}-${pad(daysInMonth)}`;
      const params = new URLSearchParams({
        latitude: location.latitude,
        longitude: location.longitude,
        start_date: startDate,
        end_date: endDate,
        daily: "temperature_2m_max,temperature_2m_min",
        timezone: "auto",
      });
      return fetchJson(`${ARCHIVE_URL}?${params}`, "Historical weather");
    })
  );

  const dayHighs = [];
  const monthHighs = [];
  const dayRecords = []; // per-year high/low for the tooltip

  responses.forEach((data, i) => {
    const { time, temperature_2m_max, temperature_2m_min } = data.daily;

    // (b) Collect every available daily high for the month average.
    temperature_2m_max.forEach((t) => {
      if (t != null) monthHighs.push(t);
    });

    // (a) Pick the same calendar day in this particular year. Years where
    //     the date does not exist (e.g. Feb 29 in non-leap years) are
    //     simply skipped, and null values are ignored.
    const targetDate = `${years[i]}-${pad(monthNum)}-${pad(dayNum)}`;
    const idx = time.indexOf(targetDate);
    if (idx !== -1 && temperature_2m_max[idx] != null) {
      dayHighs.push(temperature_2m_max[idx]);
      dayRecords.push({
        year: years[i],
        max: temperature_2m_max[idx],
        min: temperature_2m_min?.[idx] ?? null,
      });
    }
  });

  return {
    dayHighAverage: avg(dayHighs),
    monthHighAverage: avg(monthHighs),
    daySamples: dayHighs.length,
    monthSamples: monthHighs.length,
    dayRecords,
  };
}

/* ---------------------------- Rendering --------------------------------- */

// Puts skeleton placeholders back into every section while data loads.
function showLoadingState(location) {
  els.locationName.classList.remove("skeleton", "skeleton-text");
  els.locationName.textContent = location.name;
  els.locationMeta.textContent = [location.admin1, location.country]
    .filter(Boolean)
    .join(", ");
  els.locationDate.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  els.forecastGrid.innerHTML = Array.from(
    { length: FORECAST_DAYS },
    () => '<div class="forecast-card skeleton-card"></div>'
  ).join("");

  els.uvSummary.innerHTML =
    '<span class="skeleton skeleton-text" style="width: 180px"></span>';
  els.uvHours.innerHTML = "";

  els.historyContent.innerHTML = `
    <div class="history-item">
      <span class="history-label">Avg. high on this date</span>
      <span class="skeleton skeleton-text" style="width: 90px"></span>
    </div>
    <div class="history-item">
      <span class="history-label">Avg. high this month</span>
      <span class="skeleton skeleton-text" style="width: 90px"></span>
    </div>`;
  els.historyCompare.textContent = "";
}

// Groups the hourly forecast (temps + precipitation probability) by date so
// each forecast card can show an hourly breakdown on hover.
function groupHoursByDate(hourly) {
  const map = {};
  const times = hourly?.time ?? [];
  times.forEach((t, k) => {
    const date = t.slice(0, 10);
    (map[date] ??= []).push({
      hour: t.slice(11, 16), // "HH:MM"
      temp: hourly.temperature_2m?.[k],
      precip: hourly.precipitation_probability?.[k],
    });
  });
  return map;
}

// Builds the hover popup for one forecast card: two side-by-side columns of
// "hour / temp / precipitation %" rows covering all 24 hours. `id` becomes the
// tooltip's element id so the card can reference it via aria-describedby.
function buildHourlyTooltip(entries, id) {
  if (!entries?.length) return "";

  const column = (list) =>
    `<div class="fc-tooltip-col">${list
      .map(
        (e) => `
        <div class="fc-tooltip-row">
          <span class="fc-tooltip-hour">${escapeHtml(e.hour)}</span>
          <span class="fc-tooltip-temp">${e.temp != null ? `${formatTemp(e.temp)}°` : "–"}</span>
          <span class="fc-tooltip-precip">${e.precip != null ? `${e.precip}%` : "–"}</span>
        </div>`
      )
      .join("")}</div>`;

  const mid = Math.ceil(entries.length / 2);

  return `
    <div class="fc-tooltip" role="tooltip" id="fc-tooltip-${id}">
      <span class="fc-tooltip-title">By hour · temp / precip</span>
      <div class="fc-tooltip-cols">${column(entries.slice(0, mid))}${column(entries.slice(mid))}</div>
    </div>`;
}

function renderForecast(forecast) {
  const daily = forecast.daily;
  const hoursByDate = groupHoursByDate(forecast.hourly);

  els.forecastGrid.innerHTML = daily.time
    .map((dateStr, i) => {
      const code = WMO_CODES[daily.weather_code[i]] ?? {
        icon: GLYPHS.unknown,
        label: "Unknown",
      };
      const precip = daily.precipitation_probability_max?.[i];
      const uvMax = daily.uv_index_max?.[i];
      const label =
        i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatDate(dateStr);
      const tooltipId = `fc-tooltip-${i}`;
      const tooltip = buildHourlyTooltip(hoursByDate[dateStr], i);
      const describedBy = tooltip ? ` aria-describedby="${tooltipId}"` : "";

      return `
        <article class="forecast-card ${i === 0 ? "forecast-card--today" : ""} ${tooltip ? "forecast-card--has-hours" : ""}"${tooltip ? ' tabindex="0"' : ""}${describedBy}>
          <h3 class="forecast-date">${escapeHtml(label)}</h3>
          <div class="forecast-icon" title="${escapeHtml(code.label)}">${code.icon}</div>
          <p class="forecast-desc">${escapeHtml(code.label)}</p>
          <p class="forecast-temps">
            <span class="temp-max">${formatTemp(daily.temperature_2m_max[i])}°</span> /
            <span class="temp-min">${formatTemp(daily.temperature_2m_min[i])}°</span>
          </p>
          <p class="forecast-meta">${META_GLYPHS.droplet} Precip: ${precip != null ? `${precip}%` : "–"}</p>
          <p class="forecast-meta">${META_GLYPHS.uv} UV: ${uvMax != null ? uvMax.toFixed(1) : "–"}</p>
          <p class="forecast-meta">${META_GLYPHS.sunrise} ${formatIsoTime(daily.sunrise?.[i])}</p>
          <p class="forecast-meta">${META_GLYPHS.sunset} ${formatIsoTime(daily.sunset?.[i])}</p>
          ${tooltip}
        </article>`;
    })
    .join("");

  // Position new tooltips immediately so the horizontal clamp is in place
  // before the user can hover (avoids a horizontal slide-in on entry).
  requestAnimationFrame(repositionAllTooltips);
}

/* Renders today's maximum UV plus an hourly strip. An hour is marked as a
   "peak" (worst exposure) hour when its UV index reaches 80% of the day's
   maximum — a dynamic version of the classic "avoid 10:00–16:00" advice.
   If hourly data is unavailable we fall back to that static window.       */
function renderTodayUv(hourly, daily) {
  const maxUv = daily?.uv_index_max?.[0];
  const cat = uvCategory(maxUv);

  els.uvSummary.innerHTML = `
    <span class="uv-value">${maxUv != null ? maxUv.toFixed(1) : "–"}</span>
    <span class="uv-badge ${cat.cls}">${cat.label}</span>
    <span class="uv-sub">daily maximum UV index</span>`;

  const times = hourly?.time ?? [];
  const values = hourly?.uv_index ?? [];

  if (!times.length) {
    els.uvHours.innerHTML =
      '<p class="uv-fallback">Hourly UV data unavailable — avoid sun exposure between 10:00 and 16:00.</p>';
    return;
  }

  const peakThreshold = (maxUv ?? 0) * 0.8;

  els.uvHours.innerHTML = times
    .map((t, i) => {
      const v = values[i];
      const hourLabel = t.slice(11, 16); // "HH:MM"
      const isPeak = v != null && peakThreshold > 0 && v >= peakThreshold;
      const { cls } = uvCategory(v);

      return `
        <div class="uv-hour ${cls} ${isPeak ? "peak" : ""}" title="UV index ${v ?? "–"}${isPeak ? " (peak)" : ""}">
          <span class="uv-hour-val">${v != null ? v.toFixed(1) : "–"}</span>
          <span class="uv-hour-time">${hourLabel}</span>
        </div>`;
    })
    .join("");
}

function renderHistory(history, daily) {
  if (!history) {
    els.historyContent.innerHTML =
      '<p class="history-unavailable">Historical data is currently unavailable.</p>';
    return;
  }

  const fmt = (v) => (v != null ? `${formatTemp(v, 1)}${unitLabel()}` : "–");

  // Hover tooltip: per-year high/low for today's calendar date.
  let dayTooltipHtml = "";
  if (history.dayRecords?.length) {
    const rows = [...history.dayRecords]
      .reverse() // most recent year first
      .map(
        (r) => `
        <div class="history-tooltip-row">
          <span>${r.year}</span>
          <span>${r.max != null ? formatTemp(r.max, 1) : "–"} / ${r.min != null ? formatTemp(r.min, 1) : "–"}</span>
        </div>`
      )
      .join("");

    const dateLabel = new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

    dayTooltipHtml = `
      <span class="history-tooltip" role="tooltip">
        <span class="history-tooltip-title">High / Low · ${escapeHtml(dateLabel)}</span>
        ${rows}
      </span>`;
  }

  els.historyContent.innerHTML = `
    <div class="history-item ${dayTooltipHtml ? "history-item--has-info" : ""}" tabindex="${dayTooltipHtml ? 0 : -1}">
      <span class="history-label">Avg. high on this date</span>
      <span class="history-value">${fmt(history.dayHighAverage)}</span>
      <span class="history-sub">${history.daySamples} of ${HISTORY_YEARS} years had data for this date</span>
      ${dayTooltipHtml}
    </div>
    <a class="history-item history-item--link" href="calendar.html" title="View daily averages for this month">
      <span class="history-label">Avg. high this month</span>
      <span class="history-value">${fmt(history.monthHighAverage)}</span>
      <span class="history-sub">${history.monthSamples} daily readings analysed</span>
    </a>`;

  // Comparison line: today's forecast high vs the 5-year average high.
  const todayMax = daily?.temperature_2m_max?.[0];
  if (todayMax != null && history.dayHighAverage != null) {
    const diffC = todayMax - history.dayHighAverage;
    const diff = tempUnit === "f" ? (diffC * 9) / 5 : diffC;
    const dir = diff >= 0 ? "warmer" : "cooler";
    els.historyCompare.textContent =
      `Today's forecast high of ${formatTemp(todayMax)}${unitLabel()} is about ` +
      `${Math.abs(diff).toFixed(1)}${unitLabel()} ${dir} than the ` +
      `${HISTORY_YEARS}-year average high for this date.`;
  } else {
    els.historyCompare.textContent = "";
  }
}

/* --------------------------- Orchestration ------------------------------ */

// Loads all dashboard sections for a location. The forecast request drives
// the error banner; the secondary requests degrade gracefully on failure.
async function loadDashboard(location) {
  activeLocation = location;
  hideError();
  showLoadingState(location);

  lastForecast = null;
  lastHourlyUv = null;
  lastHistory = null;

  try {
    const [forecast, hourlyUv, history] = await Promise.all([
      fetchForecast(location),
      fetchHourlyUv(location).catch((err) => {
        console.error(err);
        return null;
      }),
      fetchHistoricalAverages(location).catch((err) => {
        console.error(err);
        return null;
      }),
    ]);

    lastForecast = forecast;
    lastHourlyUv = hourlyUv;
    lastHistory = history;
    renderCurrentData();
  } catch (err) {
    console.error(err);
    showError(`Could not load weather data. ${err.message}`);
  }
}

// Re-renders every temperature-bearing section from the cached data.
function renderCurrentData() {
  if (!lastForecast) return;
  renderForecast(lastForecast);
  renderTodayUv(lastHourlyUv?.hourly, lastForecast.daily);
  renderHistory(lastHistory, lastForecast.daily);
}

/* ----------------------------- Event wiring ----------------------------- */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  doSearch(els.input.value.trim());
});

// Live search with debounce so we don't hammer the geocoding API per keystroke.
els.input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = els.input.value.trim();
  if (query.length < 2) {
    hideResults();
    return;
  }
  searchTimer = setTimeout(() => doSearch(query), SEARCH_DEBOUNCE_MS);
});

// Click (or Enter) on a result selects that city.
els.results.addEventListener("click", (e) => {
  const item = e.target.closest("li[data-index]");
  if (item) handleResultSelection(Number(item.dataset.index));
});
els.results.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const item = e.target.closest("li[data-index]");
  if (item) handleResultSelection(Number(item.dataset.index));
});

function handleResultSelection(index) {
  const result = currentResults[index];
  if (result) selectLocation(result);
}

// Dismiss the dropdown when clicking outside or pressing Escape.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrapper")) hideResults();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideResults();
});

/* ----------------- Forecast-card tooltip interactions -----------------
   The tooltip anchors above each card via CSS, but cards at the row
   edges would otherwise let the tooltip overflow horizontally. JS clamps
   the tooltip to the viewport by setting two CSS custom properties on
   it: --tip-x shifts the box, --arrow-x counter-shifts the arrow so it
   stays pointing at the card center. Tooltips are positioned up-front
   (on render + on resize/scroll) so the entry motion is just a vertical
   rise — no horizontal slide. */

function positionTooltip(card) {
  const tooltip = card.querySelector(".fc-tooltip");
  if (!tooltip) return;
  const cardRect = card.getBoundingClientRect();
  const tipWidth = tooltip.offsetWidth;
  if (tipWidth === 0) return; // not laid out yet
  const margin = 8;
  // Clamp against the real layout width (clientWidth excludes the classic
  // desktop scrollbar; innerWidth includes it, which let tooltips leak
  // past the scrollable edge by the scrollbar's width).
  const layoutWidth =
    document.documentElement.clientWidth || window.innerWidth;
  const centeredLeft = cardRect.left + cardRect.width / 2 - tipWidth / 2;
  const clampedLeft = Math.max(
    margin,
    Math.min(layoutWidth - tipWidth - margin, centeredLeft)
  );
  const shiftX = clampedLeft - centeredLeft;
  tooltip.style.setProperty("--tip-x", `${shiftX}px`);
  tooltip.style.setProperty("--arrow-x", `${-shiftX}px`);
}

function repositionAllTooltips() {
  els.forecastGrid
    .querySelectorAll(".forecast-card")
    .forEach(positionTooltip);
}

let repositionTick = null;
window.addEventListener("scroll", () => {
  if (repositionTick) return;
  repositionTick = requestAnimationFrame(() => {
    repositionAllTooltips();
    repositionTick = null;
  });
}, true);
window.addEventListener("resize", repositionAllTooltips);

// Arrow-key navigation between cards. Up/Down moves by visual row
// (rows are detected from getBoundingClientRect().top proximity).
els.forecastGrid.addEventListener("keydown", (e) => {
  if (
    ![
      "ArrowRight",
      "ArrowLeft",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
    ].includes(e.key)
  ) {
    return;
  }
  const card = e.target.closest(".forecast-card");
  if (!card) return;
  const cards = Array.from(
    els.forecastGrid.querySelectorAll(".forecast-card")
  );
  const idx = cards.indexOf(card);
  if (idx < 0) return;

  const rects = cards.map((c) => ({
    c,
    i: cards.indexOf(c),
    rect: c.getBoundingClientRect(),
  }));
  const cardRect = card.getBoundingClientRect();
  const ROW_TOLERANCE = 4;

  const rowAt = (topY) =>
    rects
      .filter((o) => Math.abs(o.rect.top - topY) < ROW_TOLERANCE)
      .sort((a, b) => a.rect.left - b.rect.left);

  const currentRow = rowAt(cardRect.top);
  const colIdx = Math.max(0, currentRow.findIndex((o) => o.i === idx));

  let nextIdx = -1;
  if (e.key === "ArrowRight") nextIdx = Math.min(idx + 1, cards.length - 1);
  else if (e.key === "ArrowLeft") nextIdx = Math.max(idx - 1, 0);
  else if (e.key === "ArrowDown") {
    const nextRow = rowAt(cardRect.top + cardRect.height + 12);
    if (nextRow[colIdx]) nextIdx = nextRow[colIdx].i;
  } else if (e.key === "ArrowUp") {
    const prevRow = rowAt(cardRect.top - cardRect.height - 12);
    if (prevRow[colIdx]) nextIdx = prevRow[colIdx].i;
  } else if (e.key === "Home") nextIdx = 0;
  else if (e.key === "End") nextIdx = cards.length - 1;

  if (nextIdx >= 0 && nextIdx !== idx) {
    e.preventDefault();
    cards[nextIdx].focus();
  }
});

// Escape blurs a focused forecast card, dismissing its tooltip.
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    document.activeElement?.classList.contains("forecast-card")
  ) {
    document.activeElement.blur();
  }
});

els.retryBtn.addEventListener("click", () => {
  if (activeLocation) loadDashboard(activeLocation);
});

/* ------------------------- Unit toggle (°C / °F) ------------------------ */

function applyUnitButtons() {
  els.unitC.classList.toggle("active", tempUnit === "c");
  els.unitC.setAttribute("aria-pressed", String(tempUnit === "c"));
  els.unitF.classList.toggle("active", tempUnit === "f");
  els.unitF.setAttribute("aria-pressed", String(tempUnit === "f"));
  els.forecastUnit.textContent = unitLabel();
  if (els.unitPill) {
    window.slidePill(els.unitPill, tempUnit === "f" ? 100 : 0);
  }
}

function setUnit(unit) {
  if (unit === tempUnit) return;
  tempUnit = unit;
  try {
    localStorage.setItem(UNIT_STORAGE_KEY, tempUnit);
  } catch (err) {
    console.warn("Could not save unit to localStorage:", err);
  }
  applyUnitButtons();
  renderCurrentData();
}

els.unitC.addEventListener("click", () => setUnit("c"));
els.unitF.addEventListener("click", () => setUnit("f"));

/* --------------------------- Theme switching -----------------------------
   Reads the theme that the inline <head> script already wrote to
   documentElement.dataset.theme and reconciles the switcher UI to match.
   Saving is what makes the choice stick on subsequent loads; the inline
   script is what makes the first paint match (no flash). */

function getInitialTheme() {
  const fromDom = document.documentElement.dataset.theme;
  if (THEMES.includes(fromDom)) return fromDom;
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch (err) {}
  return "blueprint";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeButtons.forEach((btn) => {
    const isActive = btn.dataset.themeValue === theme;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
  const idx = THEMES.indexOf(theme);
  if (els.themePill && idx >= 0) {
    window.slidePill(els.themePill, idx * 100);
  }
  // The unit pill is hidden in Blueprint but visible in Modern/Dark.
  // Always slide it on theme change so it's positioned correctly when
  // the user switches into Modern/Dark from another theme.
  if (els.unitPill) {
    window.slidePill(els.unitPill, tempUnit === "f" ? 100 : 0);
  }
}

function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  applyTheme(theme);
  // Lazy-load Blueprint fonts when switching *to* Blueprint — they were
  // skipped at boot if Modern/Dark was the resolved theme.
  if (theme === "blueprint") window.loadBlueprintFonts();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (err) {
    console.warn("Could not save theme to localStorage:", err);
  }
}

els.themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
});

/* -------------------------------- Init ----------------------------------- */

// On startup: restore the last selected location from localStorage
// (or fall back to London) and load the dashboard for it.
tempUnit = getSavedUnit();
applyUnitButtons();
applyTheme(getInitialTheme());
if (window.fillTitleBlockDate) window.fillTitleBlockDate();
loadDashboard(getSavedLocation());

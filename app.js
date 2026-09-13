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

const DEFAULT_LOCATION = {
  name: "London",
  admin1: "England",
  country: "United Kingdom",
  latitude: 51.5072,
  longitude: -0.1276,
};

/* WMO weather interpretation codes -> icon + description
   (documented at https://open-meteo.com/en/docs) */
const WMO_CODES = {
  0: { icon: "☀️", label: "Clear sky" },
  1: { icon: "🌤️", label: "Mainly clear" },
  2: { icon: "⛅", label: "Partly cloudy" },
  3: { icon: "☁️", label: "Overcast" },
  45: { icon: "🌫️", label: "Fog" },
  48: { icon: "🌫️", label: "Depositing rime fog" },
  51: { icon: "🌦️", label: "Light drizzle" },
  53: { icon: "🌦️", label: "Moderate drizzle" },
  55: { icon: "🌦️", label: "Dense drizzle" },
  56: { icon: "🌧️", label: "Light freezing drizzle" },
  57: { icon: "🌧️", label: "Dense freezing drizzle" },
  61: { icon: "🌧️", label: "Slight rain" },
  63: { icon: "🌧️", label: "Moderate rain" },
  65: { icon: "🌧️", label: "Heavy rain" },
  66: { icon: "🌧️", label: "Light freezing rain" },
  67: { icon: "🌧️", label: "Heavy freezing rain" },
  71: { icon: "🌨️", label: "Slight snowfall" },
  73: { icon: "🌨️", label: "Moderate snowfall" },
  75: { icon: "🌨️", label: "Heavy snowfall" },
  77: { icon: "🌨️", label: "Snow grains" },
  80: { icon: "🌦️", label: "Slight rain showers" },
  81: { icon: "🌦️", label: "Moderate rain showers" },
  82: { icon: "⛈️", label: "Violent rain showers" },
  85: { icon: "🌨️", label: "Slight snow showers" },
  86: { icon: "🌨️", label: "Heavy snow showers" },
  95: { icon: "⛈️", label: "Thunderstorm" },
  96: { icon: "⛈️", label: "Thunderstorm with slight hail" },
  99: { icon: "⛈️", label: "Thunderstorm with heavy hail" },
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
// "hour / temp / precipitation %" rows covering all 24 hours.
function buildHourlyTooltip(entries) {
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
    <div class="fc-tooltip" role="tooltip">
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
        icon: "❓",
        label: "Unknown",
      };
      const precip = daily.precipitation_probability_max?.[i];
      const uvMax = daily.uv_index_max?.[i];
      const label =
        i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatDate(dateStr);
      const tooltip = buildHourlyTooltip(hoursByDate[dateStr]);

      return `
        <article class="forecast-card ${i === 0 ? "forecast-card--today" : ""} ${tooltip ? "forecast-card--has-hours" : ""}"${tooltip ? ' tabindex="0"' : ""}>
          <h3 class="forecast-date">${escapeHtml(label)}</h3>
          <div class="forecast-icon" title="${escapeHtml(code.label)}">${code.icon}</div>
          <p class="forecast-desc">${escapeHtml(code.label)}</p>
          <p class="forecast-temps">
            <span class="temp-max">${formatTemp(daily.temperature_2m_max[i])}°</span> /
            <span class="temp-min">${formatTemp(daily.temperature_2m_min[i])}°</span>
          </p>
          <p class="forecast-meta">💧 Precip: ${precip != null ? `${precip}%` : "–"}</p>
          <p class="forecast-meta">🔆 UV: ${uvMax != null ? uvMax.toFixed(1) : "–"}</p>
          <p class="forecast-meta">🌅 ${formatIsoTime(daily.sunrise?.[i])}</p>
          <p class="forecast-meta">🌇 ${formatIsoTime(daily.sunset?.[i])}</p>
          ${tooltip}
        </article>`;
    })
    .join("");
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

/* -------------------------------- Init ----------------------------------- */

// On startup: restore the last selected location from localStorage
// (or fall back to London) and load the dashboard for it.
tempUnit = getSavedUnit();
applyUnitButtons();
loadDashboard(getSavedLocation());

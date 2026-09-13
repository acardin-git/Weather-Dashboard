/* ==========================================================================
   Weather Dashboard — calendar.js

   Monthly averages page: for the selected month, shows each day's average
   high and low temperature across the last 5 full years, laid out as a
   calendar grid.

   Data source — Open-Meteo Archive API (free, no key):
     https://archive-api.open-meteo.com/v1/archive
   One request per past year, each covering only the viewed month; the 5
   responses are averaged per calendar day. The five FULL years before the
   current one are used because the archive lags a few days behind real
   time (same strategy as the dashboard's historical card).
   ========================================================================== */

"use strict";

/* ------------------------------- Constants ------------------------------ */

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const HISTORY_YEARS = 5;
const UNIT_STORAGE_KEY = "weather-dashboard-unit";
const LOCATION_STORAGE_KEY = "weather-dashboard-location";
const THEME_STORAGE_KEY = "weather-dashboard-theme";
const THEMES = ["blueprint", "modern", "dark"];

const DEFAULT_LOCATION = {
  name: "London",
  admin1: "England",
  country: "United Kingdom",
  latitude: 51.5072,
  longitude: -0.1276,
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ------------------------------ DOM refs -------------------------------- */

const els = {
  grid: document.getElementById("calendar-grid"),
  monthTitle: document.getElementById("month-title"),
  meta: document.getElementById("cal-meta"),
  prevBtn: document.getElementById("prev-month"),
  nextBtn: document.getElementById("next-month"),
  error: document.getElementById("cal-error"),
  unitC: document.getElementById("unit-c"),
  unitF: document.getElementById("unit-f"),
  themeButtons: document.querySelectorAll(".theme-btn"),
  themePill: document.querySelector(".theme-pill"),
  unitPill: document.querySelector(".unit-pill"),
};

/* ------------------------------- State ---------------------------------- */

let tempUnit = "c"; // "c" or "f"
let loc = DEFAULT_LOCATION;
let viewMonth = new Date().getMonth(); // 0–11; layout always uses the current year
let currentYears = [];
let lastData = null; // cached { highs, lows } so the unit toggle re-renders offline

/* ------------------------------- Helpers -------------------------------- */

const pad = (n) => String(n).padStart(2, "0");

// Arithmetic mean; returns null when there is no data at all.
const avg = (arr) =>
  arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;

const cToF = (c) => (c * 9) / 5 + 32;

const unitLabel = () => (tempUnit === "f" ? "°F" : "°C");

// Converts a Celsius API value to the active unit and formats it.
function formatTemp(celsius, decimals = 1) {
  if (celsius == null) return "–";
  const v = tempUnit === "f" ? cToF(celsius) : celsius;
  return `${v.toFixed(decimals)}°`;
}

function daysInMonth(monthIdx, year) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

// The five full years before the current one, e.g. in 2026 -> [2021..2025].
function archiveYears() {
  const y = new Date().getFullYear();
  return Array.from({ length: HISTORY_YEARS }, (_, i) => y - HISTORY_YEARS + i);
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

/* --------------------------- localStorage logic ------------------------- */

function getSavedLocation() {
  try {
    const raw = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.latitude === "number" && typeof parsed.longitude === "number") {
        return parsed;
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

/* ---------------------------- Data fetching ----------------------------- */

async function fetchYearMonth(year, monthIdx) {
  const params = new URLSearchParams({
    latitude: loc.latitude,
    longitude: loc.longitude,
    start_date: `${year}-${pad(monthIdx + 1)}-01`,
    end_date: `${year}-${pad(monthIdx + 1)}-${pad(daysInMonth(monthIdx, year))}`,
    daily: "temperature_2m_max,temperature_2m_min",
    timezone: "auto",
  });
  return fetchJson(`${ARCHIVE_URL}?${params}`, "Historical weather");
}

/* ----------------------------- Rendering -------------------------------- */

function updateMeta() {
  const place = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
  els.meta.textContent =
    `${place} · Average daily high (top) / low (bottom) for ` +
    `${currentYears[0]}–${currentYears[currentYears.length - 1]} · shown in ${unitLabel()}`;
}

function renderSkeleton() {
  const dim = daysInMonth(viewMonth, new Date().getFullYear());
  const offset = new Date(new Date().getFullYear(), viewMonth, 1).getDay();

  const cells = DOW_LABELS.map((d) => `<div class="calendar-dow">${d}</div>`);
  for (let i = 0; i < offset; i++) {
    cells.push('<div class="cal-day cal-day--empty"></div>');
  }
  for (let d = 0; d < dim; d++) {
    cells.push('<div class="cal-day cal-day--loading skeleton"></div>');
  }
  els.grid.innerHTML = cells.join("");
}

function renderCalendar({ highs, lows }) {
  const now = new Date();
  const year = now.getFullYear();
  const dim = daysInMonth(viewMonth, year);
  const offset = new Date(year, viewMonth, 1).getDay();

  const cells = DOW_LABELS.map(
    (d) => `<div class="calendar-dow">${d}</div>`
  );
  for (let i = 0; i < offset; i++) {
    cells.push('<div class="cal-day cal-day--empty"></div>');
  }

  for (let d = 1; d <= dim; d++) {
    const isToday = viewMonth === now.getMonth() && d === now.getDate();
    const hi = highs[d - 1];
    const lo = lows[d - 1];

    cells.push(`
      <div class="cal-day ${isToday ? "cal-day--today" : ""}">
        <span class="cal-day-num">${d}</span>
        <span class="cal-day-temps">
          <span class="cal-day-high">${hi != null ? formatTemp(hi) : "–"}</span>
          <span class="cal-day-low">${lo != null ? formatTemp(lo) : "–"}</span>
        </span>
      </div>`);
  }

  els.grid.innerHTML = cells.join("");
}

/* ---------------------------- Orchestration ----------------------------- */

async function loadMonth() {
  currentYears = archiveYears();
  lastData = null;
  els.error.classList.add("hidden");
  els.monthTitle.textContent = MONTH_NAMES[viewMonth];
  updateMeta();
  renderSkeleton();

  try {
    // One request per year for the same month, fetched in parallel.
    const responses = await Promise.all(
      currentYears.map((y) => fetchYearMonth(y, viewMonth))
    );

    const dim = daysInMonth(viewMonth, new Date().getFullYear());
    const highSamples = Array.from({ length: dim }, () => []);
    const lowSamples = Array.from({ length: dim }, () => []);

    responses.forEach((data) => {
      const { time, temperature_2m_max, temperature_2m_min } = data.daily;
      time.forEach((iso, k) => {
        const d = Number(iso.slice(8, 10)) - 1; // "YYYY-MM-DD" -> day index
        if (temperature_2m_max?.[k] != null) highSamples[d].push(temperature_2m_max[k]);
        if (temperature_2m_min?.[k] != null) lowSamples[d].push(temperature_2m_min[k]);
      });
    });

    lastData = {
      highs: highSamples.map(avg),
      lows: lowSamples.map(avg),
    };
    renderCalendar(lastData);
  } catch (err) {
    console.error(err);
    els.grid.innerHTML = "";
    els.error.textContent = `Could not load historical data. ${err.message}`;
    els.error.classList.remove("hidden");
  }
}

/* ------------------------- Unit toggle (°C / °F) ------------------------ */

function applyUnitButtons() {
  els.unitC.classList.toggle("active", tempUnit === "c");
  els.unitC.setAttribute("aria-pressed", String(tempUnit === "c"));
  els.unitF.classList.toggle("active", tempUnit === "f");
  els.unitF.setAttribute("aria-pressed", String(tempUnit === "f"));
  if (els.unitPill) {
    window.slidePill(els.unitPill, tempUnit === "f" ? 100 : 0);
  }
  updateMeta();
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
  if (lastData) renderCalendar(lastData);
}

/* ----------------------------- Event wiring ----------------------------- */

els.prevBtn.addEventListener("click", () => {
  viewMonth = (viewMonth + 11) % 12;
  loadMonth();
});

els.nextBtn.addEventListener("click", () => {
  viewMonth = (viewMonth + 1) % 12;
  loadMonth();
});

els.unitC.addEventListener("click", () => setUnit("c"));
els.unitF.addEventListener("click", () => setUnit("f"));

/* --------------------------- Theme switching -----------------------------
   Mirrors app.js: the inline <head> script sets data-theme before CSS
   evaluates, this code reconciles the switcher UI and persists picks. */

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

tempUnit = getSavedUnit();
loc = getSavedLocation();
applyUnitButtons();
applyTheme(getInitialTheme());
loadMonth();

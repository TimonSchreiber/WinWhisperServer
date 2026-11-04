// Usage statistics page: loads /api/analytics and renders cards, a per-day chart and a details table.
// Independent of how access is configured: 401 means "not signed in", 403 means "no access".

import { clearMessage, downloadFile, showError } from '/shared/common.js';

const DEFAULT_DAYS = 30;
const DEFAULT_METRIC = 'jobs';
const REFRESH_INTERVAL_MS = 30_000;

// Dates and numbers on the page follow the English UI rather than the browser locale (avoids "Mo., 2. Nov. · 6 transcriptions");
// en-GB keeps day-month order and 24-hour time. The CSV export deliberately uses the browser locale instead, see csvFormat().
const LOCALE = 'en-GB';
const NBSP = '\u00A0';

// DOM Elements
const trackingInfo = document.getElementById('trackingInfo');
const windowButtons = document.querySelectorAll('#windowSelector [data-days]');
const metricButtons = document.querySelectorAll('#metricSelector [data-metric]');
const refreshBtn = document.getElementById('refreshBtn');
const csvBtn = document.getElementById('csvBtn');
const updatedAt = document.getElementById('updatedAt');
const resultDiv = document.getElementById('result');
const contentDiv = document.getElementById('content');
const currentState = document.getElementById('currentState');
const windowTitle = document.getElementById('windowTitle');
const cardsDiv = document.getElementById('cards');
const audioHint = document.getElementById('audioHint');
const chartMax = document.getElementById('chartMax');
const chartBars = document.getElementById('chartBars');
const dayDetailText = document.getElementById('dayDetailText');
const detailsHead = document.getElementById('detailsHead');
const detailsBody = document.getElementById('detailsBody');

// View state
let selectedDays = DEFAULT_DAYS;
let selectedMetric = DEFAULT_METRIC;
let selectedDate = null; // null = most recent day
let lastData = null;
let pendingRequest = null;

// Formatters
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const factorFormat = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const shortDateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const longDateFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'medium' });

// One definition per metric, used by the details table and the CSV export.
// Durations are in seconds; 'hours' and 'minutes' only choose the unit in the CSV.
const DETAIL_ROWS = [
  { label: 'Transcriptions',          unit: 'count',   value: (s) => s.jobs },
  { label: 'Completed',               unit: 'count',   value: (s) => s.completed },
  { label: 'Failed',                  unit: 'count',   value: (s) => s.failed },
  { label: 'Completed with warnings', unit: 'count',   value: (s) => s.completedWithWarnings },
  { label: 'Audio transcribed',       unit: 'hours',   value: (s) => (hasMissingAudioLengths(s) ? null : s.totalAudioHours * 3600) },
  { label: 'Average recording',       unit: 'minutes', value: (s) => parseTimeSpan(s.averageAudioLength) },
  { label: 'Longest recording',       unit: 'minutes', value: (s) => parseTimeSpan(s.longestAudio) },
  { label: 'Total processing time',   unit: 'hours',   value: (s) => s.totalProcessingHours * 3600 },
  { label: 'Average processing time', unit: 'minutes', value: (s) => parseTimeSpan(s.averageProcessingTime) },
  { label: 'Processing speed',        unit: 'factor',  value: (s) => s.realtimeFactor },
  { label: 'Average wait in queue',   unit: 'minutes', value: (s) => parseTimeSpan(s.averageQueueWait) },
  { label: 'Longest wait in queue',   unit: 'minutes', value: (s) => parseTimeSpan(s.longestQueueWait) },
];

// =============================================================================
// LOADING
// =============================================================================

async function loadAnalytics() {
  // A newer request (window switch, refresh) supersedes an older one still in flight
  pendingRequest?.abort();
  const controller = new AbortController();
  pendingRequest = controller;
  refreshBtn.classList.add('loading');

  try {
    const response = await fetch(`/api/analytics?days=${selectedDays}`, {
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 401) {
      showAccessProblem(
        'Sign-in Required',
        'You are not signed in, or your session has expired.',
        'Sign in again to view the usage statistics.',
        { label: 'Sign in', href: '/analytics' }
      );
      return;
    }

    if (response.status === 403) {
      showAccessProblem(
        'No Access',
        (await readServerError(response)) || 'You don’t have permission to view the usage statistics.',
        'Ask your administrator if you need access.'
      );
      return;
    }

    if (!response.ok) {
      showLoadProblem(
        `Server error (${response.status})`,
        `Error (${response.status})`,
        'The statistics could not be loaded.',
        'Please try again. If the problem persists, contact your administrator.'
      );
      return;
    }

    lastData = await response.json();
    clearMessage(resultDiv);
    render(lastData);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Loading analytics failed:', error);
    showLoadProblem(
      'Connection lost',
      'Connection Failed',
      'Could not connect to the server.',
      'Check your network connection or verify the server is running.'
    );
  } finally {
    if (pendingRequest === controller) {
      pendingRequest = null;
      refreshBtn.classList.remove('loading');
    }
  }
}

async function readServerError(response) {
  try {
    return (await response.json()).error;
  } catch {
    return null;
  }
}

// Network or server error. With figures on screen, the status banner says they are outdated
// (one message in one place); without any, the error box explains what went wrong.
function showLoadProblem(bannerText, title, message, hint) {
  if (lastData) {
    const since = timeFormat.format(new Date(lastData.generatedAt));
    setCurrentState('stale', 'cloud_off', `${bannerText} · figures below are from ${since} · retrying every ${REFRESH_INTERVAL_MS / 1000} s`);
    return;
  }

  trackingInfo.textContent = '';
  showError(resultDiv, title, message, hint);
}

// =============================================================================
// RENDERING
// =============================================================================

function render(data) {
  contentDiv.hidden = false;
  csvBtn.disabled = false;

  renderTrackingInfo(data);
  renderCurrentState(data.current);
  windowTitle.textContent = `Last ${data.recent.days} Days`;
  renderCards(data.recent.summary);
  renderChart(data.recent.perDay);
  renderDetails(data.recent, data.allTime);

  updatedAt.textContent = `Updated ${timeFormat.format(new Date(data.generatedAt))}`;
}

function renderTrackingInfo(data) {
  const since = data.trackingSince
    ? `Recorded since ${dateTimeFormat.format(new Date(data.trackingSince))}`
    : 'No transcriptions recorded yet';
  trackingInfo.textContent = `${since} · server running since ${dateTimeFormat.format(new Date(data.serverStartedAt))}`;
}

function renderCurrentState({ queued, processing }) {
  const busy = queued + processing > 0;
  setCurrentState(
    busy ? 'busy' : 'idle',
    busy ? 'sync' : 'check_circle',
    busy ? `Right now: ${processing} running, ${queued} waiting` : 'Right now: idle'
  );
}

function setCurrentState(kind, icon, text) {
  currentState.className = `current-state ${kind}`;
  currentState.innerHTML = `<span class="material-icons" aria-hidden="true">${icon}</span>`;
  currentState.append(text);
}

function renderCards(summary) {
  const averageAudio = parseTimeSpan(summary.averageAudioLength);
  const averageWait = parseTimeSpan(summary.averageQueueWait);
  const longestWait = parseTimeSpan(summary.longestQueueWait);
  const factor = summary.realtimeFactor;

  cardsDiv.replaceChildren(
    createCard(
      'description', 'Transcriptions', integerFormat.format(summary.jobs),
      summary.failed > 0
        ? joinParts(`${summary.completed} completed`, `${summary.failed} failed`)
        : `${summary.completed} completed`
    ),
    createCard(
      'graphic_eq', 'Audio Transcribed', formatAudioHours(summary),
      averageAudio != null ? `avg. recording ${formatDuration(averageAudio)}` : 'Recording length unknown'
    ),
    createCard(
      'speed', 'Processing Speed', formatFactor(factor),
      factor != null ? `10${NBSP}min of audio ≈ ${formatDuration(factor * 600)}` : 'Not enough data yet'
    ),
    createCard(
      'hourglass_empty', 'Average Wait', formatDuration(averageWait),
      longestWait != null ? `longest ${formatDuration(longestWait)}` : 'No jobs yet'
    ),
  );

  audioHint.hidden = !hasMissingAudioLengths(summary);
}

function createCard(icon, label, value, sub) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-label"><span class="material-icons" aria-hidden="true">${icon}</span>${label}</div>
    <div class="card-value"></div>
    <div class="card-sub"></div>
  `;
  card.querySelector('.card-value').textContent = value;
  card.querySelector('.card-sub').textContent = sub;
  return card;
}

function renderChart(perDay) {
  const values = perDay.map(metricValue);
  const max = Math.max(0, ...values);

  // Keep a selected day across refreshes, as long as it is still inside the window
  if (!perDay.some((day) => day.date === selectedDate)) {
    selectedDate = null;
  }

  // Label every n-th day, counted back from today so the latest day is always labeled
  const labelEvery = perDay.length <= 7 ? 1 : perDay.length <= 31 ? 7 : 14;

  chartMax.textContent = max > 0 ? formatMetric(max) : '';

  chartBars.replaceChildren(...perDay.map((day, index) => {
    const height = max > 0 ? (values[index] / max) * 100 : 0;

    const column = document.createElement('button');
    column.type = 'button';
    column.className = 'bar-column';
    column.dataset.date = day.date;
    column.style.setProperty('--bar-height', `${height}%`);
    column.setAttribute('aria-label', describeDay(day));

    const bar = document.createElement('span');
    bar.className = values[index] > 0 ? 'bar' : 'bar empty';
    column.append(bar);

    // Value badge above the bar, shown for the day described below the chart
    const badge = document.createElement('span');
    badge.className = 'bar-value';
    badge.textContent = formatMetric(values[index]);
    column.append(badge);

    if ((perDay.length - 1 - index) % labelEvery === 0) {
      const label = document.createElement('span');
      label.className = 'bar-label';
      const date = parseDate(day.date);
      label.textContent = perDay.length <= 7 ? weekdayFormat.format(date) : shortDateFormat.format(date);
      column.append(label);
    }

    // Hovering or focusing previews a day, clicking keeps it
    column.addEventListener('mouseenter', () => showDay(perDay, day.date));
    column.addEventListener('focus', () => showDay(perDay, day.date));
    column.addEventListener('click', () => {
      selectedDate = day.date;
      showDay(perDay, day.date);
    });

    return column;
  }));

  const showSelectedDay = () => showDay(perDay, selectedDate ?? perDay.at(-1)?.date);
  chartBars.onmouseleave = showSelectedDay;
  chartBars.onfocusout = (event) => {
    if (!chartBars.contains(event.relatedTarget)) showSelectedDay();
  };
  showSelectedDay();
}

function showDay(perDay, date) {
  for (const column of chartBars.children) {
    column.classList.toggle('active', column.dataset.date === date);
  }
  const day = perDay.find((d) => d.date === date);
  dayDetailText.textContent = day ? describeDay(day) : '';
}

function renderDetails(recent, allTime) {
  detailsHead.replaceChildren(createRow('th', ['', `Last ${recent.days} days`, 'All time']));
  detailsBody.replaceChildren(...DETAIL_ROWS.map((row) =>
    createRow('td', [row.label, formatRowValue(row, row.value(recent.summary)), formatRowValue(row, row.value(allTime))])
  ));
}

function createRow(cellTag, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement(cellTag);
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

// =============================================================================
// CSV EXPORT
// =============================================================================

function exportCsv() {
  if (!lastData) return;

  const { recent, allTime } = lastData;
  const { delimiter, number } = csvFormat();
  const firstDay = recent.perDay[0]?.date ?? '';
  const lastDay = recent.perDay.at(-1)?.date ?? '';

  const rows = [
    ['WinWhisperServer usage statistics'],
    ['Generated', formatCsvDateTime(lastData.generatedAt)],
    ['Period', `Last ${recent.days} days (${firstDay} to ${lastDay})`],
    ['Recorded since', lastData.trackingSince ? formatCsvDateTime(lastData.trackingSince) : ''],
    [],
    ['Metric', `Last ${recent.days} days`, 'All time'],
    ...DETAIL_ROWS.map((row) => [
      csvRowLabel(row),
      csvRowValue(row, row.value(recent.summary), number),
      csvRowValue(row, row.value(allTime), number),
    ]),
    [],
    ['Date', 'Transcriptions', 'Failed', 'Audio (minutes)', 'Processing (minutes)'],
    ...recent.perDay.map((day) => [
      day.date, number(day.jobs), number(day.failed), number(day.audioMinutes), number(day.processingMinutes),
    ]),
  ];

  const csv = rows.map((cells) => cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join('\r\n');

  // The byte order mark makes Excel read the file as UTF-8
  downloadFile(`\uFEFF${csv}\r\n`, `usage-statistics_${lastDay}_${recent.days}-days.csv`, 'text/csv;charset=utf-8');
}

// Excel reads CSV according to the regional settings: with a decimal comma (e.g. German), it expects
// semicolons between fields. The browser language is the best available hint for those settings.
function csvFormat() {
  const locale = navigator.language;
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value;
  const numberFormat = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 2 });

  return {
    delimiter: decimal === ',' ? ';' : ',',
    number: (value) => (value == null ? '' : numberFormat.format(value)),
  };
}

function csvRowLabel(row) {
  return row.unit === 'hours' || row.unit === 'minutes' ? `${row.label} (${row.unit})` : row.label;
}

function csvRowValue(row, value, number) {
  if (value == null) return '';
  if (row.unit === 'hours') return number(value / 3600);
  if (row.unit === 'minutes') return number(value / 60);
  return number(value);
}

function csvCell(value, delimiter) {
  const text = String(value ?? '');
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
}

// "YYYY-MM-DD HH:MM" in local time, which Excel recognizes as a date
function formatCsvDateTime(value) {
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// =============================================================================
// FORMATTING
// =============================================================================

// "hh:mm:ss" or "d.hh:mm:ss" (how System.Text.Json writes a TimeSpan) to seconds
function parseTimeSpan(value) {
  if (value == null) return null;
  const match = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (!match) return null;
  const [, days = '0', hours, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// "YYYY-MM-DD" as a local date; new Date("YYYY-MM-DD") would be UTC midnight and can show the previous day
function parseDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Non-breaking spaces keep a duration like "16 min 39 s" on one line
function formatDuration(totalSeconds) {
  if (totalSeconds == null) return '—';
  const s = Math.round(totalSeconds);
  let parts;
  if (s < 60) {
    parts = [`${s} s`];
  } else if (s < 3600) {
    parts = [`${Math.floor(s / 60)} min`, s % 60 ? `${s % 60} s` : ''];
  } else {
    const totalMinutes = Math.round(s / 60);
    parts = [`${Math.floor(totalMinutes / 60)} h`, totalMinutes % 60 ? `${totalMinutes % 60} min` : ''];
  }
  return parts.filter(Boolean).join(' ').replaceAll(' ', NBSP);
}

// Each part stays on one line; wrapping happens only between parts
function joinParts(...parts) {
  return parts.map((part) => part.replaceAll(' ', NBSP)).join(' · ');
}

function formatRowValue(row, value) {
  if (value == null) return '—';
  switch (row.unit) {
    case 'count': return integerFormat.format(value);
    case 'factor': return formatFactor(value);
    default: return row.unit === 'hours' && value === 0 ? '0 h' : formatDuration(value);
  }
}

// Without NormalizeAudio the total would read "0 h", which looks like a measurement but isn't one
function formatAudioHours(summary) {
  if (hasMissingAudioLengths(summary)) return '—';
  return summary.totalAudioHours === 0 ? '0 h' : formatDuration(summary.totalAudioHours * 3600);
}

function hasMissingAudioLengths(summary) {
  return summary.completed > 0 && summary.averageAudioLength == null;
}

function formatFactor(factor) {
  return factor == null ? '—' : `${factorFormat.format(factor)}×`;
}

function metricValue(day) {
  return selectedMetric === 'audio' ? day.audioMinutes : day.jobs;
}

function formatMetric(value) {
  return selectedMetric === 'audio' ? formatDuration(value * 60) : integerFormat.format(value);
}

function describeDay(day) {
  const date = longDateFormat.format(parseDate(day.date));
  if (day.jobs === 0) return `${date} · no transcriptions`;
  const jobs = `${day.jobs} ${day.jobs === 1 ? 'transcription' : 'transcriptions'}`;
  const failed = day.failed > 0 ? ` (${day.failed} failed)` : '';
  return day.audioMinutes > 0
    ? `${date} · ${jobs}${failed} · ${formatDuration(day.audioMinutes * 60)} of audio`
    : `${date} · ${jobs}${failed}`;
}

// =============================================================================
// EVENTS
// =============================================================================

function setActive(buttons, activeButton) {
  buttons.forEach((button) => {
    const active = button === activeButton;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

windowButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedDays = Number(button.dataset.days);
    setActive(windowButtons, button);
    loadAnalytics();
  });
});

metricButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedMetric = button.dataset.metric;
    setActive(metricButtons, button);
    if (lastData) renderChart(lastData.recent.perDay);
  });
});

refreshBtn.addEventListener('click', loadAnalytics);
csvBtn.addEventListener('click', exportCsv);

// Initialize
setActive(windowButtons, [...windowButtons].find((b) => Number(b.dataset.days) === DEFAULT_DAYS));
setActive(metricButtons, [...metricButtons].find((b) => b.dataset.metric === DEFAULT_METRIC));
loadAnalytics();

const $ = (id) => document.getElementById(id);

let selectedRange = 'all';
let refreshing = false;

const palette = {
  successfulRouted: '#43dc9d',
  successfulGatewayLocal: '#4b9dff',
  failedRouted: '#ff6c7d',
  failedGatewayLocal: '#ff936a',
  policyRejected: '#f05d78',
  timeouts: '#f3b24f',
  abandonedUnknown: '#9a7cff'
};

const rangeLabels = {
  today: 'Today',
  month: 'This month',
  all: 'All time'
};

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function formatPercent(value) {
  const numeric = Number(value ?? 0);
  return `${Number.isInteger(numeric) ? numeric : numeric.toFixed(1)}%`;
}

function formatDuration(value) {
  if (value == null) return 'Average routed latency --';
  const numeric = Number(value);
  if (numeric < 1000) return `Average routed latency ${Math.round(numeric)} ms`;
  return `Average routed latency ${(numeric / 1000).toFixed(2)} s`;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function renderStatus(status) {
  const host = $('statusStrip');
  host.replaceChildren();

  const rows = [
    ['Home', Boolean(status.homeOnline), status.homeOnline ? 'online' : 'offline'],
    ['OAuth', Boolean(status.oauthEnabled), status.oauthEnabled ? 'enabled' : 'disabled'],
    ['Public proxy', Boolean(status.publicProxyHealthy), status.publicProxyHealthy ? 'healthy' : 'unhealthy'],
    ['Funnel', Boolean(status.funnelOn), status.funnelOn ? 'on' : 'off']
  ];

  for (const [name, ok, state] of rows) {
    const chip = createElement('span', `status-chip ${ok ? 'ok' : 'bad'}`, `${name} ${state}`);
    host.appendChild(chip);
  }
}

function renderMetrics(data) {
  const counters = data.summary.counters;
  const todayCalls = data.activity.hours.reduce((sum, row) => sum + Number(row.calls ?? 0), 0);

  setText('mTotal', formatNumber(counters.totalCalls));
  setText('mRouted', formatNumber(counters.successfulRouted));
  setText('mGateway', formatNumber(counters.successfulGatewayLocal));
  setText('mRejected', formatNumber(counters.policyRejected));
  setText('mTimeouts', formatNumber(counters.timeouts));
  setText('mAbandoned', formatNumber(counters.abandonedUnknown));
  setText('mToday', formatNumber(todayCalls));
  setText('mSuccess', formatPercent(counters.successRate));
  setText('mAvgDuration', formatDuration(counters.averageRoutedDurationMs));
}

function clientPresentation(client) {
  switch (client) {
    case 'chatgpt':
      return { label: 'ChatGPT', initials: 'GPT', css: 'client-chatgpt' };
    case 'claude':
      return { label: 'Claude', initials: 'CL', css: 'client-claude' };
    case 'local-owner':
      return { label: 'Local owner', initials: 'PC', css: 'client-local' };
    case 'local-noauth':
      return { label: 'Local no-auth', initials: 'PC', css: 'client-local' };
    case 'legacy-unknown':
      return { label: 'Legacy / unknown', initials: '?', css: 'client-legacy' };
    case 'unknown-oauth':
      return { label: 'OAuth / unknown', initials: '?', css: 'client-legacy' };
    default:
      return { label: client || 'Other', initials: 'EXT', css: 'client-other' };
  }
}

function renderClients(data) {
  const host = $('clientGrid');
  host.replaceChildren();

  const rows = data.clients?.clients ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.calls ?? 0), 0);
  setText('clientTotal', `${formatNumber(total)} calls`);

  if (rows.length === 0) {
    host.appendChild(createElement('div', 'empty', 'No client-attributed calls in this range.'));
    return;
  }

  for (const row of rows) {
    const presentation = clientPresentation(row.client);
    const card = createElement('article', `client-card ${presentation.css}`);
    const logo = createElement('div', 'client-logo', presentation.initials);
    const copy = createElement('div', 'client-copy');
    const name = createElement('span', 'client-name', presentation.label);
    const detail = createElement(
      'span',
      'client-detail',
      `${formatNumber(row.successful)} successful / ${formatNumber(row.failed)} failed`
    );
    const countWrap = createElement('div', 'client-count', formatNumber(row.calls));
    const share = total === 0 ? 0 : (Number(row.calls ?? 0) / total) * 100;
    countWrap.appendChild(createElement('span', 'client-share', `${Math.round(share)}% of calls`));

    copy.append(name, detail);
    card.append(logo, copy, countWrap);
    host.appendChild(card);
  }
}
function renderToolChart(data) {
  const host = $('toolChart');
  host.replaceChildren();

  const rows = data.tools.tools.slice(0, 8);
  setText('toolTotal', `${formatNumber(data.summary.counters.totalCalls)} calls`);

  if (rows.length === 0) {
    host.appendChild(createElement('div', 'empty', 'No calls in this range.'));
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.calls ?? 0)), 1);

  for (const row of rows) {
    const item = createElement('div', 'bar-item');
    const value = createElement('div', 'bar-value', formatNumber(row.calls));
    const track = createElement('div', 'bar-track');
    const bar = createElement('div', 'bar');
    const label = createElement('div', 'bar-label', row.toolName);

    const height = Math.max(2, (Number(row.calls ?? 0) / max) * 185);
    bar.style.height = `${height}px`;
    bar.title = `${row.toolName}: ${formatNumber(row.calls)} calls`;
    label.title = row.toolName;

    track.appendChild(bar);
    item.append(value, track, label);
    host.appendChild(item);
  }
}

function renderCallMix(data) {
  const counters = data.summary.counters;
  const rows = [
    ['Successful routed', counters.successfulRouted, 'successfulRouted'],
    ['Gateway-local', counters.successfulGatewayLocal, 'successfulGatewayLocal'],
    ['Failed routed', counters.failedRouted, 'failedRouted'],
    ['Failed gateway-local', counters.failedGatewayLocal, 'failedGatewayLocal'],
    ['Policy rejected', counters.policyRejected, 'policyRejected'],
    ['Timeouts', counters.timeouts, 'timeouts'],
    ['Abandoned / unknown', counters.abandonedUnknown, 'abandonedUnknown']
  ];

  const total = Number(counters.totalCalls ?? 0);
  setText('mixTotal', `${formatNumber(total)} calls`);
  setText('donutTotal', formatNumber(total));

  let cursor = 0;
  const slices = [];
  for (const [, rawValue, key] of rows) {
    const value = Number(rawValue ?? 0);
    if (value <= 0 || total <= 0) continue;
    const start = cursor;
    cursor += (value / total) * 100;
    slices.push(`${palette[key]} ${start.toFixed(3)}% ${cursor.toFixed(3)}%`);
  }

  $('callDonut').style.background = slices.length
    ? `conic-gradient(${slices.join(', ')})`
    : 'rgba(121, 174, 195, .11)';

  const legend = $('callLegend');
  legend.replaceChildren();

  for (const [label, rawValue, key] of rows) {
    const value = Number(rawValue ?? 0);
    const share = total === 0 ? 0 : (value / total) * 100;

    const line = createElement('div', 'legend-row');
    const swatch = createElement('span', 'legend-swatch');
    swatch.style.background = palette[key];
    const name = createElement('span', '', label);
    const count = createElement(
      'span',
      'legend-value',
      `${formatNumber(value)} / ${Math.round(share)}%`
    );

    line.append(swatch, name, count);
    legend.appendChild(line);
  }
}
function renderActivity(data) {
  const host = $('activityChart');
  host.replaceChildren();

  const rows = data.activity.hours;
  const total = rows.reduce((sum, row) => sum + Number(row.calls ?? 0), 0);
  const max = Math.max(...rows.map((row) => Number(row.calls ?? 0)), 1);

  setText('todayTotal', `${formatNumber(total)} calls`);

  const axisLabels = document.querySelectorAll('.activity-axis span');
  if (axisLabels.length === 3) {
    axisLabels[0].textContent = formatNumber(max);
    axisLabels[1].textContent = formatNumber(Math.ceil(max / 2));
    axisLabels[2].textContent = '0';
  }

  for (const row of rows) {
    const calls = Number(row.calls ?? 0);
    const bar = createElement('div', 'hour-bar');
    bar.style.height = `${Math.max(2, (calls / max) * 185)}px`;
    bar.style.opacity = calls === 0 ? '.16' : '1';
    bar.dataset.tip = `${row.label}: ${formatNumber(calls)} calls`;
    host.appendChild(bar);
  }
}

function humanizeReason(reason) {
  return String(reason ?? '')
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventDetail(event) {
  if (event.reason) return humanizeReason(event.reason);
  if (event.deviceName) return event.deviceName;
  if (event.deviceId) return `${event.deviceId.slice(0, 12)}...`;
  return event.callType === 'gateway-local' ? 'Gateway' : 'Home';
}

function appendCell(row, text, className = '') {
  const cell = createElement('td', className, text);
  row.appendChild(cell);
  return cell;
}

function renderEvents(data) {
  const body = $('eventsBody');
  body.replaceChildren();

  const events = data.events.events;
  setText('eventCount', `${events.length} latest`);

  if (events.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty', 'No audit events yet.');
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  for (const event of events) {
    const row = document.createElement('tr');
    const when = new Date(event.ts);
    const latency = event.durationMs == null ? '--' : `${formatNumber(event.durationMs)} ms`;
    const callType = event.callType === 'gateway-local' ? 'Gateway-local' : 'Routed device';

    appendCell(row, when.toLocaleString());

    const clientCell = document.createElement('td');
    const clientInfo = clientPresentation(event.client);
    const clientBadge = createElement('span', `client-badge ${event.client}`, clientInfo.label);
    clientCell.appendChild(clientBadge);
    row.appendChild(clientCell);

    appendCell(row, event.toolName, 'tool-name');

    const statusCell = document.createElement('td');
    statusCell.appendChild(createElement('span', `badge ${event.outcome}`, event.outcome));
    row.appendChild(statusCell);

    appendCell(row, callType, 'call-type');
    appendCell(row, eventDetail(event));
    appendCell(row, latency);

    body.appendChild(row);
  }
}
function updateTimestamp(data) {
  const generated = new Date(data.generatedAt);
  const timezone = data.summary.timezone || 'local';
  setText('lastUpdated', `Updated ${generated.toLocaleTimeString()} / ${timezone}`);
  setText('footerRange', `${rangeLabels[selectedRange]} view`);
}

function renderDisconnected(error) {
  console.error(error);
  setText('lastUpdated', 'Dashboard backend unavailable');

  const strip = $('statusStrip');
  strip.replaceChildren(createElement('span', 'status-chip bad', 'Dashboard disconnected'));
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;

  try {
    const response = await fetch(
      `/api/dashboard?range=${encodeURIComponent(selectedRange)}`,
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`Dashboard API returned ${response.status}`);
    }

    const data = await response.json();
    renderStatus(data.status);
    renderMetrics(data);
    renderClients(data);
    renderToolChart(data);
    renderCallMix(data);
    renderActivity(data);
    renderEvents(data);
    updateTimestamp(data);

    document.title =
      `SETU - ${formatNumber(data.summary.counters.totalCalls)} calls`;
  } catch (error) {
    renderDisconnected(error);
  } finally {
    refreshing = false;
  }
}

for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => {
    selectedRange = button.dataset.range || 'all';

    for (const item of document.querySelectorAll('[data-range]')) {
      item.classList.toggle('selected', item === button);
    }

    void refresh();
  });
}

void refresh();
setInterval(() => void refresh(), 5000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

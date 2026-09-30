const $ = (id) => document.getElementById(id);
let selectedRange = 'all';
let refreshing = false;

const palette = {
  successfulRouted: '#39df9a',
  successfulGatewayLocal: '#3396ff',
  failedRouted: '#ff6577',
  failedGatewayLocal: '#ff8d6b',
  policyRejected: '#f05b74',
  timeouts: '#f0ad4e',
  abandonedUnknown: '#a579ff'
};

function number(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function pct(value) {
  const n = Number(value ?? 0);
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

function duration(value) {
  if (value == null) return 'Average routed latency —';
  if (value < 1000) return `Average routed latency ${Math.round(value)} ms`;
  return `Average routed latency ${(value / 1000).toFixed(2)} s`;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function renderStatus(status) {
  const rows = [
    ['Home', status.homeOnline, status.homeOnline ? 'online' : 'offline'],
    ['OAuth', status.oauthEnabled, status.oauthEnabled ? 'enabled' : 'disabled'],
    ['Public proxy', status.publicProxyHealthy, status.publicProxyHealthy ? 'healthy' : 'unhealthy'],
    ['Funnel', status.funnelOn, status.funnelOn ? 'on' : 'off']
  ];

  $('statusStrip').innerHTML = '';
  for (const [name, ok, value] of rows) {
    const chip = document.createElement('span');
    chip.className = `status-chip ${ok ? 'ok' : 'bad'}`;
    chip.textContent = `${name} ${value}`;
    $('statusStrip').appendChild(chip);
  }
}

function renderMetrics(data) {
  const c = data.summary.counters;
  const todayCalls = data.activity.hours.reduce((sum, row) => sum + row.calls, 0);
  setText('mTotal', number(c.totalCalls));
  setText('mRouted', number(c.successfulRouted));
  setText('mGateway', number(c.successfulGatewayLocal));
  setText('mRejected', number(c.policyRejected));
  setText('mTimeouts', number(c.timeouts));
  setText('mAbandoned', number(c.abandonedUnknown));
  setText('mToday', number(todayCalls));
  setText('mSuccess', pct(c.successRate));
  setText('mAvgDuration', duration(c.averageRoutedDurationMs));
}

function renderToolChart(data) {
  const host = $('toolChart');
  host.innerHTML = '';
  const rows = data.tools.tools.slice(0, 8);
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  setText('toolTotal', `${number(total)} calls`);

  if (rows.length === 0) {
    host.innerHTML = '<div class="empty">No calls in this range.</div>';
    return;
  }

  const max = Math.max(...rows.map((row) => row.calls), 1);
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'bar-item';

    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = number(row.calls);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(3, (row.calls / max) * 185)}px`;
    bar.title = `${row.toolName}: ${row.calls} calls`;

    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = row.toolName;
    label.title = row.toolName;

    item.append(value, bar, label);
    host.appendChild(item);
  }
}

function renderCallMix(data) {
  const c = data.summary.counters;
  const rows = [
    ['Successful routed', c.successfulRouted, 'successfulRouted'],
    ['Gateway-local', c.successfulGatewayLocal, 'successfulGatewayLocal'],
    ['Failed routed', c.failedRouted, 'failedRouted'],
    ['Failed gateway-local', c.failedGatewayLocal, 'failedGatewayLocal'],
    ['Policy rejected', c.policyRejected, 'policyRejected'],
    ['Timeouts', c.timeouts, 'timeouts'],
    ['Abandoned / unknown', c.abandonedUnknown, 'abandonedUnknown']
  ];
  const total = c.totalCalls;
  setText('mixTotal', `${number(total)} calls`);
  setText('donutTotal', number(total));

  let cursor = 0;
  const pieces = [];
  for (const [, value, key] of rows) {
    if (!value || total === 0) continue;
    const start = cursor;
    cursor += (value / total) * 100;
    pieces.push(`${palette[key]} ${start}% ${cursor}%`);
  }
  $('callDonut').style.background = pieces.length
    ? `conic-gradient(${pieces.join(',')})`
    : 'rgba(126,190,219,.14)';

  const legend = $('callLegend');
  legend.innerHTML = '';
  for (const [label, value, key] of rows) {
    const line = document.createElement('div');
    line.className = 'legend-row';
    const share = total === 0 ? 0 : (value / total) * 100;
    line.innerHTML =
      `<span class="legend-swatch" style="background:${palette[key]}"></span>`
      + `<span>${label}</span><span class="legend-value">${number(value)} · ${Math.round(share)}%</span>`;
    legend.appendChild(line);
  }
}

function renderActivity(data) {
  const host = $('activityChart');
  host.innerHTML = '';
  const rows = data.activity.hours;
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  const max = Math.max(...rows.map((row) => row.calls), 1);
  setText('todayTotal', `${number(total)} calls`);

  for (const row of rows) {
    const bar = document.createElement('div');
    bar.className = 'hour-bar';
    bar.style.height = `${Math.max(2, (row.calls / max) * 185)}px`;
    bar.style.opacity = row.calls === 0 ? '.2' : '1';
    bar.dataset.tip = `${row.label} · ${row.calls} calls`;
    host.appendChild(bar);
  }
}

function eventDetail(event) {
  if (event.reason) return event.reason.replaceAll('_', ' ');
  if (event.deviceName) return event.deviceName;
  if (event.deviceId) return event.deviceId.slice(0, 12) + '…';
  return event.callType === 'gateway-local' ? 'Gateway' : 'Home';
}

function renderEvents(data) {
  const body = $('eventsBody');
  body.innerHTML = '';
  const events = data.events.events;
  setText('eventCount', `${events.length} latest`);

  if (events.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No audit events yet.</td></tr>';
    return;
  }

  for (const event of events) {
    const row = document.createElement('tr');
    const when = new Date(event.ts);
    const latency = event.durationMs == null ? '—' : `${event.durationMs} ms`;
    const callType = event.callType === 'gateway-local' ? 'Gateway-local' : 'Routed device';
    row.innerHTML =
      `<td>${when.toLocaleString()}</td>`
      + `<td class="tool-name"></td>`
      + `<td><span class="badge ${event.outcome}">${event.outcome}</span></td>`
      + `<td>${callType}</td>`
      + `<td>${eventDetail(event)}</td>`
      + `<td>${latency}</td>`;
    row.querySelector('.tool-name').textContent = event.toolName;
    body.appendChild(row);
  }
}

function updateTimestamp(data) {
  const when = new Date(data.generatedAt);
  setText('lastUpdated', `Updated ${when.toLocaleTimeString()} · ${data.summary.timezone}`);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch(`/api/dashboard?range=${encodeURIComponent(selectedRange)}`, {
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    const data = await response.json();
    renderStatus(data.status);
    renderMetrics(data);
    renderToolChart(data);
    renderCallMix(data);
    renderActivity(data);
    renderEvents(data);
    updateTimestamp(data);
    document.title = `Desktop Commander Selfhost — ${data.summary.counters.totalCalls} calls`;
  } catch (error) {
    console.error(error);
    setText('lastUpdated', 'Dashboard backend unavailable');
    const strip = $('statusStrip');
    strip.innerHTML = '<span class="status-chip bad">Dashboard disconnected</span>';
  } finally {
    refreshing = false;
  }
}

for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => {
    selectedRange = button.dataset.range;
    document.querySelectorAll('[data-range]').forEach((item) =>
      item.classList.toggle('selected', item === button)
    );
    void refresh();
  });
}

void refresh();
setInterval(() => void refresh(), 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

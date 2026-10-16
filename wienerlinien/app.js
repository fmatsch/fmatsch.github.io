(() => {
'use strict';
const API = (window.WL_API || '') + '/api/';
const MODES = {u: {title: 'U-Bahn Wien', file: 'network.json'}, tram: {title: 'Straßenbahn Wien', file: 'network_tram.json'}};
let mode = ls0('wl.mode', 'u');
if (location.hash === '#tram') mode = 'tram'; else if (location.hash === '#u') mode = 'u';
const api = (path) => API + path + (mode === 'tram' ? '?mode=tram' : '');
let LINES = [];
const colorOf = (line) => (net && net.lines[line] && net.lines[line].color) || '#888';
function ls0(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }
const $ = (s) => document.querySelector(s);
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString('de-AT', {timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit', second: '2-digit'});
const ls = {get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
            set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }};

let net = null, tracks = {}, active = new Set();
let trains = new Map();            // id -> {data, err, t0, marker, g}
let clockOffset = 0;               // serverTime - clientTime (s)
let pollMs = 30000, lastOk = 0, lastCount = 0, lastMsg = '';
let view = ls.get('wl.view', 'map');
const nowS = () => Date.now() / 1000 + clockOffset;

// ---------------------------------------------------------------- geometry helpers
function prepTrack(line, d, td) {
  const t = {line, dir: d, td, color: net.lines[line].color, st: td.stations, path: td.path, cum: td.cum};
  t.sArr = t.st.map((s) => s.s);
  return t;
}
function latlon(t, s) {
  const c = t.cum; let lo = 1, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m + 1; else hi = m; }
  const a = c[lo - 1], b = c[lo], f = b === a ? 0 : Math.min(1, Math.max(0, (s - a) / (b - a)));
  const p = t.path[lo - 1], q = t.path[lo];
  return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
}
function bearing(t, s) {
  const c = t.cum; let lo = 1, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m + 1; else hi = m; }
  const p = t.path[lo - 1], q = t.path[lo];
  return (Math.atan2((q[1] - p[1]) * Math.cos(p[0] * Math.PI / 180), q[0] - p[0]) * 180 / Math.PI + 360) % 360;
}
function posAt(wp, t) {
  if (!wp.length) return 0;
  if (t <= wp[0][0]) return wp[0][1];
  for (let i = 1; i < wp.length; i++) {
    if (t <= wp[i][0]) {
      const [t0, s0] = wp[i - 1], [t1, s1] = wp[i];
      return t1 === t0 ? s1 : s0 + (s1 - s0) * (t - t0) / (t1 - t0);
    }
  }
  return wp[wp.length - 1][1];
}
function stationFrac(t, s) {              // fractional station index for arc length s
  const a = t.sArr; let i = 0;
  while (i < a.length - 2 && s > a[i + 1]) i++;
  const span = a[i + 1] - a[i];
  return i + (span ? Math.min(1, Math.max(0, (s - a[i]) / span)) : 0);
}

// ---------------------------------------------------------------- map
let map, lineLayers = {}, stationLayers = {};
function createMap() {
  map = L.map('map', {zoomControl: true, attributionControl: true}).setView([48.2082, 16.3738], 12);
  L.tileLayer('https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/{z}/{y}/{x}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: 'Grundkarte: <a href="https://basemap.at">basemap.at</a> (CC BY 4.0)'}).addTo(map);
  const zoomLabels = () => map.getContainer().classList.toggle('labels', map.getZoom() >= (mode === 'tram' ? 14 : 13));
  map.on('zoomend', zoomLabels); zoomLabels();
}
function addLayers() {
  map.invalidateSize();
  const labeled = new Set();
  for (const line of Object.keys(net.lines)) {
    const grp = L.layerGroup(), sg = L.layerGroup();
    const H = tracks[line + '/H'];
    L.polyline(H.path, {color: H.color, weight: mode === 'tram' ? 4 : 5, opacity: .9, lineCap: 'round'}).addTo(grp);
    for (const s of H.st) {
      L.circleMarker([s.lat, s.lon], {radius: mode === 'tram' ? 3.5 : 4.5, weight: 2, color: H.color, fillColor: '#fff', fillOpacity: 1})
        .bindTooltip(`<b>${s.name}</b><br><span class="sub">${line}</span>`, {direction: 'top', offset: [0, -4]}).addTo(sg);
      if (!labeled.has(s.diva)) {      // interchange stations: one label only
        labeled.add(s.diva);
        L.marker([s.lat, s.lon], {interactive: false, keyboard: false, icon: L.divIcon({className: 'stn-label-wrap', iconSize: [0, 0],
          html: `<span class="stn-label">${s.name}</span>`})}).addTo(sg);
      }
    }
    lineLayers[line] = grp; stationLayers[line] = sg;
  }
  map.fitBounds(L.polyline(Object.values(tracks).flatMap((t) => t.path)).getBounds().pad(0.05));
  map.getContainer().classList.toggle('labels', map.getZoom() >= (mode === 'tram' ? 14 : 13));
  applyFilter();
}

function trainIcon(d) {
  const c = colorOf(d.line);
  return L.divIcon({className: 'train-wrap', iconSize: [0, 0],
    html: `<div class="train${d.ghost ? ' ghost' : ''}" style="--c:${c}"><div class="arrow"></div><div class="body">${d.line}</div></div>`});
}
function popupHtml(tr) {
  const d = tr.data, nd = d.next_departure;
  let dep = '';
  if (nd) { const mins = Math.max(0, Math.round((nd.t - nowS()) / 60)); dep = `<br>Abfahrt ${nd.station}: <b>${fmtTime(nd.t)}</b> <span class="sub">(${mins === 0 ? 'jetzt' : 'in ' + mins + ' min'})</span>`; }
  const where = d.at_station ? `in <b>${d.next}</b>` : `${d.prev} → <b>${d.next}</b>`;
  return `<div class="tip"><b style="color:${colorOf(d.line)}">${d.line}</b> Richtung <b>${d.towards}</b><br>${where}${dep}</div>`;
}

// ---------------------------------------------------------------- schematic
let svgTrains = {};
function buildNet() {
  const W = 1090, left = 60, right = 120, rowH = 150, top = 55;
  let html = '', y = top;
  const rows = LINES;
  rows.forEach((line, r) => {
    const H = tracks[line + '/H'], n = H.st.length, dx = (W - left - right) / (n - 1);
    const yH = y + 82, yR = yH + 24, c = H.color;
    html += `<g data-line="${line}" style="--c:${c}">`;
    html += `<text x="6" y="${(yH + yR) / 2 + 5}" style="font-weight:800;font-size:18px;fill:${c}">${line}</text>`;
    html += `<line class="lane" x1="${left}" x2="${W - right}" y1="${yH}" y2="${yH}"/><line class="lane" x1="${left}" x2="${W - right}" y1="${yR}" y2="${yR}" opacity=".55"/>`;
    H.st.forEach((s, i) => {
      const x = left + i * dx;
      html += `<circle class="stn" cx="${x}" cy="${(yH + yR) / 2}" r="5.5"/>`;
      html += `<text transform="translate(${x + 3},${yH - 14}) rotate(-52)" font-size="11">${s.name}</text>`;
    });
    html += `<text class="mute" x="${W - right + 4}" y="${yH + 4}" font-size="10">→ ${H.td.towards}</text>`;
    html += `<text class="mute" x="${W - right + 4}" y="${yR + 4}" font-size="10">← ${tracks[line + '/R'].td.towards}</text>`;
    html += `<g id="trains-${line}"></g></g>`;
    net._row = net._row || {}; net._row[line] = {left, dx, yH, yR, n, divaIdx: Object.fromEntries(H.st.map((s, i) => [s.diva, i]))};
    y += rowH;
  });
  $('#net').innerHTML = `<svg viewBox="0 0 ${W} ${y}" role="img" aria-label="Schematischer Netzplan mit Live-Zügen">${html}</svg>`;
  svgTrains = {};
  applyFilter();
}
function netX(row, track, frac) {
  const a = Math.floor(frac), b = Math.min(Math.ceil(frac), track.st.length - 1), f = frac - a;
  const xi = (i) => row.left + row.divaIdx[track.st[i].diva] * row.dx;
  return xi(a) + (xi(b) - xi(a)) * f;
}

// ---------------------------------------------------------------- data + animation
function applyFilter() {
  for (const line of Object.keys(lineLayers)) {
    const on = active.has(line);
    for (const g of [lineLayers[line], stationLayers[line]]) on ? g.addTo(map) : map.removeLayer(g);
  }
  document.querySelectorAll('#net [data-line]').forEach((g) => { g.style.display = active.has(g.dataset.line) ? '' : 'none'; });
  document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', active.has(b.dataset.line)));
  for (const tr of trains.values()) syncVisibility(tr);
}
function syncVisibility(tr) {
  const on = active.has(tr.data.line);
  if (tr.marker) { on ? tr.marker.addTo(map) : map.removeLayer(tr.marker); }
}

function onData(res) {
  clockOffset = res.now - Date.now() / 1000;
  pollMs = (res.poll_interval || 30) * 1000;
  lastOk = res.ok ? Date.now() : lastOk; lastMsg = res.message; lastCount = res.trains.length;
  const seen = new Set(), t = nowS();
  for (const d of res.trains) {
    seen.add(d.id);
    let tr = trains.get(d.id);
    const track = tracks[d.line + '/' + d.dir];
    const target = posAt(d.wp, t);
    if (!tr) {
      tr = {data: d, err: 0, t0: t, track};
      tr.marker = L.marker(latlon(track, target), {icon: trainIcon(d), zIndexOffset: 500, keyboard: false})
        .bindPopup(() => popupHtml(tr), {offset: [0, -8]});
      trains.set(d.id, tr);
      syncVisibility(tr);
    } else {
      tr.err = tr.disp != null ? tr.disp - target : 0;   // blend from where it is drawn now to the new estimate
      tr.t0 = t; tr.data = d;
      if (d.ghost !== tr.ghost) tr.marker.setIcon(trainIcon(d));
    }
    tr.ghost = d.ghost;
  }
  for (const [id, tr] of trains) if (!seen.has(id)) { if (tr.marker) map.removeLayer(tr.marker); if (tr.g) tr.g.remove(); trains.delete(id); }
}

function frame() {
  const t = nowS();
  for (const tr of trains.values()) {
    const d = tr.data, s = posAt(d.wp, t) + tr.err * Math.exp(-(t - tr.t0) / 2);
    tr.disp = s;
    if (view === 'map' && tr.marker && active.has(d.line)) {
      tr.marker.setLatLng(latlon(tr.track, s));
      const el = tr.marker.getElement && tr.marker.getElement();
      if (el) { const a = el.querySelector('.arrow'); if (a) a.style.transform = `rotate(${bearing(tr.track, s)}deg)`; }
    } else if (view === 'net') {
      const row = net._row[d.line], host = $('#trains-' + d.line);
      if (!row || !host) continue;
      if (!tr.g) {
        tr.g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        tr.g.setAttribute('class', 't'); tr.g.setAttribute('style', `--c:${colorOf(d.line)}`);
        tr.g.innerHTML = `<circle r="9"/><text y="3">${d.dir === 'H' ? '›' : '‹'}</text><title></title>`;
        tr.g.addEventListener('click', () => { tr.g.querySelector('title').textContent = ''; });
        host.appendChild(tr.g);
      }
      const x = netX(row, tr.track, stationFrac(tr.track, s)), y = d.dir === 'H' ? row.yH : row.yR;
      tr.g.setAttribute('transform', `translate(${x},${y})`);
      tr.g.querySelector('title').textContent = `${d.line} → ${d.towards}\n${d.at_station ? 'in ' + d.next : d.prev + ' → ' + d.next}`;
    }
  }
  requestAnimationFrame(frame);
}

let pollGen = 0, pollTimer = null;
async function poll(gen) {
  if (gen !== pollGen) return;
  try {
    const r = await fetch(api('trains'), {cache: 'no-store'});
    const res = await r.json();
    if (gen !== pollGen) return;          // mode switched while the request was running
    if (res.trains) onData(res);
    else lastMsg = res.error || 'keine Daten';
  } catch (e) { lastMsg = 'API nicht erreichbar'; }
  renderStatus();
  if (!$('#debug').hidden) loadDebug();
  pollTimer = setTimeout(() => poll(gen), Math.max(15000, pollMs));
}
function renderStatus() {
  const el = $('#status'), txt = $('#status-text');
  const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
  const ok = age !== null && age < Math.max(90, pollMs * 2.5 / 1000);
  el.className = 'status ' + (ok ? 'ok' : 'bad');
  txt.textContent = ok ? `${lastCount} Züge · Stand vor ${age} s` : `keine aktuellen Daten${lastMsg && lastMsg !== 'ok' ? ' – ' + lastMsg : ''}`;
  const n = $('#notice');
  if (ok && lastCount === 0) { n.hidden = false; n.textContent = 'Gerade fahren keine Züge (Nachtpause) oder die Wiener Linien liefern keine Prognosen.'; }
  else n.hidden = true;
}

// ---------------------------------------------------------------- debug panel
async function loadDebug() {
  try {
    const res = await (await fetch(api('debug'), {cache: 'no-store'})).json();
    const snap = res.snapshot; if (!snap) return;
    const line = $('#debug-line').value || LINES[0];
    $('#debug-meta').textContent = `Poll ${fmtTime(snap.ts)} · polls ${res.status.polls} · Fehler ${res.status.failures} · vehicle.onStop ${snap.on_stop_seen ? 'vorhanden' : 'nie gesehen'}`;
    let html = '';
    for (const d of ['H', 'R']) {
      const tk = tracks[line + '/' + d]; if (!tk) continue;
      const mine = snap.trains.filter((t) => t.line === line && t.dir === d);
      html += `<strong>${line} ${d} → ${tk.td.towards}</strong> · ${mine.length} Züge`;
      html += '<table><tr><th>#</th><th>Station</th><th>RBL</th><th>Roh-Countdowns (s, r=Echtzeit p=Plan)</th><th>Zug am Kopf der Kette</th></tr>';
      tk.st.forEach((s, i) => {
        const deps = (snap.stations[`${line}/${d}/${i}`] || []).filter((x) => x.in > -60).slice(0, 8)
          .map((x) => `${x.in}${x.real ? 'r' : 'p'}${x.onStop ? '*' : ''}`).join('  ');
        const heads = mine.filter((t) => t.next_departure && t.next_departure.station === s.name).map((t) => `#${t.id}${t.ghost ? ' (Ghost)' : ''}`).join(', ');
        html += `<tr><td class="n">${i}</td><td>${s.name}</td><td class="n">${s.rbl || '–'}</td><td>${s.rbl ? deps || '<span class="n">keine Daten</span>' : '<span class="n">Endstation/keine RBL</span>'}</td><td>${heads}</td></tr>`;
      });
      html += '</table>';
      html += '<table><tr><th>Zug</th><th>Position</th><th>s (m)</th><th>Ziel</th><th>nächste Abfahrt</th></tr>' + mine.map((t) =>
        `<tr><td>#${t.id}${t.ghost ? ' Ghost' : ''}</td><td>${t.at_station ? 'in ' + t.next : t.prev + ' → ' + t.next}</td><td>${Math.round(t.s)}</td><td>${t.towards}</td><td>${t.next_departure ? fmtTime(t.next_departure.t) + ' ' + t.next_departure.station : '–'}</td></tr>`).join('') + '</table>';
    }
    $('#debug-body').innerHTML = html;
  } catch (e) { $('#debug-body').textContent = 'Debug-Daten nicht verfügbar: ' + e; }
}

// ---------------------------------------------------------------- boot
function setView(v) {
  view = v; ls.set('wl.view', v);
  $('#map').hidden = v !== 'map'; $('#net').hidden = v !== 'net';
  $('#tab-map').setAttribute('aria-selected', v === 'map'); $('#tab-net').setAttribute('aria-selected', v === 'net');
  if (v === 'map') { setTimeout(() => map.invalidateSize(), 0); for (const tr of trains.values()) { if (tr.g) { tr.g.remove(); tr.g = null; } } }
  else for (const tr of trains.values()) if (tr.marker) map.removeLayer(tr.marker);
  if (v === 'map') for (const tr of trains.values()) syncVisibility(tr);
}

async function loadMode(m) {
  mode = m; ls.set('wl.mode', m);
  pollGen++; clearTimeout(pollTimer);
  for (const tr of trains.values()) { if (tr.marker) map.removeLayer(tr.marker); if (tr.g) tr.g.remove(); }
  trains.clear();
  for (const g of [...Object.values(lineLayers), ...Object.values(stationLayers)]) map.removeLayer(g);
  lineLayers = {}; stationLayers = {}; tracks = {}; lastOk = 0; lastCount = 0; lastMsg = '';
  try { net = await (await fetch(api('network'))).json(); }
  catch (e) { net = await (await fetch(MODES[m].file)).json(); }
  if (mode !== m) return;                 // switched again meanwhile
  for (const [line, v] of Object.entries(net.lines)) for (const [d, td] of Object.entries(v.dirs)) tracks[line + '/' + d] = prepTrack(line, d, td);
  LINES = Object.keys(net.lines);
  const saved = ls.get('wl.lines.' + m, LINES).filter((l) => LINES.includes(l));
  active = new Set(saved.length ? saved : LINES);
  const f = $('#filters'); f.innerHTML = '';
  $('#debug-line').innerHTML = '';
  for (const line of LINES) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = line; b.dataset.line = line; b.style.setProperty('--c', colorOf(line));
    b.addEventListener('click', () => { active.has(line) ? active.delete(line) : active.add(line); ls.set('wl.lines.' + m, [...active]); applyFilter(); });
    f.appendChild(b);
    $('#debug-line').insertAdjacentHTML('beforeend', `<option>${line}</option>`);
  }
  $('#filters').hidden = LINES.length < 2;
  $('#h1').firstChild.nodeValue = MODES[m].title + ' ';
  document.title = MODES[m].title + ' live';
  document.querySelectorAll('.modeswitch button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === m));
  document.querySelector('.modeswitch').dataset.mode = m;
  addLayers(); buildNet(); setView(view);
  renderStatus();
  poll(pollGen);
}

async function boot() {
  createMap();
  document.querySelectorAll('.modeswitch button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.mode !== mode) loadMode(b.dataset.mode); }));
  $('#tab-map').onclick = () => setView('map'); $('#tab-net').onclick = () => setView('net');
  $('#debug-toggle').onclick = () => { const h = $('#debug').hidden = !$('#debug').hidden; if (!h) loadDebug(); setTimeout(() => map.invalidateSize(), 0); };
  $('#debug-line').onchange = loadDebug;
  await loadMode(mode);
  requestAnimationFrame(frame); setInterval(renderStatus, 1000);
}
boot();
})();

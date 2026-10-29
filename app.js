"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const MODELS = ["pronet", "fastforecast"];
const NAMES = {observations: "实况观测", pronet: "ProNet", fastforecast: "FastForecast"};
const COLORS = {observations: "#929b8c", pronet: "#5b85a0", fastforecast: "#c78c52"};
const HOUR = 3600000;
const number = (v) => typeof v === "number" && Number.isFinite(v);
const value = (v) => number(v) ? v.toFixed(1) : "—";
const state = {catalog: null, payload: null, cycle: null, pollutant: "pm25", range: "all", visible: new Set(["observations", ...MODELS]), epoch: 0, busy: false, abort: null, rows: [], cursor: 0};
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const fullFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const hourFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"});
function stamp(v, full = false) { return v && Number.isFinite(new Date(v).getTime()) ? (full ? fullFormatter : dateFormatter).format(new Date(v)) : "—"; }
function element(tag, attrs = {}, content) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
  if (content !== undefined) el.textContent = content;
  return el;
}
function svg(tag, attrs = {}, content) {
  const el = document.createElementNS(NS, tag);
  for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
  if (content !== undefined) el.textContent = content;
  return el;
}
function setText(id, text) { $(id).textContent = text; }
function connection(text, warning = false) {
  $("connection").replaceChildren(element("span", {class: "dot"}), document.createTextNode(text));
  $("connection").classList.toggle("warning", warning);
}
function notice(text) { setText("notice", text); $("notice").hidden = !text; }
function paths(rows, x, y, key) {
  let d = "", previous = false;
  rows.forEach((r, i) => {
    if (number(r[key])) { d += `${previous ? "L" : "M"}${x(i).toFixed(2)},${y(r[key]).toFixed(2)} `; previous = true; }
    else previous = false;
  });
  return d;
}
function spark(id, rows, key) {
  const root = $(id); root.replaceChildren();
  if (rows.length < 2) return;
  const indexed = new Map(rows.map(r => [new Date(r.valid_time).getTime(), r[key]]));
  const start = new Date(rows[0].valid_time).getTime(), end = new Date(rows[rows.length - 1].valid_time).getTime();
  const points = [];
  for (let t = start; t <= end; t += HOUR) points.push({v: indexed.get(t) ?? null});
  const vals = points.map(r => r.v).filter(number);
  if (!vals.length || points.length < 2) return;
  const min = Math.min(...vals), spread = Math.max(1, Math.max(...vals) - min);
  root.append(svg("path", {d: paths(points, i => i / (points.length - 1) * 140, v => 36 - (v - min) / spread * 30, "v"), fill: "none", stroke: "#92a782", "stroke-width": 1.5}));
}
function renderOverview() {
  const c = state.catalog;
  const obs = c.observations || {};
  const latest = obs.latest_hourly || obs.hourly?.[obs.hourly.length - 1];
  setText("pm-value", value(latest?.pm25)); setText("o3-value", value(latest?.o3));
  for (const [field, prefix] of [["pm25", "pm"], ["o3", "o3"]]) {
    setText(`${prefix}-detail`, latest ? `${stamp(latest.valid_time)} · ${latest.valid_station_count?.[field] ?? 0} / ${c.station_count} 站有效` : "尚无可用城市观测");
    spark(`${prefix}-spark`, obs.hourly || [], field);
  }
  setText("station-count", c.station_count ?? "—");
  setText("station-detail", c.latest_observation_time ? `观测更新至 ${stamp(c.latest_observation_time)}` : "等待观测到站");
  renderStations();
}
function renderCycles() {
  const select = $("cycle");
  select.replaceChildren();
  for (const item of state.catalog.cycles) select.append(element("option", {value: item.cycle}, `${stamp(item.init_time, true)} 起报`));
  if (!state.catalog.cycles.length) select.append(element("option", {}, "暂无预报批次"));
  select.disabled = !state.catalog.cycles.length;
  if (state.cycle) select.value = state.cycle;
}
function renderStations() {
  const c = state.catalog, rec = c.observations?.latest_record;
  const root = $("station-grid"); root.replaceChildren();
  setText("station-time", rec ? `${stamp(rec.valid_time, true)} · 最新站点观测，与起报批次选择无关` : "尚无站点观测，与起报批次选择无关");
  setText("station-valid", `${c.station_count || 0} 站 · 单位 μg/m³`);
  (c.stations || []).forEach((s, index) => {
    const card = element("article", {class: "station"});
    const head = element("div", {class: "station-head"});
    head.append(element("span", {}, s.name), element("span", {class: "dot", "aria-hidden": "true"}));
    const coords = number(s.longitude) && number(s.latitude) ? ` · ${s.longitude.toFixed(2)}°E ${s.latitude.toFixed(2)}°N` : "";
    card.append(head, element("div", {class: "station-id"}, `${s.station_id}${coords}`));
    const measures = element("div", {class: "station-measures"});
    for (const [field, label] of [["pm25", "PM₂.₅"], ["o3", "O₃"]]) {
      const part = element("div"); part.append(element("small", {}, label), element("strong", {}, value(rec?.values?.[field]?.[index]))); measures.append(part);
    }
    card.append(measures); root.append(card);
  });
}
function rowsForChart() {
  const p = state.payload;
  if (!p) return [];
  const series = {observations: p.observations?.hourly || []};
  for (const m of MODELS) series[m] = p.models[m]?.hourly || [];
  const predictionTimes = MODELS.flatMap(m => series[m].map(r => new Date(r.valid_time).getTime())).filter(Number.isFinite);
  if (!predictionTimes.length) return [];
  const start = Math.min(...predictionTimes), end = Math.min(Math.max(...predictionTimes), state.range === "all" ? Infinity : start + (Number(state.range) - 1) * HOUR);
  const maps = Object.fromEntries(Object.entries(series).map(([name, rows]) => [name, new Map(rows.map(r => [new Date(r.valid_time).getTime(), r]))]));
  const rows = [];
  for (let time = start; time <= end; time += HOUR) {
    const r = {time, counts: {}};
    for (const name of Object.keys(series)) {
      const source = maps[name].get(time);
      r[name] = source?.[state.pollutant] ?? null;
      r.counts[name] = source?.valid_station_count?.[state.pollutant] ?? 0;
    }
    rows.push(r);
  }
  return rows;
}
let chartGeometry = null;
function renderChart() {
  const root = $("hourly-chart"); root.replaceChildren(); $("chart-tooltip").hidden = true;
  const rows = state.rows;
  const names = ["observations", ...MODELS].filter(m => state.visible.has(m));
  const vals = rows.flatMap(r => names.map(m => r[m])).filter(number);
  $("chart-empty").hidden = Boolean(vals.length);
  setText("chart-empty", !rows.length ? "该批次暂无可展示的有效预报" : !names.length ? "点击图例，选择要显示的曲线" : "当前选择尚无有效数据");
  const w = Math.max(340, root.clientWidth), h = w < 600 ? 270 : 320;
  const left = 40, right = 12, top = 24, bottom = 38;
  root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  root.setAttribute("tabindex", "0");
  root.setAttribute("aria-label", `${state.pollutant === "pm25" ? "PM2.5" : "O3"}小时曲线，可用左右方向键查看数值，或展开下方数据表。`);
  const max = Math.max(10, ...vals), step = Math.max(5, Math.ceil(max / 4 / 5) * 5), ceiling = step * 4;
  const x = i => left + i / Math.max(1, rows.length - 1) * (w - left - right);
  const y = v => h - bottom - v / ceiling * (h - bottom - top);
  chartGeometry = {w, h, left, right, x, y, rows};
  const latest = state.catalog?.latest_observation_time ? new Date(state.catalog.latest_observation_time).getTime() : null;
  if (rows.length > 1 && latest !== null && latest >= rows[0].time && latest < rows[rows.length - 1].time) {
    const i = Math.max(0, Math.min(rows.length - 1, (latest - rows[0].time) / HOUR));
    root.append(svg("rect", {x: x(i), y: top, width: w - right - x(i), height: h - bottom - top, fill: "#f7f9f2"}));
    root.append(svg("line", {x1: x(i), x2: x(i), y1: top, y2: h - bottom, stroke: "#c5d0bb", "stroke-dasharray": "3 4"}));
    if (w - right - x(i) > 100) root.append(svg("text", {x: x(i) + 10, y: 15, fill: "#a1ad92", "font-size": 9}, "后续时段 · 等待观测"));
  }
  for (let i = 0; i <= 4; i++) {
    const yy = y(i * step);
    root.append(svg("line", {x1: left, x2: w - right, y1: yy, y2: yy, stroke: "#e9ede3", "stroke-width": 1, "stroke-dasharray": i === 0 ? "none" : "3 5"}));
    root.append(svg("text", {x: left - 10, y: yy + 3, fill: "#9aa48e", "font-size": 9, "text-anchor": "end"}, String(i * step)));
  }
  if (!rows.length) return;
  const ticks = Math.min(rows.length - 1, w < 600 ? 3 : 6);
  for (let i = 0; i <= ticks; i++) {
    const ix = ticks ? Math.round(i / ticks * (rows.length - 1)) : 0;
    root.append(svg("text", {x: x(ix), y: h - 12, fill: "#96a18c", "font-size": w < 500 ? 8 : 9, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle"}, hourFormatter.format(new Date(rows[ix].time))));
  }
  if (state.visible.has("observations")) {
    const width = Math.max(1.1, Math.min(5, (w - left - right) / rows.length * .6));
    rows.forEach((r, i) => { if (number(r.observations)) root.append(svg("rect", {x: x(i) - width / 2, y: y(r.observations), width, height: Math.max(1, y(0) - y(r.observations)), fill: COLORS.observations, opacity: .42, rx: .5})); });
  }
  for (const model of MODELS) {
    if (!state.visible.has(model)) continue;
    root.append(svg("path", {d: paths(rows, x, y, model), fill: "none", stroke: COLORS[model], "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": model === "fastforecast" ? "5 3" : "none"}));
    rows.forEach((r, i) => { if (number(r[model]) && !number(rows[i - 1]?.[model]) && !number(rows[i + 1]?.[model])) root.append(svg("circle", {cx: x(i), cy: y(r[model]), r: 2, fill: COLORS[model]})); });
  }
  root.append(svg("line", {id: "cursor-line", x1: 0, x2: 0, y1: top, y2: h - bottom, stroke: "#69805c", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden"}));
  const label = state.pollutant === "pm25" ? "PM₂.₅" : "O₃";
  setText("hourly-subtitle", `${label} 城市小时浓度 · ${stamp(rows[0].time)} — ${stamp(rows[rows.length - 1].time)} · 缺测留空`);
  setText("coverage-note", `${rows.length} 个小时位置 · 按 time + leadTimes 对齐 · 灰色柱为观测`);
}
function showCursor(index) {
  const g = chartGeometry; if (!g?.rows.length) return;
  index = Math.max(0, Math.min(index, g.rows.length - 1)); state.cursor = index;
  const r = g.rows[index], line = $("cursor-line"), tip = $("chart-tooltip");
  if (line) { line.setAttribute("x1", g.x(index)); line.setAttribute("x2", g.x(index)); line.setAttribute("visibility", "visible"); }
  tip.replaceChildren(element("b", {}, stamp(r.time, true)));
  for (const name of ["observations", ...MODELS]) {
    if (!state.visible.has(name)) continue;
    const row = element("div", {class: "tooltip-row"}), label = element("span");
    const mark = element("i", {class: "legend-dot"}); mark.style.background = COLORS[name];
    label.append(mark, document.createTextNode(NAMES[name]));
    row.append(label, element("strong", {}, `${value(r[name])}${number(r[name]) ? ` · ${r.counts[name]}站` : ""}`)); tip.append(row);
  }
  tip.hidden = false;
  const width = $("hourly-chart").clientWidth;
  tip.style.left = `${Math.max(0, Math.min(width - tip.offsetWidth, g.x(index) + (index / g.rows.length > .6 ? -tip.offsetWidth - 12 : 12)))}px`;
  tip.style.top = "30px";
}
function hideCursor() { $("chart-tooltip").hidden = true; $("cursor-line")?.setAttribute("visibility", "hidden"); }
function renderTable() {
  const body = $("hourly-table"), fragment = document.createDocumentFragment();
  for (const r of state.rows) {
    const row = element("tr"); row.append(element("td", {}, stamp(r.time, true)));
    for (const name of ["observations", ...MODELS]) row.append(element("td", {}, value(r[name])));
    fragment.append(row);
  }
  body.replaceChildren(fragment);
}
function renderDaily() {
  const p = state.payload, key = state.pollutant === "pm25" ? "pm25_daily_mean" : "o3_daily_max_8h_mean";
  setText("daily-heading", state.pollutant === "pm25" ? "每日 PM₂.₅ 平均浓度" : "每日 O₃ 最大 8 小时均值");
  const series = {observations: p.observations?.daily || []};
  for (const name of MODELS) series[name] = p.models[name]?.daily || [];
  const maps = Object.fromEntries(Object.entries(series).map(([name, rows]) => [name, new Map(rows.map(r => [r.date, r]))]));
  const dates = [...new Set(MODELS.flatMap(m => series[m].map(r => r.date)))].sort();
  const max = Math.max(1, ...Object.values(series).flatMap(rows => rows.map(r => r[key])).filter(number));
  const root = $("daily-content"); root.replaceChildren();
  if (!dates.length) { root.append(element("div", {class: "empty-inline"}, "尚无可用日指标")); return; }
  for (const day of dates) {
    const col = element("div", {class: "day-column"}), bars = element("div", {class: "day-bars"}), values = element("div", {class: "day-values"});
    let partial = false;
    for (const name of ["observations", ...MODELS]) {
      const row = maps[name].get(day), v = row?.[key], incomplete = row?.status === "partial";
      const wrap = element("div", {class: "day-bar-wrap"});
      if (incomplete) partial = true;
      const text = `${NAMES[name]}：${value(v)}${number(v) ? " μg/m³" : ""}${incomplete ? "（部分时段）" : ""}`;
      if (number(v)) { const bar = element("div", {class: `day-bar ${name}${incomplete ? " partial" : ""}`, title: text}); bar.style.height = `${Math.max(1, v / max * 95)}%`; wrap.append(bar); }
      bars.append(wrap); values.append(element("span", {class: name, title: text, "aria-label": text}, `${value(v)}${incomplete ? "*" : ""}`));
    }
    const obsStatus = maps.observations.get(day)?.status;
    const status = obsStatus === "current" ? "观测统计中" : partial ? "部分时段*" : obsStatus === "future" ? "等待观测" : "";
    col.append(bars, element("div", {class: "day-label"}, day.slice(5).replace("-", "/")), element("div", {class: "day-status"}, status), values); root.append(col);
  }
}
function renderEvaluation() {
  const models = MODELS.filter(m => state.payload.models[m]);
  const pairs = state.rows.filter(r => number(r.observations) && models.every(m => number(r[m])));
  const root = $("evaluation-content"); root.replaceChildren();
  const summary = element("div", {class: "eval-summary"}); summary.append(element("strong", {}, models.length ? String(pairs.length) : "0"), element("span", {}, "个共同有效小时")); root.append(summary);
  setText("evaluation-subtitle", `${state.pollutant === "pm25" ? "PM₂.₅" : "O₃"} · 当前显示时段 · ${models.length === 2 ? "双模型共同样本" : "可用模型有效样本"}`);
  if (!pairs.length || !models.length) { root.append(element("div", {class: "empty-inline"}, "观测尚未覆盖有效预报，误差暂不计算。")); return; }
  const table = element("table", {class: "eval-table"}), head = element("thead"), header = element("tr"), body = element("tbody");
  for (const title of ["模型", "MAE", "RMSE", "偏差"]) header.append(element("th", {scope: "col"}, title));
  head.append(header); table.append(head, body);
  for (const name of models) {
    const errors = pairs.map(r => r[name] - r.observations);
    const mae = errors.reduce((s, v) => s + Math.abs(v), 0) / errors.length;
    const rmse = Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length);
    const bias = errors.reduce((s, v) => s + v, 0) / errors.length;
    const row = element("tr"), label = element("td"); label.append(element("i", {class: `model-chip ${name}`}), document.createTextNode(NAMES[name]));
    row.append(label, element("td", {}, value(mae)), element("td", {}, value(rmse)), element("td", {}, `${bias > .05 ? "+" : ""}${value(bias)}`)); body.append(row);
  }
  root.append(table, element("p", {class: "unit"}, `${stamp(pairs[0].time)} — ${stamp(pairs[pairs.length - 1].time)} · 单位 μg/m³`));
}
function renderPayload() {
  const p = state.payload;
  const entries = MODELS.filter(m => p.models[m]);
  const maxHours = Math.max(0, ...entries.map(m => p.models[m].coverage?.hours || 0));
  setText("horizon-value", maxHours || "—");
  setText("horizon-detail", entries.map(m => `${NAMES[m]} ${p.models[m].coverage?.hours ?? "—"}h`).join(" / "));
  setText("cycle-note", entries.map(m => `${NAMES[m]} · 第 ${p.models[m].revision} 版`).join("　/　"));
  state.rows = rowsForChart();
  renderChart(); renderTable(); renderDaily(); renderEvaluation();
  $("figure-open").disabled = !p.figure;
  if ($("figure-dialog").open) showFigure();
}
function figureURL() {
  return window.HZFDataSource.figureURL(state.payload?.figure);
}
function showFigure() {
  const url = figureURL(); if (!url) return;
  setText("figure-info", `${stamp(state.payload.init_time, true)} 起报 · 图片更新 ${stamp(state.payload.figure.updated_at, true)}`);
  $("figure-error").hidden = true;
  if ($("figure-image").src !== url) $("figure-image").src = url;
  $("figure-download").href = url; $("figure-download").download = `${state.payload.cycle}.png`;
  if (!$("figure-dialog").open) $("figure-dialog").showModal();
}
async function refresh(reason = "timer") {
  if (state.busy && reason === "timer") return;
  state.abort?.abort();
  const epoch = ++state.epoch, controller = new AbortController(); state.abort = controller; state.busy = true;
  const timeout = setTimeout(() => controller.abort(), 20000);
  $("refresh").classList.add("loading"); $("refresh").setAttribute("aria-busy", "true");
  connection(state.catalog ? "正在刷新" : "正在连接数据");
  try {
    const catalog = await window.HZFDataSource.catalog(controller.signal);
    if (epoch !== state.epoch) return;
    if (catalog.schema_version !== 1 || !Array.isArray(catalog.cycles)) throw new Error("数据接口版本不匹配，请联系维护人员");
    const oldLatest = state.catalog?.cycles?.[0]?.cycle;
    const followLatest = !state.cycle || (state.cycle === oldLatest && reason !== "cycle");
    state.catalog = catalog;
    if (followLatest || !catalog.cycles.some(c => c.cycle === state.cycle)) state.cycle = catalog.cycles[0]?.cycle || null;
    renderOverview(); renderCycles();
    if (state.cycle) {
      const payload = await window.HZFDataSource.cycle(state.cycle, catalog, controller.signal);
      if (epoch !== state.epoch) return;
      if (payload.cycle !== state.cycle) throw new Error("起报批次未对齐，等待下一次刷新");
      state.payload = payload; renderPayload();
    } else {
      state.payload = null; state.rows = []; renderChart(); renderTable();
      $("daily-content").replaceChildren(element("div", {class: "empty-inline"}, "暂无预报批次"));
      $("evaluation-content").replaceChildren(element("div", {class: "empty-inline"}, "暂无预报批次"));
      $("figure-open").disabled = true;
    }
    const stale = catalog.stale || state.payload?.stale;
    const latest = catalog.latest_observation_time;
    const delayed = latest && Date.now() - new Date(latest).getTime() > 3 * HOUR;
    connection(stale ? "数据更新中 · 保留快照" : delayed ? "观测已有一段时间未更新" : window.HZFDataSource.isStatic ? "公开看板 · 30 秒刷新" : "实时连接 · 30 秒刷新", Boolean(stale || delayed));
    notice(stale ? (state.payload?.notice || catalog.notice || "数据正在更新，当前显示上一份可用快照。") : delayed ? `最新观测为 ${stamp(latest, true)}，距现在超过 3 小时。页面会持续读取后续更新。` : "");
    setText("refresh-time", `最近读取 ${stamp(new Date().toISOString(), true)} · 源数据快照 ${stamp(state.payload?.generated_at || catalog.generated_at)}`);
  } catch (error) {
    if (epoch !== state.epoch) return;
    const text = error.name === "AbortError" ? "读取超时，稍后自动重试" : error.message || "暂时无法连接数据服务";
    connection("连接暂缓 · 等待重试", true);
    notice(`${text}。${state.payload ? `当前保留 ${stamp(state.payload.init_time, true)} 起报的上次数据。` : window.HZFDataSource.isStatic ? "页面会自动重试，请稍后查看。" : "请保持 SSH 转发或组内网络连接，页面会自动重试。"}`);
    if (!state.payload) setText("chart-empty", "暂未取得数据，请稍候或点击右上角刷新。");
  } finally {
    clearTimeout(timeout);
    if (epoch === state.epoch) { state.busy = false; $("refresh").classList.remove("loading"); $("refresh").setAttribute("aria-busy", "false"); }
  }
}

$("refresh").addEventListener("click", () => refresh("manual"));
$("cycle").addEventListener("change", (event) => { state.cycle = event.target.value; refresh("cycle"); });
document.querySelectorAll("[data-pollutant]").forEach(button => button.addEventListener("click", () => {
  state.pollutant = button.dataset.pollutant;
  document.querySelectorAll("[data-pollutant]").forEach(b => { const selected = b === button; b.classList.toggle("selected", selected); b.setAttribute("aria-pressed", String(selected)); });
  if (state.payload) renderPayload();
}));
document.querySelectorAll("[data-range]").forEach(button => button.addEventListener("click", () => {
  state.range = button.dataset.range;
  document.querySelectorAll("[data-range]").forEach(b => { const selected = b === button; b.classList.toggle("selected", selected); b.setAttribute("aria-pressed", String(selected)); });
  if (state.payload) { state.rows = rowsForChart(); renderChart(); renderTable(); renderEvaluation(); }
}));
document.querySelectorAll("[data-series]").forEach(button => button.addEventListener("click", () => {
  const name = button.dataset.series;
  if (state.visible.has(name)) state.visible.delete(name); else state.visible.add(name);
  button.setAttribute("aria-pressed", String(state.visible.has(name))); renderChart();
}));
$("hourly-chart").addEventListener("pointermove", e => {
  const g = chartGeometry; if (!g?.rows.length) return;
  const rect = $("hourly-chart").getBoundingClientRect(), local = (e.clientX - rect.left) / rect.width * g.w;
  showCursor(Math.round((local - g.left) / (g.w - g.left - g.right) * (g.rows.length - 1)));
}, {passive: true});
$("hourly-chart").addEventListener("pointerleave", hideCursor);
$("hourly-chart").addEventListener("blur", hideCursor);
$("hourly-chart").addEventListener("keydown", e => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); showCursor(state.cursor + (e.key === "ArrowRight" ? 1 : -1)); }
  if (e.key === "Escape") hideCursor();
});
$("figure-open").addEventListener("click", showFigure);
$("figure-close").addEventListener("click", () => $("figure-dialog").close());
$("figure-image").addEventListener("error", () => { $("figure-error").hidden = false; });
$("figure-dialog").addEventListener("click", e => { if (e.target === $("figure-dialog")) $("figure-dialog").close(); });
const navLinks = [...document.querySelectorAll(".sidebar nav a")];
const sections = navLinks.map(a => document.querySelector(a.getAttribute("href")));
let scrollQueued = false;
window.addEventListener("scroll", () => {
  if (scrollQueued) return; scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    let active = sections[0]; for (const section of sections) if (section.getBoundingClientRect().top < 180) active = section;
    navLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${active.id}`));
  });
}, {passive: true});
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); }).observe($("hourly-chart").parentElement);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh("timer"); });
setText("today", new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long"}).format(new Date()));
refresh("initial");
setInterval(() => { if (!document.hidden) refresh("timer"); }, 30000);

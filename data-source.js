"use strict";

// 同一页面分别从 VPS 接口或 Pages 的 CSV 快照读取数据。
window.HZFDataSource = (() => {
  const isStatic = document.querySelector('meta[name="hzf-data-source"]')?.content === "static";
  const base = new URL("./", document.baseURI);
  const MODELS = ["pronet", "fastforecast"];
  const cycleCache = new Map();
  const numeric = v => v === "" || v === undefined ? null : Number(v);
  const counts = r => ({pm25: Number(r.pm25_count || 0), o3: Number(r.o3_count || 0)});
  const hourly = r => ({valid_time: r.time, pm25: numeric(r.pm25), o3: numeric(r.o3), valid_station_count: counts(r)});
  const daily = r => ({date: r.time, pm25_daily_mean: numeric(r.pm25), o3_daily_max_8h_mean: numeric(r.o3), status: r.status,
    valid_station_count: {pm25_daily_mean: Number(r.pm25_count || 0), o3_daily_max_8h_mean: Number(r.o3_count || 0)}});

  function parseCSV(text) {
    const rows = [], row = []; let field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (ch === "," || ch === "\n")) {
        row.push(field); field = "";
        if (ch === "\n") { rows.push(row.splice(0)); }
      } else if (ch !== "\r" || quoted) field += ch;
    }
    if (quoted) throw new Error("展示数据尚未完整发布");
    if (field || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift();
    if (!header?.length || new Set(header).size !== header.length) throw new Error("展示数据表头无效");
    return rows.filter(r => r.some(v => v !== "")).map(r => {
      if (r.length !== header.length) throw new Error("展示数据行未完整发布");
      return Object.fromEntries(header.map((key, i) => [key, r[i]]));
    });
  }
  async function request(path, signal, csv = false, version = "") {
    const url = new URL(path, base);
    if (version) url.searchParams.set("v", version);
    const response = await fetch(url, {cache: "no-store", credentials: "same-origin", signal,
      headers: {Accept: csv ? "text/csv" : "application/json"}});
    if (!response.ok) {
      let message = response.status === 503 ? "数据处理正在进行，稍后自动刷新" : `数据暂时无法读取（HTTP ${response.status}）`;
      if (!csv) { try { const body = await response.json(); if (typeof body.error === "string") message = body.error; } catch (_) { /* 保留 HTTP 状态。 */ } }
      throw new Error(message);
    }
    if (!csv) return response.json();
    const bytes = await response.arrayBuffer();
    if (version) {
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
      if (digest !== version) throw new Error("网页数据版本正在切换，稍后自动刷新");
    }
    return parseCSV(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  }
  async function catalog(signal) {
    if (!isStatic) return request("api/catalog", signal);
    const rows = await request("data/catalog.csv", signal, true);
    const meta = Object.fromEntries(rows.filter(r => r.kind === "meta").map(r => [r.key, r.value]));
    if (meta.schema_version !== "1") throw new Error("静态数据版本不匹配，请刷新页面");
    const stations = rows.filter(r => r.kind === "station").map(r => ({station_id: r.station_id, name: r.name,
      longitude: numeric(r.longitude), latitude: numeric(r.latitude), city: "杭州市", province: "浙江省"}));
    const cycles = rows.filter(r => r.kind === "cycle").map(r => ({cycle: r.cycle, init_time: r.init_time,
      version: r.version, models: {}, figure: null}));
    const index = new Map(cycles.map(c => [c.cycle, c]));
    for (const r of rows) {
      const c = index.get(r.cycle);
      if (c && r.kind === "model") c.models[r.source] = {revision: Number(r.revision), generated_at: r.generated_at,
        coverage: {start: r.start, end: r.end, hours: Number(r.hours)}};
      if (c && r.kind === "figure") c.figure = {url: r.url, updated_at: r.updated_at, version: r.version};
    }
    const latest = rows.find(r => r.kind === "latest_observation");
    const stationRows = new Map(rows.filter(r => r.kind === "station_observation").map(r => [r.station_id, r]));
    return {schema_version: 1, generated_at: meta.generated_at, timezone: meta.timezone, stale: false,
      selected_source: meta.selected_source, latest_observation_time: meta.latest_observation_time || null,
      station_count: stations.length, stations, cycles,
      observations: {hourly: rows.filter(r => r.kind === "recent_observation").map(hourly),
        latest_hourly: latest ? hourly(latest) : null,
        latest_record: latest ? {valid_time: latest.time, values: {
          pm25: stations.map(s => numeric(stationRows.get(s.station_id)?.pm25)),
          o3: stations.map(s => numeric(stationRows.get(s.station_id)?.o3))}} : null}};
  }
  async function cycle(id, selectedCatalog, signal) {
    if (!/^[0-9]{8}12$/.test(id)) throw new Error("起报批次格式无效");
    if (!isStatic) return request(`api/cycles/${id}`, signal);
    const entry = selectedCatalog.cycles.find(c => c.cycle === id);
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.version)) throw new Error("当前发布尚无这个批次");
    const cacheKey = `${id}:${entry.version}`;
    let rows = cycleCache.get(cacheKey);
    if (!rows) {
      rows = await request(`data/cycles/${id}.csv`, signal, true, entry.version);
      cycleCache.set(cacheKey, rows);
      while (cycleCache.size > 16) cycleCache.delete(cycleCache.keys().next().value);
    }
    const models = {};
    for (const name of MODELS) if (entry.models[name]) models[name] = {...entry.models[name],
      hourly: rows.filter(r => r.source === name && r.kind === "hour").map(hourly),
      daily: rows.filter(r => r.source === name && r.kind === "day").map(daily)};
    const observed = rows.filter(r => r.source === "observations");
    const hours = observed.filter(r => r.kind === "hour").map(hourly);
    return {schema_version: 1, generated_at: selectedCatalog.generated_at, timezone: selectedCatalog.timezone,
      stale: false, cycle: id, init_time: entry.init_time, station_count: selectedCatalog.station_count,
      stations: selectedCatalog.stations, models,
      observations: {hourly: hours, daily: observed.filter(r => r.kind === "day").map(daily),
        latest_time: hours.length ? hours[hours.length - 1].valid_time : null}, figure: entry.figure};
  }
  function figureURL(figure) {
    if (!figure) return null;
    const url = new URL(figure.url, base);
    const root = isStatic ? new URL("figures/", base).pathname : "/figures/";
    if (url.origin !== base.origin || !url.pathname.startsWith(root) || !/^[0-9]{8}12\.png$/.test(url.pathname.slice(root.length))) return null;
    url.searchParams.set("v", figure.version || figure.updated_at || "");
    return url.href;
  }
  return {catalog, cycle, figureURL, isStatic};
})();

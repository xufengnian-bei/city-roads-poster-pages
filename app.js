const geocodeEndpoints = [
  (q) =>
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN&q=${encodeURIComponent(
      q
    )}`,
];

const overpassEndpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const styleThemes = {
  minimal: {
    bg: "#f7f2e8",
    line: {
      major: "#2a2a2a",
      primary: "#3d3d3d",
      secondary: "#5a5a5a",
      tertiary: "#707070",
      local: "#8a8a8a",
      minor: "#a4a4a4",
    },
  },
  night: {
    bg: "#0f1116",
    line: {
      major: "#f4f4f8",
      primary: "#e8e8ef",
      secondary: "#d4d4df",
      tertiary: "#b8b8c8",
      local: "#9f9fb4",
      minor: "#8787a0",
    },
  },
  blueprint: {
    bg: "#0f2b4a",
    line: {
      major: "#e5f3ff",
      primary: "#cae8ff",
      secondary: "#a9d9ff",
      tertiary: "#8acaff",
      local: "#6eb9f4",
      minor: "#55a8e5",
    },
  },
};

const groupMap = {
  motorway: "major",
  motorway_link: "major",
  trunk: "major",
  trunk_link: "major",
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  residential: "local",
  unclassified: "local",
  living_street: "local",
  service: "local",
  road: "local",
  track: "minor",
  path: "minor",
  footway: "minor",
  pedestrian: "minor",
  cycleway: "minor",
  steps: "minor",
};

const widthMap = {
  major: 2.2,
  primary: 1.8,
  secondary: 1.4,
  tertiary: 1.1,
  local: 0.8,
  minor: 0.6,
};

const queryInput = document.getElementById("queryInput");
const generateBtn = document.getElementById("generateBtn");
const batchBtn = document.getElementById("batchBtn");
const downloadPngBtn = document.getElementById("downloadPngBtn");
const downloadSvgBtn = document.getElementById("downloadSvgBtn");
const statusText = document.getElementById("statusText");
const statusDetail = document.getElementById("statusDetail");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const canvas = document.getElementById("mapCanvas");
const themeSelect = document.getElementById("themeSelect");
const widthSelect = document.getElementById("widthSelect");
const detailLevelSelect = document.getElementById("detailLevelSelect");
const posterModeCheckbox = document.getElementById("posterModeCheckbox");
const batchResults = document.getElementById("batchResults");

const overpassMemoryCache = new Map();
const overpassCacheTtlMs = 10 * 60 * 1000;

const detailProfiles = {
  fast: {
    regex: "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|service|road)$",
    timeoutSec: 75,
    bboxRatio: 0.07,
  },
  standard: {
    regex: "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service|road|track|path|footway|pedestrian|cycleway|steps)$",
    timeoutSec: 110,
    bboxRatio: 0.10,
  },
  fine: {
    regex: ".*",
    timeoutSec: 140,
    bboxRatio: 0.13,
  },
};

let latestSvg = "";
let latestFileBase = "map";
let latestPngDataUrl = "";

function setStatus(text) {
  statusText.textContent = text;
}

function setDetail(text = "") {
  if (statusDetail) statusDetail.textContent = text;
}

function setProgress(percent, detail = "") {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  if (progressWrap) progressWrap.hidden = false;
  if (progressBar) progressBar.style.width = `${safe}%`;
  if (detail) setDetail(detail);
}

function hideProgress() {
  if (progressWrap) progressWrap.hidden = true;
  if (progressBar) progressBar.style.width = "0%";
}

function setBusy(busy) {
  generateBtn.disabled = busy;
  batchBtn.disabled = busy;
}

function normalizeFileName(name) {
  return (
    name
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "map"
  );
}

function parseQueries(raw) {
  const parts = raw
    .split(/[\n,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function englishTitle(query) {
  if (/^[a-zA-Z0-9\s-]+$/.test(query)) {
    return query.toUpperCase();
  }
  return query.toUpperCase();
}

function isLikelyPlaceName(query) {
  const text = query.trim();
  if (!text) return false;
  if (/\d/.test(text)) return false;
  if (/[,，;；]/.test(text)) return false;
  if (/\b(road|street|avenue|lane|号|室|楼|大道|路|街)\b/i.test(text)) return false;
  return text.length <= 12;
}

function buildAreaNameCandidates(query) {
  const text = query.trim();
  const candidates = [text];
  if (!text.endsWith("市")) candidates.push(`${text}市`);
  if (!text.endsWith("区")) candidates.push(`${text}区`);
  if (!text.endsWith("县")) candidates.push(`${text}县`);
  return [...new Set(candidates)];
}

function roundCoord(value) {
  return Number(value).toFixed(4);
}

function buildCacheKey(bbox, detailLevel) {
  return [detailLevel, ...bbox.map(roundCoord)].join("|");
}

function getCachedOverpass(cacheKey) {
  const cached = overpassMemoryCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.time > overpassCacheTtlMs) {
    overpassMemoryCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedOverpass(cacheKey, value) {
  overpassMemoryCache.set(cacheKey, { time: Date.now(), value });
}

function expandBbox(bbox, ratio = 0.08) {
  let [south, north, west, east] = bbox.map((x) => parseFloat(x));
  const latPad = (north - south) * ratio || 0.03;
  const lonPad = (east - west) * ratio || 0.03;
  south = Math.max(-85, south - latPad);
  north = Math.min(85, north + latPad);
  west = Math.max(-180, west - lonPad);
  east = Math.min(180, east + lonPad);
  return [south, north, west, east];
}

function shrinkBbox([south, north, west, east], factor = 0.72) {
  const cLat = (south + north) / 2;
  const cLon = (west + east) / 2;
  const halfLat = ((north - south) * factor) / 2;
  const halfLon = ((east - west) * factor) / 2;
  return [cLat - halfLat, cLat + halfLat, cLon - halfLon, cLon + halfLon];
}

async function fetchGeocode(query) {
  let lastError = null;
  for (const builder of geocodeEndpoints) {
    const url = builder(query);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Geocode ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data[0];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("地理编码失败");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOverpass(query, onProgress = () => {}, options = {}) {
  const errors = [];
  const endpoints = options.endpoints || overpassEndpoints;
  const attempts = options.attempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 55000;

  const fetchOne = async (endpoint) => {
    const label = endpoint.replace("https://", "");
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
      },
      timeoutMs
    );

    if (!res.ok) {
      throw new Error(`${label}: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.elements)) {
      throw new Error(`${label}: 返回结构异常`);
    }
    if (data.elements.length === 0) {
      throw new Error(`${label}: 返回空数据`);
    }

    return { data, endpoint: label };
  };

  for (let round = 1; round <= attempts; round++) {
    const phaseBase = 30 + (round - 1) * 24;
    onProgress(phaseBase, `并发请求 ${endpoints.length} 个地图节点（第${round}轮）`);

    let spin = phaseBase;
    const spinner = setInterval(() => {
      spin = Math.min(phaseBase + 8, spin + 1);
      onProgress(spin, `节点竞速中，自动选择最快可用链路...`);
    }, 900);

    try {
      const raced = endpoints.map((ep) =>
        fetchOne(ep).catch((error) => {
          throw new Error(error?.message || "未知错误");
        })
      );

      const winner = await Promise.any(raced);
      onProgress(85, `道路数据已获取（最快节点：${winner.endpoint}）`);
      clearInterval(spinner);
      return winner;
    } catch (error) {
      clearInterval(spinner);
      const errList = error?.errors || [error];
      for (const e of errList) {
        errors.push(e?.message || String(e));
      }
      onProgress(phaseBase + 10, `第${round}轮全部失败，准备重试...`);
    }
  }

  throw new Error(`Overpass 查询失败：${errors.join("；")}`);
}

function buildOverpassQuery([south, north, west, east], detailLevel = "fast") {
  const profile = detailProfiles[detailLevel] || detailProfiles.fast;
  return `[out:json][timeout:${profile.timeoutSec}];\n(\n  way["highway"~"${profile.regex}"](${south},${west},${north},${east});\n);\nout body;\n>;\nout skel qt;`;
}

function buildOverpassAreaQuery(areaName, detailLevel = "fast") {
  const profile = detailProfiles[detailLevel] || detailProfiles.fast;
  const safeName = areaName.replace(/"/g, '\\"');
  return `[out:json][timeout:${profile.timeoutSec}];\narea["name"="${safeName}"]["boundary"="administrative"]->.a;\n(\n  way["highway"~"${profile.regex}"](area.a);\n);\nout body;\n>;\nout skel qt;`;
}

function parseRoadData(elements) {
  const nodes = new Map();
  const roads = [];

  for (const el of elements) {
    if (el.type === "node") {
      nodes.set(el.id, [el.lon, el.lat]);
    }
  }

  for (const el of elements) {
    if (el.type === "way" && Array.isArray(el.nodes)) {
      const hw = el.tags?.highway;
      if (!hw) continue;
      roads.push({ nodes: el.nodes, highway: hw });
    }
  }

  return { nodes, roads };
}

function computeExtent(nodes, roads) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const road of roads) {
    for (const nid of road.nodes) {
      const p = nodes.get(nid);
      if (!p) continue;
      const [lon, lat] = p;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  return { minLon, maxLon, minLat, maxLat };
}

function toXY(lon, lat, extent, w, h, margin) {
  const iw = w - margin * 2;
  const ih = h - margin * 2;
  const x = margin + ((lon - extent.minLon) / (extent.maxLon - extent.minLon || 1e-6)) * iw;
  const y = margin + ((extent.maxLat - lat) / (extent.maxLat - extent.minLat || 1e-6)) * ih;
  return [x, y];
}

function generateSvg(roadsByLayer, extent, width, height, margin, theme) {
  const svgParts = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  svgParts.push(`<rect width="100%" height="100%" fill="${theme.bg}"/>`);

  for (const layerName of ["minor", "local", "tertiary", "secondary", "primary", "major"]) {
    const items = roadsByLayer[layerName] || [];
    const stroke = theme.line[layerName];
    const strokeWidth = widthMap[layerName];
    svgParts.push(
      `<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`
    );
    for (const pts of items) {
      if (pts.length < 2) continue;
      const d = pts
        .map(([lon, lat], idx) => {
          const [x, y] = toXY(lon, lat, extent, width, height, margin);
          return `${idx === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(" ");
      svgParts.push(`<path d="${d}"/>`);
    }
    svgParts.push(`</g>`);
  }

  svgParts.push(`</svg>`);
  return svgParts.join("\n");
}

function composeVersion1Poster(mapCanvas) {
  const mapW = mapCanvas.width;
  const mapH = mapCanvas.height;
  const margin = 90;

  const poster = document.createElement("canvas");
  poster.width = mapW + margin * 2;
  poster.height = mapH + margin * 2;
  const ctx = poster.getContext("2d");

  ctx.fillStyle = "#f5efe3";
  ctx.fillRect(0, 0, poster.width, poster.height);

  ctx.drawImage(mapCanvas, margin, margin);

  ctx.strokeStyle = "#7d7362";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    ctx.strokeRect(30 + i, 30 + i, poster.width - 60 - i * 2, poster.height - 60 - i * 2);
  }

  return poster;
}

function buildMapCanvas(roadData, themeName, targetWidth) {
  const { nodes, roads } = roadData;
  const extent = computeExtent(nodes, roads);

  const width = Number(targetWidth);
  const ratio = (extent.maxLat - extent.minLat) / (extent.maxLon - extent.minLon || 1e-6);
  const height = Math.max(900, Math.round(width * ratio));
  const margin = 30;
  const theme = styleThemes[themeName] || styleThemes.minimal;

  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = width;
  mapCanvas.height = height;
  const ctx = mapCanvas.getContext("2d");

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const roadsByLayer = {
    major: [],
    primary: [],
    secondary: [],
    tertiary: [],
    local: [],
    minor: [],
  };

  for (const road of roads) {
    const layer = groupMap[road.highway] || "minor";
    const pts = [];
    for (const nid of road.nodes) {
      const p = nodes.get(nid);
      if (p) pts.push(p);
    }
    if (pts.length >= 2) roadsByLayer[layer].push(pts);
  }

  const drawOrder = ["minor", "local", "tertiary", "secondary", "primary", "major"];

  for (const layerName of drawOrder) {
    const roadsLayer = roadsByLayer[layerName];
    ctx.strokeStyle = theme.line[layerName];
    ctx.lineWidth = widthMap[layerName];

    for (const pts of roadsLayer) {
      ctx.beginPath();
      let moved = false;
      for (const [lon, lat] of pts) {
        const [x, y] = toXY(lon, lat, extent, width, height, margin);
        if (!moved) {
          ctx.moveTo(x, y);
          moved = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  const svg = generateSvg(roadsByLayer, extent, width, height, margin, theme);
  return { mapCanvas, svg };
}

function drawToMain(sourceCanvas) {
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sourceCanvas, 0, 0);
}

async function renderForQuery(query) {
  const detailLevel = detailLevelSelect?.value || "fast";
  const profile = detailProfiles[detailLevel] || detailProfiles.fast;

  setStatus(`正在准备数据：${query}`);
  setProgress(8, "初始化请求");

  let overpassResult;
  let usedFallback = false;
  let cacheHit = false;
  let areaModeUsed = false;
  let areaMatchedName = "";

  if (isLikelyPlaceName(query)) {
    setProgress(14, "城市名模式：优先直查行政区道路");
    const areaCandidates = buildAreaNameCandidates(query);
    for (const areaName of areaCandidates) {
      const areaKey = `area|${detailLevel}|${areaName}`;
      const areaCached = getCachedOverpass(areaKey);
      if (areaCached) {
        cacheHit = true;
        areaModeUsed = true;
        areaMatchedName = areaName;
        overpassResult = { data: areaCached.data, endpoint: `${areaCached.endpoint}（缓存）` };
        setProgress(82, `命中城市名缓存：${areaName}`);
        break;
      }

      try {
        const areaQuery = buildOverpassAreaQuery(areaName, detailLevel);
        const areaFetched = await fetchOverpass(areaQuery, setProgress, {
          endpoints: overpassEndpoints.slice(0, 2),
          attempts: 1,
          timeoutMs: 22000,
        });
        setCachedOverpass(areaKey, { data: areaFetched.data, endpoint: areaFetched.endpoint });
        overpassResult = areaFetched;
        areaModeUsed = true;
        areaMatchedName = areaName;
        setProgress(84, `城市名模式命中：${areaName}`);
        break;
      } catch (_areaError) {
      }
    }
  }

  if (!overpassResult) {
    setStatus(`正在地理编码：${query}`);
    setProgress(18, "地理编码请求中");
    const geo = await fetchGeocode(query);
    if (!geo?.boundingbox) throw new Error(`未找到地名：${query}`);

    const bbox = expandBbox(geo.boundingbox, profile.bboxRatio);
    const cacheKey = buildCacheKey(bbox, detailLevel);

    setStatus(`正在拉取道路数据：${query}`);
    setProgress(22, `已获取地理范围，开始请求道路数据（${detailLevel === "fast" ? "快速" : detailLevel === "standard" ? "标准" : "精细"}）`);

    const cached = getCachedOverpass(cacheKey);
    if (cached) {
      cacheHit = true;
      overpassResult = { data: cached.data, endpoint: `${cached.endpoint}（缓存）` };
      setProgress(84, "命中缓存，跳过远程拉取");
    } else {
      const overpassQuery = buildOverpassQuery(bbox, detailLevel);
      try {
        overpassResult = await fetchOverpass(overpassQuery, setProgress);
        setCachedOverpass(cacheKey, { data: overpassResult.data, endpoint: overpassResult.endpoint });
      } catch (firstError) {
        usedFallback = true;
        setProgress(55, "主范围请求失败，尝试缩小范围重试...");
        const smaller = shrinkBbox(bbox, 0.68);
        const fallbackKey = buildCacheKey(smaller, detailLevel);
        const fallbackCached = getCachedOverpass(fallbackKey);
        if (fallbackCached) {
          cacheHit = true;
          overpassResult = { data: fallbackCached.data, endpoint: `${fallbackCached.endpoint}（缓存）` };
          setProgress(84, "命中缩小范围缓存，跳过远程拉取");
        } else {
          const fallbackQuery = buildOverpassQuery(smaller, detailLevel);
          try {
            overpassResult = await fetchOverpass(fallbackQuery, setProgress);
            setCachedOverpass(fallbackKey, { data: overpassResult.data, endpoint: overpassResult.endpoint });
          } catch (secondError) {
            throw new Error(`${firstError.message} | 缩小范围后仍失败：${secondError.message}`);
          }
        }
      }
    }
  }

  const roadData = parseRoadData(overpassResult.data.elements);
  if (!roadData.roads.length) throw new Error(`该区域未找到道路：${query}`);

  setStatus(`正在渲染：${query}`);
  setProgress(92, "道路数据已就绪，正在渲染画布");
  const { mapCanvas, svg } = buildMapCanvas(roadData, themeSelect.value, widthSelect.value);

  const outputCanvas = posterModeCheckbox.checked ? composeVersion1Poster(mapCanvas) : mapCanvas;

  setProgress(100, `完成（来源：${overpassResult.endpoint}${usedFallback ? "，缩小范围" : ""}）`);

  return {
    query,
    roadsCount: roadData.roads.length,
    svg,
    outputCanvas,
    fileBase: normalizeFileName(query),
    endpoint: overpassResult.endpoint,
    usedFallback,
    cacheHit,
    detailLevel,
    areaModeUsed,
    areaMatchedName,
  };
}

function createBatchItem(result) {
  const card = document.createElement("article");
  card.className = "batch-item";

  const title = document.createElement("h3");
  title.textContent = result.query;

  const meta = document.createElement("p");
  meta.textContent = `道路 ${result.roadsCount} 条`;

  const image = document.createElement("img");
  image.src = result.outputCanvas.toDataURL("image/png");
  image.alt = result.query;

  const actions = document.createElement("div");
  actions.className = "batch-actions";

  const pngA = document.createElement("a");
  pngA.href = image.src;
  pngA.download = `${result.fileBase}.png`;
  pngA.textContent = "下载 PNG";

  const svgBlob = new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  const svgA = document.createElement("a");
  svgA.href = svgUrl;
  svgA.download = `${result.fileBase}.svg`;
  svgA.textContent = "下载 SVG";

  actions.appendChild(pngA);
  actions.appendChild(svgA);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(image);
  card.appendChild(actions);

  return card;
}

function createBatchErrorItem(query, errorText) {
  const card = document.createElement("article");
  card.className = "batch-item";

  const title = document.createElement("h3");
  title.textContent = query;

  const meta = document.createElement("p");
  meta.textContent = `失败：${errorText}`;

  card.appendChild(title);
  card.appendChild(meta);
  return card;
}

async function runSingle() {
  const list = parseQueries(queryInput.value);
  if (!list.length) {
    setStatus("请先输入地名或地址。");
    setDetail("");
    hideProgress();
    return;
  }

  const query = list[0];
  if (list.length > 1) {
    setStatus(`检测到多个地名，单张模式仅生成第一个：${query}`);
  }

  setBusy(true);
  downloadPngBtn.disabled = true;
  downloadSvgBtn.disabled = true;

  try {
    const result = await renderForQuery(query);
    drawToMain(result.outputCanvas);

    latestSvg = result.svg;
    latestFileBase = result.fileBase;
    latestPngDataUrl = result.outputCanvas.toDataURL("image/png");

    downloadPngBtn.disabled = false;
    downloadSvgBtn.disabled = false;
    setStatus(`生成完成：${result.query}（道路 ${result.roadsCount} 条）`);
    const speedLabel = result.detailLevel === "fast" ? "快速" : result.detailLevel === "standard" ? "标准" : "精细";
    const areaLabel = result.areaModeUsed ? `｜城市名直查：${result.areaMatchedName || "是"}` : "";
    setDetail(`来源：${result.endpoint}${result.cacheHit ? "（缓存）" : ""}${result.usedFallback ? "（已缩小范围重试）" : ""}${areaLabel}｜模式：${speedLabel}`);
  } catch (err) {
    console.error(err);
    setStatus(`生成失败：${err.message || "未知错误"}`);
    setDetail("建议：稍后重试，或改成更具体地名（如加上“区/市”）。");
  } finally {
    setBusy(false);
    setTimeout(() => hideProgress(), 900);
  }
}

async function runBatch() {
  const list = parseQueries(queryInput.value);
  if (!list.length) {
    setStatus("请先输入地名或地址（可多个）。");
    setDetail("");
    hideProgress();
    return;
  }

  setBusy(true);
  batchResults.innerHTML = "";
  downloadPngBtn.disabled = true;
  downloadSvgBtn.disabled = true;

  let success = 0;
  for (let i = 0; i < list.length; i++) {
    const query = list[i];
    const overall = Math.round((i / list.length) * 100);
    setStatus(`批量生成中 [${i + 1}/${list.length}]：${query}`);
    setProgress(overall, `当前任务：${query}`);

    try {
      const result = await renderForQuery(query);
      const card = createBatchItem(result);
      batchResults.appendChild(card);
      success += 1;

      if (i === 0) {
        drawToMain(result.outputCanvas);
        latestSvg = result.svg;
        latestFileBase = result.fileBase;
        latestPngDataUrl = result.outputCanvas.toDataURL("image/png");
        downloadPngBtn.disabled = false;
        downloadSvgBtn.disabled = false;
      }
    } catch (err) {
      console.error(err);
      batchResults.appendChild(createBatchErrorItem(query, err.message || "未知错误"));
    }
  }

  setProgress(100, `批量完成：成功 ${success}/${list.length}`);
  setStatus(`批量完成：成功 ${success}/${list.length}`);
  setDetail("如有失败项，可单独重试该地名。");
  setBusy(false);
  setTimeout(() => hideProgress(), 1200);
}

function downloadPng() {
  if (!latestPngDataUrl) return;
  const a = document.createElement("a");
  a.href = latestPngDataUrl;
  a.download = `${latestFileBase}.png`;
  a.click();
}

function downloadSvg() {
  if (!latestSvg) return;
  const blob = new Blob([latestSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${latestFileBase}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

generateBtn.addEventListener("click", runSingle);
batchBtn.addEventListener("click", runBatch);

queryInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runSingle();
  }
});

downloadPngBtn.addEventListener("click", downloadPng);
downloadSvgBtn.addEventListener("click", downloadSvg);

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    queryInput.value = btn.dataset.q || "";
    runSingle();
  });
});

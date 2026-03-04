const geocodeEndpoints = [
  (q) =>
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN&q=${encodeURIComponent(
      q
    )}`,
];

const overpassEndpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
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
const posterModeCheckbox = document.getElementById("posterModeCheckbox");
const batchResults = document.getElementById("batchResults");

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

async function fetchOverpass(query, onProgress = () => {}) {
  const errors = [];

  for (let index = 0; index < overpassEndpoints.length; index++) {
    const endpoint = overpassEndpoints[index];
    const label = endpoint.replace("https://", "");

    for (let attempt = 1; attempt <= 2; attempt++) {
      const phaseBase = 30 + index * 20 + (attempt - 1) * 8;
      onProgress(phaseBase, `正在请求 ${label}（第${attempt}次）`);

      let spinner = null;
      try {
        let spin = phaseBase;
        spinner = setInterval(() => {
          spin = Math.min(phaseBase + 6, spin + 1);
          onProgress(spin, `正在等待 ${label} 响应...`);
        }, 900);

        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: new URLSearchParams({ data: query }),
          },
          55000
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        onProgress(phaseBase + 7, `正在解析 ${label} 返回数据`);
        const data = await res.json();

        if (!data || !Array.isArray(data.elements)) {
          throw new Error("返回结构异常");
        }

        if (data.elements.length === 0) {
          throw new Error("返回空数据");
        }

        onProgress(85, `道路数据已获取（来源：${label}）`);
        return { data, endpoint: label };
      } catch (error) {
        const message = error?.name === "AbortError" ? "请求超时" : (error?.message || "未知错误");
        errors.push(`${label}#${attempt}: ${message}`);
      } finally {
        if (spinner) clearInterval(spinner);
      }
    }
  }

  throw new Error(`Overpass 查询失败：${errors.join("；")}`);
}

function buildOverpassQuery([south, north, west, east]) {
  return `[out:json][timeout:120];\n(\n  way["highway"](${south},${west},${north},${east});\n);\n(._;>;);\nout body;`;
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
  setStatus(`正在地理编码：${query}`);
  setProgress(8, "地理编码请求中");
  const geo = await fetchGeocode(query);
  if (!geo?.boundingbox) throw new Error(`未找到地名：${query}`);

  const bbox = expandBbox(geo.boundingbox, 0.12);
  const overpassQuery = buildOverpassQuery(bbox);

  setStatus(`正在拉取道路数据：${query}`);
  setProgress(22, "已获取地理范围，开始请求道路数据");

  let overpassResult;
  let usedFallback = false;

  try {
    overpassResult = await fetchOverpass(overpassQuery, setProgress);
  } catch (firstError) {
    usedFallback = true;
    setProgress(55, "主范围请求失败，尝试缩小范围重试...");
    const smaller = shrinkBbox(bbox, 0.68);
    const fallbackQuery = buildOverpassQuery(smaller);
    try {
      overpassResult = await fetchOverpass(fallbackQuery, setProgress);
    } catch (secondError) {
      throw new Error(`${firstError.message} | 缩小范围后仍失败：${secondError.message}`);
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
    setDetail(`数据来源：${result.endpoint}${result.usedFallback ? "（已缩小范围重试）" : ""}`);
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

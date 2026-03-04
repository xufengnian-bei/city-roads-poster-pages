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

async function fetchOverpass(query) {
  let lastError = null;
  for (const endpoint of overpassEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.elements)) throw new Error("Overpass返回异常");
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Overpass查询失败");
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

function composeVersion1Poster(mapCanvas, query) {
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

  const zhTitle = `${query}·城市道路`;
  const enTitle = `${englishTitle(query)} ROAD NETWORK`;
  const y0 = poster.height - 225;

  ctx.fillStyle = "#2c2824";
  ctx.font = "700 72px 'Noto Serif CJK SC','Noto Serif SC','PingFang SC','Microsoft YaHei',serif";
  ctx.fillText(zhTitle, 92, y0);

  ctx.fillStyle = "#524c44";
  ctx.font = "500 34px 'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif";
  ctx.fillText(enTitle, 96, y0 + 88);

  ctx.fillStyle = "#70685c";
  ctx.font = "400 24px 'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif";
  ctx.fillText("Data: OpenStreetMap  |  Styled by 小聂子", 96, y0 + 132);

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
  const geo = await fetchGeocode(query);
  if (!geo?.boundingbox) throw new Error(`未找到地名：${query}`);

  const bbox = expandBbox(geo.boundingbox, 0.12);
  setStatus(`正在拉取道路数据：${query}`);
  const overpassQuery = buildOverpassQuery(bbox);
  const osm = await fetchOverpass(overpassQuery);

  const roadData = parseRoadData(osm.elements);
  if (!roadData.roads.length) throw new Error(`该区域未找到道路：${query}`);

  setStatus(`正在渲染：${query}`);
  const { mapCanvas, svg } = buildMapCanvas(roadData, themeSelect.value, widthSelect.value);

  const outputCanvas = posterModeCheckbox.checked ? composeVersion1Poster(mapCanvas, query) : mapCanvas;

  return {
    query,
    roadsCount: roadData.roads.length,
    svg,
    outputCanvas,
    fileBase: normalizeFileName(query),
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
  } catch (err) {
    console.error(err);
    setStatus(`生成失败：${err.message || "未知错误"}`);
  } finally {
    setBusy(false);
  }
}

async function runBatch() {
  const list = parseQueries(queryInput.value);
  if (!list.length) {
    setStatus("请先输入地名或地址（可多个）。");
    return;
  }

  setBusy(true);
  batchResults.innerHTML = "";
  downloadPngBtn.disabled = true;
  downloadSvgBtn.disabled = true;

  let success = 0;
  for (let i = 0; i < list.length; i++) {
    const query = list[i];
    setStatus(`批量生成中 [${i + 1}/${list.length}]：${query}`);

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

  setStatus(`批量完成：成功 ${success}/${list.length}`);
  setBusy(false);
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
  if (e.key === "Enter") runSingle();
});

downloadPngBtn.addEventListener("click", downloadPng);
downloadSvgBtn.addEventListener("click", downloadSvg);

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    queryInput.value = btn.dataset.q || "";
    runSingle();
  });
});

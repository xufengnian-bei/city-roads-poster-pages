const geocodeEndpoints = [
  (q) => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
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
const downloadPngBtn = document.getElementById("downloadPngBtn");
const downloadSvgBtn = document.getElementById("downloadSvgBtn");
const statusText = document.getElementById("statusText");
const canvas = document.getElementById("mapCanvas");
const themeSelect = document.getElementById("themeSelect");
const widthSelect = document.getElementById("widthSelect");

let latestSvg = "";
let latestFileBase = "map";

function setStatus(text) {
  statusText.textContent = text;
}

function normalizeFileName(name) {
  return name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "map";
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
    svgParts.push(`<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`);
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

function renderMap(roadData, query, themeName, targetWidth) {
  const { nodes, roads } = roadData;
  const extent = computeExtent(nodes, roads);

  const width = Number(targetWidth);
  const ratio = (extent.maxLat - extent.minLat) / (extent.maxLon - extent.minLon || 1e-6);
  const height = Math.max(900, Math.round(width * ratio));
  const margin = 30;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const theme = styleThemes[themeName] || styleThemes.minimal;

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

  latestSvg = generateSvg(roadsByLayer, extent, width, height, margin, theme);
  latestFileBase = normalizeFileName(query) || "map";
  downloadPngBtn.disabled = false;
  downloadSvgBtn.disabled = false;
}

async function generate() {
  const query = queryInput.value.trim();
  if (!query) {
    setStatus("请先输入地名或地址。");
    return;
  }

  generateBtn.disabled = true;
  downloadPngBtn.disabled = true;
  downloadSvgBtn.disabled = true;

  try {
    setStatus("正在地理编码...");
    const geo = await fetchGeocode(query);
    if (!geo?.boundingbox) throw new Error("未找到该地名");

    const bbox = expandBbox(geo.boundingbox, 0.12);

    setStatus("正在拉取道路数据（可能需要几十秒）...");
    const overpassQuery = buildOverpassQuery(bbox);
    const osm = await fetchOverpass(overpassQuery);

    setStatus("正在渲染地图...");
    const roadData = parseRoadData(osm.elements);
    if (!roadData.roads.length) throw new Error("该区域未找到道路数据");

    renderMap(roadData, query, themeSelect.value, widthSelect.value);
    setStatus(`生成完成：${query}（道路 ${roadData.roads.length} 条）`);
  } catch (err) {
    console.error(err);
    setStatus(`生成失败：${err.message || "未知错误"}`);
  } finally {
    generateBtn.disabled = false;
  }
}

function downloadPng() {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${latestFileBase}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
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

generateBtn.addEventListener("click", generate);
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") generate();
});

downloadPngBtn.addEventListener("click", downloadPng);
downloadSvgBtn.addEventListener("click", downloadSvg);

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    queryInput.value = btn.dataset.q || "";
    generate();
  });
});

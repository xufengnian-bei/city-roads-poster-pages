# City Roads Poster Generator

一个可部署到 GitHub Pages 的静态网站：输入地名或地址，生成道路地图，并下载 PNG / SVG。

## 功能

- 输入地名/地址后自动生成道路图
- 支持三种风格（早期极简、深色夜景、蓝图）
- 支持下载 PNG / SVG
- 支持常用示例地名快捷按钮
- 自动切换多个 Overpass 节点重试

## 本地运行

直接用静态服务器打开：

```bash
cd city-map-pages
python3 -m http.server 8080
```

打开 `http://localhost:8080`

## 部署到 GitHub Pages

仓库已包含 `.github/workflows/pages.yml`，推送到 `main` 后会自动部署。

## 数据来源

- OpenStreetMap
- Nominatim (地理编码)
- Overpass API (道路查询)

请遵守相关服务的使用条款与访问频率限制。

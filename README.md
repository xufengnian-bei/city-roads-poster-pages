# City Roads Poster Generator

一个可部署到 GitHub Pages 的静态网站：输入地名或地址，生成道路地图，并下载 PNG / SVG。

## 功能

- 输入地名/地址后自动生成道路图
- 支持三种风格（早期极简、深色夜景、蓝图）
- 支持下载 PNG / SVG
- 支持常用示例地名快捷按钮
- 支持批量生成（逗号/中文逗号/分号/换行分隔）
- 支持自动套用“版本1海报版式”（米色留白 + 边框，无文字）
- 移动端自适应布局（输入区、按钮区、结果区）
- 拉取道路数据时显示进度条与节点状态
- 自动切换多个 Overpass 节点重试，失败时自动缩小范围重试

## 本地运行

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

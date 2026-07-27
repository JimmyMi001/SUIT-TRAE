# 123就出发 — 走过的路，值得被验证

> 🏆 2026 年度"火山杯"Agent 创新大赛 · 第 123 号队伍
>
> 社区路线众包 × AI 交叉验证 × 个性化旅行伴侣

---

## 产品简介

**123就出发** 是一个覆盖旅行全生命周期的 AI 助手。不再是"给你一个目的地就结束"——从灵感激发、路线验证、行程规划、行前准备、旅途陪伴、旅行复盘到社区分享，每一个环节都有专门的 AI Agent 为你服务。

### 7 个 Agent，全生命周期覆盖

| Agent | 做什么 | 核心能力 |
|-------|--------|---------|
| 🎯 目的地推荐 | 不知道去哪？渐进式提问推荐 | 多维打分（预算/季节/兴趣/交通） |
| 🔍 路线验证 | 刷到一条攻略？验证真假 | 四维验证引擎（时间/空间/时效/多源一致性） |
| 📅 行程规划 | 生成详细行程 | 个性化适配矩阵（预算/体力/人数/季节） |
| 🎒 行前准备 | 出发前要带什么？ | 7 项检查（证件/天气/健康/支付/通讯/保险/预约） |
| 🧭 旅途伴侣 | 在路上遇到问题？ | 周边搜索/天气预警/翻译/紧急求助/记账 |
| 📝 旅行复盘 | 旅行回来记录 | 高光时刻/避坑指南/美食红黑榜/预算复盘 |
| 👥 社区知识库 | 分享你的路线 | 路线众包 + 去重合并 + 贡献者激励体系 |

## 技术架构

```
index.html (前端 SPA)
    │
    ├── 设计系统: 深夜暖金 · DM Serif + DM Sans · 三栏不对称
    ├── Mock Agent 调度器 (7 Agent → 关键词 → 预设数据)
    ├── API Client (优先真实 API，失败降级 Mock)
    │
    ▼
server.js (Express 后端)
    │
    ├── /api/amap/*      → 高德地图 (POI/天气/路线)
    ├── /api/weather/*   → Open-Meteo 免费降级
    ├── /api/routes      → 社区路线 CRUD
    ├── /api/fx          → Frankfurter 实时汇率
    ├── /api/chat        → DeepSeek AI 对话 (8 角色)
    └── /api/health      → 服务状态检查
```

## 数据源策略

| 功能 | 首选 | 降级 | 免费？ |
|------|------|------|:---:|
| 天气 | 高德 API | Open-Meteo | ✅ |
| POI 搜索 | 高德 API | 社区路线库 | ✅ |
| 路线规划 | 高德 API | Mock | ✅ |
| 汇率 | Frankfurter | Mock | ✅ 永久免费 |
| AI 对话 | DeepSeek | Mock | ✅ |
| 社区路线 | 本地 JSON | 种子数据 | ✅ |

## 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/YOUR_USERNAME/123-jiu-chu-fa.git
cd 123-jiu-chu-fa

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的高德 Key 和 DeepSeek Key
# 不填也能运行——自动降级 Mock

# 4. 启动
npm start

# 5. 浏览器打开
open http://localhost:3000
```

## 环境变量

```bash
AMAP_KEY=           # 高德地图 API Key（可选，不填自动降级）
DEEPSEEK_KEY=       # DeepSeek API Key（可选，不填自动降级）
PORT=3000           # 服务端口（默认 3000）
```

## 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/123-jiu-chu-fa)

或在 Vercel Dashboard 中：
1. Import GitHub 仓库
2. 在 Environment Variables 中设置 `AMAP_KEY` 和 `DEEPSEEK_KEY`
3. Deploy

## 设计特色

- **深夜暖金** 调色板 — `#0A0E1A` 底色 × `#F0A500` 暖金 × `#00C6B7` 青碧
- **DM Serif Display + DM Sans** 字体配对 — 拒绝 Inter/Roboto
- **三栏不对称布局** — 打破居中对称的"AI 味"
- **毛玻璃视觉语言** — `backdrop-filter: blur(20px)` 统一参数
- **CSS 驱动动画** — scroll-driven、transform-only、prefers-reduced-motion 全适配
- **字符级标题动画** — 逐字弹出 + 微妙 overshoot 缓动

## 项目结构

```
123-jiu-chu-fa/
├── index.html           # 前端 SPA（7 页面）
├── server.js            # Express 后端
├── api/index.js         # Vercel Serverless 入口
├── package.json
├── .env.example
├── vercel.json
├── README.md
├── data/
│   └── community.json   # 社区路线库（5 条种子数据）
├── css/                 # 独立 CSS（8 个文件）
└── js/                  # 独立 JS（8 个文件）
```

## 比赛信息

- **赛事**: 2026 年度"火山杯"Agent 创新大赛暨国赛遴选赛
- **学校**: 深圳信息职业技术大学
- **队伍**: 第 123 号
- **截止**: 2026 年 7 月 31 日
- **平台**: 火山引擎 Trae

## License

MIT

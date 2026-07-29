# 123就出发 — 走过的路，值得被验证

> 🏆 2026 年度"火山杯"Agent 创新大赛 · 第 123 号队伍
>
> 社区路线众包 × AI 交叉验证 × 个性化旅行伴侣

---

## 一键部署到 Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/123-jiu-chu-fa)

> 部署后,在 Render Dashboard → Environment 设置 `AMAP_KEY` 和 `DEEPSEEK_KEY` 即可,密钥不会进入 GitHub。

## 本地开发

```bash
git clone https://github.com/YOUR_USERNAME/123-jiu-chu-fa.git
cd 123-jiu-chu-fa
npm install
cp .env.example .env
# 编辑 .env 填入 AMAP_KEY 和 DEEPSEEK_KEY
npm start
# 浏览器打开 http://localhost:3000
```

## 密钥加密(可选,但推荐)

如果想把 `.env` 加密后推送到 GitHub(例如团队协作、备份):

```bash
# 1) 生成主密钥(会写到 .env.keys,这个文件不入仓)
node scripts/encrypt-env.js --genkey

# 2) 加密 .env → .env.enc
node scripts/encrypt-env.js

# 3) 把 .env.keys 的内容(纯文本)配置到部署平台的环境变量 ENV_MASTER_KEY
#    部署时,env-loader.js 会自动解密
```

**GitHub 工作流**:
- 真实密钥永远不入仓(`.env` / `.env.keys` 已在 `.gitignore`)
- `.env.enc` 是密文,公开也没关系(没有主密钥解不开)
- 部署平台(Render)只需配置 `ENV_MASTER_KEY` 一个变量

## 目录结构

```
123-jiu-chu-fa/
├── index.html / community.html / companion.html / ...
├── server.js                 # Express 后端
├── api/index.js              # Vercel Serverless 入口
├── env-loader.js             # .env 加密加载器
├── scripts/encrypt-env.js    # 密钥加密/解密 CLI
├── render.yaml               # Render 部署配置
├── vercel.json               # Vercel 部署配置
├── .github/workflows/        # CI + 自动部署到 Render
├── css/  js/  data/          # 前端与数据
└── .env.example              # 环境变量模板
```

## GitHub Actions 自动部署

`.github/workflows/deploy-render.yml` 在每次 `push main` 时自动通知 Render 拉取新代码。

配置:
1. Render Dashboard → 你的 Service → Settings → **Deploy Hook** → 复制 URL
2. GitHub → Settings → Secrets and variables → Actions → New repository secret:
   - Name: `RENDER_DEPLOY_HOOK`
   - Value: 上面那个 URL
3. 之后 `git push origin main` 即可自动部署

## 持续开发流程

```bash
# 1. 改完代码
git add .
git commit -m "feat: 优化城市选择"
git push origin main

# 2. GitHub Actions 自动:
#    - 运行基础检查 + 密钥扫描
#    - 通知 Render 拉取新代码
#    - Render 自动重启服务(约 30-60s)
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

## 设计特色

- **深夜暖金** 调色板 — `#0A0E1A` 底色 × `#F0A500` 暖金 × `#00C6B7` 青碧
- **DM Serif Display + DM Sans** 字体配对
- **三栏不对称布局** — 打破居中对称
- **毛玻璃视觉语言** — `backdrop-filter: blur(20px)` 统一参数
- **CSS 驱动动画** — scroll-driven、transform-only、prefers-reduced-motion 全适配

## 比赛信息

- **赛事**: 2026 年度"火山杯"Agent 创新大赛暨国赛遴选赛
- **学校**: 深圳信息职业技术大学
- **队伍**: 第 123 号

## License

MIT

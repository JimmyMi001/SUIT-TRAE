/**
 * 123 就出发 — 后端服务
 *
 * 路由总览：
 *  静态        GET  /                          托管当前目录
 *  健康        GET  /api/health
 *  高德代理    GET  /api/amap/poi | /detail | /direction | /weather
 *  社区路线    GET  /api/routes [?city=…&days=…&budget=…]
 *              GET  /api/routes/search?q=…
 *              GET  /api/routes/:id
 *              POST /api/routes
 *  汇率        GET  /api/fx
 */

require('dotenv').config({ override: true });  // .env 优先，绕过 shell 注入的同名环境变量

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const AMAP_KEY = (process.env.AMAP_KEY || '').trim();

/* ---------- 全局中间件 ---------- */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '512kb' }));

// 简易访问日志
app.use((req, _res, next) => {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------- 工具：调用高德 ---------- */
async function callAmap(qs) {
  if (!AMAP_KEY || AMAP_KEY === 'your_amap_key_here') {
    return { status: '0', info: 'OK', count: '0', pois: [] };
  }
  const url = `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&extensions=base&${qs}`;
  const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
  if (!r.ok) throw new Error(`amap http ${r.status}`);
  return r.json();
}

async function callAmapRaw(pathname, qs) {
  if (!AMAP_KEY || AMAP_KEY === 'your_amap_key_here') {
    return { status: '0', info: 'AMAP_KEY 未配置', count: '0' };
  }
  const url = `https://restapi.amap.com${pathname}?key=${AMAP_KEY}&${qs}`;
  const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
  if (!r.ok) throw new Error(`amap http ${r.status}`);
  return r.json();
}

/* ---------- 健康检查 ---------- */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    amap_configured: Boolean(AMAP_KEY) && AMAP_KEY !== 'your_amap_key_here',
    deepseek_configured: Boolean(DEEPSEEK_KEY) && DEEPSEEK_KEY !== 'your_deepseek_key_here',
  });
});

/* ---------- 高德代理 ---------- */
app.get('/api/amap/poi', async (req, res) => {
  try {
    const { keywords = '', city = '', offset = '10', page = '1' } = req.query;
    const qs = new URLSearchParams({ keywords, city, offset, page, output: 'json' }).toString();
    const data = await callAmap(qs);
    res.json({ error: false, source: 'amap', data });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

app.get('/api/amap/detail', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: true, message: 'id is required' });
    const qs = new URLSearchParams({ id, output: 'json' }).toString();
    const data = await callAmapRaw('/v3/place/detail', qs);
    res.json({ error: false, source: 'amap', data });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

app.get('/api/amap/direction', async (req, res) => {
  try {
    const { origin, destination, type = 'driving', city = '' } = req.query;
    if (!origin || !destination) {
      return res.status(400).json({ error: true, message: 'origin & destination are required' });
    }
    const pathMap = { driving: '/v3/direction/driving', walking: '/v3/direction/walking', transit: '/v3/direction/transit/integrated' };
    const pathname = pathMap[type] || pathMap.driving;
    const qs = new URLSearchParams({ origin, destination, city, output: 'json' }).toString();
    const data = await callAmapRaw(pathname, qs);
    res.json({ error: false, source: 'amap', type, data });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

app.get('/api/amap/weather', async (req, res) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });
    const qs = new URLSearchParams({ city, extensions: 'base', output: 'json' }).toString();
    const data = await callAmapRaw('/v3/weather/weatherInfo', qs);
    res.json({ error: false, source: 'amap', data });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 天气降级：Open-Meteo（免费免注册） ---------- */
// 城市 → 坐标映射（覆盖常用旅游城市）
const CITY_COORDS = {
  '北京':   { lat: 39.9042, lon: 116.4074 },
  '上海':   { lat: 31.2304, lon: 121.4737 },
  '广州':   { lat: 23.1291, lon: 113.2644 },
  '深圳':   { lat: 22.5431, lon: 114.0579 },
  '成都':   { lat: 30.5728, lon: 104.0668 },
  '西安':   { lat: 34.3416, lon: 108.9398 },
  '大理':   { lat: 25.6065, lon: 100.2677 },
  '杭州':   { lat: 30.2741, lon: 120.1551 },
  '重庆':   { lat: 29.5630, lon: 106.5516 },
  '拉萨':   { lat: 29.6469, lon: 91.1175 },
  '南京':   { lat: 32.0603, lon: 118.7969 },
  '苏州':   { lat: 31.2989, lon: 120.5853 },
  '厦门':   { lat: 24.4798, lon: 118.0894 },
  '青岛':   { lat: 36.0671, lon: 120.3826 },
  '武汉':   { lat: 30.5928, lon: 114.3055 },
  '长沙':   { lat: 28.2282, lon: 112.9388 },
  '丽江':   { lat: 26.8721, lon: 100.2330 },
  '三亚':   { lat: 18.2528, lon: 109.5119 },
  '昆明':   { lat: 25.0389, lon: 102.7183 },
  '哈尔滨': { lat: 45.8038, lon: 126.5350 },
  '桂林':   { lat: 25.2736, lon: 110.2907 },
  '黄山':   { lat: 29.7148, lon: 118.3171 }
};

// WMO 天气代码 → 中文描述
const WMO_DESC = {
  0:'晴', 1:'少云', 2:'多云', 3:'阴',
  45:'雾', 48:'雾凇',
  51:'小毛毛雨', 53:'毛毛雨', 55:'强毛毛雨',
  61:'小雨', 63:'中雨', 65:'大雨',
  71:'小雪', 73:'中雪', 75:'大雪', 77:'雪粒',
  80:'阵雨', 81:'强阵雨', 82:'极强阵雨',
  85:'阵雪', 86:'强阵雪',
  95:'雷暴', 96:'雷暴伴冰雹', 99:'强雷暴伴冰雹'
};

app.get('/api/weather/fallback', async (req, res) => {
  try {
    const city = (req.query.city || '').toString().trim();
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });
    const coords = CITY_COORDS[city];
    if (!coords) {
      return res.status(404).json({ error: true, message: `unknown city: ${city}`, supported: Object.keys(CITY_COORDS) });
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
    if (!r.ok) throw new Error(`open-meteo http ${r.status}`);
    const data = await r.json();
    const cur = data.current || {};
    const code = cur.weather_code;
    const condition = WMO_DESC[code] || `code ${code}`;
    res.json({
      error: false,
      source: 'open-meteo',
      city,
      temperature: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      wind_kmh: cur.wind_speed_10m,
      condition,
      icon: code,
      fetched_at: data.current?.time || new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 社区路线数据层 ---------- */
const DATA_FILE = path.join(__dirname, 'data', 'community.json');

function loadRoutes() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json.routes) ? json.routes : [];
  } catch (e) {
    console.error('loadRoutes error:', e.message);
    return [];
  }
}

function saveRoutes(routes) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ routes }, null, 2), 'utf8');
}

function dedupeKey(r) {
  const nodes = (r.nodes || []).map(n => (n.poi || '').trim()).join('|');
  return `${(r.city || '').trim()}__${r.days}__${nodes}`;
}

// 计算节点重合度（0~1）：以较小集合为基数的命中率
// 例：新增 5 节点全部命中已有 7 节点 → 1.0；7 中只有 5 个属于新提交 → 5/7≈0.71
function nodeOverlap(a, b) {
  const A = new Set((a.nodes || []).map(n => (n.poi || '').trim()));
  const B = new Set((b.nodes || []).map(n => (n.poi || '').trim()));
  if (A.size === 0 || B.size === 0) return 0;
  const minSize = Math.min(A.size, B.size);
  let hit = 0;
  A.forEach(x => { if (B.has(x)) hit++; });
  return hit / minSize;
}

app.get('/api/routes', (req, res) => {
  let list = loadRoutes();
  const { city, days, budget } = req.query;
  if (city)   list = list.filter(r => (r.city || '').includes(city));
  if (days)   list = list.filter(r => String(r.days) === String(days));
  if (budget) list = list.filter(r => (r.budget || '') === budget);
  res.json({ error: false, count: list.length, routes: list });
});

app.get('/api/routes/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ error: false, count: 0, routes: [] });
  const list = loadRoutes().filter(r => {
    const hay = [
      r.title, r.city, r.budget,
      ...(r.tags || []),
      ...((r.nodes || []).map(n => n.poi || '')),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
  res.json({ error: false, count: list.length, routes: list });
});

app.get('/api/routes/:id', (req, res) => {
  const list = loadRoutes();
  const item = list.find(r => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: true, message: 'route not found' });
  res.json({ error: false, route: item });
});

app.post('/api/routes', (req, res) => {
  const body = req.body || {};
  if (!body.title || !body.city || !body.days) {
    return res.status(400).json({ error: true, message: 'title / city / days 必填' });
  }
  const list = loadRoutes();

  // 去重：同目的地+天数 且 节点重合度 >= 80%
  const exist = list.find(r =>
    (r.city || '').trim() === (body.city || '').trim() &&
    Number(r.days) === Number(body.days) &&
    nodeOverlap(r, body) >= 0.8
  );
  if (exist) {
    return res.status(409).json({
      error: true,
      duplicate: true,
      message: '已有高度重合的路线',
      existing: { id: exist.id, title: exist.title }
    });
  }

  const newRoute = {
    id: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    title: String(body.title).trim(),
    city: String(body.city).trim(),
    days: Number(body.days),
    budget: body.budget || '舒适',
    budget_per_day: body.budget_per_day || '',
    contributor: body.contributor || { name: '匿名', level: 'Lv.1 新人', avatar_emoji: '🧭' },
    tags: Array.isArray(body.tags) ? body.tags : [],
    nodes: Array.isArray(body.nodes) ? body.nodes : [],
    stats: body.stats || { used: 0, rating: 0, verified: false }
  };
  list.push(newRoute);
  saveRoutes(list);
  res.status(201).json({ error: false, route: newRoute });
});

/* ---------- 汇率代理 ---------- */
app.get('/api/fx', async (req, res) => {
  try {
    const from = (req.query.from || 'CNY').toString().toUpperCase();
    const to = (req.query.to || 'USD').toString().toUpperCase();
    const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
    if (!r.ok) throw new Error(`frankfurter http ${r.status}`);
    const data = await r.json();
    res.json({ error: false, source: 'frankfurter', data });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- DeepSeek AI 对话代理 ---------- */
const DEEPSEEK_KEY = (process.env.DEEPSEEK_KEY || '').trim();

// 8 个 Agent 的 system prompt（精简到 ≤200 字）
const AGENT_PROMPTS = {
  dispatcher: `你是"123就出发"主调度 Agent。任务：识别用户意图并路由到 7 个子 Agent：目的地推荐/路线验证/行程规划/行前准备/旅途伴侣/旅行复盘/社区。回复≤60字，2-3 个候选方向，例："听起来你想规划行程，我可以推荐路线 + 安排酒店 + 估算预算，你想从哪个开始？"语气温暖、行动导向。`,

  destination: `你是目的地推荐 Agent。基于用户偏好（季节/预算/同行人/兴趣）推荐 3-4 个国内目的地。每条≤80字：含特色亮点、最佳季节、预算范围、推荐指数 0-100。避免堆砌，结尾问 1 个引导问题（"要不要看具体路线？"）。语言简洁有力。`,

  verify: `你是路线验证 Agent。评估用户给定路线（城市+天数+节点）可信度。回复结构：总分 0-100，4 维度（时间/空间/时效/一致性）各 1 句评价，3 条风险（高/中/低），每条带 1 句建议。专业克制，不夸张。`,

  itinerary: `你是行程规划 Agent。根据用户城市+天数+预算生成详细行程。结构：总预算估算 + 3 家酒店比价（名称/类型/价格/来源/是否最低）+ 按天分节点（时间/POI/费用/评分/交通/标签）。节点至少 5 个/天，节奏从慢到快。结尾给 1 条贴士。`,

  pretrip: `你是行前准备 Agent。生成 7 项 checklist（证件/天气/预约/交通/酒店/预算/保险），每项 1 句当前状态（已完成/需关注/未做）+ 简明说明。附 6 件打包清单（已勾/未勾）。最后给 1 句天气提示。结构化输出。`,

  companion: `你是旅途伴侣 Agent。快速响应旅途问题（附近/天气/翻译/紧急/汇率/航班）。回复≤100字，分场景：天气给温度+穿衣；翻译给中文+英文+使用场景；紧急给电话+地址；汇率给当前 1 货币→1 货币值+日期。零废话。`,

  posttrip: `你是旅行复盘 Agent。总结给定行程：高光 3 条（具体场景描述）、避坑 3 条（教训+下次怎么做）、红榜 3 家餐厅（名称/区/评分/人均）、黑榜 2 家（避免理由）、4 项数据统计（步数/公里/打卡/照片）。感性 + 数据结合。`,

  community: `你是社区知识库 Agent。回应用户对社区路线的查询：城市覆盖、热门路线、人气排名、风格标签。回复≤120字，列出 3-5 条相关路线名（用 ● 分隔），末尾引导"想看哪条详情？"。风格平易近人。`
};

app.post('/api/chat', async (req, res) => {
  try {
    const { messages = [], agent = 'dispatcher', context = {} } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: true, message: 'messages is required' });
    }
    if (!DEEPSEEK_KEY || DEEPSEEK_KEY === 'your_deepseek_key_here') {
      return res.status(503).json({ error: true, message: 'DEEPSEEK_KEY 未配置', source: 'mock' });
    }
    const sysPrompt = AGENT_PROMPTS[agent] || AGENT_PROMPTS.dispatcher;
    // 注入 context 提示
    const ctxHint = Object.keys(context).length
      ? `\n\n[上下文] ${JSON.stringify(context)}`
      : '';
    const fullMessages = [
      { role: 'system', content: sysPrompt + ctxHint },
      ...messages.slice(-6)  // 只传最近 6 条 = 3 轮对话
    ];
    const url = 'https://api.deepseek.com/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
        'User-Agent': '123-travel/1.0'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: fullMessages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: false
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`deepseek http ${r.status} ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    if (!reply) throw new Error('empty reply from deepseek');
    const usage = data?.usage || {};
    res.json({
      error: false,
      source: 'deepseek',
      agent,
      reply,
      data: null,  // 未来可让 AI 返回 JSON 数据
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
    });
  } catch (e) {
    console.error('[chat] error:', e.message);
    res.status(500).json({ error: true, message: e.message, source: 'mock' });
  }
});

/* ---------- 静态资源（放最后，便于 API 路由优先） ---------- */
app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: true, message: 'not found' }));

/* ---------- 导出 + 启动 ---------- */
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    const keyStatus = AMAP_KEY && AMAP_KEY !== 'your_amap_key_here' ? '已配置' : '未配置（API 将返回空数据，前端走 Mock）';
    console.log(`\n  123 就出发 · 后端服务已启动`);
    console.log(`  ➜  http://localhost:${PORT}`);
    console.log(`  ➜  健康检查    GET /api/health`);
    console.log(`  ➜  社区路线    GET /api/routes`);
    console.log(`  ➜  高德 Key   ${keyStatus}\n`);
  });
}

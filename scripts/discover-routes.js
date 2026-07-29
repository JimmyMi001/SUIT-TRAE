/**
 * 真实路线自动发现脚本
 * 原理: 通过高德POI搜索API + 已知热门城市/主题词, 抓取真实POI数据, 生成新路线草稿
 * 输出: 追加到 data/real-routes-curated.json (草稿状态,需人工 review)
 * 用法: AMAP_KEY=xxx node scripts/discover-routes.js [city1,city2,...]
 *      不传 city 时遍历所有 280+ 城市
 *
 * 注意:
 * - 本脚本只生成草稿,不直接入库 community.json
 * - 每次生成的草稿会标记 source.author = "auto-discover (pending review)"
 * - 草稿写入 real-routes-curated.json 时不会覆盖已有条目
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const AMAP_KEY = (process.env.AMAP_KEY || '').trim();
if (!AMAP_KEY || AMAP_KEY === 'your_amap_key_here') {
  console.error('❌ 缺少 AMAP_KEY 环境变量');
  console.error('   设置方法:  set AMAP_KEY=你的高德key  (Windows)');
  console.error('           export AMAP_KEY=你的高德key  (Linux/Mac)');
  process.exit(1);
}

const CURATED_FILE = path.join(__dirname, '..', 'data', 'real-routes-curated.json');

// 主题 → 高德 keywords
const THEMES = [
  { tag: '美食', keywords: ['美食街', '小吃街', '老字号餐厅', '夜市'] },
  { tag: '历史', keywords: ['博物馆', '古城墙', '古镇', '古寺', '古街'] },
  { tag: '自然', keywords: ['国家森林公园', '湿地公园', '瀑布', '峡谷', '海岛'] },
  { tag: '亲子', keywords: ['主题乐园', '动物园', '海洋公园', '科技馆'] },
  { tag: '文化', keywords: ['文化广场', '文创园', '艺术馆', '书院'] },
  { tag: '地标', keywords: ['电视塔', '城市广场', '著名景点'] }
];

// 城市白名单（精选人口多、旅游资源丰富的城市）
const DEFAULT_CITIES = [
  '北京', '上海', '广州', '深圳', '成都', '西安', '杭州', '重庆', '南京', '苏州',
  '厦门', '青岛', '武汉', '长沙', '大理', '丽江', '三亚', '拉萨', '哈尔滨', '桂林',
  '无锡', '嘉兴', '福州', '天津', '大连', '兰州', '郑州', '济南', '合肥', '南昌'
];

const argv = process.argv.slice(2);
const cities = argv.length ? argv[0].split(',') : DEFAULT_CITIES;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'discover-routes/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}\n${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function searchPOI(city, keyword) {
  const url = `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}&citylimit=true&extensions=base&offset=5&page=1`;
  const j = await fetchJSON(url);
  if (j.status !== '1') return [];
  return (j.pois || []).map(p => ({
    name: p.name,
    address: p.address || '',
    type: p.type || '',
    location: p.location || '',  // "lng,lat"
    pname: p.pname || '',
    cityname: p.cityname || '',
    adname: p.adname || ''
  }));
}

function poiToNode(poi, type) {
  const [lng, lat] = poi.location.split(',').map(Number);
  if (!isFinite(lng) || !isFinite(lat)) return null;
  return { poi: poi.name, type, lng, lat };
}

async function discoverCity(city) {
  console.log(`\n🔍 正在发现: ${city}`);
  const draft = { city, themes: {} };
  for (const theme of THEMES) {
    const collected = [];
    for (const kw of theme.keywords) {
      try {
        const pois = await searchPOI(city, kw);
        for (const p of pois) {
          if (!collected.find(c => c.name === p.name)) collected.push(p);
        }
        // 限流: 每次关键词请求间隔 100ms
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.warn(`   ⚠️  ${kw} 失败: ${e.message}`);
      }
    }
    draft.themes[theme.tag] = collected;
    console.log(`   ✓ ${theme.tag}: ${collected.length} 个POI`);
  }
  return draft;
}

function draftToCurated(draft) {
  // 为每个城市生成 1-2 条草稿路线(选 POI 数 >= 3 的主题)
  const curated = [];
  const validThemes = Object.entries(draft.themes)
    .filter(([_, pois]) => pois.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);

  for (let i = 0; i < Math.min(2, validThemes.length); i++) {
    const [tag, pois] = validThemes[i];
    const nodes = pois.slice(0, 6)
      .map(p => poiToNode(p, tag))
      .filter(Boolean);
    if (nodes.length < 3) continue;

    const id = `auto-${draft.city}-${tag}-${Date.now().toString(36)}`;
    curated.push({
      id,
      title: `${draft.city} ${nodes.length}天${tag}主题游(草稿)`,
      city: draft.city,
      days: Math.min(5, Math.max(2, Math.ceil(nodes.length / 2))),
      budget_per_day: 400,
      budget: '¥400/天',
      pax: '朋友',
      tags: [tag, 'auto-discover'],
      summary: `由高德POI自动发现的${draft.city}${tag}主题路线,需人工 review`,
      source: {
        platform: '高德POI',
        url: 'https://lbs.amap.com/',
        author: 'auto-discover (pending review)',
        fetched_at: new Date().toISOString().slice(0, 10)
      },
      nodes
    });
  }
  return curated;
}

async function main() {
  console.log(`📡 高德POI自动发现 — 共 ${cities.length} 个城市`);
  const allDrafts = [];
  for (const city of cities) {
    try {
      const draft = await discoverCity(city);
      allDrafts.push(...draftToCurated(draft));
    } catch (e) {
      console.error(`❌ ${city} 失败: ${e.message}`);
    }
  }
  console.log(`\n✅ 共生成 ${allDrafts.length} 条草稿路线`);

  // 追加到 real-routes-curated.json
  let existing = { _meta: {}, routes: [] };
  try {
    existing = JSON.parse(fs.readFileSync(CURATED_FILE, 'utf8'));
  } catch (e) {
    console.warn('⚠️  无法读取现有策展文件,创建新文件');
  }
  if (!Array.isArray(existing.routes)) existing.routes = [];

  // 去重: 已存在相同 city+title 的跳过
  const existingKeys = new Set(existing.routes.map(r => `${r.city}__${r.title}`));
  const newOnes = allDrafts.filter(d => !existingKeys.has(`${d.city}__${d.title}`));
  existing.routes.push(...newOnes);

  fs.writeFileSync(CURATED_FILE, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`\n📝 追加 ${newOnes.length} 条到 ${CURATED_FILE}`);
  console.log('   草稿状态,需人工 review 后再通过 /api/routes/import-curated/:id 入库');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

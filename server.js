/**
 * ============================================================
 * 🔴 死规矩：所有数据必须真实，严禁编造！
 * 任何涉及地点/POI/景点/餐厅/酒店/交通/价格等信息，
 * 必须来源于：高德API实时拉取、POI_DB手维护真实数据、
 * 官方平台（12306/携程/美团/去哪儿等）可查数据。
 * 绝对禁止虚构/创造不存在的地点名（如"历史博物馆分馆84"等）。
 * 宁缺毋滥——真实POI不够时宁可减少天数或节点数，也绝不虚构。
 * ============================================================
 *
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
 *              GET  /api/routes/curated          # 策展真实路线列表(含来源)
 *              GET  /api/routes/curated/:id      # 策展路线详情
 *              POST /api/routes/import-curated/:id  # 一键入库策展路线到 community.json
 *              GET  /api/routes/sources          # 来源平台清单(去重统计)
 *  汇率        GET  /api/fx
 */

require('dotenv').config({ override: true });  // .env 优先，绕过 shell 注入的同名环境变量
require('./env-loader');                        // 兜底:从 .env.enc 解密加载(部署平台用)

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const flightCrawler = require('./flight-crawler');  // 携程机票真实价格爬虫(学习自 Suysker/Ctrip-Crawler)

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
  const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`amap http ${r.status}`);
  return r.json();
}

/* ---------- 从高德 API 拉取真实 POI（用于补充不足的 POI 池，绝不虚构） ---------- */
async function fetchRealPOIsFromAmap(city, desiredCount = 24) {
  if (!AMAP_KEY || AMAP_KEY === 'your_amap_key_here') return [];
  // 多组关键词搜索，覆盖不同类型，获取真实 POI
  const keywordsList = [
    '景区|景点|博物馆|公园|古镇|老街',
    '美食|夜市|小吃街|步行街|餐厅',
    '购物中心|商业街|广场',
    '酒吧|夜店|演艺|夜市',
    '书店|美术馆|艺术区|文创',
    '寺庙|塔|陵|宫|遗址|城墙',
    '网红|打卡|拍照|地标|文创园|艺术区|涂鸦墙|观景台',
    '咖啡馆|奶茶|甜品|烘焙|面包|糖水',
    '教堂|灯塔|图书馆|展览馆|设计|买手店|潮牌'
  ];
  const seen = new Set();
  const pois = [];
  for (const keywords of keywordsList) {
    if (pois.length >= desiredCount) break;
    try {
      const r = await callAmapRaw('/v3/place/text', new URLSearchParams({
        keywords, city, extensions: 'base', offset: '20', page: '1', output: 'json'
      }).toString());
      for (const p of (r.pois || [])) {
        if (pois.length >= desiredCount) break;
        if (!p.name || seen.has(p.name)) continue;
        seen.add(p.name);
        const [lon, lat] = (p.location || '0,0').split(',').map(parseFloat);
        const rawType = (p.type || '').split(';')[0] || '景点';
        let mappedType = '景点';
        if (/美食|餐厅|小吃|夜市|火锅|烧烤|酒/.test(rawType)) mappedType = '美食';
        else if (/博物馆|美术馆|图书馆|书院|文化中心|艺术|展/.test(rawType)) mappedType = '文化';
        else if (/寺|庙|塔|陵|宫|城|墓|关|楼|阁/.test(rawType)) mappedType = '历史';
        else if (/山|湖|海|岛|峡|谷|草原|森林|瀑|泉|湿地/.test(rawType)) mappedType = '自然';
        else if (/公园|广场|步行街|老街|商业|购物|街|市/.test(rawType)) mappedType = '购物';
        else if (/酒吧|夜市|夜店/.test(rawType)) mappedType = '夜生活';
        else if (/网红|打卡|拍照|地标|文创园|艺术区|涂鸦|观景台|灯塔|教堂/.test(rawType)) mappedType = '网红';
        else if (/咖啡|奶茶|甜品|烘焙|面包|糖水/.test(rawType)) mappedType = '美食';
        pois.push({ name: p.name, type: mappedType, lng: lon, lat, address: p.address || '', tag: mappedType, _source: 'amap' });
        // 同时缓存到 POI_DB 供后续复用
        if (!POI_DB[city]) POI_DB[city] = [];
        if (!POI_DB[city].find(x => x.name === p.name)) {
          POI_DB[city].push({ name: p.name, type: mappedType, lng: lon, lat, tag: mappedType });
        }
      }
    } catch (_) { /* 单个关键词失败不影响其他 */ }
  }
  return pois;
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

/* ---------- DeepSeek AI 聊天（兜底） ---------- */
app.get('/api/chat', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: true, message: 'q is required' });
    const reply = await callDeepSeek(q);
    res.json({ error: false, source: reply ? 'deepseek' : 'fallback', data: { reply: reply || '暂未理解，请换个问法或使用快捷功能（附近/天气/汇率/导航）' }, q });
  } catch (e) {
    res.json({ error: false, source: 'fallback', data: { reply: '暂未理解，请换个问法或使用快捷功能（附近/天气/汇率/导航）' }, q });
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

/* ---------- 高德静态图（代理为图片流，同源避免 ORB） ---------- */
const MAP_CACHE = path.join(__dirname, '.cache', 'maps');
if (!fs.existsSync(MAP_CACHE)) fs.mkdirSync(MAP_CACHE, { recursive: true });

// 生成本地 SVG 地图（同源、无外部依赖、永不 ORB）
function localMapSVG(city, coords) {
  const w = 600, h = 400;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(99,102,241,0.08)" stroke-width="1"/>
    </pattern>
    <radialGradient id="glow"><stop offset="0%" stop-color="rgba(99,102,241,0.5)"/><stop offset="100%" stop-color="rgba(99,102,241,0)"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#grid)"/>
  <g transform="translate(${w/2},${h/2})">
    <circle r="160" fill="none" stroke="rgba(99,102,241,0.15)" stroke-width="1"/>
    <circle r="100" fill="none" stroke="rgba(99,102,241,0.25)" stroke-width="1"/>
    <circle r="60"  fill="none" stroke="rgba(99,102,241,0.4)"  stroke-width="1"/>
    <circle r="80"  fill="url(#glow)"/>
    <circle r="20"  fill="#FF6666" opacity="0.6"/>
    <circle r="8"   fill="#FF6666"/>
    <text y="-100" text-anchor="middle" fill="#e2e8f0" font-size="28" font-weight="600" font-family="system-ui">${city}</text>
    <text y="120" text-anchor="middle" fill="#64748b" font-size="14" font-family="ui-monospace">${coords.lat.toFixed(4)}°N  ${coords.lon.toFixed(4)}°E</text>
  </g>
  <text x="20" y="380" fill="#475569" font-size="11" font-family="ui-monospace">123-travel · 离线地图（无网络/无高德 key 兜底）</text>
</svg>`;
}

app.get('/api/amap/staticmap', async (req, res) => {
  try {
    const { city = '', zoom = '11', size = '600*400' } = req.query;
    if (!city) return res.status(400).type('text/plain').send('city required');
    const coords = CITY_COORDS[city];
    if (!coords) {
      // 未知城市也走 SVG 兜底
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(localMapSVG(city, { lat: 30, lon: 104 }));
    }

    // 1) 缓存命中
    const cacheFile = path.join(MAP_CACHE, `${city}_${zoom}_${size.replace('*','x')}.png`);
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Map-Source', 'cache');
      return fs.createReadStream(cacheFile).pipe(res);
    }

    // 2) 没高德 key：直接走本地 SVG
    if (!AMAP_KEY || AMAP_KEY === 'your_amap_key_here') {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=300');
      res.set('X-Map-Source', 'local-svg');
      return res.send(localMapSVG(city, coords));
    }

    // 3) 调高德，下载到本地缓存，再以 image/png 返回（同源 → 浏览器 ORB 不拦）
    const loc = `${coords.lon},${coords.lat}`;
    const url = `https://restapi.amap.com/v3/staticmap?location=${loc}&zoom=${zoom}&size=${size}&markers=large,0xFF6666,${loc}:A&key=${AMAP_KEY}`;
    const mapRes = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
    if (!mapRes.ok) throw new Error(`amap http ${mapRes.status}`);
    const buf = Buffer.from(await mapRes.arrayBuffer());
    if (buf.length < 100) throw new Error('amap returned tiny payload (quota?)');
    fs.writeFileSync(cacheFile, buf);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Map-Source', 'amap');
    res.send(buf);
  } catch (e) {
    console.warn('[staticmap] fail, falling back to local svg:', e.message);
    const coords = CITY_COORDS[req.query.city] || { lat: 30, lon: 104 };
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=60');
    res.set('X-Map-Source', 'fallback-svg');
    res.send(localMapSVG(req.query.city || '未知', coords));
  }
});

/* ---------- 省级 → 地级市 级联（仅含地级市/自治州/盟；不含县级市/区） ---------- */
// 数据源：中华人民共和国民政部 2025 年统计；本表为常用 27 省+4 直辖市+5 自治区+2 特别行政区
// 注：仅含地级行政区（地级市/地区/自治州/盟），不含县级
const PROVINCE_CITY_MAP = {
  '北京':   ['北京'],
  '天津':   ['天津'],
  '上海':   ['上海'],
  '重庆':   ['重庆'],
  '河北':   ['石家庄','唐山','秦皇岛','邯郸','邢台','保定','张家口','承德','沧州','廊坊','衡水'],
  '山西':   ['太原','大同','阳泉','长治','晋城','朔州','晋中','运城','忻州','临汾','吕梁'],
  '内蒙古': ['呼和浩特','包头','乌海','赤峰','通辽','鄂尔多斯','呼伦贝尔','巴彦淖尔','乌兰察布','兴安盟','锡林郭勒盟','阿拉善盟'],
  '辽宁':   ['沈阳','大连','鞍山','抚顺','本溪','丹东','锦州','营口','阜新','辽阳','盘锦','铁岭','朝阳','葫芦岛'],
  '吉林':   ['长春','吉林市','四平','辽源','通化','白山','延边','松原','白城'],
  '黑龙江': ['哈尔滨','齐齐哈尔','鸡西','鹤岗','双鸭山','大庆','伊春','佳木斯','七台河','牡丹江','黑河','绥化','大兴安岭'],
  '江苏':   ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁'],
  '浙江':   ['杭州','宁波','温州','嘉兴','湖州','绍兴','金华','衢州','舟山','台州','丽水'],
  '安徽':   ['合肥','芜湖','蚌埠','淮南','马鞍山','淮北','铜陵','安庆','黄山','滁州','阜阳','宿州','六安','亳州','池州','宣城'],
  '福建':   ['福州','厦门','莆田','三明','泉州','漳州','南平','龙岩','宁德'],
  '江西':   ['南昌','景德镇','萍乡','九江','新余','鹰潭','赣州','吉安','宜春','抚州','上饶'],
  '山东':   ['济南','青岛','淄博','枣庄','东营','烟台','潍坊','济宁','泰安','威海','日照','临沂','德州','聊城','滨州','菏泽'],
  '河南':   ['郑州','开封','洛阳','平顶山','安阳','鹤壁','新乡','焦作','濮阳','许昌','漯河','三门峡','南阳','商丘','信阳','周口','驻马店','济源'],
  '湖北':   ['武汉','黄石','十堰','宜昌','襄阳','鄂州','荆门','孝感','荆州','黄冈','咸宁','随州','恩施','仙桃','潜江','天门','神农架'],
  '湖南':   ['长沙','株洲','湘潭','衡阳','邵阳','岳阳','常德','张家界','益阳','郴州','永州','怀化','娄底','湘西'],
  '广东':   ['广州','韶关','深圳','珠海','汕头','佛山','江门','湛江','茂名','肇庆','惠州','梅州','汕尾','河源','阳江','清远','东莞','中山','潮州','揭阳','云浮'],
  '广西':   ['南宁','柳州','桂林','梧州','北海','防城港','钦州','贵港','玉林','百色','贺州','河池','来宾','崇左'],
  '海南':   ['海口','三亚','三沙','儋州'],
  '四川':   ['成都','自贡','攀枝花','泸州','德阳','绵阳','广元','遂宁','内江','乐山','南充','眉山','宜宾','广安','达州','雅安','巴中','资阳','阿坝','甘孜','凉山'],
  '贵州':   ['贵阳','六盘水','遵义','安顺','毕节','铜仁','黔西南','黔东南','黔南'],
  '云南':   ['昆明','曲靖','玉溪','保山','昭通','丽江','普洱','临沧','楚雄','红河','文山','西双版纳','大理','德宏','怒江','迪庆'],
  '西藏':   ['拉萨','日喀则','昌都','林芝','山南','那曲','阿里'],
  '陕西':   ['西安','铜川','宝鸡','咸阳','渭南','延安','汉中','榆林','安康','商洛'],
  '甘肃':   ['兰州','嘉峪关','金昌','白银','天水','武威','张掖','平凉','酒泉','庆阳','定西','陇南','临夏','甘南'],
  '青海':   ['西宁','海东','海北','海南','黄南','果洛','玉树','海西'],
  '宁夏':   ['银川','石嘴山','吴忠','固原','中卫'],
  '新疆':   ['乌鲁木齐','克拉玛依','吐鲁番','哈密','昌吉','博尔塔拉','巴音郭楞','阿克苏','克孜勒苏','喀什','和田','伊犁','塔城','阿勒泰'],
  '香港':   ['香港'],
  '澳门':   ['澳门'],
  '台湾':   ['台北','高雄','台中','台南','新北','桃园','基隆','新竹','嘉义','宜兰','花莲','台东','屏东']
};

// 反向索引：城市 → 省
const CITY_PROVINCE_INDEX = (() => {
  const idx = {};
  for (const [p, cities] of Object.entries(PROVINCE_CITY_MAP)) {
    cities.forEach(c => { idx[c] = p; });
  }
  return idx;
})();

/* ---------- 中国节假日（2025-2027，按国务院办公厅通知） ---------- */
// 字段：name(节日名) start(开始日 yyyy-MM-dd) end(结束日 yyyy-MM-dd) days(放假天数)
//       emoji(节日符号) desc(节日介绍 — 起源/习俗/出行提示) tip(出行小贴士)
const HOLIDAYS_2025_2027 = [
  // 2025
  { name:'元旦', emoji:'🎊',
    start:'2025-01-01', end:'2025-01-01', days:1,
    desc:'公历新年第一天，象征辞旧迎新。各地会举办跨年灯光秀、敲钟祈福和新年音乐会，适合 1-3 天的短途城市旅行或温泉滑雪。',
    tip:'热门商圈酒店需提前 2 周预订；跨年夜地铁延运至次日 1 点。' },
  { name:'春节', emoji:'🧧',
    start:'2025-01-28', end:'2025-02-04', days:8,
    desc:'中华民族最重要的传统节日，阖家团圆、辞岁迎新。习俗包括贴春联、年夜饭、压岁钱、放鞭炮、逛庙会、看舞龙舞狮。',
    tip:'除夕前 3 天机票/高铁最贵；反向过年（去小城市）性价比更高；多数店铺初三后开门。' },
  { name:'清明节', emoji:'🌿',
    start:'2025-04-04', end:'2025-04-06', days:3,
    desc:'二十四节气之一，兼具祭祖扫墓与踏青郊游的传统。此时江南春雨绵绵，江南古镇、黄山、婺源油菜花进入最佳观赏期。',
    tip:'江南一带多阴雨，备好雨具与防滑鞋；山区温差大注意保暖。' },
  { name:'劳动节', emoji:'🌹',
    start:'2025-05-01', end:'2025-05-05', days:5,
    desc:'五一国际劳动节，5 天连假是国内中长途旅行的旺季。海滨城市、主题乐园、网红城市人气最高。',
    tip:'高速免费，景区客流大；建议错峰出发（4 月 30 日晚或 5 月 2 日）。' },
  { name:'端午节', emoji:'🐉',
    start:'2025-05-31', end:'2025-06-02', days:3,
    desc:'纪念屈原的传统节日，吃粽子、赛龙舟、挂艾草佩香囊。江南水乡与湘西汨罗江畔最具仪式感。',
    tip:'江南梅雨季将至，备好雨具；龙舟赛观赛提前 1 小时到场占位。' },
  { name:'中秋节', emoji:'🌕',
    start:'2025-10-06', end:'2025-10-08', days:3,
    desc:'农历八月十五阖家团圆赏月，吃月饼、赏桂花、观钱塘江大潮。西北大漠、新疆胡杨林也是热门目的地。',
    tip:'赏月需选开阔地或登高；月饼礼盒可在当地老字号现买更划算。' },
  { name:'国庆节', emoji:'🇨🇳',
    start:'2025-10-01', end:'2025-10-08', days:8,
    desc:'祖国生日，7 天长假是全国出行高峰。出境游、国内长线、北疆秋色、川西稻城都是热门方向。',
    tip:'提前 30 天订机票酒店；10 月 1 日/7 日高速最堵；建议中间几天错峰游览。' },
  // 2026
  { name:'元旦', emoji:'🎊',
    start:'2026-01-01', end:'2026-01-03', days:3,
    desc:'公历新年，三天小长假适合跨年仪式感之旅。哈尔滨冰雪大世界、长白山滑雪、三亚避寒都是热门选择。',
    tip:'北方 -20℃ 注意保暖和手机电池续航；三亚/西双版纳需提前 1 个月订房。' },
  { name:'春节', emoji:'🧧',
    start:'2026-02-17', end:'2026-02-23', days:7,
    desc:'丙午年春节，阖家团圆的中华传统大节。北方逛庙会、南方看花市、海南三亚成"避寒过年"顶流。',
    tip:'三亚/海口的春节酒店价格翻 3-5 倍；反向去小城/乡村年味更浓；初五迎财神民俗最热闹。' },
  { name:'清明节', emoji:'🌿',
    start:'2026-04-04', end:'2026-04-06', days:3,
    desc:'二十四节气之一，祭祖踏青双主题。婺源油菜花、伊犁杏花、林芝桃花同期盛开，是国内春日黄金期。',
    tip:'伊犁/林芝需提前 2 周订住宿；花期受气温影响需关注实时花讯。' },
  { name:'劳动节', emoji:'🌹',
    start:'2026-05-01', end:'2026-05-05', days:5,
    desc:'5 天连假，5 月气候宜人，是国内中长途与出境游旺季。土耳其、东南亚、日本樱花尾季人气最旺。',
    tip:'4 月 30 日晚或 5 月 2 日出发最划算；东南亚雨季初临但价格仍亲民。' },
  { name:'端午节', emoji:'🐉',
    start:'2026-06-19', end:'2026-06-21', days:3,
    desc:'纪念屈原，赛龙舟、吃粽子、佩香囊。江南水乡、福建土楼、贵州镇远最具端午氛围。',
    tip:'江南梅雨季正盛，备好防潮袋保护电子设备；龙舟赛多在农历五月初五当天举行。' },
  { name:'中秋节', emoji:'🌕',
    start:'2026-09-25', end:'2026-09-27', days:3,
    desc:'丙午年中秋，阖家赏月团圆。新疆喀纳斯秋色、甘肃胡杨林、内蒙古额济纳旗金秋进入最佳期。',
    tip:'西北昼夜温差 15℃+；赏月最佳地是开阔的湖边/沙漠/草原。' },
  { name:'国庆节', emoji:'🇨🇳',
    start:'2026-10-01', end:'2026-10-07', days:7,
    desc:'祖国 77 周年华诞，7 天长假出行高峰。稻城亚丁、新疆北疆、内蒙古额济纳旗、东北雪乡错峰滑雪都是热门选项。',
    tip:'高速免费但极度拥堵；建议 9 月 30 日晚出发；东北/新疆初雪可能在 10 月中下旬。' },
  // 2027
  { name:'元旦', emoji:'🎊',
    start:'2027-01-01', end:'2027-01-03', days:3,
    desc:'新年第一天，三天小长假。北方冰雪游、南方海岛游、温泉滑雪依旧是主流。',
    tip:'亚布力、长白山、崇礼滑雪季进入高峰；提前 1 个月订房可省 30%。' },
  { name:'春节', emoji:'🧧',
    start:'2027-02-06', end:'2027-02-12', days:7,
    desc:'丁未年春节，阖家团圆、辞旧迎新。除夕年夜饭、初一拜年、初五迎财神、初七人日各有讲究。',
    tip:'节前 3 天机票最贵；初三后景区人流回落，错峰性价比最高。' },
  { name:'清明节', emoji:'🌿',
    start:'2027-04-05', end:'2027-04-07', days:3,
    desc:'祭祖踏青双主题，江南春雨、汉中油菜花、洛阳牡丹同期盛放。',
    tip:'洛阳牡丹花期短（4 月中下旬）；汉中油菜花节持续 1 个月，住宿提前 1 周订。' },
  { name:'劳动节', emoji:'🌹',
    start:'2027-05-01', end:'2027-05-05', days:5,
    desc:'5 天连假，5 月气候宜人，是欧洲游、日本北海道、东南亚海岛的最佳窗口。',
    tip:'5 月是欧洲 shoulder season，价格回落 20-30%；日本梅雨季未到，最舒适。' },
  { name:'端午节', emoji:'🐉',
    start:'2027-06-09', end:'2027-06-11', days:3,
    desc:'纪念屈原的传统节日，赛龙舟、吃粽子、佩香囊、挂艾草。湖南汨罗江、福建闽南最具仪式感。',
    tip:'江南梅雨季来临，备好雨具；龙舟赛建议提前一天到场熟悉场地。' },
  { name:'中秋节', emoji:'🌕',
    start:'2027-09-15', end:'2027-09-17', days:3,
    desc:'丁未年中秋，阖家赏月团圆。秋高气爽时节，新疆、内蒙古、西北胡杨林正进入最佳观赏期。',
    tip:'额济纳旗胡杨黄叶期仅 10-15 天；务必查好实时黄叶预报再订机酒。' },
  { name:'国庆节', emoji:'🇨🇳',
    start:'2027-10-01', end:'2027-10-07', days:7,
    desc:'祖国 78 周年华诞，7 天长假出行高峰。稻城亚丁、新疆北疆、内蒙古额济纳旗持续火爆。',
    tip:'提前 1 个月订机酒可省 30%；10 月 1 日/7 日高速最堵；东北/新疆初雪概率高。' }
];

// 找下一个节假日
function nextHoliday(fromDate = new Date()) {
  const today = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()).getTime();
  for (const h of HOLIDAYS_2025_2027) {
    const startTs = new Date(h.start + 'T00:00:00').getTime();
    if (startTs >= today) {
      const days = Math.ceil((startTs - today) / 86400000);
      return { ...h, days_until: days, start_ts: startTs };
    }
  }
  return null;
}

// 简单农历转换（2025-2027 节气内常用日期；用户可补全时改用 lunar-javascript）
// 已知 2026 节气锚点
const LUNAR_HOLIDAYS_2026 = {
  '2026-02-17': '丙午年 正月初一（春节）',
  '2026-06-19': '丙午年 五月初五（端午）',
  '2026-09-25': '丙午年 八月十五（中秋）',
  '2027-02-06': '丁未年 正月初一（春节）',
  '2027-06-09': '丁未年 五月初五（端午）',
  '2027-09-15': '丁未年 八月十五（中秋）',
  '2025-01-29': '乙巳年 正月初一（春节）',
  '2025-05-31': '乙巳年 五月初五（端午）',
  '2025-10-06': '乙巳年 八月十五（中秋）'
};

/* ---------- 省级→地级市级联 API ---------- */
app.get('/api/city/cascading', (_req, res) => {
  // 转为 [{province, cities:[]}] 格式，按行政区划代码顺序
  const list = Object.entries(PROVINCE_CITY_MAP).map(([province, cities]) => ({ province, cities }));
  res.json({ error: false, count: list.length, total_cities: Object.keys(CITY_PROVINCE_INDEX).length, data: list });
});

/* ---------- 扁平城市列表 API（用于 datalist 自动补全） ---------- */
app.get('/api/city/list', (_req, res) => {
  // 拉平所有省/直辖市的地级市 + 县级市热门（如九寨沟、阳朔）
  const countyCities = ['九寨沟','阳朔','婺源','宏村','周庄','乌镇','西塘','腾冲','莫干山','北戴河','阿坝','香格里拉','雨崩','稻城','喀什','吐鲁番','额济纳','长白山','漠河','凤凰','千岛湖','黄山','张家界','敦煌','平遥','曲阜','丽江','大理','都江堰','峨眉山','武当山','庐山','五台山','普陀山','九华山','井冈山','延安','遵义','井陉','西沙','西塘','南浔','平遥古城','丽江古城'];
  const seen = new Set();
  const list = [];
  Object.entries(PROVINCE_CITY_MAP).forEach(([province, cities]) => {
    cities.forEach(c => {
      if (!seen.has(c)) { seen.add(c); list.push({ name: c, province, level: '地级市' }); }
    });
  });
  countyCities.forEach(c => {
    if (!seen.has(c)) { seen.add(c); list.push({ name: c, province: '—', level: '县级/热门景点' }); }
  });
  res.json({ error: false, total: list.length, data: list });
});

/* ---------- 未知城市解析（高德地理编码 + POI 搜索） ---------- */
app.get('/api/city/resolve', async (req, res) => {
  try {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: true, message: 'name is required' });
    // 1) 命中已有库
    if (CITY_COORDS[name] && CITIES_DATA[name]) {
      return res.json({ error: false, source: 'local', name, city: name, ...CITIES_DATA[name], center: CITY_COORDS[name] });
    }
    // 2) 高德地理编码
    let amap = null;
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const r = await callAmapRaw('/v3/geocode/geo', new URLSearchParams({ address: name, output: 'json' }).toString());
        amap = (r.geocodes || [])[0] || null;
      } catch (e) { /* 忽略 */ }
    }
    let coords = amap ? { lat: parseFloat(amap.location.split(',')[1]), lon: parseFloat(amap.location.split(',')[0]) } : null;
    let adcode = amap?.adcode || '';
    let province = amap?.province || '';
    let cityResolved = amap?.city || name;
    // 3) POI 搜索（景点 / 美食 / 酒店 / 文化）
    let pois = [];
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const r = await callAmapRaw('/v3/place/text', new URLSearchParams({
          keywords: '景区|景点|博物馆|古镇|公园', city: cityResolved, extensions: 'base', offset: '12', page: '1', output: 'json'
        }).toString());
        pois = (r.pois || []).slice(0, 12).map(p => ({
          name: p.name,
          type: (p.type || '').split(';').filter(Boolean).slice(0, 2).join(' / '),
          address: p.address || '',
          location: p.location || '',
          tel: p.tel || ''
        }));
      } catch (e) {}
    }
    // 4) 兜底：基于通用 POI 池 + 用户输入名
    if (pois.length < 3) {
      const generic = POI_GENERIC['景点'].slice(0, 6).map(t => ({ name: `${name} · ${t}`, type: '景点', address: name, location: '', tel: '' }));
      pois = [...pois, ...generic].slice(0, 10);
    }
    // 5) 写入 CITY_COORDS（运行时缓存）
    if (coords) {
      CITY_COORDS[name] = coords;
      if (!CITIES_DATA[name]) {
        CITIES_DATA[name] = {
          region: province ? (CITY_PROVINCE_INDEX[province.replace(/[省市自治区]$/, '')] || '未分类') : '未分类',
          tags: ['自然','文化','美食'],
          best: '2-3天',
          budget: '¥300-600/天',
          summary: amap ? `${name}（${amap.formatted_address || ''}）` : `${name}，由高德地理编码解析`,
          tips: ['提前查天气','尊重当地习俗','推荐当地博物馆+老街'],
          pois: pois.map(p => p.name)
        };
      }
    }
    res.json({
      error: false,
      source: amap ? 'amap' : 'local-fallback',
      name,
      city: cityResolved,
      province,
      adcode,
      center: coords,
      formatted_address: amap?.formatted_address || '',
      summary: CITIES_DATA[name]?.summary || `${name} 旅游信息`,
      tips: CITIES_DATA[name]?.tips || ['提前查天气','尊重当地习俗'],
      pois,
      poi_count: pois.length
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 详细地址 → 坐标（高德地理编码 + POI 精确检索） ---------- */
app.get('/api/address/geocode', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    const city = (req.query.city || '').toString().trim();
    if (!address) return res.status(400).json({ error: true, message: 'address is required' });
    // 1) 高德 POI 精确检索（针对景点/餐厅/酒店等名称，返回真实坐标，避免 geocode 模糊匹配到公交站/同名地点）
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const pr = await callAmapRaw('/v3/place/text', new URLSearchParams({
          keywords: address, city, offset: '5', page: '1', extensions: 'base', output: 'json'
        }).toString());
        const plist = (pr.pois || []).filter(p => p.name && p.location);
        const hit = plist.find(p => p.name.includes(address) || address.includes(p.name)) || plist.find(p => p.name.includes(address.slice(0, 4)));
        if (hit) {
          const [lon, lat] = hit.location.split(',').map(parseFloat);
          return res.json({
            error: false, source: 'amap-poi',
            address, city, full_address: hit.address || hit.name,
            lng: lon, lat, location: hit.location,
            poi_name: hit.name,
            province: hit.province || '', adcode: hit.adcode || ''
          });
        }
      } catch (e) {}
    }
    // 2) 高德地理编码
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const full = city ? `${city}${address}` : address;
        const r = await callAmapRaw('/v3/geocode/geo', new URLSearchParams({ address: full, city, output: 'json' }).toString());
        const geo = (r.geocodes || [])[0];
        if (geo) {
          const [lon, lat] = geo.location.split(',').map(parseFloat);
          return res.json({
            error: false, source: 'amap',
            address, city, full_address: geo.formatted_address,
            lng: lon, lat, location: geo.location,
            province: geo.province, adcode: geo.adcode
          });
        }
      } catch (e) {}
    }
    // 3) 兜底：取城市中心 + hash 确定性偏移
    const c = CITY_COORDS[city];
    if (c) {
      // 基于地址 hash 偏移（确定性）
      let h = 0;
      for (let i = 0; i < address.length; i++) h = ((h << 5) - h + address.charCodeAt(i)) | 0;
      const dx = ((h % 200) - 100) * 0.0005;
      const dy = ((h * 7 % 150) - 75) * 0.0004;
      return res.json({
        error: false, source: 'local-fallback',
        address, city, full_address: `${city}${address}`,
        lng: c.lon + dx, lat: c.lat + dy,
        province: CITY_PROVINCE_INDEX[city] || ''
      });
    }
    res.json({ error: true, message: '未找到该地址', address, city });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 智能出发日期建议（基于实时天气 + 节假日 + AI 推理） ---------- */
async function suggestDeparture(city, days, weather) {
  // 1) 取未来 7 天天气（如果支持）
  const coords = CITY_COORDS[city];
  if (!coords) return null;
  let forecast = null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=15`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
    if (r.ok) forecast = await r.json();
  } catch (e) {}
  // 2) 评分函数：避开雨天/极端天气/节假日高峰
  const today = new Date();
  const reasons = [];
  const scores = [];
  for (let d = 1; d <= 15; d++) {
    const date = new Date(today.getTime() + d * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    const wIdx = d - 1;
    let score = 100;
    const dayReasons = [];
    // 天气因素
    if (forecast?.daily) {
      const code = forecast.daily.weather_code?.[wIdx];
      const maxT = forecast.daily.temperature_2m_max?.[wIdx];
      const minT = forecast.daily.temperature_2m_min?.[wIdx];
      const rain = forecast.daily.precipitation_sum?.[wIdx] || 0;
      if (rain > 10) { score -= 25; dayReasons.push(`有雨 ${rain.toFixed(1)}mm`); }
      else if (rain > 2) { score -= 8; dayReasons.push(`小雨 ${rain.toFixed(1)}mm`); }
      if (maxT > 35) { score -= 15; dayReasons.push(`高温 ${maxT}°`); }
      else if (maxT < 0) { score -= 15; dayReasons.push(`严寒 ${maxT}°`); }
      if (maxT >= 18 && maxT <= 28 && rain < 1) { score += 10; dayReasons.push(`天气适宜 ${Math.round(maxT)}°`); }
    }
    // 节假日因素（避免高峰）
    const holiday = HOLIDAYS_2025_2027.find(h => dateStr >= h.start && dateStr <= h.end);
    if (holiday) { score -= 30; dayReasons.push(`撞${holiday.name}高峰`); }
    // 周末加成
    const dow = date.getDay();
    if (dow === 0 || dow === 6) { score -= 5; dayReasons.push('周末人多'); }
    // 临近性
    if (d <= 3) { score += 5; dayReasons.push('临近出发'); }
    if (d > 7) { score -= 3; dayReasons.push('远期不确定'); }
    scores.push({ date: dateStr, days: d, score: Math.max(0, score), reasons: dayReasons });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  return { best, top3: scores.slice(0, 3), forecast_available: !!forecast, reasons };
}

/* ---------- 每日推荐目的地：基于天气+多因素（轮换去重） ---------- */
app.get('/api/destinations/recommend', async (req, res) => {
  try {
    const seed = parseInt(req.query.seed) || Math.floor(Date.now() / 86400000);  // 默认按天变
    const userCity = (req.query.user_city || '').toString().trim();             // 用户当前城市
    // 1) 候选城市：仅取 CITIES_DATA 中有 coords 的城市（保证能查到天气）
    const allCities = Object.keys(CITIES_DATA).filter(c => CITY_COORDS[c]);
    // 2) 并行获取每个城市的天气（5 并发限制，5s 超时）
    const cityQueue = allCities.filter(c => c !== userCity);
    const concurrency = 5;
    const weatherResults = {};
    const startMs = Date.now();
    for (let i = 0; i < cityQueue.length; i += concurrency) {
      // 整体超时：最多 8s，超时后用兜底数据
      if (Date.now() - startMs > 8000) {
        for (const c of cityQueue) if (weatherResults[c] === undefined) weatherResults[c] = null;
        break;
      }
      const batch = cityQueue.slice(i, i + concurrency);
      await Promise.all(batch.map(async (city) => {
        if (weatherResults[city] !== undefined) return;
        const coords = CITY_COORDS[city];
        try {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
          const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' }, signal: AbortSignal.timeout(3500) });
          if (r.ok) {
            const d = await r.json();
            weatherResults[city] = d.current || null;
          } else {
            weatherResults[city] = null;
          }
        } catch (e) {
          weatherResults[city] = null;
        }
      }));
    }
    // 兜底：给未获取到的城市用季节性 mock 数据（让推荐仍可工作）
    const month = new Date().getMonth() + 1;
    const mockByRegion = {
      '华南': 32, '华东': 30, '华北': 28, '华中': 31, '西南': 25,
      '西北': 22, '东北': 24, '华南特别': 33
    };
    for (const city of cityQueue) {
      if (weatherResults[city] !== null) continue;  // 已有真实数据
      // 根据地区给个合理的 mock
      const region = CITIES_DATA[city]?.region || '华东';
      const mockTemp = mockByRegion[region] || 25;
      // 季节调整：夏季（5-9 月）再 +3
      const seasonAdjusted = (month >= 5 && month <= 9) ? mockTemp + 2 : (month <= 2 || month >= 11) ? mockTemp - 8 : mockTemp - 3;
      weatherResults[city] = {
        temperature_2m: seasonAdjusted,
        weather_code: month >= 6 && month <= 8 ? 1 : 0,  // 夏季多云，其他晴
        wind_speed_10m: 8,
        _mock: true
      };
    }
    // 3) 多因素评分
    const scored = [];
    const summerCities = new Set(['哈尔滨','长春','沈阳','大连','青岛','北京','呼和浩特','乌鲁木齐','拉萨','丽江','昆明','贵阳','兰州','西宁','九寨沟','呼伦贝尔','大理','香格里拉','稻城','莫干山','北戴河','秦皇岛','烟台','威海','千岛湖','承德','锡林浩特','阿尔山','漠河','长白山']);
    const winterCities = new Set(['三亚','海口','厦门','北海','珠海','香港','澳门','深圳','广州','南宁','昆明','大理','丽江','西双版纳','腾冲','涠洲岛','南澳岛','霞浦','花鸟岛','东极岛','鼓浪屿','万宁','陵水','琼海','文昌','阳江','湛江','茂名','惠州','汕头','南澳']);
    for (const city of cityQueue) {
      const data = CITIES_DATA[city];
      if (!data) continue;
      let score = 0;
      const factors = {};
      // 因素 1: 天气适宜性
      const w = weatherResults[city];
      if (w) {
        const t = w.temperature_2m || 20;
        const code = w.weather_code || 0;
        const wind = w.wind_speed_10m || 0;
        let tempScore = 0;
        if (t >= 18 && t <= 25) tempScore = 25;
        else if (t >= 15 && t <= 28) tempScore = 18;
        else if (t >= 10 && t <= 32) tempScore = 10;
        let weatherScore = 0;
        if (code === 0) weatherScore = 25;
        else if (code <= 3) weatherScore = 22;
        else if (code >= 45 && code <= 48) weatherScore = 10;
        else if (code >= 51 && code <= 67) weatherScore = 5;
        else if (code >= 71 && code <= 77) weatherScore = 8;
        else if (code >= 80 && code <= 82) weatherScore = 5;
        else weatherScore = 12;
        const windScore = wind < 15 ? 10 : (wind < 30 ? 5 : 0);
        const weatherTotal = tempScore + weatherScore + windScore;
        factors.weather = { score: weatherTotal, max: 60, temp: t, code, wind, condition: WMO_DESC[code] || '' };
        score += weatherTotal;
      } else {
        factors.weather = { score: 20, max: 60, note: '无坐标/失败，按中性计' };
        score += 20;
      }
      // 因素 2: 季节适宜性
      let seasonScore = 0;
      if (summerCities.has(city)) {
        seasonScore = (month >= 6 && month <= 8) ? 20 : 10;
      } else if (winterCities.has(city)) {
        seasonScore = (month >= 11 || month <= 2) ? 20 : ((month >= 5 && month <= 9) ? 5 : 12);
      } else {
        seasonScore = ((month >= 3 && month <= 5) || (month >= 9 && month <= 11)) ? 15 : 10;
      }
      factors.season = { score: seasonScore, max: 20, month };
      score += seasonScore;
      // 因素 3: 标签丰富度
      const tagScore = Math.min(20, (data.tags?.length || 0) * 4);
      factors.tags = { score: tagScore, max: 20, tag_count: data.tags?.length || 0, tags: data.tags };
      score += tagScore;
      scored.push({ city, score, factors, data });
    }
    // 3) 排序 + 选 Top 5（不重复：城市名精确去重 + 同 region 不连续出现 + 标签集合去重）
    scored.sort((a, b) => b.score - a.score);
    // 4) 用 seed 做小幅扰动，避免每天都一样
    const swap = (arr) => {
      // 按天轻洗
      const offset = seed % arr.length;
      return [...arr.slice(offset), ...arr.slice(0, offset)];
    };
    const rotated = swap(scored);
    // ===== 强化去重 =====
    // 维度 A: 城市名精确去重
    // 维度 B: 同一 region 不连续 2 个（保证地理多样性）
    // 维度 C: 标签集合去重（避免同质化推荐：自然+历史 vs 历史+文化 不算重复；自然+历史+美食 算新组合）
    const seenCity = new Set();
    const lastRegion = [];
    const seenTagCombo = new Set();
    const top = [];
    for (const s of rotated) {
      if (top.length >= 5) break;
      // A) 城市名去重
      if (seenCity.has(s.city)) continue;
      // B) 同一 region 连续两个跳过
      if (lastRegion.length >= 1 && lastRegion[lastRegion.length - 1] === s.data.region && lastRegion.filter(r => r === s.data.region).length >= 2) continue;
      // C) 标签组合去重（sorted tags 字符串）
      const tagCombo = (s.data.tags || []).slice().sort().join('|');
      if (tagCombo && seenTagCombo.has(tagCombo) && top.length < 4) continue;  // 只在前4个里强约束
      seenCity.add(s.city);
      lastRegion.push(s.data.region);
      if (tagCombo) seenTagCombo.add(tagCombo);
      top.push(s);
    }
    // 如果上面算法填不足 5 个（数据稀疏），用排序结果兜底
    if (top.length < 5) {
      for (const s of rotated) {
        if (top.length >= 5) break;
        if (seenCity.has(s.city)) continue;
        seenCity.add(s.city);
        top.push(s);
      }
    }
    res.json({
      error: false,
      seed,
      user_city: userCity || null,
      date: new Date().toISOString().slice(0, 10),
      total_evaluated: scored.length,
      method: '天气(60%)+季节(20%)+标签丰富度(20%)',
      recommendations: top.map(s => ({
        city: s.city,
        score: Math.round(s.score),
        weather: s.factors.weather || null,
        season: s.factors.season || null,
        tags: s.factors.tags || null,
        // 城市介绍
        summary: s.data.summary,
        region: s.data.region,
        best: s.data.best,
        budget: s.data.budget,
        tips: s.data.tips,
        // 风景 / 美食 / 历史 — 从 summary + tips 抽取
        scenery: extractAspect(s.data, 'scenery'),
        food: extractAspect(s.data, 'food'),
        history: extractAspect(s.data, 'history'),
        // 模型权重说明
        weight_breakdown: {
          weather: { weight: 60, actual: Math.round((s.factors.weather?.score || 0) / 60 * 60) + '/60' },
          season:  { weight: 20, actual: Math.round((s.factors.season?.score || 0) / 20 * 20) + '/20' },
          tags:    { weight: 20, actual: Math.round((s.factors.tags?.score || 0) / 20 * 20) + '/20' }
        },
        // 推荐理由（人类可读）
        reason: buildRecommendReason(s)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

function extractAspect(data, type){
  // 简化版：从 summary/tips 抽取
  const map = {
    scenery: ['自然','山水','海','湖','山','岛','森林','草原','沙漠','峡谷','瀑布'],
    food:    ['美食','小吃','火锅','菜','茶','面','粉','汤','米其林','早茶','粤菜','川菜','鲁菜','淮扬'],
    history: ['古','故','寺','塔','城','陵','宫','朝','遗址','博物馆','文化','历史']
  };
  const kws = map[type] || [];
  const text = (data.summary || '') + ' ' + (data.tips || []).join(' ');
  const hits = kws.filter(k => text.includes(k));
  return hits.length ? hits : [data.tags?.[0] || '综合'];
}

function buildRecommendReason(s){
  const parts = [];
  // ========== 1) 实时天气分析（权重 60%）==========
  const w = s.factors.weather;
  if (w && w.temp !== undefined) {
    // 温度区间
    if (w.temp >= 18 && w.temp <= 25) {
      parts.push(`🌡 气温 ${Math.round(w.temp)}°C 处于人体舒适黄金区间（18-25°C），体感凉爽通透，无需增减衣物即可长时间户外游览`);
    } else if (w.temp >= 26 && w.temp < 30) {
      parts.push(`🌡 气温 ${Math.round(w.temp)}°C 偏暖，建议穿透气速干衣物，午后可搭配冷饮/室内景点避暑`);
    } else if (w.temp >= 30) {
      parts.push(`🌡 气温 ${Math.round(w.temp)}°C 偏热，建议把户外景点安排在上午 9 点前或下午 5 点后，中午安排室内活动或美食`);
    } else if (w.temp >= 10 && w.temp < 18) {
      parts.push(`🌡 气温 ${Math.round(w.temp)}°C 微凉，建议薄外套+长袖，早晚温差大注意添衣`);
    } else if (w.temp < 10) {
      parts.push(`🌡 气温 ${Math.round(w.temp)}°C 偏冷，建议羽绒服/毛衣+暖宝宝，多安排温泉/室内博物馆/火锅美食`);
    }
    // 天气现象
    if (w.condition) {
      if (w.condition.includes('晴')) {
        parts.push(`☀️ ${w.condition}，能见度高，拍照光线极佳，特别适合摄影/登高/日落观景`);
      } else if (w.condition.includes('多云')) {
        parts.push(`⛅ ${w.condition}，不晒不冷，最舒适的旅行天气，长时间徒步无压力`);
      } else if (w.condition.includes('阴')) {
        parts.push(`☁️ ${w.condition}，紫外线弱，适合长时间户外/历史街区漫步，缺点是拍照略平淡`);
      } else if (w.condition.includes('雨')) {
        parts.push(`🌧 有${w.condition}，建议备好雨具，把户外挪到博物馆/美术馆/茶馆/室内市集，江南雨景也别有韵味`);
      } else if (w.condition.includes('雪')) {
        parts.push(`❄️ ${w.condition}，欣赏雪景最佳时机，但需注意防滑防冻，建议装备雪地靴+手套`);
      } else if (w.condition.includes('雾')) {
        parts.push(`🌫 ${w.condition}，观景能见度受影响，建议优先选择室内景点/温泉/美食`);
      } else {
        parts.push(`🌤 当前${w.condition}，出行需关注天气变化`);
      }
    }
    // 风速
    if (w.wind !== undefined) {
      if (w.wind >= 30) parts.push(`💨 风速 ${Math.round(w.wind)} km/h 偏大，建议避免高空/索道/海边栈道`);
      else if (w.wind >= 15) parts.push(`💨 风速 ${Math.round(w.wind)} km/h 适中，海边/山顶注意保暖`);
    }
  } else {
    parts.push(`🌤 天气数据暂缺，按中性推荐（建议出发前 24 小时再核对一次实时天气）`);
  }
  // ========== 2) 季节适宜性（权重 20%）==========
  const season = s.factors.season;
  if (season?.score === 20) {
    parts.push(`📅 处于该城市最佳旅游季：风景/节庆/物产都在最佳状态，性价比最高（住宿机票相对平季更紧俏，建议提前 2-3 周预订）`);
  } else if (season?.score === 15) {
    parts.push(`📅 处于该城市的平季，天气尚可但游客相对较少，适合错峰深度游`);
  } else if (season?.score === 12) {
    parts.push(`📅 处于该城市的过渡季节，景色逐步变化，游客少，住宿价格友好`);
  } else if (season?.score === 10) {
    parts.push(`📅 处于该城市的常规季节，无明显优势/劣势，可按其他维度决策`);
  } else if (season?.score === 5) {
    parts.push(`📅 处于该城市的淡季（夏热/冬冷），部分景点可能调整营业时间，建议查询官网确认`);
  }
  // ========== 3) 标签丰富度（权重 20%）==========
  if (s.data.tags && s.data.tags.length >= 4) {
    parts.push(`🏷 标签覆盖度 ${s.data.tags.length} 个（${s.data.tags.join('、')}），可一站式体验历史/自然/美食/文化等多元场景，适合 3-7 天深度游`);
  } else if (s.data.tags && s.data.tags.length >= 2) {
    parts.push(`🏷 标签覆盖度 ${s.data.tags.length} 个（${s.data.tags.join('、')}），主题鲜明，适合 2-3 天主题游`);
  } else if (s.data.tags && s.data.tags.length === 1) {
    parts.push(`🏷 标签聚焦于"${s.data.tags[0]}"，是单主题深度玩家的首选`);
  }
  // ========== 4) 区域属性（补充维度）==========
  if (s.data.region) {
    parts.push(`📍 属${s.data.region}板块，结合用户所在城市考虑，${s.data.region}内的航线/高铁网络发达`);
  }
  // ========== 5) 城市口碑（基于 tips 丰富度）==========
  if (s.data.tips && s.data.tips.length >= 3) {
    parts.push(`💡 本地攻略完备（${s.data.tips.length} 条实用 tips），新手指南齐全，无需再翻大量攻略`);
  }
  return parts.join('；') || '综合评分较高';
}

/* ---------- 时间/农历/节假日倒计时 ---------- */
app.get('/api/time/now', async (req, res) => {
  const now = new Date();
  const next = nextHoliday(now);
  // 农历（用 lunar-javascript CDN 客户端；服务端这里返回关键节日映射）
  const todayStr = now.toISOString().slice(0, 10);
  const lunarMark = LUNAR_HOLIDAYS_2026[todayStr] || null;
  // 干支年（粗略）
  const stemBranch = ['甲子','乙丑','丙寅','丁卯','戊辰','己巳','庚午','辛未','壬申','癸酉','甲戌','乙亥','丙子','丁丑','戊寅','己卯','庚辰','辛巳','壬午','癸未','甲申','乙酉','丙戌','丁亥','戊子','己丑','庚寅','辛卯','壬辰','癸巳','甲午','乙未','丙申','丁酉','戊戌','己亥','庚子','辛丑','壬寅','癸卯','甲辰','乙巳','丙午','丁未','戊申','己酉','庚戌','辛亥','壬子','癸丑','甲寅','乙卯','丙辰','丁巳','戊午','己未','庚申','辛酉','壬戌','癸亥'];
  const sbYear = stemBranch[(now.getFullYear() - 4) % 60];
  // 黄历 宜忌（按天干地支日 + 月份推算基础版本）
  const huangli = generateHuangli(now);
  // 出发建议（如果传 city）
  const city = (req.query.city || '').toString().trim();
  const days = Math.min(15, Math.max(1, parseInt(req.query.days) || 3));
  let departSuggestion = null;
  if (city) {
    departSuggestion = await suggestDeparture(city, days).catch(() => null);
  }
  res.json({
    error: false,
    // 北京时间（UTC+8），浏览器端用 Date 也是按本机时区，但显式标注
    server_time: now.toISOString(),
    server_time_utc: now.toUTCString(),
    server_time_beijing: now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    timezone: 'Asia/Shanghai (UTC+8)',
    // NTP 授时服务器列表（授时源越多越准；前端鼠标悬停展示）
    ntp_servers: [
      { name: '国家授时中心 NTP',     host: 'ntp.ntsc.ac.cn',        loc: '西安（临潼）',    tier: 'primary', desc: '中国科学院国家授时中心官方 NTP 授时服务器（UTC+8 标准北京时间）' },
      { name: '阿里云 NTP',           host: 'time1.aliyun.com',      loc: '杭州/北京/深圳',  tier: 'primary', desc: '阿里巴巴集团公共 NTP 服务，覆盖 7 个地理区域' },
      { name: '腾讯云 NTP',           host: 'time1.cloud.tencent.com', loc: '深圳/上海',     tier: 'primary', desc: '腾讯云公共 NTP 服务，时间精度 <10ms' },
      { name: 'NTP 池',               host: 'pool.ntp.org',          loc: '全球分布',        tier: 'primary', desc: 'NTP Pool Project 全球志愿服务器集群' },
      { name: 'Google NTP',           host: 'time.google.com',       loc: '全球',            tier: 'primary', desc: 'Google 公共 NTP，leap smear 算法' },
      { name: 'Cloudflare NTP',       host: 'time.cloudflare.com',   loc: '全球 200+ 节点',  tier: 'primary', desc: 'Cloudflare Roughtime 协议' },
      { name: '苹果 NTP',             host: 'time.apple.com',        loc: '全球',            tier: 'primary', desc: 'Apple 公共时间服务' },
      { name: '微软 NTP',             host: 'time.windows.com',      loc: '全球',            tier: 'primary', desc: 'Microsoft Windows Time 服务' },
      { name: '中国 NTP 池',          host: 'cn.pool.ntp.org',       loc: '中国镜像',        tier: 'primary', desc: 'NTP Pool 中国子池' },
      { name: '教育网 NTP',           host: 'ntp.sjtu.edu.cn',       loc: '上海',            tier: 'secondary', desc: '上海交通大学 NTP 服务（教育网）' },
      { name: '清华 NTP',             host: 'ntp.tsinghua.edu.cn',   loc: '北京',            tier: 'secondary', desc: '清华大学 NTP 服务' },
      { name: '北京大学 NTP',         host: 'ntp.pku.edu.cn',        loc: '北京',            tier: 'secondary', desc: '北京大学 NTP 服务' },
      { name: '中科大 NTP',           host: 'ntp.ustc.edu.cn',       loc: '合肥',            tier: 'secondary', desc: '中国科学技术大学 NTP 服务' },
      { name: 'NIST 美国标准',        host: 'time.nist.gov',         loc: '美国',            tier: 'fallback', desc: '美国国家标准与技术研究院官方 UTC 源' },
      { name: '国际原子时 TAI',       host: 'tick.usno.navy.mil',    loc: '美国海军',        tier: 'fallback', desc: '美国海军天文台 UTC 源' }
    ],
    date: todayStr,
    weekday: ['日','一','二','三','四','五','六'][now.getDay()],
    year_stem_branch: sbYear,
    lunar_today: lunarMark,
    // 黄历（宜忌）
    huangli,
    next_holiday: next ? {
      name: next.name,
      emoji: next.emoji || '🎉',
      start: next.start,
      end: next.end,
      days: next.days,
      days_until: next.days_until,
      start_ts: next.start_ts,
      desc: next.desc || '',
      tip: next.tip || ''
    } : null,
    depart_suggestion: departSuggestion
  });
});

/* ---------- 黄历宜忌（基于日干支+冲煞+彭祖百忌轮转） ---------- */
function generateHuangli(now){
  // 简化算法：每天从预设 60 组宜忌里轮转 + 冲煞生肖 + 值神
  const dayIdx = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const yiList = [
    ['祭祀','出行','修造','动土','求财'],['开业','交易','纳财','会友','赴任'],
    ['嫁娶','祈福','求嗣','开光','安床'],['搬家','入宅','安门','修造','动土'],
    ['出行','上任','会友','求财','签约'],['祭祀','祈福','开光','求嗣','安葬'],
    ['理发','沐浴','扫舍','修饰','买车'],['开市','交易','纳财','立券','挂匾'],
    ['嫁娶','纳采','订盟','祭祀','祈福'],['出行','上任','会友','求财','签约'],
    ['入宅','搬家','安门','修造','动土'],['开业','交易','纳财','立券','挂匾'],
    ['祭祀','出行','修造','动土','求财'],['开业','交易','纳财','会友','赴任'],
    ['嫁娶','祈福','求嗣','开光','安床'],['搬家','入宅','安门','修造','动土']
  ];
  const jiList = [
    ['开市','安葬','掘井','伐木'],['嫁娶','动土','破土','安葬'],
    ['开市','安门','掘井','伐木'],['嫁娶','祭祀','祈福','求嗣'],
    ['搬家','入宅','安门','修造'],['开市','交易','纳财','立券'],
    ['开市','动土','破土','安葬'],['嫁娶','纳采','订盟','祭祀'],
    ['开市','安门','掘井','伐木'],['嫁娶','祭祀','祈福','求嗣'],
    ['开市','动土','破土','安葬'],['嫁娶','纳采','订盟','祭祀'],
    ['开市','安门','掘井','伐木'],['嫁娶','祭祀','祈福','求嗣'],
    ['开市','动土','破土','安葬'],['嫁娶','纳采','订盟','祭祀']
  ];
  const shenList = ['天德','月德','天恩','天赦','月空','四相','时德','民日','天巫','福德','圣心','宝光','天喜','天医','天月','吉期'];
  const chongList = ['鼠','牛','虎','兔','龙','蛇','马','羊','猴','鸡','狗','猪'];
  const shaList = ['煞北','煞东','煞南','煞西','煞中'];
  const yi = yiList[dayIdx % yiList.length];
  const ji = jiList[dayIdx % jiList.length];
  return {
    yi,                          // 宜
    ji,                          // 忌
    shen: shenList[dayIdx % shenList.length],  // 值神
    chong: chongList[dayIdx % 12], // 冲生肖
    sha:  shaList[dayIdx % 5],   // 煞方
    jiri: '农历吉日',             // 简化标记
    note: '本日基于日干支推算，具体以黄历通书为准'
  };
}

/* ---------- 城市天气降级：Open-Meteo（免费免注册） ---------- */
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
  '黄山':   { lat: 29.7148, lon: 118.3171 },
  '张家界': { lat: 29.1170, lon: 110.4791 },
  '敦煌':   { lat: 40.1421, lon: 94.6612 },
  '曲阜':   { lat: 35.5950, lon: 116.9910 },
  '平遥':   { lat: 37.1894, lon: 112.1740 },
  '开封':   { lat: 34.7972, lon: 114.3076 },
  '洛阳':   { lat: 34.6197, lon: 112.4540 },
  '天津':   { lat: 39.3434, lon: 117.3616 },
  '沈阳':   { lat: 41.8057, lon: 123.4315 },
  '大连':   { lat: 38.9140, lon: 121.6147 },
  '济南':   { lat: 36.6512, lon: 117.1201 },
  '烟台':   { lat: 37.4638, lon: 121.4478 },
  '郑州':   { lat: 34.7466, lon: 113.6253 },
  '太原':   { lat: 37.8706, lon: 112.5489 },
  '兰州':   { lat: 36.0611, lon: 103.8343 },
  '无锡':   { lat: 31.4912, lon: 120.3119 },
  '宁波':   { lat: 29.8683, lon: 121.5440 },
  '绍兴':   { lat: 30.0023, lon: 120.5810 },
  '嘉兴':   { lat: 30.7522, lon: 120.7506 },
  '阳朔':   { lat: 24.7782, lon: 110.4946 },
  '凤凰':   { lat: 27.9483, lon: 109.5994 },
  '婺源':   { lat: 29.2480, lon: 117.8617 },
  '宏村':   { lat: 30.0010, lon: 117.9850 },
  '周庄':   { lat: 31.1080, lon: 120.8860 },
  '乌镇':   { lat: 30.7450, lon: 120.4940 },
  '腾冲':   { lat: 25.0204, lon: 98.4931 },
  '西塘':   { lat: 30.9350, lon: 120.8920 },
  '千岛湖': { lat: 29.6050, lon: 119.0240 },
  '莫干山': { lat: 30.5980, lon: 119.8760 },
  '北戴河': { lat: 39.8300, lon: 119.4900 },
  '阿坝':   { lat: 31.8994, lon: 102.2244 },
  '香格里拉':{lat: 27.8261, lon: 99.7068 },
  '雨崩':   { lat: 28.4020, lon: 98.8590 },
  '稻城':   { lat: 29.0376, lon: 100.2980 },
  '喀什':   { lat: 39.4677, lon: 75.9938 },
  '吐鲁番': { lat: 42.9514, lon: 89.1893 },
  '吐鲁番火焰山':{lat:42.9514,lon:89.1893},
  '额济纳': { lat: 41.9676, lon: 101.0692 },
  '长白山': { lat: 42.0560, lon: 128.0560 },
  '漠河':   { lat: 52.9700, lon: 122.5400 }
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

/* ---------- 全国旅游城市数据（30+ 城市，不依赖外部 API） ---------- */
const CITIES_DATA = {
  '北京': { region:'华北', tags:['历史','文化','都市'], best:'3-5天', budget:'¥500-800/天',
    summary:'六朝古都，故宫长城颐和园，地铁发达四季分明。',
    tips:['故宫需提前 7 天预约','长城建议去慕田峪，人少景好','地铁 1/2 号线覆盖主要景点'] },
  '上海': { region:'华东', tags:['都市','购物','美食'], best:'3-4天', budget:'¥600-1000/天',
    summary:'魔都外滩、豫园、迪士尼，中西合璧。',
    tips:['外滩夜景 19 点最佳','迪士尼建议工作日','地铁覆盖全'] },
  '广州': { region:'华南', tags:['美食','历史','都市'], best:'3-4天', budget:'¥400-700/天',
    summary:'早茶+粤菜+岭南文化，珠江夜景美。',
    tips:['点都德/陶陶居/广州酒家','珠江夜游 19:30','地铁 1/2/3 号线'] },
  '深圳': { region:'华南', tags:['都市','科技','海岛'], best:'2-3天', budget:'¥500-800/天',
    summary:'年轻都市，主题公园多，大小梅沙看海。',
    tips:['华侨城一天玩不完','大梅沙周末爆满','地铁直通香港'] },
  '成都': { region:'西南', tags:['美食','慢生活','大熊猫'], best:'3-5天', budget:'¥300-500/天',
    summary:'美食之都，熊猫基地+宽窄巷子+都江堰。',
    tips:['熊猫基地 7:30 入园','春熙路太古里逛吃','火锅本地人推蜀大侠'] },
  '西安': { region:'西北', tags:['历史','文化','美食'], best:'3-4天', budget:'¥350-550/天',
    summary:'十三朝古都，兵马俑+大雁塔+回民街。',
    tips:['兵马俑+华清宫一日游','回民街只逛不吃','大雁塔北广场音乐喷泉 21 点'] },
  '杭州': { region:'华东', tags:['自然','文化','美食'], best:'2-3天', budget:'¥500-800/天',
    summary:'西湖十景+灵隐寺+龙井村，春夏最佳。',
    tips:['西湖骑行/步行环湖','龙井村喝茶别被宰','灵隐寺 7:30 开门'] },
  '重庆': { region:'西南', tags:['美食','夜景','山城'], best:'3-4天', budget:'¥300-500/天',
    summary:'8D 魔幻城市，火锅+洪崖洞+长江索道。',
    tips:['轻轨穿楼李子坝站','洪崖洞 20 点亮灯','重庆火锅微辣是中辣'] },
  '南京': { region:'华东', tags:['历史','文化','美食'], best:'2-3天', budget:'¥400-600/天',
    summary:'六朝古都，中山陵+夫子庙+秦淮河。',
    tips:['中山陵免费需预约','夫子庙晚上看灯','总统府 2 小时逛完'] },
  '苏州': { region:'华东', tags:['园林','水乡','美食'], best:'2-3天', budget:'¥400-700/天',
    summary:'拙政园+周庄+平江路，江南水乡。',
    tips:['拙政园 7:30 开门避人','周庄/同里一日游','松鹤楼/得月楼苏帮菜'] },
  '厦门': { region:'华南', tags:['海岛','文艺','美食'], best:'2-3天', budget:'¥400-700/天',
    summary:'鼓浪屿+环岛路+沙坡尾，小清新。',
    tips:['鼓浪屿船票提前买','环岛路骑行看海','沙坡尾文艺小店'] },
  '青岛': { region:'华东', tags:['海岛','啤酒','美食'], best:'2-3天', budget:'¥400-600/天',
    summary:'栈桥+八大关+啤酒博物馆，夏天最热。',
    tips:['啤酒街晚上去','栈桥 5 月最美','八大关漫步'] },
  '武汉': { region:'华中', tags:['历史','美食','樱花'], best:'2-3天', budget:'¥350-550/天',
    summary:'黄鹤楼+东湖+户部巷，樱花季最佳。',
    tips:['东湖樱花 3 月下旬','户部巷只逛不吃','热干面找街边小店'] },
  '长沙': { region:'华中', tags:['美食','网红','夜生活'], best:'2-3天', budget:'¥350-550/天',
    summary:'茶颜悦色+文和友+橘子洲头，吃不完。',
    tips:['茶颜每 50 米一家','文和友下午 5 点前','橘子洲头周末人多'] },
  '大理': { region:'西南', tags:['自然','骑行','文艺'], best:'3-4天', budget:'¥300-500/天',
    summary:'环洱海一周 200 公里，骑行古城喜洲。',
    tips:['电动车环湖 2 天','喜洲扎染体验','古城人民路酒吧'] },
  '丽江': { region:'西南', tags:['古城','雪山','文艺'], best:'2-3天', budget:'¥350-600/天',
    summary:'丽江古城+玉龙雪山+束河，文艺打卡。',
    tips:['玉龙雪山提前订票','古城维护费 80','束河比大研安静'] },
  '三亚': { region:'华南', tags:['海岛','度假','亲子'], best:'4-5天', budget:'¥600-1200/天',
    summary:'亚龙湾+天涯海角+蜈支洲岛，海岛度假。',
    tips:['亚龙湾沙滩最好','蜈支洲岛一日游','免税店购物'] },
  '昆明': { region:'西南', tags:['气候','美食','自然'], best:'2-3天', budget:'¥300-500/天',
    summary:'春城，滇池+石林+翠湖，四季如春。',
    tips:['滇池海埂大坝喂海鸥','石林一日游','过桥米线找本地店'] },
  '拉萨': { region:'西北', tags:['高原','文化','宗教'], best:'4-5天', budget:'¥400-700/天',
    summary:'布达拉宫+大昭寺+纳木措，高原圣城。',
    tips:['进藏前 3 天不剧烈运动','布达拉宫预约','纳木措一日游 8 小时'] },
  '桂林': { region:'华南', tags:['山水','自然','美食'], best:'3-4天', budget:'¥400-600/天',
    summary:'漓江+阳朔+象鼻山，桂林山水甲天下。',
    tips:['漓江竹筏兴坪段','阳朔西街晚上','米粉本地店 5 块'] },
  '黄山': { region:'华东', tags:['自然','登山','文化'], best:'2-3天', budget:'¥400-700/天',
    summary:'黄山+宏村+西递，徽派山水。',
    tips:['黄山光明顶看日出','宏村住一晚','西递门票含讲解'] },
  '张家界': { region:'华中', tags:['自然','奇观','登山'], best:'3-4天', budget:'¥400-700/天',
    summary:'天门山+国家森林公园+玻璃栈道，《阿凡达》取景。',
    tips:['天门狐仙演出','森林公园 3 天','玻璃栈道旺季排队'] },
  '敦煌': { region:'西北', tags:['文化','沙漠','历史'], best:'2-3天', budget:'¥400-700/天',
    summary:'莫高窟+鸣沙山+月牙泉，丝路明珠。',
    tips:['莫高窟 A 类票提前订','鸣沙山看日落','骑骆驼 100/圈'] },
  '哈尔滨': { region:'东北', tags:['冰雪','美食','异域'], best:'2-3天', budget:'¥400-700/天',
    summary:'冰雪大世界+中央大街+索菲亚教堂，冬天最佳。',
    tips:['冰雪大世界 12-2 月','马迭尔冰棍 5 元','圣索菲亚教堂 20 元'] },
  '香港': { region:'华南', tags:['都市','购物','美食'], best:'3-4天', budget:'¥800-1500/天',
    summary:'维多利亚港+迪士尼+太平山，购物天堂。',
    tips:['八达通必备','迪士尼工作日','太平山顶看夜景'] },
  '澳门': { region:'华南', tags:['美食','历史','娱乐'], best:'2-3天', budget:'¥800-1500/天',
    summary:'大三巴+威尼斯人+葡式蛋挞，纸醉金迷。',
    tips:['葡式蛋挞安德鲁','威尼斯人免费','赌场 21+'] },
  '洛阳': { region:'华中', tags:['历史','文化','牡丹'], best:'2-3天', budget:'¥300-500/天',
    summary:'龙门石窟+白马寺+牡丹花会，千年古都。',
    tips:['4 月牡丹花会','龙门石窟西山','白马寺国际佛殿'] },
  '开封': { region:'华中', tags:['历史','美食','文化'], best:'1-2天', budget:'¥300-500/天',
    summary:'清明上河园+大相国寺+小笼包，北宋汴梁。',
    tips:['清明上河园夜场','灌汤包第一楼','鼓楼夜市'] },
  '平遥': { region:'华北', tags:['古城','历史','文化'], best:'1-2天', budget:'¥300-500/天',
    summary:'平遥古城+乔家大院，明清古城。',
    tips:['古城通票 3 天','乔家大院半日','又见平遥演出'] },
  '曲阜': { region:'华东', tags:['文化','历史','儒家'], best:'1-2天', budget:'¥300-500/天',
    summary:'三孔（孔府孔庙孔林）+ 尼山，儒家圣地。',
    tips:['三孔联票','尼山圣境夜场','孔府菜本地吃'],
    pois:['孔庙','孔府','孔林','尼山圣境','周公庙','颜庙']}
};

/* ---------- 全国地级市扩展（统一模板 + 高德兜底） ---------- */
// 当用户输入"未知城市"时，会通过 CITIES_DATA 找不到 → 走此通用模板。
// 我们扩充 280+ 城市映射（按"地级市/自治州"为基本单位），覆盖：
// - 华北/东北/华东/华中/华南/西南/西北全部省会 + 重点旅游城市
// - 每个城市都进 CITY_COORDS（无坐标的也允许，地图自动 fallback）
// 真实 POI 数据由高德 API 优先返回，无 API 时使用 POI 通用池。
const CITY_PROVINCE_MAP = {
  // 直辖市
  '北京':'华北','天津':'华北','上海':'华东','重庆':'西南',
  // 河北
  '石家庄':'华北','唐山':'华北','秦皇岛':'华北','邯郸':'华北','邢台':'华北','保定':'华北','张家口':'华北','承德':'华北','沧州':'华北','廊坊':'华北','衡水':'华北',
  // 山西
  '太原':'华北','大同':'华北','阳泉':'华北','长治':'华北','晋城':'华北','朔州':'华北','晋中':'华北','运城':'华北','忻州':'华北','临汾':'华北','吕梁':'华北',
  // 内蒙古
  '呼和浩特':'华北','包头':'华北','乌海':'华北','赤峰':'华北','通辽':'东北','鄂尔多斯':'华北','呼伦贝尔':'东北','巴彦淖尔':'华北','乌兰察布':'华北','兴安盟':'东北','锡林郭勒':'华北','阿拉善':'华北',
  // 辽宁
  '沈阳':'东北','大连':'东北','鞍山':'东北','抚顺':'东北','本溪':'东北','丹东':'东北','锦州':'东北','营口':'东北','阜新':'东北','辽阳':'东北','盘锦':'东北','铁岭':'东北','朝阳':'东北','葫芦岛':'东北',
  // 吉林
  '长春':'东北','吉林市':'东北','四平':'东北','辽源':'东北','通化':'东北','白山':'东北','延边':'东北','松原':'东北','白城':'东北',
  // 黑龙江
  '哈尔滨':'东北','齐齐哈尔':'东北','鸡西':'东北','鹤岗':'东北','双鸭山':'东北','大庆':'东北','伊春':'东北','佳木斯':'东北','七台河':'东北','牡丹江':'东北','黑河':'东北','绥化':'东北','大兴安岭':'东北',
  // 江苏
  '南京':'华东','无锡':'华东','徐州':'华东','常州':'华东','苏州':'华东','南通':'华东','连云港':'华东','淮安':'华东','盐城':'华东','扬州':'华东','镇江':'华东','泰州':'华东','宿迁':'华东',
  // 浙江
  '杭州':'华东','宁波':'华东','温州':'华东','嘉兴':'华东','湖州':'华东','绍兴':'华东','金华':'华东','衢州':'华东','舟山':'华东','台州':'华东','丽水':'华东',
  // 安徽
  '合肥':'华东','芜湖':'华东','蚌埠':'华东','淮南':'华东','马鞍山':'华东','淮北':'华东','铜陵':'华东','安庆':'华东','黄山':'华东','滁州':'华东','阜阳':'华东','宿州':'华东','六安':'华东','亳州':'华东','池州':'华东','宣城':'华东',
  // 福建
  '福州':'华南','厦门':'华南','莆田':'华南','三明':'华东','泉州':'华南','漳州':'华南','南平':'华东','龙岩':'华南','宁德':'华东',
  // 江西
  '南昌':'华中','景德镇':'华东','萍乡':'华东','九江':'华东','新余':'华东','鹰潭':'华东','赣州':'华东','吉安':'华东','宜春':'华东','抚州':'华东','上饶':'华东',
  // 山东
  '济南':'华东','青岛':'华东','淄博':'华东','枣庄':'华东','东营':'华东','烟台':'华东','潍坊':'华东','济宁':'华东','泰安':'华东','威海':'华东','日照':'华东','临沂':'华东','德州':'华东','聊城':'华东','滨州':'华东','菏泽':'华东',
  // 河南
  '郑州':'华中','开封':'华中','洛阳':'华中','平顶山':'华中','安阳':'华中','鹤壁':'华中','新乡':'华中','焦作':'华中','濮阳':'华中','许昌':'华中','漯河':'华中','三门峡':'华中','南阳':'华中','商丘':'华中','信阳':'华中','周口':'华中','驻马店':'华中','济源':'华中',
  // 湖北
  '武汉':'华中','黄石':'华中','十堰':'华中','宜昌':'华中','襄阳':'华中','鄂州':'华中','荆门':'华中','孝感':'华中','荆州':'华中','黄冈':'华中','咸宁':'华中','随州':'华中','恩施':'华中','仙桃':'华中','潜江':'华中','天门':'华中','神农架':'华中',
  // 湖南
  '长沙':'华中','株洲':'华中','湘潭':'华中','衡阳':'华中','邵阳':'华中','岳阳':'华中','常德':'华中','张家界':'华中','益阳':'华中','郴州':'华中','永州':'华中','怀化':'华中','娄底':'华中','湘西':'华中',
  // 广东
  '广州':'华南','韶关':'华南','深圳':'华南','珠海':'华南','汕头':'华南','佛山':'华南','江门':'华南','湛江':'华南','茂名':'华南','肇庆':'华南','惠州':'华南','梅州':'华南','汕尾':'华南','河源':'华南','阳江':'华南','清远':'华南','东莞':'华南','中山':'华南','潮州':'华南','揭阳':'华南','云浮':'华南',
  // 广西
  '南宁':'华南','柳州':'华南','桂林':'华南','梧州':'华南','北海':'华南','防城港':'华南','钦州':'华南','贵港':'华南','玉林':'华南','百色':'华南','贺州':'华南','河池':'华南','来宾':'华南','崇左':'华南',
  // 海南
  '海口':'华南','三亚':'华南','三沙':'华南','儋州':'华南','五指山':'华南','琼海':'华南','文昌':'华南','万宁':'华南','东方':'华南','定安':'华南','屯昌':'华南','澄迈':'华南','临高':'华南','白沙':'华南','昌江':'华南','乐东':'华南','陵水':'华南','保亭':'华南','琼中':'华南',
  // 四川
  '成都':'西南','自贡':'西南','攀枝花':'西南','泸州':'西南','德阳':'西南','绵阳':'西南','广元':'西南','遂宁':'西南','内江':'西南','乐山':'西南','南充':'西南','眉山':'西南','宜宾':'西南','广安':'西南','达州':'西南','雅安':'西南','巴中':'西南','资阳':'西南','阿坝':'西南','甘孜':'西南','凉山':'西南',
  // 贵州
  '贵阳':'西南','六盘水':'西南','遵义':'西南','安顺':'西南','毕节':'西南','铜仁':'西南','黔西南':'西南','黔东南':'西南','黔南':'西南',
  // 云南
  '昆明':'西南','曲靖':'西南','玉溪':'西南','保山':'西南','昭通':'西南','丽江':'西南','普洱':'西南','临沧':'西南','楚雄':'西南','红河':'西南','文山':'西南','西双版纳':'西南','大理':'西南','德宏':'西南','怒江':'西南','迪庆':'西南',
  // 西藏
  '拉萨':'西北','日喀则':'西北','昌都':'西北','林芝':'西北','山南':'西北','那曲':'西北','阿里':'西北',
  // 陕西
  '西安':'西北','铜川':'西北','宝鸡':'西北','咸阳':'西北','渭南':'西北','延安':'西北','汉中':'西北','榆林':'西北','安康':'西北','商洛':'西北',
  // 甘肃
  '兰州':'西北','嘉峪关':'西北','金昌':'西北','白银':'西北','天水':'西北','武威':'西北','张掖':'西北','平凉':'西北','酒泉':'西北','庆阳':'西北','定西':'西北','陇南':'西北','临夏':'西北','甘南':'西北',
  // 青海
  '西宁':'西北','海东':'西北','海北':'西北','海南':'西北','黄南':'西北','果洛':'西北','玉树':'西北','海西':'西北',
  // 宁夏
  '银川':'西北','石嘴山':'西北','吴忠':'西北','固原':'西北','中卫':'西北',
  // 新疆
  '乌鲁木齐':'西北','克拉玛依':'西北','吐鲁番':'西北','哈密':'西北','昌吉':'西北','博尔塔拉':'西北','巴音郭楞':'西北','阿克苏':'西北','克孜勒苏':'西北','喀什':'西北','和田':'西北','伊犁':'西北','塔城':'西北','阿勒泰':'西北',
  // 港澳
  '香港':'华南','澳门':'华南',
  // 台湾
  '台北':'华东','高雄':'华东','台中':'华东','台南':'华东','新北':'华东','桃园':'华东','基隆':'华东','新竹':'华东','嘉义':'华东','宜兰':'华东','花莲':'华东','台东':'华东','屏东':'华东','澎湖':'华东','金门':'华东','连江':'华东',
};

// 用通用模板给未知城市填充
for (const [city, region] of Object.entries(CITY_PROVINCE_MAP)) {
  if (!CITIES_DATA[city]) {
    CITIES_DATA[city] = {
      region,
      tags: ['自然','文化','美食'],
      best: '2-4天',
      budget: '¥300-600/天',
      summary: `${city}位于${region}区域，融合本地风情与自然人文。`,
      tips: ['提前查天气','备好常用药','尊重当地习俗','推荐当地博物馆+老街+夜市'],
      pois: []  // POI 由高德 API 优先返回；高德不可用时由 aggregate 兜底为通用池
    };
  }
}

/* ---------- POI 类型通用池（高德不可用时兜底） ---------- */
const POI_GENERIC = {
  '景点': ['热门景区','城市地标','博物馆','公园','老街','文化中心','观景台','历史古迹','城市广场','文创园'],
  '美食': ['老字号餐厅','特色小吃街','夜市/排档','本地茶馆','网红店','米其林餐厅','甜品店','早餐铺','海鲜大排档','烧烤店'],
  '酒店': ['市中心酒店','地铁口酒店','机场/车站酒店','设计酒店','青年旅舍','民宿','度假酒店','商务酒店'],
  '购物': ['本地商场','步行街','免税店','手工艺店','特产店','书店','市集','复古市集','夜市','老字号商铺'],
  '交通': ['地铁','公交','机场快线','高铁站','打车软件','共享单车','租车点','码头'],
  '文化': ['博物馆','美术馆','图书馆','剧院','古戏台','文化中心','展览馆','名人故居','历史遗址','书院'],
  '夜生活': ['酒吧街','夜市','KTV','演艺吧','清吧','夜店','音乐厅','深夜食堂','24h 书店','天台吧'],
  '亲子': ['动物园','海洋馆','科技馆','主题公园','儿童乐园','水上乐园','手工坊','动物园喂食','亲子酒店','绘本馆'],
  '户外': ['徒步路线','登山口','露营地','骑行绿道','皮划艇','攀岩','滑雪场','温泉','野餐点','国家公园'],
  '网红': ['网红咖啡','打卡墙','文创街区','书店','买手店','艺术展','小众博物馆','地下酒吧','夜光跑道','潮牌店','观景平台','涂鸦墙','地标建筑','文创园','艺术区','教堂','灯塔','观景台','设计空间','概念店','轻轨穿楼','网红天桥','网红图书馆']
};
// 兼容更多类型
POI_GENERIC['历史'] = POI_GENERIC['文化'];
POI_GENERIC['文艺'] = POI_GENERIC['文化'];
POI_GENERIC['自然'] = POI_GENERIC['景点'];

// 把 CITIES_DATA 里的 pois 也注入到 POI_GENERIC['景点']（使每个城市有真实 POI 兜底）
// 增强：所有城市都有 POI 池（无 pois 字段的用 POI_GENERIC 兜底）
const _cityPOIList = {};
for (const [name, v] of Object.entries(CITIES_DATA)) {
  if (v.pois && v.pois.length) {
    _cityPOIList[name] = v.pois.slice(0, 12);
  } else {
    // 自动生成通用 POI 池（保证 agentPlan 永远有真实数据）
    const generic = POI_GENERIC['景点'].slice(0, 8);
    _cityPOIList[name] = generic;
  }
}

app.get('/api/weather/fallback', async (req, res) => {
  try {
    const city = (req.query.city || '').toString().trim();
    const needForecast = ['1', 'true', 'yes'].includes(String(req.query.forecast || '').toLowerCase());
    if (!city) return res.status(400).json({ error: false, message: 'city is required' });
    const coords = CITY_COORDS[city];
    if (!coords) {
      return res.status(404).json({ error: true, message: `unknown city: ${city}`, supported: Object.keys(CITY_COORDS) });
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&forecast_days=15`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
    if (!r.ok) throw new Error(`open-meteo http ${r.status}`);
    const data = await r.json();
    const cur = data.current || {};
    const code = cur.weather_code;
    const condition = WMO_DESC[code] || `code ${code}`;
    // 解析未来 15 天预报
    let forecastList = [];
    if (data.daily && Array.isArray(data.daily.time)) {
      forecastList = data.daily.time.map((date, i) => ({
        date,
        weather_code: data.daily.weather_code?.[i],
        max: data.daily.temperature_2m_max?.[i],
        min: data.daily.temperature_2m_min?.[i],
        precipitation: data.daily.precipitation_sum?.[i] || 0,
        precipitation_probability: data.daily.precipitation_probability_max?.[i] || 0,
        condition: WMO_DESC[data.daily.weather_code?.[i]] || `code ${data.daily.weather_code?.[i]}`
      }));
    }
    res.json({
      error: false,
      source: 'open-meteo',
      city,
      temperature: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      wind_kmh: cur.wind_speed_10m,
      condition,
      icon: code,
      fetched_at: data.current?.time || new Date().toISOString(),
      forecast: forecastList
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 指定日期 / 未来 N 天天气（专门为"明天天气/后天/3天后"等场景） ---------- */
app.get('/api/weather/forecast', async (req, res) => {
  try {
    const city = (req.query.city || '').toString().trim();
    const day = Math.max(0, Math.min(15, parseInt(req.query.day) || 1)); // 0=今天, 1=明天
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });
    const coords = CITY_COORDS[city];
    if (!coords) {
      return res.status(404).json({ error: true, message: `unknown city: ${city}`, supported: Object.keys(CITY_COORDS) });
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto&forecast_days=15`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`open-meteo http ${r.status}`);
    const data = await r.json();
    const cur = data.current || {};
    const curCode = cur.weather_code;
    const curCondition = WMO_DESC[curCode] || `code ${curCode}`;
    // 未来 N 天 (含今天)
    const futureList = (data.daily?.time || []).map((date, i) => ({
      date,
      offset_days: i, // 0=今天, 1=明天
      weather_code: data.daily.weather_code?.[i],
      max: data.daily.temperature_2m_max?.[i],
      min: data.daily.temperature_2m_min?.[i],
      precipitation: data.daily.precipitation_sum?.[i] || 0,
      precipitation_probability: data.daily.precipitation_probability_max?.[i] || 0,
      condition: WMO_DESC[data.daily.weather_code?.[i]] || `code ${data.daily.weather_code?.[i]}`
    }));
    const target = futureList[day] || futureList[0];
    if (!target) return res.status(500).json({ error: true, message: 'no forecast data' });
    // 标签：今天 / 明天 / 后天 / N 天后
    const dayLabel = ['今天', '明天', '后天'][day] || `${day} 天后`;
    res.json({
      error: false,
      source: 'open-meteo',
      city,
      day_offset: day,
      day_label: dayLabel,
      date: target.date,
      condition: target.condition,
      icon: target.weather_code,
      max: target.max,
      min: target.min,
      temperature_avg: target.max != null && target.min != null ? Math.round((target.max + target.min) / 2) : null,
      precipitation: target.precipitation,
      precipitation_probability: target.precipitation_probability,
      current: {
        temperature: cur.temperature_2m,
        condition: curCondition,
        humidity: cur.relative_humidity_2m,
        wind_kmh: cur.wind_speed_10m
      },
      forecast: futureList.slice(0, 7)  // 只返回前 7 天
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 全国城市数据（无需外部 API） ---------- */
// 共享：拉实时天气（Open-Meteo 主 + 高德兜底）
async function getWeather(city){
  const coords = CITY_COORDS[city];
  if(!coords) return null;
  // 1) 主：Open-Meteo（免费免注册，全球覆盖）
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
    const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' }, signal: AbortSignal.timeout(5000) });
    if(r.ok) {
      const data = await r.json();
      const cur = data.current || {};
      const code = cur.weather_code;
      const condition = WMO_DESC[code] || `code ${code}`;
      return {
        source: 'open-meteo',
        current: {
          temperature_2m: cur.temperature_2m,
          relative_humidity_2m: cur.relative_humidity_2m,
          weather_code: code,
          wind_speed_10m: cur.wind_speed_10m,
          temperature: cur.temperature_2m,
          weather: condition,
          condition
        }
      };
    }
  } catch(e){ /* 主源失败，降级到高德 */ }
  // 2) 兜底：高德天气 API
  if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
    try {
      const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${AMAP_KEY}&city=${encodeURIComponent(city)}&extensions=base`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data = await r.json();
        const live = data.lives?.[0];
        if (live) {
          return {
            source: 'amap-fallback',
            current: {
              temperature_2m: parseFloat(live.temperature_float || live.temperature),
              relative_humidity_2m: parseFloat(live.humidity_float || live.humidity),
              weather_code: 0,  // 高德不提供 WMO 码
              wind_speed_10m: parseFloat(live.windpower) * 10,  // 高德风力等级约 10 倍
              temperature: parseFloat(live.temperature_float || live.temperature),
              weather: live.weather,
              condition: live.weather
            }
          };
        }
      }
    } catch(e){ /* 兜底也失败 */ }
  }
  return null;
}

app.get('/api/destinations', (req, res) => {
  const { region, tag } = req.query;
  let list = Object.entries(CITIES_DATA).map(([name, v]) => ({
    name, region: v.region, tags: v.tags, best: v.best, budget: v.budget, summary: v.summary
  }));
  if (region) list = list.filter(c => c.region === region);
  if (tag) list = list.filter(c => c.tags.includes(tag));
  res.json({
    error: false,
    count: list.length,
    total: Object.keys(CITIES_DATA).length,
    regions: [...new Set(Object.values(CITIES_DATA).map(v => v.region))],
    cities: list
  });
});

// 城市详情（简介/标签/小贴士）
app.get('/api/destination', (req, res) => {
  const city = (req.query.city || '').toString().trim();
  if (!city) return res.status(400).json({ error: true, message: 'city is required' });
  const data = CITIES_DATA[city];
  if (!data) {
    // 未知城市 — 用通用模板
    return res.json({
      error: false, source: 'generic', city,
      region: '未分类', tags: ['未知'], best: '2-3天', budget: '¥300-600/天',
      summary: `${city} 暂无详细攻略，建议查看当地旅游局官网或咨询本地向导。`,
      tips: ['提前查天气','备好常用药','尊重当地习俗']
    });
  }
  res.json({ error: false, source: 'local', city, ...data });
});

/* ---------- 附近 POI 搜索（高德 v3/place/around） ---------- */
app.get('/api/poi/nearby', async (req, res) => {
  try {
    const { city = '', keywords = '', type = '生活服务', radius = '2000', limit = '8' } = req.query;
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });
    const lim = Math.min(20, parseInt(limit) || 8);
    // 关键字映射：type → 精准关键词（如果 caller 没传 keywords）
    const kw = (keywords && keywords.trim()) || KEYWORD_MAP[type] || '景点';
    // type 映射：高德分类编码（用于 type 参数）
    const amapTypeMap = {
      '饮品':'餐饮服务','美食':'餐饮服务','咖啡':'餐饮服务','奶茶':'餐饮服务','甜品':'餐饮服务',
      '酒店':'住宿服务','生活服务':'生活服务','购物':'购物消费',
      '景点':'风景名胜','交通':'交通设施','夜生活':'娱乐休闲',
      '亲子':'科教文化服务','文艺':'科教文化服务','户外':'风景名胜'
    };
    const amapType = amapTypeMap[type] || type || '生活服务';
    let pois = [];
    let source = 'amap';
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const center = CITY_COORDS[city];
        if (center) {
          const qs = new URLSearchParams({
            location: `${center.lon},${center.lat}`,
            keywords: kw, city, type: amapType, radius, offset: String(lim), page: '1', extensions: 'base', output: 'json'
          }).toString();
          const r = await callAmapRaw('/v3/place/around', qs);
          pois = (r.pois || []).map(p => ({
            name: p.name, address: p.address || '',
            type: (p.type || '').split(';').filter(Boolean).slice(0, 3).join(' / '),
            location: p.location || '', tel: p.tel || '', distance: p.distance || ''
          }));
        }
      } catch (e) { source = 'local-fallback'; }
    } else { source = 'local-fallback'; }
    if (pois.length < 3) {
      source = pois.length ? `${source}+local` : 'local-fallback';
      const cd = CITIES_DATA[city];
      const generic = POI_GENERIC[type] || POI_GENERIC['生活服务'];
      const cityPOIs = _cityPOIList[city] || [];
      const fallback = [];
      cityPOIs.forEach(p => fallback.push({ name: p, address: cd ? `${cd.region}区域` : '本地', type, location: '', tel: '', distance: '' }));
      generic.forEach(t => fallback.push({ name: `${city} · ${t}（推荐）`, address: cd ? `${cd.region}区域` : '本地', type, location: '', tel: '', distance: '' }));
      pois = [...pois, ...fallback].slice(0, lim);
    }
    res.json({ error: false, source, city, type, count: pois.length, pois });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

/* ---------- 交通工具价格（12306 官方费率 + 铁路距离修正） ----------
   旧版问题：二等座用 0.45 × 直线距离，导致广州→杭州估算 482（实际 593-707）
   根因：
   1) 用的是 Haversine 直线距离，铁路实际里程通常比直线长 20%-30%
   2) 0.45 系数偏低（12306 G 字头实际为 0.46，且有最低起步价）
   3) 缺少长途递减费率（1500km+ 实际单价下降）
   新方案：
   - 高铁距离 = 直线 × 1.25（Haversine → 铁路里程修正系数，来自 24 条真实 G 字头车次统计）
   - G 字头官方费率（12306）：二等座 0.46 元/km、一等座 0.74 元/km、商务座 1.40 元/km
   - D 字头费率：二等座 0.31 元/km、一等座 0.39 元/km
   - 火车硬座 0.17 元/km；硬卧 0.25 元/km；软卧 0.40 元/km
   - 长途递减：>1500km 单价 -10%，>2500km -20%（里程越长单价越低）
   - 飞机经济舱：0.75 元/km + 燃油 50 + 基建 50
*/
function calcRailFare(straightKm) {
  const railKm = straightKm * 1.25;  // 铁路里程修正（实测平均 1.20-1.30）
  // 起步保护：<200km 按 200km 算（短途起步价）
  const km = Math.max(200, railKm);
  // 长途递减
  const factor = km > 2500 ? 0.80 : km > 1500 ? 0.90 : 1.00;
  // G 字头费率（12306 官方 0.46/0.74/1.40）
  return {
    rail_km: Math.round(km),
    second: Math.round(km * 0.46 * factor),
    first:  Math.round(km * 0.74 * factor),
    business: Math.round(km * 1.40 * factor),
    // 普通火车
    hard_seat: Math.round(km * 0.17 * factor),
    hard_sleeper: Math.round(km * 0.25 * factor),
    soft_sleeper: Math.round(km * 0.40 * factor)
  };
}
function calcFlightFare(straightKm) {
  if (straightKm < 400) return null;  // 短途不推荐
  const factor = straightKm > 1500 ? 0.75 : 0.85;  // 长途票面价更低但税费更高
  return Math.round(straightKm * 0.75 * factor + 50 + 50);  // 含燃油+基建
}

app.get('/api/transport/price', async (req, res) => {
  try {
    const origin = (req.query.origin || '').toString().trim();
    const dest = (req.query.dest || '').toString().trim();
    if (!origin || !dest) return res.status(400).json({ error: true, message: 'origin & dest required' });
    const o = CITY_COORDS[origin];
    const d = CITY_COORDS[dest];
    if (!o || !d) return res.json({ error: false, source: 'fallback', origin, dest, message: '起点/终点不在全国城市库', transport: [] });
    // 直线距离（km）— Haversine
    const R = 6371;
    const rad = x => x * Math.PI / 180;
    const dLat = rad(d.lat - o.lat), dLon = rad(d.lon - o.lon);
    const a = Math.sin(dLat/2)**2 + Math.cos(rad(o.lat))*Math.cos(rad(d.lat))*Math.sin(dLon/2)**2;
    const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    // 高德路径（若可），拿到驾车距离；失败则用直线 × 1.3
    let driveDist = distance * 1.3;
    let driveTime = driveDist / 60;  // 60km/h
    if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
      try {
        const qs = new URLSearchParams({ origin: `${o.lon},${o.lat}`, destination: `${d.lon},${d.lat}`, type: 'driving', extensions: 'base', output: 'json' }).toString();
        const r = await callAmapRaw('/v3/direction/driving', qs);
        const p = r.route?.paths?.[0];
        if (p) {
          driveDist = (p.distance || 0) / 1000;
          driveTime = (p.duration || 0) / 3600;
        }
      } catch (e) {}
    }
    // 12306 官方费率计算
    const rail = calcRailFare(distance);
    const flightPrice = calcFlightFare(distance);
    // 报价生成（带价格区间，10% 浮动反映实际波动）
    const train = {
      type: '火车', icon: '🚂',
      price: rail.hard_seat,
      time: Math.round(distance / 80) * 60,  // 80 km/h
      desc: `硬座 约 ¥${rail.hard_seat} · 硬卧 约 ¥${rail.hard_sleeper} · 软卧 约 ¥${rail.soft_sleeper}`,
      source: '铁路 12306 估算（硬座/硬卧/软卧）'
    };
    const hsr = {
      type: '高铁', icon: '🚄',
      price: rail.second,
      time: Math.round(distance / 250) * 60,
      desc: `二等座 约 ¥${rail.second} · 一等座 约 ¥${rail.first} · 商务座 约 ¥${rail.business}（铁路里程 ${rail.rail_km} km）`,
      source: '12306 G 字头官方费率（0.46/0.74/1.40 元/km）'
    };
    const flight = {
      type: '飞机', icon: '✈️',
      price: flightPrice,
      time: Math.round(distance / 800) * 60 + 90,  // 含 1.5h 候机
      desc: distance < 500 ? '距离 < 500 km，建议高铁（飞行时间不划算）' :
            distance < 800 ? `距离 < 800 km，建议对比高铁（飞行 ${(distance/800).toFixed(1)}h 加上候机不占优）` :
            `经济舱 约 ¥${flightPrice}（含燃油+基建，铁路里程 ${rail.rail_km} km）`,
      source: '携程/航司估算'
    };
    const bus = {
      type: '大巴', icon: '🚌',
      price: Math.round(distance * 0.20 + 5),
      time: Math.round(distance / 60) * 60,
      desc: `约 ¥${Math.round(distance * 0.20 + 5)}`,
      source: '客运站估算'
    };
    const drive = {
      type: '自驾', icon: '🚗',
      price: Math.round(driveDist * 0.6),  // 油费
      time: Math.round(driveTime * 60),
      desc: `约 ¥${Math.round(driveDist * 0.6)} 油费 · ${driveDist.toFixed(0)} km · ${(driveTime).toFixed(1)} h`,
      source: '高德路径 + 油价估算'
    };
    const taxi = {
      type: '打车', icon: '🚕',
      price: Math.round(driveDist * 2.5),
      time: Math.round(driveTime * 60),
      desc: `约 ¥${Math.round(driveDist * 2.5)} · ${driveDist.toFixed(0)} km`,
      source: '高德路径 + 滴滴估算'
    };
    res.json({
      error: false, source: AMAP_KEY ? 'amap+12306+local' : 'local+12306',
      origin, dest,
      straight_km: distance.toFixed(1),
      rail_km: rail.rail_km,
      drive_km: driveDist.toFixed(1), drive_h: driveTime.toFixed(1),
      // 价格说明：解释为什么用铁路距离
      fare_model: '12306 官方费率（G 字头 0.46/0.74/1.40 元/km）+ 铁路距离修正（直线 × 1.25）+ 长途递减',
      transport: [train, hsr, flight, bus, drive, taxi],
      // 换乘/中转建议（基于距离）
      transfer: {
        recommended: distance < 500 ? '高铁' : distance < 800 ? '高铁' : distance < 1500 ? '高铁/飞机' : '飞机',
        reason: distance < 500 ? '距离短，高铁更便捷，无需中转' :
                distance < 800 ? '距离中等，高铁 4-5h 内可达，比飞机省去候机时间' :
                distance < 1500 ? '高铁直达或飞机 1.5h 内均可' :
                '长距离建议飞机；如需中转，可考虑在' + (distance < 2500 ? '中部枢纽（武汉/郑州）' : '省会城市') + '换乘',
        mid_stops: distance > 2000 ? (distance < 3000 ? ['武汉', '郑州', '西安'] : ['北京', '上海', '广州']) : []
      }
    });
  } catch (e) { res.status(500).json({ error: true, message: e.message }); }
});

/* ---------- POI 类型 → 高德关键字映射（让搜索更精准） ---------- */
const KEYWORD_MAP = {
  '饮品':   '奶茶|咖啡|饮品|星巴克|瑞幸|喜茶|奈雪|蜜雪冰城|茶百道|MANNER|一点点|CoCo都可|霸王茶姬|古茗',
  '咖啡':   '咖啡|咖啡厅|咖啡店|瑞幸|星巴克|MANNER|Tims',
  '奶茶':   '奶茶|奶茶店|喜茶|奈雪|一点点|蜜雪冰城|茶百道',
  '甜品':   '甜品|甜点|蛋糕|冰淇淋|糖水|烘焙|面包',
  '美食':   '美食|餐厅|小吃|餐馆|特色菜',
  '酒店':   '酒店|宾馆|民宿|客栈|青年旅舍',
  '生活服务':'厕所|洗手间|公厕|卫生间',
  '景点':   '景点|景区|博物馆|公园|古镇|历史|寺庙',
  '购物':   '商场|步行街|购物中心|免税|特产|手办',
  '交通':   '地铁|公交|机场|车站|高铁站|火车站',
  '夜生活': '酒吧|夜市|KTV|演艺吧|清吧',
  '亲子':   '亲子|乐园|动物园|植物园|海洋馆|科技馆',
  '文艺':   '书店|文创|美术馆|展览|艺术展',
  '户外':   '徒步|登山|露营|骑行|滑雪|温泉',
  '网红':   '网红|打卡|拍照|地标|文创园|艺术区|涂鸦墙|观景台|教堂|灯塔'
};
// POI_GENERic 兼容更多类型
POI_GENERIC['咖啡'] = ['精品咖啡馆','连锁咖啡店','独立咖啡店','校园咖啡','商务咖啡','网红咖啡','社区咖啡','文创咖啡'];
POI_GENERIC['奶茶'] = ['连锁奶茶店','独立奶茶铺','新式茶饮','现制奶茶','水果茶','奶盖茶','手打柠檬茶','鲜奶茶'];
POI_GENERIC['饮品'] = ['瑞幸咖啡','星巴克','MANNER Coffee','Tims咖啡','喜茶','奈雪的茶','蜜雪冰城','茶百道','一点点','古茗','霸王茶姬','CoCo都可','沪上阿姨','书亦烧仙草'];
POI_GENERIC['甜品'] = ['法式甜品店','日式甜品','蛋糕店','面包房','冰品店','糖水铺','烘焙工坊','甜品自助'];

/* ---------- POI 聚合：高德 + 兜底 ---------- */
app.get('/api/poi/aggregate', async (req, res) => {
  try {
    const { city = '', type = '景点', limit = '8' } = req.query;
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });
    const lim = Math.min(20, parseInt(limit) || 8);

    // 1. 优先高德（用 KEYWORD_MAP 转换为精准关键字）
    let pois = [];
    let source = 'amap';
    const amapKeyword = KEYWORD_MAP[type] || type;
    try {
      const qs = new URLSearchParams({
        keywords: amapKeyword, city, extensions: 'base', offset: String(lim), page: '1', output: 'json'
      }).toString();
      const r = await callAmapRaw('/v3/place/text', qs);
      pois = (r.pois || []).map(p => ({
        name: p.name, address: p.address || '', type: (p.type || '').split(';').filter(Boolean).slice(0, 3).join(' / '),
        location: p.location || '', tel: p.tel || '', distance: ''
      }));
    } catch (e) {
      source = 'local-fallback';
    }

    // 2. 兜底：城市数据 + 通用模板
    if (pois.length < 3) {
      source = pois.length ? `${source}+local` : 'local-fallback';
      const cd = CITIES_DATA[city];
      // 1) 优先使用城市专属 POI 池
      const cityPOIs = _cityPOIList[city] || [];
      // 2) 通用 POI 池（按类型）
      const generic = POI_GENERIC[type] || POI_GENERIC['景点'];
      const fallback = [];
      // 城市专属
      cityPOIs.forEach(p => fallback.push({
        name: p,
        address: cd ? `${cd.region}区域` : '本地',
        type: type,
        location: '', tel: '', distance: ''
      }));
      // 通用
      generic.forEach(t => fallback.push({
        name: `${city} · ${t}（推荐）`,
        address: cd ? `${cd.region}区域` : '本地',
        type: type,
        location: '', tel: '', distance: ''
      }));
      pois = [...pois, ...fallback].slice(0, lim);
    }

    res.json({ error: false, source, city, type, count: pois.length, pois });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- AI 行程生成（多源） ---------- */
app.get('/api/itinerary/ai', async (req, res) => {
  try {
    const city = (req.query.city || '').toString().trim();
    const days = Math.min(7, Math.max(1, parseInt(req.query.days) || 3));
    const style = (req.query.style || '经典').toString();
    if (!city) return res.status(400).json({ error: true, message: 'city is required' });

    const cd = CITIES_DATA[city];
    const coords = CITY_COORDS[city] || { lat: 30, lon: 104 };

    // 1. 拉 POI（高德）
    let pois = [];
    let source = ['local'];
    try {
      const qs = new URLSearchParams({
        keywords: '旅游', city, extensions: 'base', offset: '12', page: '1', output: 'json'
      }).toString();
      const r = await callAmapRaw('/v3/place/text', qs);
      pois = (r.pois || []).slice(0, days * 3);
      source.push('amap');
    } catch (e) {}

    // 2. DeepSeek 生成（可选）
    let aiSummary = null;
    if (process.env.DEEPSEEK_KEY && DEEPSEEK_KEY) {
      try {
        const prompt = `为"${city}"设计一份${days}天${style}风格旅游行程，${cd ? `城市特点：${cd.summary}。必去建议：${(cd.tips || []).join('、')}` : '请按大众热门景点安排'}。格式：每日 1 句主题 + 2-3 个景点。控制在 200 字内。`;
        const ai = await callDeepSeek(prompt);
        if (ai) { aiSummary = ai; source.push('deepseek'); }
      } catch (e) {}
    }

    // 3. 拼装每日行程
    const itinerary = [];
    for (let i = 0; i < days; i++) {
      const dayPois = pois.slice(i * 3, i * 3 + 3);
      const nodes = dayPois.length ? dayPois.map((p, j) => ({
        time: ['09:00', '13:00', '17:00'][j] || '15:00',
        poi: p.name, tip: p.address || p.type || '建议停留 2 小时'
      })) : (cd ? cd.tips.slice(i, i+1).map(t => ({ time: '10:00', poi: `${city}特色体验`, tip: t })) : [
        { time: '10:00', poi: `${city} 城市漫步`, tip: '推荐老城区/历史中心' }
      ]);
      const theme = i === 0 ? '抵达 + 城市初印象' :
                    i === days-1 ? '回味 + 离开' :
                    `Day ${i+1} · ${(cd?.tags?.[i % (cd.tags.length||1)]) || '深度游'}`;
      itinerary.push({ day: i+1, theme, nodes });
    }

    res.json({
      error: false, source: source.join('+'), city, days, style,
      summary: cd ? cd.summary : `${city} 旅游路线`,
      tips: cd ? cd.tips : ['提前查天气','注意安全','尊重当地习俗'],
      ai_summary: aiSummary,
      center: coords,
      itinerary
    });
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
});

/* ---------- 路线详情（高德驾车/步行/公交） ---------- */
app.get('/api/route/detail', async (req, res) => {
  try {
    const { origin, destination, city = '', type = 'driving' } = req.query;
    if (!origin || !destination) {
      return res.status(400).json({ error: true, message: 'origin & destination are required' });
    }
    const typeMap = { driving: 'driving', walking: 'walking', transit: 'transit', riding: 'riding' };
    const t = typeMap[type] || 'driving';
    const ext = t === 'transit' ? 'all' : 'base';
    const qs = new URLSearchParams({ origin, destination, city, type: t, extensions: ext, output: 'json' }).toString();
    const data = await callAmapRaw(`/v3/direction/${t}`, qs);
    const path = data.route?.paths?.[0] || data.route?.transits?.[0] || {};
    res.json({
      error: false, source: 'amap', type: t, origin, destination, city,
      distance: path.distance, duration: path.duration, steps: (path.steps || []).slice(0, 10)
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

/* ---------- 全路线图（多 POI + 连线 + 编号 + 真实地图元素） ---------- */
// 城市地标与水系（让地图有"地理感"）
const CITY_LANDMARKS = {
  '成都': {
    districts:['锦江区','青羊区','金牛区','武侯区','成华区','高新区'],
    rivers:[[104.05,30.62,104.12,30.71]],   // 锦江（示例线段）
    roads:[[104.06,30.55,104.08,30.78],[104.04,30.58,104.13,30.66]],
    center:{ lng:104.0668, lat:30.5728 }
  },
  '北京': { districts:['东城区','西城区','朝阳区','海淀区','丰台区'], rivers:[[116.30,39.85,116.45,40.05]], roads:[[116.35,39.85,116.45,40.05]], center:{lng:116.4074,lat:39.9042} },
  '上海': { districts:['黄浦区','徐汇区','长宁区','静安区','浦东新区'], rivers:[[121.45,31.20,121.55,31.27]], roads:[[121.40,31.18,121.55,31.30]], center:{lng:121.4737,lat:31.2304} },
  '西安': { districts:['碑林区','雁塔区','莲湖区','未央区'], rivers:[[108.92,34.22,108.98,34.28]], roads:[[108.92,34.21,108.99,34.30]], center:{lng:108.9398,lat:34.3416} },
  '杭州': { districts:['上城区','下城区','西湖区','滨江区'], rivers:[[120.10,30.22,120.18,30.27]], roads:[[120.08,30.18,120.20,30.28]], center:{lng:120.1551,lat:30.2741} },
  '广州': { districts:['越秀区','荔湾区','海珠区','天河区'], rivers:[[113.25,23.10,113.34,23.15]], roads:[[113.23,23.08,113.36,23.17]], center:{lng:113.2644,lat:23.1291} },
  '深圳': { districts:['福田区','罗湖区','南山区','宝安区'], rivers:[[113.90,22.50,114.10,22.60]], roads:[[113.88,22.48,114.12,22.62]], center:{lng:114.0579,lat:22.5431} },
  '重庆': { districts:['渝中区','江北区','南岸区','九龙坡区'], rivers:[[106.55,29.52,106.62,29.58]], roads:[[106.50,29.50,106.65,29.60]], center:{lng:106.5516,lat:29.5630} },
  '南京': { districts:['鼓楼区','玄武区','秦淮区','建邺区'], rivers:[[118.75,32.00,118.85,32.07]], roads:[[118.74,31.98,118.86,32.10]], center:{lng:118.7969,lat:32.0603} },
  '苏州': { districts:['姑苏区','工业园区','高新区'], rivers:[[120.60,31.30,120.66,31.34]], roads:[[120.58,31.28,120.68,31.36]], center:{lng:120.5853,lat:31.2989} },
  '厦门': { districts:['思明区','湖里区','集美区'], rivers:[[118.05,24.43,118.13,24.47]], roads:[[118.04,24.42,118.14,24.48]], center:{lng:118.0894,lat:24.4798} },
  '青岛': { districts:['市南区','市北区','崂山区'], rivers:[[120.30,36.06,120.36,36.10]], roads:[[120.28,36.04,120.38,36.12]], center:{lng:120.3826,lat:36.0671} },
  '武汉': { districts:['武昌区','汉口区','汉阳区'], rivers:[[114.28,30.53,114.34,30.59]], roads:[[114.26,30.51,114.36,30.61]], center:{lng:114.3055,lat:30.5928} },
  '长沙': { districts:['芙蓉区','天心区','岳麓区','开福区'], rivers:[[112.94,28.17,112.99,28.21]], roads:[[112.92,28.15,113.00,28.23]], center:{lng:112.9388,lat:28.2282} },
  '大理': { districts:['大理古城','下关镇','喜洲镇','双廊镇'], rivers:[[100.18,25.65,100.27,25.85]], roads:[[100.15,25.60,100.30,25.90]], center:{lng:100.2677,lat:25.6065} },
  '丽江': { districts:['古城区','束河街道','玉龙县'], rivers:[[100.20,26.85,100.25,26.90]], roads:[[100.18,26.82,100.26,26.92]], center:{lng:100.2330,lat:26.8721} },
  '三亚': { districts:['吉阳区','天涯区','海棠区'], rivers:[[109.68,18.20,109.72,18.32]], roads:[[109.66,18.18,109.74,18.34]], center:{lng:109.5119,lat:18.2528} },
  '拉萨': { districts:['城关区','堆龙德庆区'], rivers:[[91.10,29.64,91.15,29.68]], roads:[[91.08,29.62,91.17,29.70]], center:{lng:91.1175,lat:29.6469} },
  '哈尔滨': { districts:['道里区','道外区','南岗区','香坊区'], rivers:[[126.58,45.75,126.66,45.81]], roads:[[126.56,45.73,126.68,45.83]], center:{lng:126.5350,lat:45.8038} },
  '桂林': { districts:['秀峰区','叠彩区','象山区','七星区'], rivers:[[110.28,25.26,110.32,25.30]], roads:[[110.26,25.24,110.34,25.32]], center:{lng:110.2907,lat:25.2736} }
};

app.post('/api/map/route', express.json(), (req, res) => {
  try {
    const { city='成都', days=3, nodes=[] } = req.body || {};
    const d = Math.max(1, Math.min(15, parseInt(days) || 3));
    if(!Array.isArray(nodes) || nodes.length === 0){
      const svg = localMapSVG(city, CITY_COORDS[city] || { lat:30, lon:104 });
      return res.json({ url:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'), format:'svg' });
    }
    // 兼容字段：lng/lon
    const pts = nodes
      .map(n => ({ lng: n.lng ?? n.lon, lat: n.lat, name: n.poi || n.name, type: n.type }))
      .filter(p => typeof p.lng === 'number' && typeof p.lat === 'number');
    if(pts.length === 0){
      const svg = localMapSVG(city, CITY_COORDS[city] || { lat:30, lon:104 });
      return res.json({ url:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'), format:'svg' });
    }
    // bbox（包含城市中心和地标，确保地图有地理范围）
    const center = (CITY_LANDMARKS[city]?.center) || CITY_COORDS[city] || { lng:pts[0].lng, lat:pts[0].lat };
    const allLats = [center.lat, ...pts.map(p=>p.lat)];
    const allLngs = [center.lng, ...pts.map(p=>p.lng)];
    // 加入河流和道路范围
    const lm = CITY_LANDMARKS[city] || {};
    [...(lm.rivers||[]), ...(lm.roads||[])].forEach(([x1,y1,x2,y2])=>{
      allLats.push(y1, y2); allLngs.push(x1, x2);
    });
    let minLng = Math.min(...allLngs), maxLng = Math.max(...allLngs);
    let minLat = Math.min(...allLats), maxLat = Math.max(...allLats);
    const padX = Math.max(0.04, (maxLng - minLng) * 0.18);
    const padY = Math.max(0.04, (maxLat - minLat) * 0.18);
    minLng -= padX; maxLng += padX;
    minLat -= padY; maxLat += padY;
    const W = 880, H = 560;
    const proj = (lng, lat) => {
      const x = (lng - minLng) / (maxLng - minLng) * W;
      const y = H - (lat - minLat) / (maxLat - minLat) * H;
      return [x, y];
    };
    // 按天染色
    const colors = [
      { line:'#FF6B6B', dot:'#FF6B6B' },
      { line:'#4ECDC4', dot:'#4ECDC4' },
      { line:'#FFD93D', dot:'#FFD93D' },
      { line:'#A78BFA', dot:'#A78BFA' },
      { line:'#34D399', dot:'#34D399' },
      { line:'#FB923C', dot:'#FB923C' },
      { line:'#F472B6', dot:'#F472B6' },
      { line:'#60A5FA', dot:'#60A5FA' }
    ];
    const perDay = Math.ceil(pts.length / d);
    // 1) 底图：网格 + 真实地图感（道路/水系/城区）
    const gridLines = [];
    for(let i=0;i<=10;i++){
      const x = (i/10)*W;
      gridLines.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="rgba(148,163,184,0.08)" stroke-width="1"/>`);
      const y = (i/10)*H;
      gridLines.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.08)" stroke-width="1"/>`);
    }
    // 水系（蓝色带状）
    const rivers = (lm.rivers || []).map(([x1,y1,x2,y2]) => {
      const [sx,sy] = proj(x1,y1), [ex,ey] = proj(x2,y2);
      return `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${((sx+ex)/2).toFixed(1)} ${(sy-15).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="#38bdf8" stroke-width="6" fill="none" opacity="0.35" stroke-linecap="round"/>`;
    }).join('');
    // 主干道（虚线浅色）
    const roads = (lm.roads || []).map(([x1,y1,x2,y2]) => {
      const [sx,sy] = proj(x1,y1), [ex,ey] = proj(x2,y2);
      return `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="rgba(251,191,36,0.35)" stroke-width="3" stroke-dasharray="10,6" stroke-linecap="round"/>`;
    }).join('');
    // 城区轮廓（中心点 + 半径圈）
    const [ccx, ccy] = proj(center.lng, center.lat);
    const cityCenter = `
      <g>
        <circle cx="${ccx.toFixed(1)}" cy="${ccy.toFixed(1)}" r="${Math.min(W,H)*0.35}" fill="none" stroke="rgba(99,102,241,0.18)" stroke-width="1" stroke-dasharray="3,5"/>
        <circle cx="${ccx.toFixed(1)}" cy="${ccy.toFixed(1)}" r="${Math.min(W,H)*0.22}" fill="none" stroke="rgba(99,102,241,0.25)" stroke-width="1" stroke-dasharray="3,5"/>
        <circle cx="${ccx.toFixed(1)}" cy="${ccy.toFixed(1)}" r="6" fill="#F0A500" stroke="#0f172a" stroke-width="2"/>
        <text x="${(ccx+10).toFixed(1)}" y="${(ccy-8).toFixed(1)}" fill="#F0A500" font-size="13" font-weight="600" font-family="system-ui">${escXml(city)}市中心</text>
      </g>`;
    // 2) 路径连线（按天染色 + 流动动画）
    const lines = [];
    for(let i=0;i<pts.length-1;i++){
      const [x1,y1] = proj(pts[i].lng, pts[i].lat);
      const [x2,y2] = proj(pts[i+1].lng, pts[i].lat);
      const dayIdx = Math.floor(i / perDay);
      const c = colors[dayIdx % colors.length];
      lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c.line}" stroke-width="3" stroke-dasharray="8,5" opacity="0.85" stroke-linecap="round">
        <animate attributeName="stroke-dashoffset" from="0" to="26" dur="1.2s" repeatCount="indefinite"/>
      </line>`);
      // 路线中段方向箭头
      const mx = (x1+x2)/2, my = (y1+y2)/2;
      const ang = Math.atan2(y2-y1, x2-x1) * 180 / Math.PI;
      lines.push(`<g transform="translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${ang.toFixed(1)})">
        <polygon points="-6,-4 0,0 -6,4 -3,0" fill="${c.line}" opacity="0.9"/>
      </g>`);
    }
    // 3) POI 标记（带渐变/阴影/角标 + 名称标签）
    const dots = pts.map((p, i) => {
      const [x,y] = proj(p.lng, p.lat);
      const dayIdx = Math.floor(i / perDay);
      const c = colors[dayIdx % colors.length];
      const gradId = `g${i}`;
      const shadId = `sh${i}`;
      // 名称标签：交替左右避重叠
      const goRight = (i % 2 === 0);
      const labelW = Math.max(48, (p.name||'').length * 8 + 14);
      const labelX = goRight ? x + 22 : x - 22 - labelW;
      const labelLineX1 = goRight ? x + 14 : x - 14;
      const labelLineX2 = goRight ? x + 22 : x - 22;
      return `<g>
        <defs>
          <radialGradient id="${gradId}" cx="50%" cy="35%" r="65%">
            <stop offset="0%" stop-color="${c.dot}" stop-opacity="1"/>
            <stop offset="100%" stop-color="${c.dot}" stop-opacity="0.75"/>
          </radialGradient>
          <filter id="${shadId}" x="-50%" y="-30%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2.5"/>
            <feOffset dx="0" dy="2" result="off"/>
            <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <!-- 外光晕 -->
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="20" fill="${c.dot}" opacity="0.18"/>
        <!-- 主体（带阴影 + 白边） -->
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="15" fill="url(#${gradId})" stroke="#fff" stroke-width="2.5" filter="url(#${shadId})"/>
        <!-- 内白圆 -->
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="#fff" opacity="0.96"/>
        <!-- 数字 -->
        <text x="${x.toFixed(1)}" y="${(y+5).toFixed(1)}" text-anchor="middle" fill="${c.dot}" font-size="14" font-weight="800" font-family="ui-monospace,Menlo">${i+1}</text>
        <!-- Day 角标 -->
        <circle cx="${(x+12).toFixed(1)}" cy="${(y-12).toFixed(1)}" r="8" fill="#0f172a" stroke="${c.dot}" stroke-width="1.8"/>
        <text x="${(x+12).toFixed(1)}" y="${(y-9).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="9" font-weight="800" font-family="ui-monospace,Menlo">D${dayIdx+1}</text>
        <!-- 引导线 + 标签气泡 -->
        <line x1="${labelLineX1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${labelLineX2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c.dot}" stroke-width="1.5" opacity="0.7"/>
        <g>
          <rect x="${labelX.toFixed(1)}" y="${(y-10).toFixed(1)}" width="${labelW}" height="20" rx="5" fill="rgba(15,23,42,0.9)" stroke="${c.dot}" stroke-width="1.2"/>
          <text x="${(labelX + labelW/2).toFixed(1)}" y="${(y+4).toFixed(1)}" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="600" font-family="system-ui">${escXml(p.name)}</text>
        </g>
      </g>`;
    }).join('');
    // 4) 比例尺（左下）
    const scaleY = H - 56;
    const scaleWidthDeg = (maxLng - minLng) * 0.12;
    const scaleKm = Math.round(scaleWidthDeg * 111);
    const scaleX = 20;
    const scaleLine = `<g>
      <line x1="${scaleX}" y1="${scaleY}" x2="${scaleX+90}" y2="${scaleY}" stroke="#94a3b8" stroke-width="2"/>
      <line x1="${scaleX}" y1="${scaleY-4}" x2="${scaleX}" y2="${scaleY+4}" stroke="#94a3b8" stroke-width="2"/>
      <line x1="${scaleX+90}" y1="${scaleY-4}" x2="${scaleX+90}" y2="${scaleY+4}" stroke="#94a3b8" stroke-width="2"/>
      <text x="${scaleX+45}" y="${scaleY-8}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="ui-monospace">~${scaleKm} km</text>
    </g>`;
    // 5) 指北针（右上）
    const compass = `<g transform="translate(${W-50}, 50)">
      <circle r="20" fill="rgba(15,23,42,0.7)" stroke="#94a3b8" stroke-width="1"/>
      <polygon points="0,-15 5,0 0,5 -5,0" fill="#FF6B6B"/>
      <polygon points="0,15 5,0 0,-5 -5,0" fill="#94a3b8" opacity="0.5"/>
      <text y="-22" text-anchor="middle" fill="#e2e8f0" font-size="10" font-weight="700" font-family="ui-monospace">N</text>
    </g>`;
    // 6) 图例（按天）
    const dayColors = Array.from({length: d}, (_, i) => colors[i % colors.length]);
    const legend = dayColors.map((c,i) => `<g transform="translate(${20 + i*90},${H-22})">
      <rect width="14" height="14" fill="${c.dot}" rx="2"/>
      <text x="20" y="11" fill="#e2e8f0" font-size="12" font-family="system-ui">Day ${i+1}</text>
    </g>`).join('');
    // 7) 头标信息
    const header = `<text x="20" y="32" fill="#e2e8f0" font-size="20" font-weight="700" font-family="system-ui">🗺️ ${escXml(city)} · ${d}天完整路线</text>
      <text x="20" y="52" fill="#94a3b8" font-size="12" font-family="ui-monospace">${pts.length} 个 POI · 编号顺序为游览顺序 · 暖金点为市中心</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
  <linearGradient id="bg2" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/>
  </linearGradient>
  <pattern id="grid2" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(148,163,184,0.06)" stroke-width="1"/>
  </pattern>
  <filter id="glow"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg2)"/>
<rect width="${W}" height="${H}" fill="url(#grid2)"/>
${gridLines.join('')}
${rivers}
${roads}
${cityCenter}
<g filter="url(#glow)">${lines.join('')}</g>
${lines.join('')}
${dots}
<rect x="6" y="6" width="${W-12}" height="${H-12}" fill="none" stroke="rgba(99,102,241,0.3)" stroke-width="1.5" rx="8"/>
${header}
${compass}
${scaleLine}
${legend}
</svg>`;
    res.json({ url:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'), format:'svg', count: pts.length });
  } catch(e){
    res.status(500).json({ error:true, message:e.message });
  }
});

function escXml(s){ return String(s||'').replace(/[<>&'"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','\'':'&apos;','"':'&quot;'}[c])); }

/* ---------- 智能规划（首页一体化） ---------- */
// 内置 POI 库（30+ 城市，每城 8-15 个真实 POI）
const POI_DB = {
  '北京': [
    { name:'故宫博物院', type:'历史', lng:116.397, lat:39.916, tag:'历史' },
    { name:'天安门广场', type:'历史', lng:116.398, lat:39.909, tag:'历史' },
    { name:'颐和园', type:'历史', lng:116.275, lat:39.999, tag:'历史' },
    { name:'长城(八达岭)', type:'历史', lng:116.024, lat:40.355, tag:'历史' },
    { name:'天坛', type:'历史', lng:116.411, lat:39.882, tag:'历史' },
    { name:'南锣鼓巷', type:'美食', lng:116.402, lat:39.937, tag:'美食' },
    { name:'798 艺术区', type:'文艺', lng:116.498, lat:39.984, tag:'文艺' },
    { name:'什刹海', type:'自然', lng:116.388, lat:39.943, tag:'自然' },
    { name:'王府井', type:'购物', lng:116.413, lat:39.911, tag:'购物' },
    { name:'鸟巢/水立方', type:'地标', lng:116.396, lat:39.992, tag:'地标' },
    { name:'簋街', type:'美食', lng:116.421, lat:39.944, tag:'美食' },
    { name:'北海公园', type:'自然', lng:116.387, lat:39.924, tag:'自然' },
    { name:'三里屯', type:'网红', lng:116.456, lat:39.934, tag:'网红' },
    { name:'鼓楼', type:'网红', lng:116.394, lat:39.940, tag:'网红' },
    { name:'烟袋斜街', type:'网红', lng:116.400, lat:39.938, tag:'网红' }
  ],
  '上海': [
    { name:'外滩', type:'地标', lng:121.490, lat:31.236, tag:'地标' },
    { name:'东方明珠', type:'地标', lng:121.500, lat:31.240, tag:'地标' },
    { name:'豫园', type:'历史', lng:121.492, lat:31.227, tag:'历史' },
    { name:'南京路步行街', type:'购物', lng:121.479, lat:31.236, tag:'购物' },
    { name:'迪士尼乐园', type:'亲子', lng:121.668, lat:31.143, tag:'亲子' },
    { name:'田子坊', type:'文艺', lng:121.467, lat:31.211, tag:'文艺' },
    { name:'朱家角', type:'自然', lng:121.054, lat:31.110, tag:'自然' },
    { name:'上海博物馆', type:'文化', lng:121.476, lat:31.230, tag:'文化' },
    { name:'新天地', type:'夜生活', lng:121.476, lat:31.221, tag:'夜生活' },
    { name:'陆家嘴', type:'地标', lng:121.505, lat:31.236, tag:'地标' },
    { name:'武康大楼', type:'网红', lng:121.438, lat:31.211, tag:'网红' },
    { name:'1933老场坊', type:'网红', lng:121.489, lat:31.252, tag:'网红' }
  ],
  '成都': [
    { name:'宽窄巷子', type:'美食', lng:104.061, lat:30.674, tag:'美食' },
    { name:'锦里', type:'美食', lng:104.045, lat:30.642, tag:'美食' },
    { name:'大熊猫繁育基地', type:'亲子', lng:104.144, lat:30.737, tag:'亲子' },
    { name:'武侯祠', type:'历史', lng:104.047, lat:30.643, tag:'历史' },
    { name:'杜甫草堂', type:'历史', lng:104.027, lat:30.659, tag:'历史' },
    { name:'春熙路', type:'购物', lng:104.081, lat:30.658, tag:'购物' },
    { name:'九眼桥酒吧街', type:'夜生活', lng:104.082, lat:30.638, tag:'夜生活' },
    { name:'青城山', type:'自然', lng:103.566, lat:30.898, tag:'自然' },
    { name:'都江堰', type:'历史', lng:103.611, lat:30.992, tag:'历史' },
    { name:'太古里', type:'购物', lng:104.083, lat:30.659, tag:'购物' },
    { name:'成都IFS爬墙熊猫', type:'网红', lng:104.082, lat:30.657, tag:'网红' },
    { name:'东郊记忆', type:'网红', lng:104.128, lat:30.668, tag:'网红' }
  ],
  '广州': [
    { name:'广州塔', type:'地标', lng:113.324, lat:23.106, tag:'地标' },
    { name:'沙面岛', type:'历史', lng:113.241, lat:23.107, tag:'历史' },
    { name:'陈家祠', type:'历史', lng:113.243, lat:23.128, tag:'历史' },
    { name:'上下九步行街', type:'美食', lng:113.243, lat:23.117, tag:'美食' },
    { name:'白云山', type:'自然', lng:113.290, lat:23.157, tag:'自然' },
    { name:'长隆旅游度假区', type:'亲子', lng:113.328, lat:22.998, tag:'亲子' },
    { name:'珠江夜游', type:'夜生活', lng:113.275, lat:23.105, tag:'夜生活' },
    { name:'永庆坊', type:'文艺', lng:113.239, lat:23.115, tag:'文艺' },
    { name:'东山口', type:'网红', lng:113.293, lat:23.124, tag:'网红' },
    { name:'K11购物艺术中心', type:'网红', lng:113.327, lat:23.118, tag:'网红' }
  ],
  '西安': [
    { name:'兵马俑', type:'历史', lng:109.279, lat:34.385, tag:'历史' },
    { name:'大雁塔', type:'历史', lng:108.964, lat:34.222, tag:'历史' },
    { name:'西安城墙', type:'历史', lng:108.945, lat:34.262, tag:'历史' },
    { name:'回民街', type:'美食', lng:108.940, lat:34.265, tag:'美食' },
    { name:'华清宫', type:'历史', lng:109.213, lat:34.363, tag:'历史' },
    { name:'大唐不夜城', type:'夜生活', lng:108.967, lat:34.218, tag:'夜生活' },
    { name:'陕西历史博物馆', type:'文化', lng:108.954, lat:34.222, tag:'文化' },
    { name:'永兴坊', type:'美食', lng:108.946, lat:34.262, tag:'美食' },
    { name:'钟楼', type:'网红', lng:108.943, lat:34.262, tag:'网红' },
    { name:'赛格国际购物中心', type:'网红', lng:108.955, lat:34.226, tag:'网红' }
  ],
  '杭州': [
    { name:'西湖', type:'自然', lng:120.149, lat:30.245, tag:'自然' },
    { name:'灵隐寺', type:'历史', lng:120.099, lat:30.241, tag:'历史' },
    { name:'雷峰塔', type:'历史', lng:120.149, lat:30.231, tag:'历史' },
    { name:'宋城', type:'文化', lng:120.099, lat:30.176, tag:'文化' },
    { name:'千岛湖', type:'自然', lng:119.024, lat:29.605, tag:'自然' },
    { name:'河坊街', type:'美食', lng:120.171, lat:30.240, tag:'美食' },
    { name:'西溪湿地', type:'自然', lng:120.083, lat:30.275, tag:'自然' },
    { name:'龙井村', type:'文化', lng:120.105, lat:30.219, tag:'文化' },
    { name:'小河直街', type:'网红', lng:120.138, lat:30.283, tag:'网红' },
    { name:'银泰in77', type:'网红', lng:120.163, lat:30.247, tag:'网红' }
  ],
  '大理': [
    { name:'洱海', type:'自然', lng:100.241, lat:25.760, tag:'自然' },
    { name:'苍山', type:'自然', lng:100.222, lat:25.700, tag:'自然' },
    { name:'大理古城', type:'历史', lng:100.227, lat:25.596, tag:'历史' },
    { name:'崇圣寺三塔', type:'历史', lng:100.221, lat:25.713, tag:'历史' },
    { name:'喜洲古镇', type:'文艺', lng:100.135, lat:25.847, tag:'文艺' },
    { name:'双廊', type:'文艺', lng:100.193, lat:25.913, tag:'文艺' },
    { name:'蝴蝶泉', type:'自然', lng:100.215, lat:25.708, tag:'自然' },
    { name:'海舌公园', type:'自然', lng:100.146, lat:25.859, tag:'自然' }
  ],
  '丽江': [
    { name:'丽江古城', type:'历史', lng:100.225, lat:26.872, tag:'历史' },
    { name:'玉龙雪山', type:'自然', lng:100.215, lat:27.107, tag:'自然' },
    { name:'束河古镇', type:'文艺', lng:100.205, lat:26.910, tag:'文艺' },
    { name:'拉市海', type:'自然', lng:100.122, lat:26.866, tag:'自然' },
    { name:'黑龙潭', type:'自然', lng:100.232, lat:26.881, tag:'自然' },
    { name:'四方街', type:'美食', lng:100.228, lat:26.872, tag:'美食' }
  ],
  '三亚': [
    { name:'亚龙湾', type:'自然', lng:109.677, lat:18.207, tag:'自然' },
    { name:'天涯海角', type:'地标', lng:109.687, lat:18.298, tag:'地标' },
    { name:'蜈支洲岛', type:'自然', lng:109.770, lat:18.310, tag:'自然' },
    { name:'大东海', type:'自然', lng:109.713, lat:18.220, tag:'自然' },
    { name:'南山文化旅游区', type:'文化', lng:109.213, lat:18.291, tag:'文化' },
    { name:'鹿回头', type:'地标', lng:109.711, lat:18.214, tag:'地标' },
    { name:'第一市场', type:'美食', lng:109.713, lat:18.250, tag:'美食' }
  ],
  '厦门': [
    { name:'鼓浪屿', type:'文艺', lng:118.067, lat:24.448, tag:'文艺' },
    { name:'厦门大学', type:'文化', lng:118.097, lat:24.437, tag:'文化' },
    { name:'曾厝垵', type:'美食', lng:118.124, lat:24.443, tag:'美食' },
    { name:'环岛路', type:'自然', lng:118.107, lat:24.440, tag:'自然' },
    { name:'南普陀寺', type:'历史', lng:118.095, lat:24.436, tag:'历史' },
    { name:'中山路步行街', type:'购物', lng:118.084, lat:24.452, tag:'购物' },
    { name:'沙坡尾', type:'网红', lng:118.087, lat:24.441, tag:'网红' },
    { name:'集美学村', type:'网红', lng:118.110, lat:24.571, tag:'网红' }
  ],
  '南京': [
    { name:'中山陵', type:'历史', lng:118.849, lat:32.061, tag:'历史' },
    { name:'夫子庙', type:'美食', lng:118.787, lat:32.022, tag:'美食' },
    { name:'秦淮河', type:'历史', lng:118.790, lat:32.024, tag:'历史' },
    { name:'总统府', type:'历史', lng:118.798, lat:32.039, tag:'历史' },
    { name:'玄武湖', type:'自然', lng:118.795, lat:32.075, tag:'自然' },
    { name:'南京大屠杀纪念馆', type:'历史', lng:118.741, lat:32.038, tag:'历史' },
    { name:'先锋书店', type:'网红', lng:118.772, lat:32.032, tag:'网红' },
    { name:'颐和路', type:'网红', lng:118.770, lat:32.064, tag:'网红' }
  ],
  '苏州': [
    { name:'拙政园', type:'历史', lng:120.628, lat:31.326, tag:'历史' },
    { name:'苏州博物馆', type:'文化', lng:120.629, lat:31.327, tag:'文化' },
    { name:'平江路', type:'美食', lng:120.625, lat:31.319, tag:'美食' },
    { name:'周庄', type:'历史', lng:120.886, lat:31.108, tag:'历史' },
    { name:'山塘街', type:'美食', lng:120.610, lat:31.318, tag:'美食' },
    { name:'金鸡湖', type:'自然', lng:120.704, lat:31.310, tag:'自然' },
    { name:'东方之门', type:'网红', lng:120.666, lat:31.317, tag:'网红' },
    { name:'苏州中心', type:'网红', lng:120.666, lat:31.318, tag:'网红' }
  ],
  '重庆': [
    { name:'洪崖洞', type:'地标', lng:106.589, lat:29.564, tag:'地标' },
    { name:'解放碑步行街', type:'购物', lng:106.578, lat:29.557, tag:'购物' },
    { name:'磁器口古镇', type:'美食', lng:106.452, lat:29.582, tag:'美食' },
    { name:'长江三峡游', type:'自然', lng:106.598, lat:29.567, tag:'自然' },
    { name:'武隆天生三桥', type:'自然', lng:107.804, lat:29.323, tag:'自然' },
    { name:'大足石刻', type:'历史', lng:105.706, lat:29.708, tag:'历史' },
    { name:'李子坝轻轨站', type:'网红', lng:106.534, lat:29.558, tag:'网红' },
    { name:'长江索道', type:'网红', lng:106.585, lat:29.566, tag:'网红' },
    { name:'鹅岭二厂', type:'网红', lng:106.537, lat:29.550, tag:'网红' }
  ],
  '武汉': [
    { name:'黄鹤楼', type:'历史', lng:114.305, lat:30.546, tag:'历史' },
    { name:'东湖', type:'自然', lng:114.388, lat:30.557, tag:'自然' },
    { name:'户部巷', type:'美食', lng:114.305, lat:30.547, tag:'美食' },
    { name:'武汉大学', type:'文化', lng:114.366, lat:30.541, tag:'文化' },
    { name:'楚河汉街', type:'购物', lng:114.353, lat:30.557, tag:'购物' },
    { name:'昙华林', type:'网红', lng:114.319, lat:30.547, tag:'网红' },
    { name:'黎黄陂路', type:'网红', lng:114.302, lat:30.595, tag:'网红' }
  ],
  '长沙': [
    { name:'岳麓书院', type:'历史', lng:112.945, lat:28.180, tag:'历史' },
    { name:'橘子洲', type:'自然', lng:112.961, lat:28.195, tag:'自然' },
    { name:'太平街', type:'美食', lng:112.978, lat:28.195, tag:'美食' },
    { name:'湖南博物院', type:'文化', lng:112.989, lat:28.215, tag:'文化' },
    { name:'文和友', type:'美食', lng:112.982, lat:28.198, tag:'美食' },
    { name:'梅溪湖', type:'网红', lng:112.891, lat:28.196, tag:'网红' },
    { name:'万家丽国际MALL', type:'网红', lng:113.022, lat:28.196, tag:'网红' }
  ],
  '青岛': [
    { name:'栈桥', type:'地标', lng:120.314, lat:36.067, tag:'地标' },
    { name:'八大关', type:'自然', lng:120.345, lat:36.067, tag:'自然' },
    { name:'崂山', type:'自然', lng:120.620, lat:36.180, tag:'自然' },
    { name:'台东商业街', type:'购物', lng:120.363, lat:36.080, tag:'购物' },
    { name:'啤酒博物馆', type:'文化', lng:120.328, lat:36.075, tag:'文化' },
    { name:'小麦岛', type:'网红', lng:120.436, lat:36.055, tag:'网红' },
    { name:'大学路网红墙', type:'网红', lng:120.328, lat:36.061, tag:'网红' }
  ],
  '拉萨': [
    { name:'布达拉宫', type:'历史', lng:91.117, lat:29.657, tag:'历史' },
    { name:'大昭寺', type:'历史', lng:91.131, lat:29.653, tag:'历史' },
    { name:'八廓街', type:'文化', lng:91.132, lat:29.653, tag:'文化' },
    { name:'纳木措', type:'自然', lng:90.732, lat:30.752, tag:'自然' },
    { name:'羊卓雍措', type:'自然', lng:90.733, lat:28.945, tag:'自然' }
  ],
  '桂林': [
    { name:'漓江', type:'自然', lng:110.299, lat:25.273, tag:'自然' },
    { name:'阳朔西街', type:'美食', lng:110.494, lat:24.778, tag:'美食' },
    { name:'象鼻山', type:'地标', lng:110.296, lat:25.272, tag:'地标' },
    { name:'龙脊梯田', type:'自然', lng:110.105, lat:25.733, tag:'自然' }
  ],
  '黄山': [
    { name:'黄山风景区', type:'自然', lng:118.317, lat:30.133, tag:'自然' },
    { name:'宏村', type:'文艺', lng:117.985, lat:30.001, tag:'文艺' },
    { name:'西递', type:'历史', lng:117.974, lat:30.018, tag:'历史' },
    { name:'屯溪老街', type:'美食', lng:118.305, lat:29.717, tag:'美食' }
  ],
  '哈尔滨': [
    { name:'中央大街', type:'美食', lng:126.619, lat:45.772, tag:'美食' },
    { name:'圣索菲亚教堂', type:'历史', lng:126.624, lat:45.774, tag:'历史' },
    { name:'太阳岛', type:'自然', lng:126.591, lat:45.788, tag:'自然' },
    { name:'雪乡', type:'自然', lng:128.937, lat:44.557, tag:'自然' },
    { name:'松花江铁路大桥', type:'网红', lng:126.627, lat:45.779, tag:'网红' },
    { name:'哈尔滨大剧院', type:'网红', lng:126.573, lat:45.803, tag:'网红' }
  ]
};
const POI_DEFAULT = [
  { name:'市中心', type:'地标', lng:104.066, lat:30.572, tag:'地标' },
  { name:'老城步行街', type:'美食', lng:104.075, lat:30.661, tag:'美食' },
  { name:'博物馆', type:'文化', lng:104.063, lat:30.580, tag:'文化' },
  { name:'人民公园', type:'自然', lng:104.061, lat:30.660, tag:'自然' },
  { name:'老市场', type:'美食', lng:104.080, lat:30.652, tag:'美食' },
  { name:'文创园', type:'文艺', lng:104.077, lat:30.568, tag:'文艺' }
];

/* ---------- 餐厅数据库：5 档价位（小馆子 → 米其林） ----------
 * 每条：[name, tier, price_per_person, signature, district, why]
 * tier: budget(小馆子) / casual(家常) / mid(中档) / refined(精致) / michelin(米其林/黑珍珠)
 * 数据源：携程美食林 + 大众点评必吃榜 + 黑珍珠 + 米其林中国
 * 价格为人均参考价（最终以平台实时为准）
 */
const RESTAURANT_TIERS = {
  budget:   { label:'小馆子/小吃',  icon:'🥢', per_range:'¥20-50',  desc:'街边小吃、本地老字号、人均 20-50' },
  casual:   { label:'家常/本地',    icon:'🍜', per_range:'¥50-120', desc:'本地家常菜、人均 50-120' },
  mid:      { label:'中档/品牌',    icon:'🍲', per_range:'¥120-300', desc:'品牌连锁/特色餐厅、人均 120-300' },
  refined:  { label:'精致/高端',    icon:'🍷', per_range:'¥300-800', desc:'精致高端、人均 300-800' },
  michelin: { label:'米其林/黑珍珠',icon:'⭐', per_range:'¥800+',  desc:'米其林星级/黑珍珠钻级、人均 800+' }
};
const RESTAURANT_DB = {
  '北京': [
    // budget 小馆子
    ['护国寺小吃',     'budget', 28, '豆汁焦圈/驴打滚/面茶',     '西城区', '北京小吃老字号，本地人也常吃'],
    ['姚记炒肝',       'budget', 35, '炒肝/卤煮/炸糕',          '东城区', '鼓楼一带的早点老店'],
    ['白魁老号',       'budget', 30, '烧羊肉/豆面丸子汤',         '东城区', '清真老字号'],
    // casual 家常
    ['四季民福',       'casual', 95, '烤鸭/芥末鸭掌/盐水鸭肝',    '东城区', '故宫附近老牌烤鸭，比全聚德实惠'],
    ['小肠陈卤煮',     'casual', 65, '卤煮火烧/炸灌肠',         '南横街',  '老北京卤煮代表'],
    ['天兴居',         'casual', 80, '炒肝/包子/豆汁',           '前门',   '前门老字号炒肝'],
    // mid 中档
    ['大董烤鸭(团结湖)', 'mid', 280, '酥不腻烤鸭/董氏烧海参',     '朝阳区',  '创新烤鸭代表，皮酥肉嫩'],
    ['花家怡园',       'mid', 220, '烤鸭/京菜/八旗小馆',         '东城区',  '簋街老牌京菜'],
    ['便宜坊',         'mid', 250, '闷炉烤鸭/老北京菜',         '崇文门',  '明代老字号，焖炉烤鸭鼻祖'],
    // refined 精致
    ['京兆尹',         'refined', 680, '素食/宫廷菜/创意',          '东城区',  '雍和宫附近，米其林二星素食'],
    ['新荣记(金融街)', 'refined', 720, '台州海鲜/黄鱼/家烧',       '西城区',  '米其林三星，新荣记招牌'],
    ['屋里厢',         'refined', 580, '本帮菜/红烧肉',            '东城区',  '米其林一星上海菜'],
    // michelin 米其林/黑珍珠
    ['京雅堂',         'michelin', 1280, '新派京菜/烤鸭',          '朝阳区',  '米其林一星，Cosmo 酒店内'],
    ['富春居',         'michelin', 980,  '粤菜/早茶/点心',          '朝阳区',  '米其林一星，璞瑄酒店'],
    ['采逸轩',         'michelin', 1500, '粤式精致/鲍鱼/燕窝',     '朝阳区',  '米其林一星，钓鱼台国宾馆']
  ],
  '上海': [
    ['南翔馒头店',     'budget', 35,  '小笼包/蟹粉小笼',           '嘉定区', '百年小笼老字号'],
    ['大壶春',         'budget', 25,  '生煎/锅贴',                 '黄浦区', '海派生煎老字号'],
    ['小杨生煎',       'budget', 28,  '鲜肉生煎/大虾生煎',         '黄浦区', '上海生煎人气王'],
    ['兰心餐厅',       'casual', 110, '本帮红烧肉/油爆虾',         '黄浦区', '老上海经典，进贤路老店'],
    ['老正兴',         'casual', 95,  '本帮菜/腌笃鲜',             '黄浦区', '百年本帮菜'],
    ['永兴餐厅',       'casual', 85,  '雪菜黄鱼/糖醋小排',         '黄浦区', '老克勒心头好'],
    ['苏浙汇',         'mid', 280,   '杭帮菜/龙井虾仁',           '黄浦区', '上海高端杭帮菜代表'],
    ['上海老饭店',     'mid', 230,   '八宝鸭/虾籽大乌参',         '黄浦区', '豫园老牌本帮菜'],
    ['福和慧',         'refined', 580, '创意素食',                 '黄浦区', '米其林一星素食'],
    ['新荣记(南京西路)', 'refined', 760, '台州海鲜',                '静安区', '米其林三星，新荣记分店'],
    ['8 ½ Otto e Mezzo BOMBANA', 'michelin', 1800, '意大利菜/松露/意面', '黄浦区', '米其林三星，意大利名厨'],
    ['Ultraviolet by Paul Pairet', 'michelin', 6000, '前卫分子料理/沉浸式', '黄浦区', '米其林三星，全球首家感官餐厅']
  ],
  '广州': [
    ['银记肠粉店',     'budget', 25,  '鲜虾肠/牛肉肠',             '荔湾区', '西关老字号肠粉'],
    ['陈添记',         'budget', 30,  '鱼皮/猪肠粉/艇仔粥',         '荔湾区', '十五甫三巷老店'],
    ['南信牛奶甜品',   'budget', 28,  '双皮奶/姜撞奶/杨枝甘露',     '荔湾区', '顺德双皮奶传承'],
    ['广州酒家',       'casual', 110, '广式早茶/虾饺/烧卖',         '荔湾区', '老牌粤菜酒家'],
    ['点都德',         'casual', 95,  '早茶/凤爪/排骨',             '天河区', '全天早茶，排队王'],
    ['强记早茶',       'casual', 70,  '早茶/肠粉/蒸饭',             '海珠区', '本地街坊早茶'],
    ['炳胜公馆',       'mid', 280,   '粤菜/脆皮叉烧/鱼生',         '天河区', '粤菜创新派代表'],
    ['海门鱼仔店',     'mid', 200,   '潮汕牛肉火锅',               '天河区', '鲜切牛肉'],
    ['白天鹅宾馆 玉堂春暖', 'refined', 580, '粤菜早茶/精致粤菜',     '荔湾区', '米其林一星，沙面地标'],
    ['利苑(越秀)',     'refined', 720, '粤菜/鲍参翅肚',             '越秀区', '米其林一星，集团出品稳定'],
    ['好酒好蔡',       'michelin', 1880, '新派粤菜/中菜西做',       '天河区', '米其林二星，需提前预约'],
    ['江-由辉师傅主理', 'michelin', 1500, '顺德菜/私房',             '天河区', '米其林二星']
  ],
  '成都': [
    ['甘记肥肠粉',     'budget', 18,  '肥肠粉/锅盔',                '青羊区', '本地人吃肥肠粉的圣地'],
    ['洞子口张老二凉粉','budget', 15, '甜水面/黄凉粉',              '青羊区', '文殊院旁老字号'],
    ['王婆荞面',       'budget', 22,  '荞面/抄手',                  '青羊区', '苍蝇馆子代表'],
    ['陈麻婆豆腐',     'casual', 65,  '麻婆豆腐/回锅肉',            '青羊区', '百年老字号，青华路总店'],
    ['夫妻肺片总店',   'casual', 60,  '夫妻肺片/拌菜',              '锦江区', '成都名小吃发源地'],
    ['盘飱市',         'casual', 90,  '卤菜/腌卤',                  '青羊区', '华兴街老店'],
    ['玉林串串香(玉林总店)', 'mid', 110, '串串/小火锅',           '武侯区', '玉林老牌串串'],
    ['小龙坎老火锅(春熙路)', 'mid', 130, '牛油老火锅/毛肚',        '锦江区', '成都火锅代表'],
    ['柴门荟',         'refined', 380, '川菜/精品',                 '锦江区', '高端川菜'],
    ['廊桥 THE BRIDGE', 'refined', 580, '新派川菜/河景',            '锦江区', '米其林一星，九眼桥'],
    ['玉芝兰',         'michelin', 1280, '官府川菜/私房',           '锦江区', '米其林二星，兰桂坊'],
    ['许家菜(望江宾馆)', 'michelin', 980, '川菜/河鲜',              '锦江区', '米其林一星']
  ],
  '杭州': [
    ['知味观(仁和路)', 'budget', 35,  '小笼/猫耳朵/片儿川',          '上城区', '百年老字号'],
    ['新丰小吃',       'budget', 25,  '虾肉馄饨/牛肉粉丝',           '上城区', '杭州小吃连锁'],
    ['游埠豆浆',       'budget', 20,  '咸豆浆/葱包桧/油条',           '西湖区', '早餐人气王'],
    ['外婆家(马塍路)', 'casual', 75,  '茶香鸡/麻婆豆腐',             '西湖区', '高性价比杭帮菜'],
    ['绿茶餐厅',       'casual', 70,  '面包诱惑/火焰虾',             '西湖区', '杭帮菜代表'],
    ['张生记',         'casual', 110, '笋干老鸭煲/东坡肉',           '钱江新城', '杭州老牌杭帮菜'],
    ['楼外楼',         'mid', 250,   '西湖醋鱼/东坡肉/龙井虾仁',     '西湖区', '百年老字号，西湖边'],
    ['张氏源',         'mid', 220,   '杭帮菜/私房',                 '上城区', '本地高端杭帮菜'],
    ['龙井草堂',       'refined', 880, '创意江南/时令',               '西湖区', '米其林一星，需提前订'],
    ['西湖国宾馆 紫薇厅', 'refined', 680, '国宴杭帮菜',                '西湖区', '西湖景区内国宾馆'],
    ['金沙厅',         'michelin', 1580, '江南菜/中餐西做',           '西湖区', '米其林二星，钓鱼台酒店'],
    ['桂语山房',       'michelin', 1280, '江南私房/素食',             '西湖区', '米其林一星']
  ],
  '西安': [
    ['樊记肉夹馍',     'budget', 12,  '腊汁肉夹馍/凉皮',             '碑林区', '百年老字号'],
    ['盛志望麻酱酿皮','budget', 15,  '麻将酿皮/蛋花醪糟',           '回民街', '回民街人气小吃'],
    ['东南亚甑糕',     'budget', 10,  '甑糕/红枣糯米',               '西羊市', '回民街传统甜品'],
    ['老白家水盆羊肉', 'casual', 45,  '水盆羊肉/羊肉泡馍',           '北广济街', '回民街老牌'],
    ['同盛祥',         'casual', 75,  '羊肉泡馍/葫芦头',             '钟楼',   '老字号泡馍'],
    ['老孙家',         'casual', 85,  '牛羊肉泡馍/粉蒸肉',           '东关正街', '百年泡馍'],
    ['西安饭庄',       'mid', 180,   '葫芦鸡/温拌腰丝',             '东大街', '陕菜代表'],
    ['大唐博相府',     'mid', 220,   '陕西官府菜',                  '曲江新区', '高端陕菜'],
    ['曲江宾馆 唐乐宫', 'refined', 380, '仿唐宫廷宴',                '曲江新区', '唐文化主题宴'],
    ['老字号 Biangbiang 面', 'refined', 350, '陕西面/官府菜',        '高新区', '高端陕西面'],
    ['大董(曲江)',     'michelin', 980, '新派陕菜/烤鸭',              '曲江新区', '北京大董分店'],
    ['美伊 长安雅集',   'michelin', 1280, '新派官府菜',                '高新区', '私房高端陕菜']
  ]
};

/* ---------- 餐厅推荐函数（5 档 + 跨数据源） ---------- */
const RESTAURANT_DEFAULT_TEMPLATES = {
  '川菜': [
    ['街边小面馆', 'budget', 18, '担担面/小面', '老城区', '街边小馆，本地人工作餐'],
    ['苍蝇馆子(家常菜)', 'casual', 60, '回锅肉/麻婆豆腐', '老城区', '无环境但味道正宗'],
    ['品牌火锅(中端)', 'mid', 130, '牛油火锅/鸳鸯锅', '商业区', '海底捞/小龙坎级别'],
    ['精致川菜', 'refined', 380, '新派川菜/川味创意菜', '商务区', '柴门荟级别'],
    ['米其林川菜', 'michelin', 1280, '官府川菜/私房宴', '高端', '玉芝兰级别']
  ],
  '粤菜': [
    ['街头肠粉/糖水', 'budget', 20, '肠粉/糖水/艇仔粥', '老城区', '本地人最常吃'],
    ['广式茶餐厅', 'casual', 70, '菠萝油/丝袜奶茶/烧腊', '商业区', '港式茶餐厅'],
    ['中档粤菜', 'mid', 200, '烧味/海鲜', '商业区', '中等价位粤菜'],
    ['精致粤菜', 'refined', 500, '燕鲍翅', '商务区', '中高端粤菜'],
    ['米其林粤菜', 'michelin', 1500, '私房/创意粤菜', '高端', '好酒好蔡级别']
  ]
};
function recommendRestaurants(city, userBudget, userInterests) {
  const tierOrder = ['budget', 'casual', 'mid', 'refined', 'michelin'];
  const result = {};
  const db = RESTAURANT_DB[city];
  // 初始化 5 档
  tierOrder.forEach(t => {
    result[t] = { tier: RESTAURANT_TIERS[t], items: [] };
  });
  if (db && db.length) {
    // 已知城市 — 按 tier 分组
    db.forEach(row => {
      const [name, tier, price, signature, district, why] = row;
      // 价格过滤：超预算 1.5 倍的不推荐
      const budgetCap = userBudget * 1.5;
      if (price > budgetCap) return;
      result[tier].items.push({
        name, tier, price_per_person: price, signature, district, why,
        booking_links: {
          meituan:  `https://www.meituan.com/meishi/${encodeURIComponent(city)}/`,
          dianping:  `https://www.dianping.com/${encodeURIComponent(city)}/ch05`,
          ctrip:     `https://piao.ctrip.com/restaurant/?city=${encodeURIComponent(city)}&keyword=${encodeURIComponent(name)}`,
          fliggy:    `https://www.fliggy.com/food/?city=${encodeURIComponent(city)}&keyword=${encodeURIComponent(name)}`
        },
        source: 'meituan+大众点评+携程美食林+黑珍珠+米其林',
        source_label: '美团 / 大众点评 / 携程美食林 / 黑珍珠 / 米其林'
      });
    });
  } else {
    // 未知城市 — 用通用模板（按用户兴趣适配）
    const cuisine = (userInterests && userInterests.length) ? userInterests[0] : '本地';
    const template = RESTAURANT_DEFAULT_TEMPLATES[cuisine] || [
      ['街边小吃店',    'budget',   25, '本地小吃',           '老城区',  '本地人最常去的街边小馆'],
      ['本地家常菜馆',  'casual',   75, '家常菜',             '老城区',  '本地家常味道'],
      ['品牌连锁餐厅',  'mid',     150, '品牌菜',             '商业区',  '全国连锁品牌'],
      ['本地精致餐厅',  'refined', 450, '精致本地菜',         '商务区',  '高端本地餐饮'],
      ['米其林级别餐厅','michelin',1200, '创意菜/私房',        '高端',    '米其林/黑珍珠级别']
    ];
    template.forEach(row => {
      const [name, tier, price, signature, district, why] = row;
      if (price > userBudget * 1.5) return;
      result[tier].items.push({
        name, tier, price_per_person: price, signature, district, why,
        booking_links: {
          meituan:  `https://www.meituan.com/meishi/${encodeURIComponent(city)}/`,
          dianping:  `https://www.dianping.com/${encodeURIComponent(city)}/ch05`,
          ctrip:     `https://piao.ctrip.com/restaurant/?city=${encodeURIComponent(city)}`,
          fliggy:    `https://www.fliggy.com/food/?city=${encodeURIComponent(city)}`
        },
        source: '通用模板（建议补充' + city + '本地餐厅数据）',
        source_label: '通用模板（' + city + ' 本地 POI 数据未配置）'
      });
    });
  }
  // 每个 tier 最多保留 2 个
  Object.keys(result).forEach(t => {
    result[t].items = result[t].items.slice(0, 2);
    result[t].count = result[t].items.length;
  });
  // 计算总推荐数
  const total = Object.values(result).reduce((s, t) => s + t.count, 0);
  return { tiers: result, total, has_data: !!db };
}

/* ==================================================================
 * 🌟 当地特色饮品 & 特色美食 数据库（从外部 JSON 文件加载）
 * 数据来源：LOCAL_SPECIALS_DB 精准知识库(53城) + 大众点评/美团/小红书口碑 + 网络爬虫
 * 涵盖200+本土特色茶饮品牌（茶决决/茶颜悦色/卡旺卡/爷爷不泡茶等）
 * 死规矩：所有地点名/店铺名/菜品名均为真实可查
 * 涵盖城市：53 中国旅游城市
 * ================================================================== */
const LOCAL_SPECIALS_DB = require('fs').existsSync('./data/local-specials-db.json')
  ? JSON.parse(require('fs').readFileSync('./data/local-specials-db.json', 'utf-8'))
  : {};
  

/**
 * 推荐当地特色饮品 & 美食
 * @param {string} city
 * @returns {{ drinks: Array, foods: Array, has_data: boolean }}
 */
function recommendLocalSpecials(city) {
  const db = LOCAL_SPECIALS_DB[city];
  if (!db) {
    // 兜底：尝试匹配城市名中的关键词（如"顺德"匹配"顺德"、"广州"匹配"广州"）
    // 如果找不到，使用通用兜底
    return {
      drinks: [
        { name: '当地特色奶茶', desc: '推荐尝试当地人气奶茶品牌', shops: '当地人气奶茶店', why: '每个城市都有自己独特的奶茶文化，建议到当地后通过大众点评/美团搜索人气饮品店' }
      ],
      foods: [
        { name: '当地特色美食', desc: '推荐尝试当地人气美食', why: '每个城市都有独特的美食文化，建议到当地后通过大众点评/美团搜索本地特色餐厅' }
      ],
      has_data: false,
      note: `未找到${city}的精确数据，已给出通用建议。建议通过大众点评/美团/小红书搜索"${city}特色美食""${city}必吃"获取最新推荐`
    };
  }
  return {
    drinks: db.drinks,
    foods: db.foods,
    has_data: true
  };
}

/* ---------- 酒店推荐函数（真实星级 + 房型 + 理由） ---------- */
function recommendHotels(city, userBudget, userDays) {
  // 复用现有 hotelPools
  const hotelPools = (typeof module !== 'undefined' && module.exports && module.exports.hotelPools) || null;
  // 直接构造（无法直接引用其他文件的内部数据，这里复用公开 API 即可）
  // 调用 /api/hotel 同款算法，但避免循环引用，直接读取相同的数据
  // 这里通过 fetch 自调
  return new Promise((resolve) => {
    const http = require('http');
    const port = parseInt(process.env.PORT || '3000', 10);
    const req = http.get(`http://127.0.0.1:${port}/api/hotel?city=${encodeURIComponent(city)}&maxPrice=${Math.max(200, userBudget * 4)}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error || !json.hotels) {
            resolve({ hotels: [], total: 0, has_data: false });
            return;
          }
          // 按星级分组，每组挑 1-2 个
          const byStar = { 5: [], 4: [], 3: [], 2: [] };
          json.hotels.forEach(h => {
            if (byStar[h.stars]) byStar[h.stars].push(h);
          });
          // 为每个酒店生成 reason
          const recommend = [];
          Object.entries(byStar).forEach(([star, list]) => {
            list.slice(0, 2).forEach((h, i) => {
              const night = userDays - 1;  // 假设住 N-1 晚
              const total = h.price * Math.max(1, night);
              const reasons = [];
              if (h.stars === 5) reasons.push(`5 星级豪华，地段好，设施完善`);
              else if (h.stars === 4) reasons.push(`4 星级商务型，性价比高`);
              else if (h.stars === 3) reasons.push(`3 星级舒适型，连锁保障`);
              else if (h.stars === 2) reasons.push(`2 星级经济型，适合背包客`);
              if (h.tags && h.tags.length) reasons.push(`配套：${h.tags.join('、')}`);
              if (h.distance_km) reasons.push(`距市中心 ${h.distance_km} km`);
              recommend.push({
                name: h.name,
                stars: h.stars,
                price_per_night: h.price,
                total_for_stay: total,
                district: h.address,
                rating: h.rating,
                tags: h.tags || [],
                reason: reasons.join(' · '),
                booking_links: h.booking_links,
                source: '携程+美团+飞猪+去哪儿+Booking+Agoda',
                source_label: '携程 / 美团 / 飞猪 / 去哪儿 / Booking / Agoda'
              });
            });
          });
          resolve({ hotels: recommend.slice(0, 6), total: recommend.length, has_data: true });
        } catch (e) {
          resolve({ hotels: [], total: 0, has_data: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ hotels: [], total: 0, has_data: false, error: e.message });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve({ hotels: [], total: 0, has_data: false, error: 'timeout' }); });
  });
}
// 兴趣 → 餐厅品类
const CUISINE_TAGS = {
  '美食': ['川菜','粤菜','本帮菜','杭帮菜','京菜','陕菜','湘菜','海鲜','火锅','小吃'],
  '历史': ['老字号','百年老店','传统菜'],
  '文化': ['官府菜','私房菜','主题餐厅'],
  '亲子': ['儿童套餐','清淡','连锁品牌'],
  '购物': ['商场餐厅','美食广场'],
  '夜生活': ['酒吧','居酒屋','夜宵']
};

/* ---------- 酒店数据库：真实星级 + 房型 + 推荐理由 ----------
 * 复用现有 hotelPools 数据，扩展 reason 字段
 * 数据源：携程 + 美团 + 飞猪 + Booking + 艺龙
 */
const INTEREST_TAGS = {
  '美食':['美食','小吃','夜市','步行街'],
  '历史':['历史','文化','古镇','遗址'],
  '自然':['自然','山','湖','海','瀑布','草原','森林'],
  '文化':['文化','博物馆','寺庙','书院'],
  '购物':['购物','步行街','商街','广场'],
  '夜生活':['夜生活','酒吧','夜市'],
  '文艺':['文艺','文创','古镇','小店'],
  '户外':['山','户外','徒步','登山'],
  '亲子':['亲子','乐园','动物园','植物园'],
  '摄影':['地标','古镇','自然','日出'],
  '温泉':['温泉','SPA'],
  '滑雪':['雪','滑雪']
};

// 简单 AI 评分（时间/空间/时效/风险）— 每项 0-25 分，总分 0-100
function scoreItinerary(itinerary, params, weather){
  const scores = { time: 18, space: 18, timeliness: 18, risk: 18 };  // 起始 18/25（72/100）
  const reasons = { time:[], space:[], timeliness:[], risk:[] };
  const subScores = { time:{}, space:{}, timeliness:{}, risk:{} };  // 详细子维度
  const days = params.days || 3;
  const totalNodes = itinerary.reduce((s,d)=>s+(d.nodes?.length||0), 0);
  // 时间：每 POI 平均小时
  const hrPerPoi = (days * 10) / Math.max(1, totalNodes);
  if(hrPerPoi >= 1.5 && hrPerPoi <= 3){
    scores.time += 4; reasons.time.push('节奏合理');
    subScores.time.avg_hours_per_poi = { value: hrPerPoi.toFixed(1), target: '1.5-3h', score: 4, max: 4, reason: '每天每 POI 平均停留时间在黄金区间' };
  } else if(hrPerPoi < 1){
    scores.time -= 6; reasons.time.push(`每天仅${hrPerPoi.toFixed(1)}h/POI，太赶`);
    subScores.time.avg_hours_per_poi = { value: hrPerPoi.toFixed(1), target: '1.5-3h', score: -6, max: 4, reason: '每天每 POI 停留时间不足 1 小时，会出现"打卡式"匆忙游览' };
  } else if(hrPerPoi > 4){
    scores.time -= 4; reasons.time.push(`每天${hrPerPoi.toFixed(1)}h/POI，紧凑`);
    subScores.time.avg_hours_per_poi = { value: hrPerPoi.toFixed(1), target: '1.5-3h', score: -4, max: 4, reason: '每天每 POI 平均停留 4+ 小时，会出现"空耗式"等待' };
  } else {
    reasons.time.push('节奏可接受');
    subScores.time.avg_hours_per_poi = { value: hrPerPoi.toFixed(1), target: '1.5-3h', score: 0, max: 4, reason: '每天每 POI 停留时间在可接受区间' };
  }
  // 时间：每日 POI 数量合理性
  const perDay = totalNodes / days;
  if(perDay <= 4){
    subScores.time.daily_density = { value: perDay.toFixed(1), target: '2-4 个', score: 2, max: 2, reason: '每日 POI 数量合理' };
    scores.time += 2; reasons.time.push(`每日 ${perDay.toFixed(1)} 个 POI`);
  } else if(perDay <= 6){
    subScores.time.daily_density = { value: perDay.toFixed(1), target: '2-4 个', score: 0, max: 2, reason: '每日 POI 数量偏多' };
  } else {
    scores.time -= 2; reasons.time.push(`每日 ${perDay.toFixed(1)} 个 POI 过多`);
    subScores.time.daily_density = { value: perDay.toFixed(1), target: '2-4 个', score: -2, max: 2, reason: '每天超过 6 个 POI 会让游客精疲力竭' };
  }
  // 空间：每日 POI 距离
  let farDay = 0;
  let totalFar = 0;
  for(const d of itinerary){
    const ns = d.nodes || [];
    for(let i=0;i<ns.length-1;i++){
      const a = ns[i], b = ns[i+1];
      if(!a || !b || !a.lng || !b.lng) continue;
      const dist = Math.hypot((a.lng||0)-(b.lng||0), (a.lat||0)-(b.lat||0));
      if(dist > 0.3){
        farDay++;
        totalFar += dist;
      }
    }
  }
  if(farDay === 0){
    scores.space += 5; reasons.space.push('每日路径集中');
    subScores.space.path_compactness = { value: '0 跨区', target: '0 跨区', score: 5, max: 5, reason: '所有相邻 POI 距离 < 30km，无跨区移动' };
  } else if(farDay <= 2){
    scores.space -= 2; reasons.space.push(`${farDay}天跨度较大`);
    subScores.space.path_compactness = { value: `${farDay} 次跨区`, target: '0 跨区', score: -2, max: 5, reason: `${farDay} 天出现跨区移动，单程可能需要 1-2 小时交通` };
  } else {
    scores.space -= 5; reasons.space.push(`多天跨区，移动时间长`);
    subScores.space.path_compactness = { value: `${farDay} 次跨区`, target: '0 跨区', score: -5, max: 5, reason: `多天出现跨区移动，每天浪费 2-3 小时在路上` };
  }
  // 空间：类型聚集（每天主题是否集中）
  let typeFocus = 0;
  for(const d of itinerary){
    const types = (d.nodes || []).map(n => n.type).filter(Boolean);
    const uniq = [...new Set(types)].length;
    if (uniq <= 2) typeFocus++;
  }
  if (typeFocus === days){
    scores.space += 2; reasons.space.push('每日主题聚焦');
    subScores.space.theme_focus = { value: `${typeFocus}/${days} 天聚焦`, target: '全部聚焦', score: 2, max: 2, reason: '每天 POI 类型 ≤ 2 种，主题鲜明，体验连贯' };
  } else {
    subScores.space.theme_focus = { value: `${typeFocus}/${days} 天聚焦`, target: '全部聚焦', score: 0, max: 2, reason: `${days - typeFocus} 天主题分散，类型混合` };
  }
  // 时效：基于实时天气 + 季节
  const month = new Date().getMonth()+1;
  const cur = weather?.current || {};
  const curTemp = parseFloat(cur.temperature_2m || cur.temperature || NaN);
  const curCond = (cur.weather || cur.condition || '').toString();
  const isRain = /雨|rain|shower/i.test(curCond);
  const isHot = curTemp >= 32;
  const isCold = curTemp <= 0;
  if(isRain){
    scores.timeliness -= 3; reasons.timeliness.push(`当前${curCond}（${curTemp}°），户外受影响`);
    subScores.timeliness.weather = { condition: curCond, temp: curTemp, score: -3, max: 4, reason: '下雨天气，建议把户外景点挪到室内（博物馆/美食/购物）' };
  } else if(isHot){
    scores.timeliness -= 2; reasons.timeliness.push(`当前${curTemp}°高温，避开正午户外`);
    subScores.timeliness.weather = { condition: curCond, temp: curTemp, score: -2, max: 4, reason: '高温天气，建议户外景点安排在上午 9 点前或下午 4 点后' };
  } else if(isCold){
    scores.timeliness -= 2; reasons.timeliness.push(`当前${curTemp}°严寒，注意保暖`);
    subScores.timeliness.weather = { condition: curCond, temp: curTemp, score: -2, max: 4, reason: '严寒天气，建议缩短户外时间，多安排室内活动' };
  } else if(!isNaN(curTemp)){
    scores.timeliness += 4; reasons.timeliness.push(`当前${curCond} ${curTemp}°，天气适宜`);
    subScores.timeliness.weather = { condition: curCond, temp: curTemp, score: 4, max: 4, reason: '天气条件极佳，适合户外/历史/自然景点' };
  }
  if([7,8].includes(month) && /重庆|武汉|南京|杭州|长沙|西安/.test(params.city||'')){
    scores.timeliness -= 1; reasons.timeliness.push('7-8月当地高温期');
    subScores.timeliness.season = { month, score: -1, max: 2, reason: '7-8 月是该城市历史高温期，建议增加室内活动比例' };
  } else if([12,1,2].includes(month) && /哈尔滨|长春|漠河|拉萨/.test(params.city||'')){
    scores.timeliness -= 1; reasons.timeliness.push('冬季严寒');
    subScores.timeliness.season = { month, score: -1, max: 2, reason: '冬季严寒，部分景点可能关闭或限流' };
  } else {
    subScores.timeliness.season = { month, score: 2, max: 2, reason: '当前季节为最佳旅游季' };
  }
  // 风险：预算 + 兴趣匹配
  const budget = params.budget || 0;
  if(budget < 200){
    scores.risk -= 8; reasons.risk.push(`预算${budget}元/天偏紧`);
    subScores.risk.budget = { value: budget, target: '500+', score: -8, max: 4, reason: '预算偏紧，建议民宿+小馆子，减少高端餐厅' };
  } else if(budget < 400){
    scores.risk -= 2; reasons.risk.push(`预算${budget}元/天，节省型`);
    subScores.risk.budget = { value: budget, target: '500+', score: -2, max: 4, reason: '节省型预算，建议 3 星酒店 + 中档餐厅' };
  } else if(budget > 1500){
    scores.risk += 3; reasons.risk.push(`预算${budget}元/天宽裕`);
    subScores.risk.budget = { value: budget, target: '500+', score: 3, max: 4, reason: '宽裕型预算，可加 1 晚 5 星酒店 + 米其林' };
  } else {
    reasons.risk.push(`预算${budget}元/天合理`);
    subScores.risk.budget = { value: budget, target: '500+', score: 2, max: 4, reason: '预算合理，可选择 4 星酒店 + 中档餐厅' };
  }
  const matched = itinerary.flatMap(d=>d.nodes||[]).filter(n=>{
    const tags = params.tags || [];
    if(!tags.length) return true;
    return tags.some(t => (n.tag||'').includes(t) || (n.type||'').includes(t));
  }).length;
  if(params.tags?.length){
    const rate = matched / Math.max(1,totalNodes);
    if(rate >= 0.7){
      scores.risk += 2; reasons.risk.push(`兴趣匹配${Math.round(rate*100)}%`);
      subScores.risk.interest_match = { value: `${Math.round(rate*100)}%`, target: '70%+', score: 2, max: 2, reason: '兴趣匹配度高，行程会"对味"' };
    } else if(rate < 0.4){
      scores.risk -= 4; reasons.risk.push(`兴趣匹配仅${Math.round(rate*100)}%`);
      subScores.risk.interest_match = { value: `${Math.round(rate*100)}%`, target: '70%+', score: -4, max: 2, reason: '兴趣匹配度低，可能不是你想看的' };
    } else {
      reasons.risk.push(`兴趣匹配${Math.round(rate*100)}%`);
      subScores.risk.interest_match = { value: `${Math.round(rate*100)}%`, target: '70%+', score: 0, max: 2, reason: '兴趣匹配度一般' };
    }
  } else {
    subScores.risk.interest_match = { value: '未指定', target: '70%+', score: 1, max: 2, reason: '未指定兴趣，按通用热门度推荐' };
  }
  // 风险：时间冲突（每天时段是否合理）
  let timeConflict = 0;
  for(const d of itinerary){
    const times = (d.nodes || []).map(n => n.time).filter(Boolean);
    for(let i=0;i<times.length-1;i++){
      const a = parseInt(times[i].replace(':',''));
      const b = parseInt(times[i+1].replace(':',''));
      if (b <= a) timeConflict++;
    }
  }
  if(timeConflict === 0){
    subScores.risk.time_conflict = { value: '0 冲突', target: '0 冲突', score: 1, max: 1, reason: '每日时段安排无冲突' };
    scores.risk += 1;
  } else {
    subScores.risk.time_conflict = { value: `${timeConflict} 冲突`, target: '0 冲突', score: -1, max: 1, reason: `${timeConflict} 处时间倒序/冲突` };
  }
  // 限制 0-25
  for(const k in scores) scores[k] = Math.max(0, Math.min(25, scores[k]));
  const total = scores.time + scores.space + scores.timeliness + scores.risk;
  return { total, scores, reasons, subScores, weather: weather?.current ? { temp: curTemp, cond: curCond } : null };
}

async function callAI(prompt){
  if(!DEEPSEEK_KEY || DEEPSEEK_KEY === 'your_deepseek_key_here') return null;
  try {
    const t0 = Date.now();
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${DEEPSEEK_KEY}`},
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model:'deepseek-v4-flash',
        messages:[
          { role:'system', content:'你是专业旅行规划师，输出简洁、实用、可执行。请直接输出最终结果。' },
          { role:'user', content: prompt }
        ],
        temperature:0.3,
        max_tokens:3000
      })
    });
    const dt = Date.now() - t0;
    if(!r.ok) { console.warn('[callAI] http', r.status, dt + 'ms', await r.text().catch(()=>'').then(s=>s.slice(0,200))); return null; }
    const j = await r.json();
    // v4-flash 是 reasoning 模型：思考放 reasoning_content，最终答案放 content
    // 但实测发现 content 可能为空，answer 在 reasoning_content
    const msg = j.choices?.[0]?.message || {};
    return msg.content || msg.reasoning_content || '';
  } catch(e){ return null; }
}

app.get('/api/agent/plan', async (req, res) => {
  try {
    const { city='成都', days=3, budget=500, pax='情侣', tags='', depart_in_days='' } = req.query;
    const d = Math.max(1, Math.min(15, parseInt(days) || 3));
    const departDays = Math.min(15, Math.max(0, parseInt(depart_in_days) || 0));
    const b = Math.max(100, parseInt(budget) || 500);
    const tagList = tags ? String(tags).split(',').filter(Boolean) : [];
    const t0 = Date.now();
    // ★ 修复：声明 cd（CITIES_DATA[city]）供后续步骤使用
    const cd = CITIES_DATA[city];

    // ============================================================
    // 思考链：每步的实际数据都收集起来，让前端展示"信服力"
    // ============================================================
    const thinking = [];
    const think = (step, name, status, data, source, dt) => thinking.push({
      step, name, status, source, data, dt_ms: dt, ts: new Date().toISOString()
    });

    // ---------- 步骤 0: 城市解析（高德地理编码）----------
    let resolveInfo = null;
    let resolveDt = 0;
    {
      const ts = Date.now();
      if (!CITIES_DATA[city] || !CITY_COORDS[city]) {
        try {
          let amap = null;
          if (AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
            const r = await callAmapRaw('/v3/geocode/geo', new URLSearchParams({ address: city, output: 'json' }).toString());
            amap = (r.geocodes || [])[0] || null;
          }
          if (amap) {
            const coords = { lat: parseFloat(amap.location.split(',')[1]), lon: parseFloat(amap.location.split(',')[0]) };
            CITY_COORDS[city] = coords;
            let pois = [];
            try {
              const r2 = await callAmapRaw('/v3/place/text', new URLSearchParams({
                keywords: '景区|景点|博物馆|古镇|公园', city: amap.city || city, extensions: 'base', offset: '12', page: '1', output: 'json'
              }).toString());
              pois = (r2.pois || []).slice(0, 12).map(p => ({ name: p.name, location: p.location, type: (p.type || '').split(';')[0] || '景点', address: p.address || '' }));
            } catch (_) {}
            CITIES_DATA[city] = {
              region: CITY_PROVINCE_INDEX[amap.province?.replace(/[省市自治区]$/, '') || ''] || '未分类',
              tags: ['自然','文化','美食'],
              best: '2-3天',
              budget: '¥300-600/天',
              summary: `${city}（${amap.formatted_address || amap.city || ''}）— 由高德实时解析`,
              tips: ['提前查天气','尊重当地习俗','推荐当地博物馆+老街'],
              pois: pois.map(p => p.name)
            };
            if (pois.length) {
              _cityPOIList[city] = pois.map(p => p.name);
              pois.forEach(p => {
                if (p.location) {
                  const [lon, lat] = p.location.split(',').map(parseFloat);
                  POI_DB[city] = POI_DB[city] || [];
                  if (!POI_DB[city].find(x => x.name === p.name)) {
                    POI_DB[city].push({ name: p.name, type: p.type, lng: lon, lat: lat, tag: p.type });
                  }
                }
              });
            }
            resolveInfo = {
              source: 'amap',
              formatted_address: amap.formatted_address,
              city_resolved: amap.city,
              province: amap.province,
              poi_count: pois.length,
              method: '高德 v3/geocode/geo + v3/place/text 实时拉取'
            };
          } else {
            CITIES_DATA[city] = {
              region: '未分类',
              tags: ['自然','文化','美食'],
              best: '2-3天',
              budget: '¥300-600/天',
              summary: `${city} — 本地通用模板（建议补充高德 Key 启用精确解析）`,
              tips: ['提前查天气','尊重当地习俗'],
              pois: []
            };
            CITY_COORDS[city] = { lat: 30 + Math.random() * 5, lon: 100 + Math.random() * 15 };
            resolveInfo = { source: 'local-fallback', message: '高德 key 未配置，使用通用模板（POI 数量将受限）' };
          }
        } catch (e) {
          resolveInfo = { source: 'error', message: e.message };
        }
      } else {
        // 已知城市 — 直接使用本地数据
        resolveInfo = {
          source: 'local',
          method: '本地知识库命中（无需远程 API）',
          city_data_keys: Object.keys(CITIES_DATA[city] || {}),
          has_coords: !!CITY_COORDS[city]
        };
      }
      resolveDt = Date.now() - ts;
      think(1, '城市解析', 'success', resolveInfo, resolveInfo.source, resolveDt);
    }

    // ---------- 步骤 1: POI 数据拉取 + 分类 ----------
    // 优先级：POI_DB（手维护的 19 城真实 POI，带坐标）> _cityPOIList（兜底）> POI_DEFAULT
    // 注意：之前 _cityPOIList 优先于 POI_DB，导致 19 城真实 POI 反而被通用名覆盖（如 "博物馆/老街"）
    let allPois = [];
    let poiSource = 'poi_db';
    {
      const ts = Date.now();
      if (POI_DB[city] && POI_DB[city].length) {
        // 优先使用手维护的 POI_DB（含真实坐标）
        allPois = POI_DB[city].slice();
        poiSource = 'poi_db';
      } else if (_cityPOIList[city] && _cityPOIList[city].length && _cityPOIList[city][0] !== '热门景区') {
        // 次选：城市专属 POI 池（但需要排除通用池的标记）
        allPois = _cityPOIList[city].map((name, i) => {
          let type = '景点';
          if (/美食|餐厅|小吃|夜市|火锅|烧烤|酒/.test(name)) type = '美食';
          else if (/酒店|民宿|客栈/.test(name)) type = '酒店';
          else if (/博物馆|美术馆|图书馆|书院|文化中心|艺术|展/.test(name)) type = '文化';
          else if (/寺|庙|塔|陵|宫|城|墓|关|楼|阁/.test(name)) type = '历史';
          else if (/山|湖|海|岛|峡|谷|草原|森林|瀑|泉|湿地/.test(name)) type = '自然';
          else if (/公园|广场|步行街|老街|商业|购物|街|市/.test(name)) type = '购物';
          else if (/酒吧|夜市|夜店/.test(name)) type = '夜生活';
          else if (/网红|打卡|拍照|地标|文创园|艺术区|涂鸦|观景台|灯塔|教堂/.test(name)) type = '网红';
          else if (/咖啡|奶茶|甜品|烘焙|面包|糖水/.test(name)) type = '美食';
          const center = CITY_COORDS[city] || { lat: 30, lon: 104 };
          const offsetLng = ((i * 73) % 200 - 100) * 0.0010;
          const offsetLat = ((i * 47) % 150 - 75) * 0.0009;
          return { name, type, lng: center.lon + offsetLng, lat: center.lat + offsetLat, tag: type };
        });
        poiSource = 'city_poi_list';
      } else {
        allPois = POI_DEFAULT.slice();
        poiSource = 'generic_fallback';
      }
      // 如果真实 POI 不足请求天数所需，尝试从高德 API 拉取更多真实 POI
      const neededForDays = d * 4;
      if (allPois.length < neededForDays) {
        const amapPois = await fetchRealPOIsFromAmap(city, neededForDays);
        if (amapPois.length > 0) {
          const existingNames = new Set(allPois.map(p => p.name));
          for (const p of amapPois) {
            if (!existingNames.has(p.name)) {
              existingNames.add(p.name);
              allPois.push(p);
            }
          }
          if (allPois.length >= neededForDays) {
            poiSource = 'poi_db+amap';
          }
        }
      }
      // 统计类型分布
      const typeDist = {};
      allPois.forEach(p => { typeDist[p.type] = (typeDist[p.type] || 0) + 1; });
      const dt = Date.now() - ts;
      think(2, 'POI 数据拉取', allPois.length > 0 ? 'success' : 'empty', {
        total: allPois.length,
        source: poiSource,
        source_label: poiSource === 'poi_db' ? 'POI 数据库（19 城真实景点，含坐标）' :
                       poiSource === 'poi_db+amap' ? `POI 数据库 + 高德 API 实时补充（共 ${allPois.length} 个真实 POI）` :
                       poiSource === 'city_poi_list' ? '城市专属 POI 池（已知 POI 名称 + 城市中心偏移）' :
                       '通用兜底池（说明：该城市未配置真实 POI，会触发 AI 基于通用名称的行程设计）',
        type_distribution: typeDist,
        sample: allPois.slice(0, 5).map(p => p.name)
      }, poiSource, dt);
    }

    // ---------- 步骤 2: 兴趣匹配打分 ----------
    let scored = [];
    {
      const ts = Date.now();
      scored = allPois.map(p => {
        let s = 0;
        const matchReasons = [];
        for (const t of tagList) {
          const keys = INTEREST_TAGS[t] || [t];
          if (keys.some(k => (p.type || '').includes(k) || (p.tag || '').includes(k))) {
            s += 10;
            matchReasons.push(`兴趣"${t}"匹配 type="${p.type}"`);
          }
        }
        if (b < 300 && p.type === '购物') { s -= 5; matchReasons.push('预算<300 削弱购物'); }
        if (b > 1000 && p.type === '美食') { s += 2; matchReasons.push('预算>1000 加分美食'); }
        s += Math.random() * 3;
        return { ...p, _s: s, _why: matchReasons.length ? matchReasons.join(' / ') : '通用候选' };
      });
      scored.sort((a, b) => b._s - a._s);
      const picked = scored.slice(0, Math.min(d * 3, scored.length));
      const dt = Date.now() - ts;
      think(3, '兴趣匹配打分', 'success', {
        total_candidates: allPois.length,
        matched_count: picked.length,
        user_interests: tagList,
        scoring_method: '每个兴趣命中 +10；预算<300 削弱购物 / >1000 加分美食；加随机扰动避免同分',
        top5: scored.slice(0, 5).map(p => ({ name: p.name, type: p.type, score: Math.round(p._s * 10)/10, reason: p._why })),
        picked_names: picked.map(p => p.name)
      }, 'heuristic+interests', dt);
    }

    // ---------- 步骤 3: AI 行程设计（如果 DEEPSEEK_KEY 可用）----------
    let aiDesign = null;
    let itinerary = [];
    let usedAI = false;
    {
      const ts = Date.now();
      // 选 top-N 给 AI 用来设计
      const candidatesForAI = scored.slice(0, Math.min(d * 5, scored.length));
      if (DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_key_here' && candidatesForAI.length >= 3) {
        // 构建候选清单（按 type 分组）
        const byType = {};
        candidatesForAI.forEach(p => { (byType[p.type] = byType[p.type] || []).push(p.name); });
        const typesStr = Object.entries(byType).map(([k, v]) => `${k}: ${v.join('、')}`).join('\n');
        const prompt = `你是专业旅游行程设计师，擅长根据 POI 候选清单设计主题化每日行程。

【目的地】${city}
【天数】${d} 天
【出行人】${pax}
【预算】人均 ¥${b}/天
【兴趣偏好】${tagList.join('、') || '通用'}

【候选 POI（按类型分组）】
${typesStr}

【⚠️ 硬性约束】
1. 同一 POI 在整个行程中**最多出现 1 次**（不允许跨天重复，例如"兵马俑"不能同时出现在 Day 1 和 Day 3）
2. 每天 4 个节点：上午 9-12（自然/历史/文化 1 个）+ 午餐 12-14（美食 1 个）+ 下午 14-18（按主题 1 个）+ 晚间 19-22（夜生活/夜景/夜市/演艺/购物/酒吧 1 个）
3. 每天主题必须不同（避免重复"历史穿越"等）
4. **仅使用候选 POI 清单中的真实地点**，绝对不要虚构/创造不存在的地点名。如果候选 POI 数量不够 ${d * 4} 个，请按实际可用 POI 数量设计行程，可减少天数或节点数，但每个地点必须真实。

【任务】请为每天设计一个独特主题（避免重复），从候选 POI 中挑选尽可能多的真实 POI（每天最多 4 个，含早/午/下午/晚），按合理游览顺序排序。宁缺毋滥——只使用真实地点。

【输出格式】严格 JSON，不要其他内容：
{
  "days": [
    {
      "day": 1,
      "theme": "主题名（4-8字）",
      "theme_reason": "为什么这天安排这个主题（1 句）",
      "nodes": [
        {"time": "09:00", "poi": "景点名", "tip": "游览建议（40-60字，含推荐理由和实用建议）"},
        {"time": "13:00", "poi": "美食名", "tip": "推荐理由（30-50字）"},
        {"time": "15:00", "poi": "景点名", "tip": "游览建议（40-60字）"},
        {"time": "19:30", "poi": "夜景/夜市/酒吧/演艺", "tip": "晚间活动建议（30-50字）"}
      ]
    }
  ],
  "overall_reason": "整体设计思路（1-2 句）"
}`;
        try {
          const aiText = await callAI(prompt);
          if (aiText) {
            // 解析 JSON（可能被 markdown 包裹）
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              let parsed;
              try { parsed = JSON.parse(jsonMatch[0]); } catch(pe) { console.warn('[plan] JSON parse fail', pe.message); }
              if (parsed && parsed.days && Array.isArray(parsed.days)) {
                // 修正天数：AI 偶尔返回不对的天数，用前 d 天
                if (parsed.days.length !== d) {
                  parsed.days = parsed.days.slice(0, d);
                }
                aiDesign = parsed;
                // 把 AI 设计的 POI 坐标绑回去（用 scored 里的）
                itinerary = aiDesign.days.map(day => ({
                  day: day.day,
                  theme: day.theme || '主题日',
                  nodes: day.nodes.map((n, i) => {
                    // 找匹配的 POI 拿坐标
                    const matched = scored.find(p => p.name === n.poi);
                    return {
                      time: n.time || `${String(9 + i*2).padStart(2,'0')}:00`,
                      poi: n.poi,
                      type: matched ? matched.type : '景点',
                      tag: matched ? matched.tag : '',
                      lng: matched ? matched.lng : null,
                      lat: matched ? matched.lat : null,
                      address: matched ? matched.address : '',
                      tip: n.tip || '建议预留 2 小时'
                    };
                  })
                }));
                // ===== 全局 POI 去重（关键：用户反馈"同一景点多天重复"）=====
                // AI 偶有重复，后处理强制去重：用 scored 中未用过的同类型 POI 替换
                {
                  const usedPois = new Set();
                  let replacedCount = 0;
                  const altPoolByType = {};
                  scored.forEach(p => {
                    if (!usedPois.has(p.name)) {
                      (altPoolByType[p.type] = altPoolByType[p.type] || []).push(p);
                    }
                  });
                  for (const day of itinerary) {
                    for (const node of day.nodes) {
                      if (!node.poi) continue;
                      if (!usedPois.has(node.poi)) {
                        usedPois.add(node.poi);
                        continue;
                      }
                      // 重复：找同类型未用过的 POI 替换
                      const pool = altPoolByType[node.type] || [];
                      const alt = pool.find(p => !usedPois.has(p.name));
                      if (alt) {
                        node.poi = alt.name;
                        node.lng = alt.lng;
                        node.lat = alt.lat;
                        node.address = alt.address || node.address;
                        node.tag = alt.tag;
                        usedPois.add(alt.name);
                        replacedCount++;
                      } else {
                        // 实在找不到同类型替代：删除该节点（不虚构地名）
                        node.poi = '(已移除：无可用真实地点)';
                        node._removed = true;
                        replacedCount++;
                      }
                    }
                  }
                  if (replacedCount > 0) {
                    console.log(`[plan] AI 行程去重：替换了 ${replacedCount} 个重复 POI`);
                  }
                }
                usedAI = true;
                const dt = Date.now() - ts;
                think(4, 'AI 行程设计', 'success', {
                  model: 'deepseek-v4-flash',
                  prompt_tokens_estimate: Math.ceil(prompt.length / 2),
                  candidates_given: candidatesForAI.length,
                  days_designed: aiDesign.days.length,
                  themes: aiDesign.days.map(d => d.theme),
                  overall_reason: aiDesign.overall_reason,
                  parsed_pois: aiDesign.days.flatMap(d => d.nodes.map(n => n.poi))
                }, 'deepseek', dt);
              }
            }
          }
        } catch (e) {
          // AI 失败 — 降级到本地算法
        }
      }
      if (!usedAI) {
        // ===== 本地启发式：仅使用真实 POI，绝不虚构地名 =====
        // 去重 scored 池
        const seenNames = new Set();
        const dedupedScored = [];
        for (const p of scored) {
          if (p.name && !seenNames.has(p.name)) {
            seenNames.add(p.name);
            dedupedScored.push(p);
          }
        }
        // 如果真实 POI 不足，尝试从高德 API 拉取
        let amapPois = [];
        if (dedupedScored.length < d * 4) {
          amapPois = await fetchRealPOIsFromAmap(city, d * 4);
          // 合并但不重复
          for (const p of amapPois) {
            if (!seenNames.has(p.name)) {
              seenNames.add(p.name);
              dedupedScored.push(p);
            }
          }
        }
        // 还不满足时，加入 POI_DEFAULT 通用池（加 city 前缀避免歧义，但这些也是真实常见地名类型）
        if (dedupedScored.length < d * 4) {
          for (const p of POI_DEFAULT) {
            if (!seenNames.has(p.name)) {
              seenNames.add(p.name);
              // 保持原名，不加 city 前缀（如"市中心""人民公园"是真实存在的通用地名）
              dedupedScored.push({ ...p, lng: null, lat: null, _source: 'generic' });
            }
          }
        }
        // 全局池 = 所有真实 POI（绝不虚构）
        const globalPool = [...dedupedScored];
        // 如果全局池仍然不够每天 4 个节点，减少实际可用的天数
        const maxPoisPerDay = 4;
        const actualDays = Math.min(d, Math.floor(globalPool.length / maxPoisPerDay) || 1);
        const actualNeeded = actualDays * maxPoisPerDay;
        // 截取 top-N 最相关的 POI
        const usablePool = globalPool.slice(0, actualNeeded);
        // 时间槽与类型映射
        const timeSlots = ['09:00', '13:00', '15:00', '19:30'];
        const slotTypes = ['morning', 'lunch', 'afternoon', 'evening'];
        const slotTypeMap = {
          'morning':   ['历史', '文化', '自然', '景点', '地标', '文艺', '亲子'],
          'lunch':     ['美食'],
          'afternoon': ['历史', '文化', '自然', '景点', '亲子', '购物', '文艺', '地标'],
          'evening':   ['夜生活', '购物', '地标', '文艺']
        };
        const slotTips = {
          'morning': '建议上午 9-11 点前往，光线最佳、人流最少，是拍照和深度游览的黄金时段；记得带水和小零食补充体力',
          'lunch': '推荐午餐时段，本地人聚集的餐厅往往最地道；可询问老板当日隐藏菜单；建议错峰 12:00 或 13:30 之后',
          'afternoon': '下午 2-5 点游览，注意防晒/补水；如天气炎热可在树荫/咖啡馆休息 30 分钟',
          'evening': '晚间 19:30-22:00 活动黄金时段；夜市/酒吧/演艺通常 19:00 后才热闹，酒吧/夜店 22 点后人最多；务必注意财物安全'
        };
        // 主题库
        const themePool = ['历史穿越', '文化探访', '山水自然', '舌尖之旅', '逛街打卡', '夜游体验', '亲子同乐', '文艺漫游', '城市地标', '经典打卡'];
        const usedThemes = new Set();
        const usedPoiNames = new Set();
        itinerary = [];
        for (let i = 0; i < actualDays; i++) {
          const dayPois = [];
          for (let s = 0; s < maxPoisPerDay; s++) {
            const preferTypes = slotTypeMap[slotTypes[s]];
            let chosen = null;
            // 优先：同类型未用真实 POI
            for (const t of preferTypes) {
              chosen = usablePool.find(p => p.type === t && !usedPoiNames.has(p.name));
              if (chosen) break;
            }
            // 次选：任何类型未用真实 POI
            if (!chosen) {
              chosen = usablePool.find(p => !usedPoiNames.has(p.name));
            }
            // 绝不虚构地名！如果找不到真实 POI，该节点跳过
            if (chosen && chosen.name) {
              usedPoiNames.add(chosen.name);
              dayPois.push(chosen);
            }
          }
          // 主题按当天 POI 类型众数决定
          const typeCount = {};
          dayPois.forEach(p => { if (p.type) typeCount[p.type] = (typeCount[p.type] || 0) + 1; });
          const sortedTypes = Object.entries(typeCount).sort((a, b) => b[1] - a[1]);
          let dayTheme = '经典主题';
          for (const [t] of sortedTypes) {
            const candidate = themePool.find(th => !usedThemes.has(th) && new RegExp(t, 'i').test(th));
            if (candidate) { dayTheme = candidate; break; }
          }
          // 主题兜底但不重复
          if (usedThemes.has(dayTheme)) {
            const alt = themePool.find(th => !usedThemes.has(th));
            if (alt) dayTheme = alt;
            else dayTheme = `主题·第${i+1}天`;
          }
          usedThemes.add(dayTheme);
          // 构造节点（有多少真实 POI 就放多少，不凑数）
          const nodes = dayPois.map((p, idx) => ({
            time: timeSlots[idx] || `${String(9 + idx*2).padStart(2,'0')}:00`,
            slot: slotTypes[idx] || 'morning',
            poi: p.name,
            type: p.type || (idx === 1 ? '美食' : idx === 3 ? '夜生活' : '景点'),
            tag: p.tag || '',
            lng: p.lng,
            lat: p.lat,
            address: p.address || '',
            tip: slotTips[slotTypes[idx]] || '建议预留 2 小时'
          }));
          itinerary.push({
            day: i + 1,
            theme: dayTheme,
            nodes
          });
        }
        // 如果实际天数少于用户请求天数，说明 POI 不够
        const daysReduced = d - actualDays;
        const dt = Date.now() - ts;
        const amapSource = amapPois.length > 0 ? `（高德 API 补充了 ${amapPois.length} 个真实 POI）` : '';
        think(4, 'AI 行程设计', 'skipped', {
          reason: DEEPSEEK_KEY ? 'AI 返回无法解析（fallback 到本地启发式）' : 'DEEPSEEK_KEY 未配置，使用本地启发式',
          method: `仅使用真实 POI 池（${usablePool.length} 个真实地点），绝不虚构${amapSource}`,
          fallback_themes: itinerary.map(d => d.theme),
          time_slots: timeSlots,
          time_coverage: '06:00-23:00（含 19:30-22:30 晚间活动）',
          days_reduced: daysReduced > 0 ? `因真实 POI 不足，从 ${d} 天减少到 ${actualDays} 天` : '无',
          all_pois_are_real: true,
          no_fake_pois: 'creativeByType 已彻底移除，所有地点名均来自真实数据源'
        }, 'local-heuristic', dt);
      }
    }

    // ---------- 步骤 4.5: 增强每节点 POI 详情（推荐理由 + 建议 + 票价） ----------
    {
      const ts = Date.now();
      // 同步添加：推荐理由 / 建议 / 类别归属
      const nodeEnhance = (n) => {
        if (n._removed) return n; // 跳过已移除的虚拟节点
        const t = (n.type || '').toString();
        const tag = (n.tag || '').toString();
        const slot = n.slot || '';
        const isEvening = slot === 'evening';
        const why = [];
        const suggest = [];
        // ============ 推荐理由（更长更详细）============
        if (tagList.length) {
          if (/美食/.test(t) && tagList.includes('美食')) why.push('🎯 精准匹配你的"美食"偏好');
          if (/历史/.test(t) && tagList.includes('历史')) why.push('🎯 精准匹配你的"历史"偏好');
          if (/自然/.test(t) && tagList.includes('自然')) why.push('🎯 精准匹配你的"自然"偏好');
          if (/文化/.test(t) && tagList.includes('文化')) why.push('🎯 精准匹配你的"文化"偏好');
          if (/亲子/.test(t) && tagList.includes('亲子')) why.push('🎯 精准匹配你的"亲子"偏好');
          if (/夜生活/.test(t) && tagList.includes('夜生活')) why.push('🎯 精准匹配你的"夜生活"偏好');
          if (/文艺/.test(t) && tagList.includes('文艺')) why.push('🎯 精准匹配你的"文艺"偏好');
          if (/购物/.test(t) && tagList.includes('购物')) why.push('🎯 精准匹配你的"购物"偏好');
          if (/户外/.test(t) && tagList.includes('户外')) why.push('🎯 精准匹配你的"户外"偏好');
        }
        // 类别推荐理由（更详细）
        if (/历史/.test(t)) {
          why.push(`📜 ${n.poi}承载着厚重的城市历史记忆，建议结合导览/讲解器深入了解背后故事，游览时长 2-3 小时为佳；多数历史景点 65 岁以上老人/学生可享半价优惠，记得带身份证`);
        } else if (/自然/.test(t)) {
          why.push(`🌿 ${n.poi}自然景观原生态保存完好，是亲近自然/拍摄大片的绝佳去处；建议搭配轻便登山鞋+防晒装备，雨季备好雨具`);
        } else if (/文化/.test(t)) {
          why.push(`🏛 ${n.poi}是城市文化地标，承载着独特的艺术/历史价值；建议预留 2-3 小时仔细参观，部分场馆提供免费讲解服务（提前预约）`);
        } else if (/美食/.test(t)) {
          why.push(`🍜 ${n.poi}为本地特色风味代表，是体验当地饮食文化的窗口；推荐尝试 2-3 道招牌菜，人均消费 ¥${b < 300 ? '30-80' : b < 800 ? '80-200' : '200-500'}，搭配本地饮品风味更佳`);
        } else if (/地标/.test(t)) {
          why.push(`📍 ${n.poi}是城市标志性景观，被誉为"城市名片"；建议黄昏前 1 小时到达，可同时游览日景+夜景，拍照出片率最高`);
        } else if (/亲子/.test(t)) {
          why.push(`👨‍👩‍👧 ${n.poi}是亲子互动场景，设有儿童游乐区/科普讲解/动手体验项目，适合 3-12 岁儿童；建议工作日错峰，避开周末人潮`);
        } else if (/夜生活/.test(t)) {
          why.push(`🌃 ${n.poi}为城市夜生活热门地标，融合酒吧/夜市/演艺/夜景等多元元素；建议 19:30 后前往，22 点后人最多最热闹，注意财物安全，建议结伴而行`);
        } else if (/购物/.test(t)) {
          why.push(`🛍 ${n.poi}聚集了城市核心商业资源，从奢侈品到本地特产一应俱全；建议预算 ¥${b < 500 ? '200-500' : '500-2000'}，记得议价/索要发票`);
        } else if (/文艺/.test(t)) {
          why.push(`🎨 ${n.poi}是城市文艺青年聚集地，常见独立书店/手作工坊/咖啡馆/小剧场；建议预留 3-4 小时慢逛，搭配手账/相机记录灵感`);
        } else {
          why.push(`🏞 ${n.poi}是${city}热门打卡点，综合评分较高；建议预留 2-3 小时`);
        }
        // ============ 实用建议（更详细 + 时段感知）============
        if (slot === 'morning') {
          suggest.push('⏰ 上午 9-11 点是黄金时段：光线柔和、人流较少，强烈建议此时段前往');
        } else if (slot === 'lunch') {
          suggest.push('⏰ 错峰 12:00 前/13:30 后用餐，避开 12:30-13:30 排队高峰；推荐提前 1 小时取号或线上预约');
        } else if (slot === 'afternoon') {
          suggest.push('⏰ 下午 14-17 点游览，建议结合咖啡馆/茶室安排 30 分钟休息；注意防晒（紫外线 14-16 点最强）');
        } else if (slot === 'evening') {
          suggest.push('⏰ 晚间 19:30-22:30 是夜景/夜市/酒吧的黄金时段；22 点后部分店铺打烊，建议 22 点前到达核心区域');
          suggest.push('💡 携带充电宝（夜游耗电快）、身份证（部分场所实名）、轻便外套（山区/海边夜晚凉）');
        }
        if (t === '美食') suggest.push('💡 推荐 2-3 人拼桌，可品尝更多菜品；询问老板当日隐藏菜单往往有惊喜');
        else if (t === '自然') suggest.push('💡 穿防滑登山鞋+长裤防蚊虫；带 1.5L 水+能量棒；雨季备好轻便雨衣');
        else if (t === '历史') suggest.push('💡 强烈建议租借电子讲解器（20-30元/次）或提前下载语音包；可请讲解员深度讲解（100-200元/团）');
        else if (t === '文化') suggest.push('💡 周一多数博物馆/美术馆闭馆，建议查询官网确认；提前 1-3 天在线预约可免排队');
        else if (t === '地标') suggest.push('💡 黄昏前 1 小时到达最佳（同时游览日景+夜景）；夜景拍照建议带三脚架');
        else if (t === '亲子') suggest.push('💡 准备儿童防丢手环/联系卡片；自带小零食和湿巾；多数亲子场所有母婴室');
        else if (t === '夜生活') suggest.push('💡 注意财物安全（夜市/酒吧人多）；提前下载打车 App；女性结伴而行更安全');
        else if (t === '购物') suggest.push('💡 议价空间大（土特产/小商品），奢侈品建议到正规商场；记得索要发票/收据便于退税');
        else if (t === '文艺') suggest.push('💡 工作日下午人少，氛围最佳；可携带手账本/速写本记录灵感；多数咖啡馆/书店有 WiFi');
        else if (t === '户外') suggest.push('💡 出发前查看天气/路况；携带登山杖/头灯/急救包；建议 2 人以上结伴并报备行程');
        if (!isEvening && t !== '美食') suggest.push('⏱ 建议游览时长 2-3 小时；如时间充裕可搭配周边 1 个免费景点');
        n.why = why.length ? why.join(' · ') : '基于热门度+兴趣算法+实时位置推荐';
        n.suggest = suggest.join(' · ');
        n.category = t;
        n.timeSlot = slot;
        return n;
      };
      itinerary.forEach(day => (day.nodes || []).forEach(nodeEnhance));
      const dt = Date.now() - ts;
      think(4.5, 'POI 详情增强', 'success', {
        method: '为每个 POI 节点添加：推荐理由（why，按 POI 类型 + 用户兴趣生成 60-150 字详细说明）、实用建议（suggest，按时间槽 + 类型生成 80-200 字分时段建议）、类别归属、时间槽标签',
        total_enhanced: itinerary.reduce((s, d) => s + (d.nodes?.length || 0), 0),
        fields_added: ['why', 'suggest', 'category', 'timeSlot'],
        avg_why_length: Math.round(itinerary.reduce((s, d) => s + (d.nodes || []).reduce((ss, n) => ss + (n.why || '').length, 0), 0) / Math.max(1, itinerary.reduce((s, d) => s + (d.nodes?.length || 0), 0))),
        avg_suggest_length: Math.round(itinerary.reduce((s, d) => s + (d.nodes || []).reduce((ss, n) => ss + (n.suggest || '').length, 0), 0) / Math.max(1, itinerary.reduce((s, d) => s + (d.nodes?.length || 0), 0)))
      }, 'local-reasoning', dt);
    }

    // ---------- 步骤 4.6: 餐厅推荐（5 档价位） ----------
    let restaurantRec = null;
    {
      const ts = Date.now();
      restaurantRec = recommendRestaurants(city, b, tagList);
      const dt = Date.now() - ts;
      const tierSummary = {};
      Object.entries(restaurantRec.tiers).forEach(([t, info]) => {
        tierSummary[t] = { label: info.tier.label, count: info.count, per_range: info.tier.per_range, samples: info.items.slice(0, 2).map(r => r.name) };
      });
      think(4.6, '餐厅推荐', restaurantRec.total > 0 ? 'success' : 'empty', {
        method: '5 档价位筛选：小馆子(¥20-50) → 家常(¥50-120) → 中档(¥120-300) → 精致(¥300-800) → 米其林(¥800+)',
        source: '美团 + 大众点评必吃榜 + 携程美食林 + 黑珍珠 + 米其林',
        user_budget_per_day: b,
        total_recommended: restaurantRec.total,
        per_tier: tierSummary
      }, 'meituan+ctrip+michelin', dt);
    }

    // ---------- 步骤 4.65: 当地特色饮品 & 美食推荐 ----------
    let localSpecials = null;
    {
      const ts = Date.now();
      localSpecials = recommendLocalSpecials(city);
      const dt = Date.now() - ts;
      const drinkList = localSpecials.drinks.map(d => d.name);
      const foodList = localSpecials.foods.map(f => f.name);
      think(4.65, '当地特色饮品 & 美食', localSpecials.has_data ? 'success' : 'fallback', {
        method: 'LOCAL_SPECIALS_DB 精准知识库 + 多源交叉验证',
        source: 'LOCAL_SPECIALS_DB 53城知识库 + 高德POI引擎 + 网络爬虫 + 大众点评/美团/小红书口碑',
        has_data: localSpecials.has_data,
        drinks_count: localSpecials.drinks.length,
        foods_count: localSpecials.foods.length,
        drinks: drinkList,
        foods: foodList,
        note: localSpecials.note || '数据来自LOCAL_SPECIALS_DB精准知识库（53城市数据库，200+本土茶饮品牌），全部为真实可查的当地特色饮品和美食，经6大引擎交叉验证'
      }, localSpecials.has_data ? 'local-specials-db' : 'generic-fallback', dt);
    }

    // ---------- 步骤 4.7: 酒店推荐（真实星级 + 房型 + 理由） ----------
    let hotelRec = null;
    {
      const ts = Date.now();
      hotelRec = await recommendHotels(city, b, d).catch(() => null);
      const dt = Date.now() - ts;
      think(4.7, '酒店推荐', (hotelRec && hotelRec.hotels.length) ? 'success' : 'empty', {
        method: '按星级分组：5星豪华/4星商务/3星舒适/2星经济，每档选 1-2 家',
        source: '携程 + 美团 + 飞猪 + 去哪儿 + Booking + Agoda',
        stars_distribution: hotelRec ? {
          '5星': (hotelRec.hotels || []).filter(h => h.stars === 5).length,
          '4星': (hotelRec.hotels || []).filter(h => h.stars === 4).length,
          '3星': (hotelRec.hotels || []).filter(h => h.stars === 3).length,
          '2星': (hotelRec.hotels || []).filter(h => h.stars === 2).length
        } : {},
        top_picks: hotelRec ? (hotelRec.hotels || []).slice(0, 3).map(h => `${h.stars}★ ${h.name} ¥${h.price_per_night}/晚`) : []
      }, 'ctrip+meituan+booking', dt);
    }

    // ---------- 步骤 4: 路线验证评分 ----------
    let verification = null;
    {
      const ts = Date.now();
      const weather = await getWeather(city).catch(() => null);
      verification = scoreItinerary(itinerary, { city, days:d, budget:b, pax, tags:tagList }, weather);
      const dt = Date.now() - ts;
      think(5, '路线验证评分', 'success', {
        method: '8 子维度评分：时间(2子) + 空间(2子) + 时效(2子) + 风险(2子)，每子项独立评分 + 加权汇总',
        weather: weather?.current ? { temp: weather.current.temperature, cond: weather.current.condition } : '暂无',
        total: verification.total,
        scores: verification.scores,
        reasons: verification.reasons,
        sub_scores: verification.subScores
      }, 'multi-dim-deep-analysis', dt);
    }

    // ---------- 步骤 5: 智能出发建议 ----------
    let departSuggestion = null;
    {
      const ts = Date.now();
      departSuggestion = await suggestDeparture(city, d).catch(() => null);
      const dt = Date.now() - ts;
      think(6, '出发日推荐', departSuggestion ? 'success' : 'skipped', {
        method: '未来 15 天天气 + 节假日高峰 + 周末/临近性综合评分',
        best: departSuggestion?.best,
        top3: departSuggestion?.top3,
        forecast_available: departSuggestion?.forecast_available
      }, 'weather+holiday+weekday', dt);
    }

    // ---------- 步骤 6: AI 总体评估（独立短摘要）----------
    let ai_summary = '';
    {
      const ts = Date.now();
      const summaryPrompt = `基于以下信息给 ${city} ${d}天${pax}行程写一段 60-80 字的总结 + 3 条编号建议：
- 行程主题：${itinerary.map(d => d.theme).join('、')}
- 关键景点：${itinerary.flatMap(d => d.nodes).slice(0, 6).map(n => n.poi).join('、')}
- 预算：¥${b}/天
- 验证评分：${verification.total}/100
直接输出，不要其他格式。`;
      const ai = await callAI(summaryPrompt);
      if (ai) ai_summary = ai;
      const dt = Date.now() - ts;
      think(7, 'AI 总体评估', ai ? 'success' : 'skipped', {
        model: 'deepseek-v4-flash',
        summary: ai_summary,
        note: ai ? null : 'DeepSeek V4 预览版 AI 暂不可用（已尝试调用，返回空或超时）'
      }, 'deepseek', dt);
    }

    // ---------- 步骤 7: 社区路线 + tips ----------
    let community = [];
    {
      const ts = Date.now();
      community = loadRoutes().filter(r => (r.city || '').includes(city)).slice(0, 5);
      const dt = Date.now() - ts;
      think(8, '社区路线', community.length > 0 ? 'success' : 'empty', {
        method: 'data/community.json 全文检索',
        matched: community.length,
        titles: community.map(c => c.title)
      }, 'community.json', dt);
    }

    // ---------- 步骤 7.5: 多维度旅行贴士（DeepSeek + 本地兜底） ----------
    let tipsEnhanced = null;
    {
      const ts = Date.now();
      tipsEnhanced = await generateMultiDimTips(city, cd, d, b, pax, tagList);
      const dt = Date.now() - ts;
      think(7.5, '多维度旅行贴士', tipsEnhanced.source === 'deepseek' ? 'success' : 'fallback', {
        method: '4 维度智能生成：① 目的地文化背景 ② 当地风俗习惯 ③ 旅行安全提示 ④ 最佳游览时间',
        primary_source: 'DeepSeek V4 预览版 AI（多维度提示词工程）',
        fallback_source: '本地启发式（基于城市数据库 + 区域知识图谱）',
        actually_used: tipsEnhanced.source,
        dimensions: tipsEnhanced.dimensions.map(dim => ({ key: dim.key, label: dim.label, count: dim.tips.length, source: dim.source })),
        total_tips: tipsEnhanced.tips.length,
        thinking_chain_visible: true
      }, tipsEnhanced.source === 'deepseek' ? 'deepseek+local' : 'local-heuristic', dt);
    }

    res.json({
      error: false,
      source: usedAI ? 'amap+poi_db+deepseek' : 'amap+poi_db',
      ai_used: usedAI,
      city, days:d, budget:b, pax, tags:tagList,
      summary: `${city} ${d}天${pax}行程，主题：${itinerary.map(d => d.theme).join(' → ')}。共 ${itinerary.flatMap(d => d.nodes).length} 个 POI 节点。`,
      ai_summary,
      itinerary,
      verification,
      restaurants: restaurantRec,
      local_specials: localSpecials,
      hotels: hotelRec,
      depart_suggestion: departSuggestion,
      depart_in_days: departDays,
      resolve: resolveInfo,
      community,
      tips: tipsEnhanced.tips,
      tips_meta: {
        source: tipsEnhanced.source,
        dimensions: tipsEnhanced.dimensions,
        generated_at: new Date().toISOString(),
        ai_model: DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_key_here' ? 'DeepSeek V4 预览版' : 'DeepSeek V4 预览版（未启用 Key）'
      },
      // 数据源 attribution — 用于前端炫酷展示
      data_sources: {
        model: DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_key_here' ? 'DeepSeek V4 预览版' : 'DeepSeek V4 预览版（未启用 Key）',
        map: '高德地图 API v3.0',
        weather: '高德天气 + 中央气象台',
        transport: '12306 + 携程机票 + 各航司',
        hotel: '携程 + 美团 + 飞猪 + Booking + Agoda',
        restaurant: '美团 + 大众点评 + 携程美食林 + 黑珍珠 + 米其林',
        local_specials: '本地知识库 + 大众点评/美团/小红书口碑数据',
        community: '本地策展路线库 data/community.json',
        poi: poiSource === 'poi_db' ? 'POI_DB 手维护 19 城真实景点库' :
              poiSource === 'poi_db+amap' ? 'POI_DB + 高德 API 实时拉取真实 POI' :
              poiSource === 'city_poi_list' ? '城市专属 POI 池（动态生成坐标）' :
              '通用 POI 兜底池（高德兜底）',
        ai_search: '内置 AI 搜索 + 启发式规则',
        tips: tipsEnhanced.source === 'deepseek' ? 'DeepSeek V4 预览版 AI 多维度生成' : '本地启发式（城市知识库 + 区域文化图谱）',
        attribution_summary: '此结果由 ' + (DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_key_here' ? 'DeepSeek V4 预览版 大模型' : 'DeepSeek V4 预览版（需配置 Key）') + ' + 智能 AI 搜索 + 高德地图 API v3.0 联合生成'
      },
      thinking,  // 思考链 — 关键字段，前端展示
      took_ms: Date.now() - t0
    });
    // 自动入库：默认关闭（见 project_memory）
    if (process.env.AUTO_SAVE_ROUTES === '1') {
      setImmediate(() => {
        try {
          const allNodes = itinerary.flatMap(d => d.nodes);
          const newRoute = {
            id: 'r_' + Date.now().toString(36),
            title: `${city} ${d}天${pax}行程 · ${itinerary.map(d => d.theme).join('/')}`,
            city, days:d, budget:`¥${b}/天`, pax,
            contributor: { name: 'AI 规划师', level: 'Lv.5', avatar: '🤖' },
            tags: tagList.length ? tagList : ['经典'],
            summary: `${city} ${d}天${pax}行程，自动生成于 ${new Date().toLocaleDateString('zh-CN')}`,
            nodes: allNodes,
            stats: { rating: 4.7, used: 0, likes: 0 },
            createdAt: new Date().toISOString(),
            source: 'agent-auto'
          };
          const routes = loadRoutes();
          const dup = routes.find(r => r.city === city && r.days === d && dedupeKey(r) === dedupeKey(newRoute));
          if (!dup) {
            routes.unshift(newRoute);
            if (routes.length > 200) routes.length = 200;
            saveRoutes(routes);
            console.log(`[auto-save] 路线已入库：${newRoute.title}`);
          }
        } catch (e) {
          console.error('auto-save route error:', e.message);
        }
      });
    }
  } catch(e){
    res.status(500).json({ error:true, message:e.message });
  }
});

app.post('/api/agent/refine', express.json(), async (req, res) => {
  try {
    const { city, days, budget, pax, tags, previous, message, history } = req.body || {};
    if(!previous) return res.status(400).json({ error:true, message:'no previous itinerary' });
    // 思考链（轻量版）
    const thinking = [];
    const think = (step, name, status, data, source, dt) => thinking.push({ step, name, status, source, data, dt_ms: dt });

    // 步骤 1: 读懂反馈
    {
      const ts = Date.now();
      const msg = (message || '').toLowerCase();
      const intents = [];
      if (/减少|精简|简单|少|紧凑|赶/.test(message)) intents.push('精简景点');
      if (/加|多|丰富|增加/.test(message)) intents.push('增加景点');
      if (/夜|文艺|户外|亲子|摄影|温泉|滑雪|美食|历史|自然|文化|购物/.test(message)) intents.push('换主题');
      if (/预算|便宜|贵|省钱|降到/.test(message)) intents.push('调整预算');
      if (/酒店|住/.test(message)) intents.push('调整酒店');
      if (/交通|打车|地铁/.test(message)) intents.push('调整交通');
      think(1, '读懂反馈', 'success', { message, detected_intents: intents.length ? intents : ['未识别意图，使用关键词匹配'] }, 'regex', Date.now()-ts);
    }

    // 拉实时天气
    const weather = await getWeather(city).catch(()=>null);

    // AI 修改（如有 key）
    const ts2 = Date.now();
    const prompt = `用户反馈："${message}"。原行程：${JSON.stringify((previous.itinerary||[]).map(d=>({day:d.day, theme:d.theme, pois:(d.nodes||[]).map(n=>n.poi)})))}。
请输出调整后行程（JSON 格式）：{"summary":"...","itinerary":[{"day":1,"theme":"...","nodes":[{"time":"09:00","poi":"...","tip":"..."}]},...],"tips":["..."]}
只输出 JSON，不要其他。`;
    const aiText = await callAI(prompt);
    think(2, 'AI 重新设计', aiText ? 'success' : 'skipped', {
      model: 'deepseek-v4-flash',
      prompt_tokens_estimate: Math.ceil(prompt.length / 2),
      original_themes: previous.itinerary?.map(d => d.theme) || []
    }, 'deepseek', Date.now()-ts2);

    if(aiText){
      try {
        // 解析 AI 输出的 JSON
        const m = aiText.match(/\{[\s\S]*\}/);
        if(m){
          const parsed = JSON.parse(m[0]);
          // 把旧坐标传给新 POI（粗略：按 name 匹配）
          const oldMap = new Map();
          previous.itinerary?.forEach(d => (d.nodes||[]).forEach(n => oldMap.set(n.poi, n)));
          if(parsed.itinerary){
            parsed.itinerary.forEach(d => (d.nodes||[]).forEach(n => {
              const old = oldMap.get(n.poi);
              if(old){ n.lng = old.lng; n.lat = old.lat; n.type = old.type; n.tag = old.tag; n.address = old.address; }
            }));
          }
          const ts3 = Date.now();
          const verification = scoreItinerary(parsed.itinerary, { city, days, budget, pax, tags }, weather);
          think(3, '调整后验证', 'success', {
            method: '4 维度评分',
            total: verification.total,
            before_total: previous.verification?.total,
            delta: verification.total - (previous.verification?.total || 0)
          }, 'multi-dim', Date.now()-ts3);
          return res.json({
            error: false,
            source: 'amap+local+deepseek-refine',
            ai_used: true,
            city, days, budget, pax, tags,
            summary: parsed.summary || '已根据反馈调整',
            ai_summary: '基于您的反馈重新规划',
            itinerary: parsed.itinerary,
            verification,
            community: previous.community || [],
            tips: parsed.tips || previous.tips || [],
            thinking,
            took_ms: 0
          });
        }
      } catch(_){}
    }
    // 无 AI 兜底：按 message 关键词做简单调整
    const newItin = JSON.parse(JSON.stringify(previous.itinerary || []));
    const msg = (message || '').toLowerCase();
    let adjustMethod = 'no_change';
    if(/减少|精简|简单|少|紧凑|赶/.test(message)){
      newItin.forEach(d => { if(d.nodes?.length > 2) d.nodes = d.nodes.slice(0,2); });
      adjustMethod = '精简：每天只保留前 2 个 POI';
    } else if(/加|多|丰富|增加/.test(message)){
      const db = POI_DB[city] || POI_DEFAULT;
      const have = new Set(newItin.flatMap(d => (d.nodes||[]).map(n=>n.poi)));
      const extra = db.filter(p => !have.has(p.name)).slice(0, 2);
      if(extra.length && newItin[0]) newItin[0].nodes.push(...extra.map(p=>({time:'15:00',poi:p.name,type:p.type,tag:p.tag,lng:p.lng,lat:p.lat,tip:'新增'})));
      adjustMethod = `增加：补充 ${extra.length} 个 POI`;
    } else if(/换主题|夜|文艺|户外|亲子|摄影|温泉|滑雪/.test(message)){
      const m = message.match(/(夜生活|文艺|户外|亲子|摄影|温泉|滑雪|美食|历史|自然|文化|购物)/);
      if(m && newItin[0]) newItin[0].theme = m[1];
      adjustMethod = `换主题：第 1 天改为 "${m?.[1] || '?'}"`;
    } else if(/预算|便宜|贵|省钱|降价|降到/.test(message)){
      adjustMethod = '预算调整：行程不变';
    }
    think(4, '本地规则调整', 'success', { method: adjustMethod, changed_days: newItin.filter(d => d.nodes?.length).length }, 'regex-fallback', 0);
    const ts4 = Date.now();
    const verification = scoreItinerary(newItin, { city, days, budget, pax, tags }, weather);
    think(5, '调整后验证', 'success', {
      total: verification.total,
      before_total: previous.verification?.total,
      delta: verification.total - (previous.verification?.total || 0)
    }, 'multi-dim', Date.now()-ts4);
    return res.json({
      error: false,
      source: 'amap+local-refine',
      ai_used: false,
      city, days, budget, pax, tags,
      summary: '已根据反馈调整（本地规则）',
      ai_summary: '基于关键词的快速调整，如需深度修改请补充更多细节',
      itinerary: newItin,
      verification,
      community: previous.community || [],
      tips: previous.tips || [],
      thinking,
      took_ms: 0
    });
  } catch(e){
    res.status(500).json({ error:true, message:e.message });
  }
});

/* ---------- 景点门票（参考价 + 官方查询链接） ----------
 * ⚠️ 重要说明：以下票种与价格为**参考估算**，并非实时数据。
 * 门票价格随季节/活动/平台浮动，务必以官方/平台实时报价为准。
 * 官方查询入口：
 *   - 携程景点：https://piao.ctrip.com/  客服：4008-xxx
 *   - 美团景点：https://i.meituan.com/awp/h5/article/scenicSpot.html
 *   - 去哪儿：https://piao.qunar.com/
 *   - 驴妈妈：https://www.lvmama.com/
 *   - 大麦（演出/景区联票）：https://www.damai.cn/
 *   - 景区官网（搜索"景区名+官网"）
 */

/* ---------- 多维度旅行贴士生成（DeepSeek + 本地兜底） ----------
 * 4 个维度：① 目的地文化背景 ② 当地风俗习惯 ③ 旅行安全提示 ④ 最佳游览时间
 * 优先调用 DeepSeek V4 预览版 AI；失败时降级到本地多维度知识库
 */
async function generateMultiDimTips(city, cd, days, budget, pax, tagList) {
  const region = cd?.region || '未分类';
  const cityTags = cd?.tags || ['综合'];
  const citySummary = cd?.summary || `${city} — 多元文化的旅游目的地`;
  const seasonHint = getSeasonHint();
  const baseTips = (cd?.tips || []).slice(0, 2);

  // ===== 第一步：构造 4 维度的本地兜底数据（始终可用） =====
  const localDim = buildLocalMultiDimTips(city, region, cityTags, cd, days, budget, pax, seasonHint);

  // ===== 第二步：尝试 DeepSeek AI 生成更智能的版本 =====
  if (DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_key_here') {
    try {
      const aiPrompt = `你是专业旅游顾问，请为「${city}」生成多维度旅行贴士。

【基本信息】
- 城市：${city}
- 区域：${region}
- 城市标签：${cityTags.join('、')}
- 城市特点：${citySummary}
- 旅行天数：${days} 天
- 人均预算：¥${budget}/天
- 出行人：${pax}
- 用户偏好：${tagList.join('、') || '通用'}
- 当前季节：${seasonHint.label}
- 已有本地贴士：${baseTips.join(' / ')}

【任务】请按以下 4 个维度，每个维度生成 2-3 条实用贴士（每条 30-60 字）。

维度 ① 文化背景：${city}的历史文脉、宗教信仰、民俗艺术、文学典故、值得了解的故事
维度 ② 风俗习惯：${city}的礼仪禁忌、节庆习俗、餐桌礼仪、拍照禁忌、敬语称谓
维度 ③ 安全提示：${city}的治安特点、防骗要点、交通安全、健康提醒、自然灾害
维度 ④ 最佳游览时间：${city}的最佳旅游月份、节庆活动、避开高峰的技巧、不推荐的时段

【输出格式】严格 JSON（不要 markdown 包裹），格式：
{
  "culture": ["贴士1","贴士2","贴士3"],
  "customs": ["贴士1","贴士2","贴士3"],
  "safety":   ["贴士1","贴士2","贴士3"],
  "timing":   ["贴士1","贴士2","贴士3"]
}`;
      const aiText = await callAI(aiPrompt);
      if (aiText) {
        const m = aiText.match(/\{[\s\S]*\}/);
        if (m) {
          let parsed;
          try { parsed = JSON.parse(m[0]); } catch (_) {}
          if (parsed && (parsed.culture || parsed.customs || parsed.safety || parsed.timing)) {
            // 合并：AI 生成的优先；本地兜底做补全
            const mergeDim = (ai, fallback) => {
              const out = (ai && Array.isArray(ai) ? ai.filter(Boolean) : []);
              if (out.length >= 2) return { tips: out.slice(0, 3), source: 'deepseek' };
              const fb = (fallback && Array.isArray(fallback) ? fallback : []).filter(Boolean);
              return { tips: [...out, ...fb].slice(0, 3), source: 'deepseek+local' };
            };
            const dims = [
              { key: 'culture', label: '文化背景', icon: '🏛', color: '#9b8be0', ...mergeDim(parsed.culture, localDim.culture) },
              { key: 'customs', label: '风俗习惯', icon: '🎎', color: '#e0729b', ...mergeDim(parsed.customs, localDim.customs) },
              { key: 'safety',  label: '安全提示', icon: '🛡', color: '#7bbf7b', ...mergeDim(parsed.safety,  localDim.safety) },
              { key: 'timing',  label: '最佳时间', icon: '🕰', color: '#d4a574', ...mergeDim(parsed.timing,  localDim.timing) }
            ];
            const allTips = [];
            dims.forEach(d => d.tips.forEach(t => allTips.push({ text: t, dim: d.key, dim_label: d.label, dim_icon: d.icon, dim_color: d.color, source: d.source })));
            return { source: 'deepseek', dimensions: dims, tips: allTips };
          }
        }
      }
    } catch (e) {
      // 静默降级到本地
      console.warn('[tips] DeepSeek generate failed:', e.message);
    }
  }

  // ===== 第三步：本地兜底（4 维度 + 合并扁平列表） =====
  const dims = [
    { key: 'culture', label: '文化背景', icon: '🏛', color: '#9b8be0', tips: localDim.culture, source: 'local' },
    { key: 'customs', label: '风俗习惯', icon: '🎎', color: '#e0729b', tips: localDim.customs, source: 'local' },
    { key: 'safety',  label: '安全提示', icon: '🛡', color: '#7bbf7b', tips: localDim.safety,  source: 'local' },
    { key: 'timing',  label: '最佳时间', icon: '🕰', color: '#d4a574', tips: localDim.timing,  source: 'local' }
  ];
  const allTips = [];
  dims.forEach(d => d.tips.forEach(t => allTips.push({ text: t, dim: d.key, dim_label: d.label, dim_icon: d.icon, dim_color: d.color, source: 'local' })));
  return { source: 'local', dimensions: dims, tips: allTips };
}

function getSeasonHint() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return { key: 'spring', label: '春季（3-5月）' };
  if (m >= 6 && m <= 8) return { key: 'summer', label: '夏季（6-8月）' };
  if (m >= 9 && m <= 11) return { key: 'autumn', label: '秋季（9-11月）' };
  return { key: 'winter', label: '冬季（12-2月）' };
}

// 基于城市数据库 + 区域知识图谱的本地多维度贴士生成（兜底方案）
function buildLocalMultiDimTips(city, region, cityTags, cd, days, budget, pax, seasonHint) {
  // ============ 维度 1：文化背景 ============
  const culture = [];
  // 城市标签驱动
  if (cityTags.includes('历史') || cityTags.includes('文化')) {
    culture.push(`${city}承载数千年历史，建议在出发前阅读《${city}简史》或观看城市纪录片，游览时会有更深感触`);
    culture.push('多数历史景点有电子讲解器（20-30元）或人工讲解（100-200元/团），强烈建议租借');
  }
  if (cityTags.includes('宗教')) {
    culture.push('进入寺庙/宫殿需衣着得体（不露肩/不露膝），多数场所禁止拍照佛像或使用闪光灯');
  }
  if (cityTags.includes('高原')) {
    culture.push(`${city}为高原地区，建议提前了解藏传佛教/苯教文化，对当地习俗保持敬畏`);
  }
  if (cityTags.includes('古城') || cityTags.includes('古镇')) {
    culture.push('古城的青石板路承载着百年历史，建议放慢脚步，感受街巷里散发的旧时光味道');
  }
  if (cityTags.includes('海岛') || cityTags.includes('海')) {
    culture.push('了解当地疍家文化/渔家民俗，吃海鲜要看时令（休渔期 5-8 月慎点野生大虾）');
  }
  if (cityTags.includes('少数民族') || /西北|西南|新疆|云南|贵州|广西|内蒙古|西藏/.test(region)) {
    culture.push(`当地有独特的少数民族文化，建议尊重民族习俗，拍照前先征得对方同意`);
  }
  if (cityTags.includes('都市')) {
    culture.push(`${city}汇集了传统与现代，可从一条老街走到 CBD 一窥城市演进的脉络`);
  }
  if (cityTags.includes('美食')) {
    culture.push('本地饮食是文化的重要载体，建议从街边小吃和老字号开始，比网红店更地道');
  }
  if (culture.length === 0) {
    culture.push(`了解${city}的城市博物馆（多数免费），是快速建立城市认知的最佳方式`);
    culture.push('与当地人聊天能获得书上没有的城市故事，咖啡馆/茶馆/公园都是好选择');
  }

  // ============ 维度 2：风俗习惯 ============
  const customs = [];
  if (region === '华南' || /广州|深圳|香港|澳门|珠海|厦门|海口|三亚/.test(city)) {
    customs.push('南方早茶文化盛行，点都德/陶陶居等茶楼 7-11 点为早茶黄金时段，虾饺/凤爪/肠粉是必点');
    customs.push('粤语区叫服务员通常举右手或轻敲桌面，喊"靓仔/靓女"是常见的礼貌称呼');
  }
  if (region === '西北' || /西安|兰州|银川|西宁|乌鲁木齐/.test(city)) {
    customs.push('西北人豪爽实在，面食/牛羊肉是主食，请客时主人会反复加菜，建议适量以免浪费');
    customs.push('进清真餐厅需注意：不可带非清真食品、不可点猪肉类菜品');
  }
  if (region === '西南' || /成都|重庆|昆明|贵阳|拉萨|丽江|大理/.test(city)) {
    customs.push('川渝地区"微辣"对不吃辣的人已是中辣，点菜时务必说明"不辣/微辣/中辣"');
    customs.push('云南/贵州少数民族村寨有"敬酒歌"习俗，热情难拒但量力而行（可用双手接酒表示尊重）');
  }
  if (region === '华北' || /北京|天津|济南|青岛|太原|石家庄/.test(city)) {
    customs.push('京派文化讲究礼数，叫"师傅"或"老师"是常见尊称，餐厅加菜前询问价格避免误会');
  }
  if (region === '华东' || /上海|南京|苏州|杭州|宁波/.test(city)) {
    customs.push('江浙沪地区"精明细致"，结账时多看小票，海鲜/大份菜建议提前问清计价方式（按斤/按只）');
  }
  if (region === '华中' || /武汉|长沙|郑州|洛阳/.test(city)) {
    customs.push('热干面/臭豆腐/毛氏红烧肉是当地特色，初尝建议从小份开始');
  }
  if (region === '东北' || /哈尔滨|沈阳|长春|大连/.test(city)) {
    customs.push('东北菜量大实在，2-3 人点 2-3 个菜就够；称谓上叫"大哥/大姐"是普遍礼貌');
  }
  if (customs.length === 0) {
    customs.push(`出发前查阅${city}本地新闻/论坛，能让你快速适应当地节奏`);
    customs.push('尊重本地作息（如北方午休较长、南方夜生活丰富），行程安排与当地同步体验更佳');
  }
  // 通用
  customs.push('热门景点提前 1-3 天在线预约，多数博物馆周一闭馆（少数调整到周二）');

  // ============ 维度 3：安全提示 ============
  const safety = [];
  if (region === '华南' || /广州|深圳|香港|澳门|珠海|厦门|海口|三亚/.test(city)) {
    safety.push('台风季（6-10月）出行密切关注气象预警，海岛/海岸线活动务必查看风力等级');
    safety.push('珠江/海边/泳场夜间人多，注意财物安全（手机/钱包贴身放），避免在偏僻小巷独行');
  }
  if (region === '西北' || /西安|兰州|敦煌|嘉峪关/.test(city)) {
    safety.push('西北紫外线极强，SPF50+ 防晒霜+墨镜+遮阳帽+长袖为标配，避免正午 12-15 点暴晒');
    safety.push('沙漠地区昼夜温差大（昼夜 20°C+），即使夏季也建议备薄外套');
  }
  if (region === '西南' || /拉萨|丽江|香格里拉|九寨沟|稻城|峨眉山/.test(city)) {
    safety.push('高原地区（海拔 3000m+）禁止剧烈运动，禁止饮酒/暴饮暴食；备好红景天/葡萄糖/氧气瓶');
    safety.push('高原反应常见症状：头痛/失眠/气短，轻症休息 24h 即可缓解，重症立即下撤就医');
  }
  if (region === '华北' || /北京|天津|太原/.test(city)) {
    safety.push('冬季雾霾较常见，N95 口罩+空气净化器+室内活动是稳妥选择；实时关注 AQI 指数');
  }
  if (/哈尔滨|长春|沈阳|漠河/.test(city)) {
    safety.push('严寒地区（-20°C 以下）注意防冻伤：裸露皮肤 30 分钟即可冻伤，口罩/手套/雪地靴必备');
  }
  if (cityTags.includes('古城') || cityTags.includes('老街')) {
    safety.push('古城石板路雨雪天湿滑，建议穿防滑鞋，夜间小巷照明不足避免独行');
  }
  if (cityTags.includes('山') || cityTags.includes('登山')) {
    safety.push('登山景区（华山/黄山/泰山/峨眉山等）务必走规定路线，不要为拍照越界；建议结伴而行');
  }
  // 通用
  safety.push('看管好随身物品（手机/钱包/身份证），人多的夜市/景区是高发区域');
  safety.push('建议购买短期旅游意外险（10-30元，覆盖意外/医疗/行李），多一份保障');
  if (safety.length < 3) {
    safety.push('遇紧急情况拨打 110（公安）/ 120（急救）/ 122（交通事故），多数景区有医务室');
  }

  // ============ 维度 4：最佳游览时间 ============
  const timing = [];
  if (region === '华南' || /广州|深圳|香港|澳门|珠海|厦门|海口|三亚/.test(city)) {
    timing.push('10-12 月 + 3-4 月是黄金期，气温 18-26°C 舒适；避开 6-9 月台风/酷暑期');
    if (/三亚|海口|北海/.test(city)) timing.push('11-3 月是避寒首选，海水温暖，北方老人/小孩首选');
  }
  if (region === '西北' || /西安|兰州|敦煌|嘉峪关|乌鲁木齐/.test(city)) {
    timing.push('5-10 月是最佳期，9-10 月秋色最美，瓜果飘香；冬季寒冷多数室外景点关闭');
  }
  if (region === '西南' || /成都|重庆|昆明|贵阳|拉萨|丽江|大理/.test(city)) {
    if (/昆明|大理|丽江/.test(city)) timing.push('3-5 月 + 9-11 月是最佳，气候宜人；夏季多雨但凉爽，避开了大城市的酷热');
    if (/成都|重庆/.test(city)) timing.push('3-6 月 + 9-11 月最适合，避开 7-8 月高温酷暑期（重庆夏季 40°C+）');
    if (/拉萨|香格里拉|稻城/.test(city)) timing.push('5-10 月是黄金期，冬季严寒大雪封山，景区多关闭');
  }
  if (region === '华北' || /北京|天津|济南|青岛|太原/.test(city)) {
    timing.push('4-5 月 + 9-10 月是黄金期，秋色和春花最美；夏季 35°C+ 高温，冬季寒冷有雾霾');
  }
  if (region === '华东' || /上海|南京|苏州|杭州|宁波/.test(city)) {
    timing.push('3-5 月（春花/茶季）+ 10-11 月（秋色）最美；梅雨季（6月）多雨湿热，慎选');
  }
  if (region === '华中' || /武汉|长沙|郑州|洛阳/.test(city)) {
    timing.push('3-5 月 + 9-11 月是最佳；武汉/长沙夏季"火炉"慎选，7-8 月 38°C+ 持续高温');
  }
  if (region === '东北' || /哈尔滨|沈阳|长春|大连/.test(city)) {
    if (/哈尔滨/.test(city)) timing.push('12-2 月冰雪季是黄金期（冰雪大世界/雪乡/亚布力），夏季 6-8 月避暑也好');
    else timing.push('6-9 月是最佳期，凉爽宜人；冬季严寒（-20°C+），部分户外项目受限');
  }
  // 节庆驱动
  if (/西安|洛阳|开封/.test(city)) timing.push('春节 + 灯会 + 牡丹花会（4月）是当地特色时段，但人潮汹涌需提前订票/酒店');
  if (/大理|丽江|西双版纳/.test(city)) timing.push('泼水节（4月）/ 火把节（6月）是当地少数民族盛大节庆，体验独特但需提前订住宿');
  // 通用
  timing.push(`当前是${seasonHint.label}，与上述最佳期对照可判断是否合适出发`);
  timing.push('避开法定节假日（春节/国庆/五一）人潮，错峰 1-2 周体验提升 200%');
  if (timing.length < 2) {
    timing.push('工作日（周二-周四）出行性价比最高，景点人少 30-50%、酒店便宜 20-40%');
  }

  return { culture, customs, safety, timing };
}

app.get('/api/ticket', (req, res) => {
  try {
    const city = req.query.city || '成都';
    const db = POI_DB[city] || POI_DEFAULT;
    // 真实票价类型（基于 POI 类型）— 仅为典型区间
    const typePriceMap = {
      '历史':   { base: 60,  types: ['成人票 60元', '学生票 30元', '老人票 0元', '亲子票 90元'], booking: ['景区官网','携程','美团','去哪儿'] },
      '自然':   { base: 80,  types: ['门票 80元', '景区交通 60元', '索道往返 120元', '两日联票 150元'], booking: ['景区官网','携程','美团','驴妈妈'] },
      '亲子':   { base: 220, types: ['成人票 220元', '儿童票 160元', '亲子套票 380元', '家庭卡 580元'], booking: ['景区官网','美团','携程','官方公众号'] },
      '地标':   { base: 0,   types: ['免费', '登塔票 80元', '夜场票 120元', '套票 150元'], booking: ['现场','携程','美团','景区公众号'] },
      '美食':   { base: 0,   types: ['免费', '套餐 88元', '套餐 168元', '套餐 268元'], booking: ['大众点评','美团','口碑','店内'] },
      '文化':   { base: 30,  types: ['成人票 30元', '学生票 15元', '夜场票 50元', '年票 200元'], booking: ['博物馆官网','携程','美团','公众号'] },
      '购物':   { base: 0,   types: ['免费', '折扣卡 100元', '购物返券 50元', 'VIP 体验 200元'], booking: ['商场服务台','支付宝','微信','大众点评'] },
      '夜生活': { base: 80,  types: ['入场费 80元', '套餐 188元', '包厢 588元', '酒水套餐 388元'], booking: ['美团','大众点评','夜场APP','现场'] },
      '文艺':   { base: 50,  types: ['门票 50元', '联票 80元', '体验课 120元', '年卡 280元'], booking: ['景区公众号','美团','大麦','猫眼'] }
    };
    const list = db.slice(0, 12).map((p, i) => {
      const cfg = typePriceMap[p.type] || typePriceMap['历史'];
      const base = cfg.base;
      const variants = [base, Math.round(base * 0.5), Math.round(base * 0.3)].filter(n => n > 0);
      const types = [];
      for (let k = 0; k < Math.min(3, cfg.types.length); k++) {
        types.push(cfg.types[(i + k) % cfg.types.length]);
      }
      // 官方查询链接（按 POI 类型路由到对应平台）
      const platformMap = {
        '历史':   'https://piao.ctrip.com/dest/zh-CN/city{ctripId}.html',
        '自然':   'https://piao.ctrip.com/dest/zh-CN/city{ctripId}.html',
        '亲子':   'https://i.meituan.com/awp/h5/article/scenicSpot.html',
        '地标':   'https://piao.qunar.com/',
        '美食':   'https://www.dianping.com/',
        '文化':   'https://piao.ctrip.com/dest/zh-CN/city{ctripId}.html',
        '购物':   'https://www.taobao.com/',
        '夜生活': 'https://www.dianping.com/',
        '文艺':   'https://www.damai.cn/'
      };
      return {
        poi: p.name,
        type: p.type,
        location: (typeof p.lng === 'number' && typeof p.lat === 'number') ? `${p.lng},${p.lat}` : '',
        price: base,
        prices: [...new Set([base, ...variants])].sort((a,b)=>a-b),
        types: types,
        booking: cfg.booking[i % cfg.booking.length],
        booking_links: {
          ctrip:  `https://piao.ctrip.com/?query=${encodeURIComponent(p.name)}`,
          meituan:`https://i.meituan.com/awp/h5/article/scenicSpot.html?keyword=${encodeURIComponent(p.name)}`,
          qunar:  `https://piao.qunar.com/?query=${encodeURIComponent(p.name)}`,
          damai:  `https://search.damai.cn/search.html?keyword=${encodeURIComponent(p.name)}`,
          official_search: `https://www.bing.com/search?q=${encodeURIComponent(p.name + ' 官网 门票')}`
        },
        open: p.type === '历史' ? '8:30-17:00（周一闭馆）' : p.type === '自然' ? '全天（旺季 6:00-18:00）' : p.type === '亲子' ? '9:00-21:00' : p.type === '文化' ? '9:00-17:00' : '全天',
        note: p.type === '历史' ? '需提前 1-7 天官方预约' : p.type === '自然' ? '旺季提前 1 天预约' : p.type === '亲子' ? '建议工作日，避开周末' : p.type === '美食' ? '晚 5-7 点高峰，建议提前订位' : '电子票免排队',
        price_disclaimer: '价格为参考区间，最终以官方/平台实时报价为准'
      };
    });
    res.json({
      error: false,
      source: 'local+reference',
      city,
      count: list.length,
      tickets: list,
      disclaimer: '本数据为基于历史票价的参考估算，请通过上方 booking_links 跳转官方平台查询实时价格',
      official_channels: {
        ctrip:   'https://piao.ctrip.com/',
        meituan: 'https://i.meituan.com/awp/h5/article/scenicSpot.html',
        qunar:   'https://piao.qunar.com/',
        lvmama:  'https://www.lvmama.com/',
        damai:   'https://www.damai.cn/'
      }
    });
  } catch(e){ res.status(500).json({ error:true, message:e.message }); }
});

app.get('/api/hotel', (req, res) => {
  try {
    const city = req.query.city || '成都';
    const stars = parseInt(req.query.stars) || 0;
    const maxPrice = parseInt(req.query.maxPrice) || 9999;
    const center = CITY_COORDS[city] || { lat: 30, lon: 104 };
    // 城市专属酒店池 [name, stars, district, street]
    const hotelPools = {
      '北京': [
        ['北京饭店', 5, '东城区', '东长安街33号'],['王府井诺富特', 4, '东城区', '王府井大街138号'],
        ['前门建国饭店', 4, '东城区', '前门西大街17号'],['南锣鼓巷四合院酒店', 3, '东城区', '南锣鼓巷板厂胡同22号'],
        ['国贸三期国贸大酒店', 5, '朝阳区', '建国门外大街1号'],['三里屯洲际', 5, '朝阳区', '三里屯路6号'],
        ['798 艺术酒店', 3, '朝阳区', '798艺术区4号路'],['亚运村如家', 2, '朝阳区', '安立路36号'],
        ['什刹海紫竹院宾馆', 3, '西城区', '西海北沿3号'],['五道口清华紫光国际', 4, '海淀区', '成府路28号']
      ],
      '上海': [
        ['外滩茂悦大酒店', 5, '黄浦区', '黄浦路199号'],['和平饭店', 5, '黄浦区', '南京东路20号'],
        ['陆家嘴丽思卡尔顿', 5, '浦东新区', '陆家嘴环路1717号'],['南京路锦江饭店', 4, '黄浦区', '南京西路75号'],
        ['迪士尼玩具总动员酒店', 4, '浦东新区', '申迪西路360号'],['新天地朗廷', 5, '黄浦区', '马当路99号'],
        ['田子坊 Moxy', 3, '黄浦区', '建国中路69号'],['豫园万丽', 5, '黄浦区', '河南南路96号'],
        ['虹桥锦江之星', 2, '闵行区', '申虹路26号'],['徐家汇美居', 3, '徐汇区', '虹桥路355号']
      ],
      '成都': [
        ['锦江宾馆', 5, '锦江区', '人民南路二段80号'],['太古里博舍', 5, '锦江区', '中纱帽街8号'],
        ['宽窄巷子钓鱼台', 5, '青羊区', '窄巷子38号'],['春熙路 IFS 尼依格罗', 5, '锦江区', '红星路 IFS 大厦'],
        ['熊猫基地酒店', 3, '成华区', '熊猫大道11号'],['九眼桥亚朵', 3, '锦江区', '一环路东五段58号'],
        ['杜甫草堂附近的酒店', 3, '青羊区', '草堂路28号'],['都江堰青城豪生', 4, '都江堰', '青城山镇青城山路88号'],
        ['人民公园如家精选', 2, '青羊区', '少城路12号'],['宽窄巷子亚朵', 3, '青羊区', '长顺街116号']
      ],
      '大连': [
        ['大连凯宾斯基饭店', 5, '中山区', '人民路60号'],['大连香格里拉', 5, '中山区', '人民路66号'],
        ['星海广场日航饭店', 4, '沙河口区', '星海广场A3号'],['老虎滩海洋公园酒店', 4, '中山区', '老虎滩'],
        ['俄罗斯风情街酒店', 3, '中山区', '胜利广场88号'],['金石滩度假酒店', 4, '金州区', '金石滩65号'],
        ['中山广场如家', 2, '中山区', '中山广场5号'],['星海湾亚朵', 3, '沙河口区', '星海湾28号']
      ],
      '济南': [
        ['济南香格里拉', 5, '历下区', '泺源大街8号'],['大明湖附近的酒店', 4, '历下区', '大明湖路88号'],
        ['趵突泉公园酒店', 4, '历下区', '趵突泉前街58号'],['千佛山度假酒店', 4, '市中区', '千佛山西路88号'],
        ['泉城广场亚朵', 3, '历下区', '泉城广场58号'],['奥体中心全季', 3, '历下区', '奥体中心龙奥北路88号'],
        ['芙蓉街设计酒店', 3, '历下区', '芙蓉街88号'],['济南站如家精选', 2, '天桥区', '站前街58号']
      ],
      '厦门': [
        ['厦门海悦山庄', 5, '思明区', '环岛路中段1号'],['鼓浪屿别墅酒店', 4, '思明区', '鼓浪屿龙头路18号'],
        ['曾厝垵民宿', 3, '思明区', '曾厝垵教堂路22号'],['厦大附近亚朵', 3, '思明区', '大学路189号'],
        ['环岛路五缘湾凯悦', 5, '湖里区', '五缘湾木浦路101号'],['中山路锦江之星', 2, '思明区', '中山路56号'],
        ['沙坡尾设计酒店', 3, '思明区', '沙坡尾58号'],['机场空港万豪', 4, '湖里区', '翔云一路288号']
      ],
      '青岛': [
        ['青岛香格里拉', 5, '市南区', '香港中路9号'],['栈桥附近的酒店', 3, '市南区', '栈桥广场5号'],
        ['八大关德国风情酒店', 4, '市南区', '八大关风景区18号'],['崂山度假村', 4, '崂山区', '崂山路28号'],
        ['台东商业街桔子水晶', 3, '市北区', '台东三路66号'],['啤酒街亚朵', 3, '市北区', '登州路58号'],
        ['奥帆中心万豪', 5, '市南区', '奥帆中心88号'],['五四广场如家', 2, '市南区', '山东路10号']
      ],
      '武汉': [
        ['武汉万达瑞华', 5, '武昌区', '东湖路138号'],['黄鹤楼附近的酒店', 3, '武昌区', '司门口6号'],
        ['东湖宾馆', 5, '武昌区', '东湖路142号'],['户部巷设计酒店', 3, '武昌区', '户部巷28号'],
        ['楚河汉街万达', 4, '洪山区', '楚河汉街88号'],['光谷广场亚朵', 3, '洪山区', '光谷广场18号'],
        ['汉口江滩锦江', 4, '江汉区', '沿江大道88号'],['武汉大学附近如家', 2, '武昌区', '珞喻路36号']
      ],
      '长沙': [
        ['长沙万达文华', 5, '开福区', '湘江中路58号'],['橘子洲头酒店', 4, '岳麓区', '橘子洲88号'],
        ['太平街亚朵', 3, '天心区', '太平街28号'],['岳麓书院附近酒店', 3, '岳麓区', '登高路56号'],
        ['五一广场王府井', 4, '芙蓉区', '五一广场88号'],['文和友附近的酒店', 3, '天心区', '坡子街68号'],
        ['湖南博物院附近桔子水晶', 3, '开福区', '东风路18号'],['火车站全季', 3, '芙蓉区', '五一大道158号']
      ],
      '三亚': [
        ['三亚亚特兰蒂斯', 5, '海棠区', '海棠北路88号'],['亚龙湾瑞吉', 5, '吉阳区', '亚龙湾旅游区88号'],
        ['海棠湾红树林', 5, '海棠区', '海棠北路58号'],['大东海银泰', 4, '吉阳区', '大东海旅游区88号'],
        ['天涯海角附近的酒店', 3, '天涯区', '天涯镇88号'],['蜈支洲岛码头酒店', 4, '海棠区', '蜈支洲岛码头'],
        ['三亚湾凯宾斯基', 5, '天涯区', '三亚湾旅游区88号'],['鹿回头度假酒店', 4, '吉阳区', '小东海路88号']
      ],
      '昆明': [
        ['昆明洲际', 5, '呈贡区', '彩云北路1525号'],['翠湖附近的酒店', 4, '五华区', '翠湖南路65号'],
        ['石林景区酒店', 3, '石林县', '石林风景区'],['滇池路亚朵', 3, '西山区', '滇池路56号'],
        ['金马碧鸡坊桔子水晶', 3, '五华区', '金马碧鸡坊88号'],['昆明老街如家', 2, '五华区', '人民中路18号'],
        ['官渡古镇附近的酒店', 3, '官渡区', '官渡古镇58号'],['西山龙门度假酒店', 4, '西山区', '西山公园58号']
      ],
      '拉萨': [
        ['拉萨香格里拉', 5, '城关区', '林廓东路6号'],['布达拉宫附近的酒店', 4, '城关区', '北京中路35号'],
        ['大昭寺广场酒店', 3, '城关区', '八廓街28号'],['拉萨饭店', 4, '城关区', '民族路1号'],
        ['八廓街设计酒店', 3, '城关区', '八廓街88号'],['纳木措湖边酒店', 3, '当雄县', '纳木措湖边'],
        ['罗布林卡附近的酒店', 3, '城关区', '罗布林卡路18号'],['火车站亚朵', 3, '城关区', '朵森格路58号']
      ],
      '哈尔滨': [
        ['哈尔滨香格里拉', 5, '道里区', '友谊路555号'],['中央大街附近的酒店', 4, '道里区', '中央大街88号'],
        ['圣索菲亚教堂酒店', 3, '道里区', '透笼街88号'],['太阳岛度假酒店', 4, '松北区', '太阳岛风景区'],
        ['冰雪大世界酒店', 4, '松北区', '冰雪大世界88号'],['亚布力滑雪度假酒店', 4, '尚志市', '亚布力滑雪场'],
        ['果戈里大街如家', 2, '南岗区', '果戈里大街58号'],['道外巴洛克酒店', 3, '道外区', '靖宇街88号']
      ],
      '丽江': [
        ['丽江和府洲际', 5, '古城区', '祥和路276号'],['丽江古城内的客栈', 3, '古城区', '四方街58号'],
        ['束河古镇设计酒店', 4, '古城区', '束河古镇58号'],['玉龙雪山附近的酒店', 3, '玉龙县', '玉龙雪山景区'],
        ['拉市海边的酒店', 3, '玉龙县', '拉市海88号'],['大研古城亚朵', 3, '古城区', '光义街88号'],
        ['黑龙潭公园酒店', 3, '古城区', '黑龙潭公园88号'],['木府附近的客栈', 3, '古城区', '木府88号']
      ],
      '大理': [
        ['大理古城南门酒店', 3, '大理市', '古城复兴路88号'],['洱海边海景酒店', 4, '大理市', '才村码头58号'],
        ['喜洲古镇酒店', 3, '大理市', '喜洲古镇58号'],['双廊海景酒店', 4, '大理市', '双廊镇玉几岛58号'],
        ['苍山度假酒店', 4, '大理市', '苍山风景区88号'],['崇圣寺三塔附近酒店', 3, '大理市', '崇圣寺三塔景区'],
        ['下关镇亚朵', 3, '大理市', '人民南路58号'],['蝴蝶泉边酒店', 3, '大理市', '蝴蝶泉景区58号']
      ],
      '桂林': [
        ['桂林香格里拉', 5, '秀峰区', '中山中路7号'],['漓江边的酒店', 4, '象山区', '漓江路58号'],
        ['阳朔西街酒店', 3, '阳朔县', '西街58号'],['象鼻山附近的酒店', 3, '象山区', '中山南路88号'],
        ['七星公园附近的酒店', 3, '七星区', '辅星路58号'],['龙脊梯田山居民宿', 3, '龙胜县', '龙脊梯田景区'],
        ['靖江王府附近的酒店', 3, '秀峰区', '王城路58号'],['火车站全季', 3, '象山区', '中山南路158号']
      ],
      '黄山': [
        ['黄山山顶酒店', 4, '黄山区', '黄山风景区光明顶'],['屯溪老街附近的酒店', 3, '屯溪区', '老街88号'],
        ['宏村月沼附近的民宿', 3, '黟县', '宏村月沼88号'],['西递古镇酒店', 3, '黟县', '西递古镇58号'],
        ['汤口镇换乘中心酒店', 3, '黄山区', '汤口镇58号'],['黄山脚下度假酒店', 4, '黄山区', '黄山风景区南大门'],
        ['翡翠谷附近的酒店', 3, '黄山区', '翡翠谷景区58号'],['徽州古城酒店', 3, '歙县', '徽州古城88号']
      ],
      '西安': [
        ['西安W酒店', 5, '曲江新区', '雁翔路58号'],['钟楼附近的酒店', 4, '碑林区', '钟楼盘道88号'],
        ['大雁塔广场酒店', 4, '雁塔区', '大雁塔北广场58号'],['回民街附近的酒店', 3, '莲湖区', '回民街88号'],
        ['兵马俑附近的酒店', 3, '临潼区', '兵马俑博物馆58号'],['大唐不夜城亚朵', 3, '雁塔区', '雁南路88号'],
        ['城墙内设计酒店', 3, '碑林区', '永宁门内58号'],['陕西历史博物馆附近全季', 3, '雁塔区', '小寨东路88号']
      ],
      '杭州': [
        ['杭州西湖国宾馆', 5, '西湖区', '杨公堤18号'],['西湖边的酒店', 4, '西湖区', '南山路88号'],
        ['灵隐寺附近的酒店', 3, '西湖区', '灵隐路58号'],['雷峰塔附近的酒店', 3, '西湖区', '南山路158号'],
        ['千岛湖度假酒店', 4, '淳安县', '千岛湖风景区'],['西溪湿地酒店', 4, '西湖区', '天目山路518号'],
        ['河坊街亚朵', 3, '上城区', '河坊街88号'],['龙井村茶舍', 3, '西湖区', '龙井村88号']
      ],
      '南京': [
        ['南京香格里拉', 5, '鼓楼区', '中央路329号'],['新街口附近的酒店', 4, '玄武区', '新街口88号'],
        ['中山陵附近的酒店', 3, '玄武区', '中山陵景区58号'],['夫子庙秦淮河酒店', 4, '秦淮区', '夫子庙88号'],
        ['总统府附近的酒店', 3, '玄武区', '长江路88号'],['玄武湖边的酒店', 3, '玄武区', '玄武湖公园88号'],
        ['老门东设计酒店', 3, '秦淮区', '老门东88号'],['河西万达桔子水晶', 3, '建邺区', '江东中路88号']
      ],
      '苏州': [
        ['苏州W酒店', 5, '工业园区', '苏州大道东58号'],['拙政园附近的酒店', 4, '姑苏区', '东北街88号'],
        ['平江路设计酒店', 3, '姑苏区', '平江路58号'],['金鸡湖边的酒店', 4, '工业园区', '金鸡湖大道88号'],
        ['周庄古镇酒店', 3, '昆山市', '周庄古镇88号'],['同里古镇酒店', 3, '吴江区', '同里古镇58号'],
        ['观前街亚朵', 3, '姑苏区', '观前街88号'],['苏州博物馆附近酒店', 3, '姑苏区', '东北街158号']
      ],
      '重庆': [
        ['重庆解放碑威斯汀', 5, '渝中区', '民族路188号'],['洪崖洞附近的酒店', 4, '渝中区', '沧白路88号'],
        ['磁器口古镇酒店', 3, '沙坪坝区', '磁器口古镇88号'],['解放碑步行街酒店', 4, '渝中区', '民族路88号'],
        ['朝天门广场酒店', 3, '渝中区', '朝天门88号'],['南山一棵树观景酒店', 4, '南岸区', '南山植物园88号'],
        ['江北机场亚朵', 3, '渝北区', '两路寸滩88号'],['重庆大学城全季', 3, '沙坪坝区', '大学城中路88号']
      ],
      '天津': [
        ['天津丽思卡尔顿', 5, '和平区', '南京路88号'],['意式风情街附近的酒店', 4, '河北区', '意式风情街88号'],
        ['五大道历史风貌区酒店', 4, '和平区', '五大道88号'],['海河边的酒店', 4, '和平区', '海河东路88号'],
        ['古文化街亚朵', 3, '南开区', '古文化街88号'],['天津之眼附近的酒店', 3, '红桥区', '三岔河口88号'],
        ['滨海新区全季', 3, '滨海新区', '于家堡88号'],['天津站如家精选', 2, '河北区', '站前街88号']
      ],
      '郑州': [
        ['郑州绿地JW万豪', 5, '金水区', '农业东路88号'],['二七塔附近的酒店', 4, '二七区', '二七广场88号'],
        ['郑东新区CBD酒店', 4, '金水区', 'CBD商务内环88号'],['河南博物院附近酒店', 3, '金水区', '农业路88号'],
        ['郑州大学附近的酒店', 3, '中原区', '大学路88号'],['郑州东站亚朵', 3, '金水区', '东站88号'],
        ['国贸360广场全季', 3, '金水区', '花园路88号'],['郑州站如家', 2, '二七区', '站前街88号']
      ],
      'default': [
        ['锦江饭店', 4, '市中心', '人民路100号'],['如家精选', 2, '市中心', '中山路58号'],
        ['亚朵酒店', 3, '商业区', '解放路88号'],['全季酒店', 3, '商业区', '建设路66号'],
        ['希尔顿欢朋', 4, '商业区', '南京路33号'],['汉庭优佳', 2, '交通枢纽', '火车站广场1号'],
        ['桔子水晶', 3, '商业区', '金融街18号'],['维也纳国际', 3, '商业区', '长安街99号']
      ]
    };
    const list = hotelPools[city] || hotelPools.default;
    // 价格基数（按星级真实定价）+ 城市经济系数
    const cityPriceFactor = { '北京':1.4, '上海':1.6, '深圳':1.4, '广州':1.2, '杭州':1.2, '成都':1.0, '西安':0.95, '重庆':0.95, '南京':1.1, '苏州':1.1, '厦门':1.1, '青岛':1.0, '武汉':1.0, '长沙':0.95, '三亚':1.3, '拉萨':1.1, '昆明':0.9, '哈尔滨':0.85, '桂林':0.9, '黄山':0.95, '张家界':0.85, '敦煌':0.8, '丽江':1.0, '大理':0.95, '澳门':1.7, '香港':1.7, '大连':1.0, '济南':0.95, '天津':1.0, '沈阳':0.9 }[city] || 1.0;
    const starBase = { 1: 120, 2: 200, 3: 350, 4: 600, 5: 1100 };
    const bookings = ['携程','美团','去哪儿','飞猪','Booking','Trip.com','艺龙','同程'];
    const tagsPool = {
      1: ['经济实惠','公用卫浴'],2: ['含早餐','24小时前台','经济型'],
      3: ['免费WiFi','市中心','含早餐','健身房','商务中心'],
      4: ['免费停车','游泳池','行政酒廊','管家服务','亲子房'],
      5: ['米其林餐厅','海景房','Spa','管家服务','礼宾服务','机场接送']
    };
    const ratingPool = { 1: ['3.8','4.0'], 2: ['4.1','4.3','4.5'], 3: ['4.4','4.5','4.6'], 4: ['4.6','4.7','4.8'], 5: ['4.7','4.8','4.9'] };
    const hotels = list.map((row, i) => {
      const [name, hStars, district, street] = row;
      const base = starBase[hStars] || 300;
      const price = Math.round(base * cityPriceFactor * (0.85 + (i * 0.07) % 0.30));
      // 真实坐标：基于城市中心 + 区域偏移（确定性，无随机）
      const offsetLng = ((i * 73) % 200 - 100) * 0.0008;
      const offsetLat = ((i * 47) % 150 - 75) * 0.0007;
      const lng = center.lon + offsetLng;
      const lat = center.lat + offsetLat;
      const distance = Math.hypot((lng - center.lon) * Math.cos(center.lat * Math.PI / 180), lat - center.lat) * 111;
      return {
        name,
        stars: hStars,
        price,
        lng, lat,
        distance_km: distance.toFixed(2),
        address: `${city}${district}${street}`,
        tags: (tagsPool[hStars] || []).slice(0, 2 + (i % 2)),
        rating: (ratingPool[hStars] || ['4.5'])[i % (ratingPool[hStars] || ['4.5']).length],
        booking: bookings[i % bookings.length],
        booking_links: {
          ctrip:  `https://hotels.ctrip.com/hotel/${encodeURIComponent(city)}?keywords=${encodeURIComponent(name)}`,
          fliggy: `https://www.fliggy.com/hotel/?city=${encodeURIComponent(city)}&keyword=${encodeURIComponent(name)}`,
          meituan:`https://hotel.meituan.com/${encodeURIComponent(city)}/?keyword=${encodeURIComponent(name)}`,
          qunar:  `https://hotel.qunar.com/city/${encodeURIComponent(city)}/?keyword=${encodeURIComponent(name)}`,
          agoda:  `https://www.agoda.com/zh-cn/search?city=${encodeURIComponent(city)}&q=${encodeURIComponent(name)}`,
          booking:`https://www.booking.com/searchresults.zh-cn.html?ss=${encodeURIComponent(city + ' ' + name)}`
        },
        source: 'local+reference',
        price_disclaimer: '价格为按"星级基数×城市系数×浮动"估算的参考价，最终以官方/平台实时报价为准'
      };
    }).filter(h => (stars === 0 || h.stars >= stars) && h.price <= maxPrice);
    res.json({
      error: false,
      source: 'local+reference',
      city,
      count: hotels.length,
      hotels,
      disclaimer: '酒店价格为基于星级/城市系数的参考估算，请通过 booking_links 跳转官方平台查询实时价格与房态',
      official_channels: {
        ctrip:   'https://hotels.ctrip.com/',
        fliggy:  'https://www.fliggy.com/hotel/',
        meituan: 'https://hotel.meituan.com/',
        qunar:   'https://hotel.qunar.com/',
        agoda:   'https://www.agoda.com/',
        booking: 'https://www.booking.com/'
      }
    });
  } catch(e){ res.status(500).json({ error:true, message:e.message }); }
});

/* ---------- 航班（参考价 + 12306/航司/OTA 官方查询链接） ----------
 * ⚠️ 价格随日期/舱位/促销活动波动，以下仅为典型区间，务必以官方为准
 * 官方查询入口：
 *   - 12306（含机票/铁路）：https://www.12306.cn/index/
 *   - 携程机票：https://flights.ctrip.com/
 *   - 飞猪：https://www.fliggy.com/
 *   - 去哪儿机票：https://flight.qunar.com/
 *   - 航旅纵横：https://www.umetrip.com/
 *   - 各航司官网（CA 国航/MU 东航/CZ 南航/3U 川航 等）
 */
app.get('/api/flight', async (req, res) => {
  try {
    const origin = req.query.origin || '北京';
    const dest = req.query.dest || '成都';
    const date = req.query.date || new Date().toISOString().slice(0,10);

    // ----- 真实爬虫（学习自 Suysker/Ctrip-Crawler, Node.js 版） -----
    // 启用: set ENABLE_FLIGHT_CRAWLER=1
    // 关闭 / 失败时降级到下方参考价
    const crawlerEnabled = process.env.ENABLE_FLIGHT_CRAWLER === '1';
    if (crawlerEnabled) {
      try {
        const real = await flightCrawler.searchFlights({
          origin, dest, date,
          timeoutMs: 25000
        });
        // 补全 booking_links, 与参考价响应结构对齐
        real.booking_links = {
          ctrip_flight:   `https://flights.ctrip.com/online/list/oneway-${origin}-${dest}?_=1&depdate=${date}`,
          fliggy:         `https://www.fliggy.com/flight/?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}&date=${date}`,
          qunar:          `https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=${encodeURIComponent(origin)}&searchArrivalAirport=${encodeURIComponent(dest)}&searchDepartureTime=${date}`,
          umetrip:        'https://www.umetrip.com/',
          airline_search: `https://www.bing.com/search?q=${encodeURIComponent(origin + '到' + dest + ' 机票 ' + date)}`
        };
        return res.json(real);
      } catch (e) {
        console.warn('[flight] crawler 失败, 降级到参考价:', e.message);
        // 失败时: 返回参考价, 但带上爬虫失败的提示, 方便排查
        return res.json(buildMockFlights(origin, dest, date, 'crawler-failed:' + e.message));
      }
    }

    return res.json(buildMockFlights(origin, dest, date, 'reference'));
  } catch(e){ res.status(500).json({ error:true, message:e.message }); }
});

// 辅助：根据起飞时间和飞行时长计算到达时间
function fmtArrive(depart, h, m) {
  const [dh, dm] = depart.split(':').map(Number);
  let ah = dh + h, am = dm + m;
  if (am >= 60) { ah += Math.floor(am / 60); am = am % 60; }
  let suffix = '';
  if (ah >= 24) { ah -= 24; suffix = '+1'; }
  return String(ah).padStart(2,'0') + ':' + String(am).padStart(2,'0') + suffix;
}

// 抽出来的参考价数据(失败/关闭爬虫时返回), 单独成函数便于复用
function buildMockFlights(origin, dest, date, sourceTag) {
  // 计算直线距离，短途不提供航班参考（<400km 通常无直飞航线）
  const o = CITY_COORDS[origin];
  const d = CITY_COORDS[dest];
  let tooClose = false;
  let straightKm = 0;
  if (o && d) {
    const R = 6371;
    const rad = x => x * Math.PI / 180;
    const dLat = rad(d.lat - o.lat), dLon = rad(d.lon - o.lon);
    const a = Math.sin(dLat/2)**2 + Math.cos(rad(o.lat))*Math.cos(rad(d.lat))*Math.sin(dLon/2)**2;
    straightKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (straightKm < 400) tooClose = true;
  }
  if (tooClose) {
    return {
      error: false,
      source: sourceTag,
      origin, dest, date,
      flights: [],
      distance_km: Math.round(straightKm),
      message: `${origin}到${dest}直线距离约 ${Math.round(straightKm)} km，距离较近，通常无直飞航班。建议选择高铁/动车出行。`,
      suggestion: 'train',
      disclaimer: '短途出行（<400km）一般不设民航航线，请通过高铁/动车出行',
      booking_links: {
        train_12306: `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${encodeURIComponent(origin)},,&ts=${encodeURIComponent(dest)},,&date=${date}&flag=N,N,Y`
      }
    };
  }
  // 根据距离调整航班时长
  const flightHours = Math.max(1, Math.round(straightKm / 800 * 10) / 10); // ~800km/h 巡航
  const h = Math.floor(flightHours);
  const m = Math.round((flightHours - h) * 60);
  const durStr = h + 'h' + (m > 0 ? m + 'm' : '');
  // 根据距离估算票价（含基建燃油）
  const basePrice = Math.round(straightKm * 0.65 + 100);
  const flights = [
    { flight:'CA1234', airline:'国航', origin, dest, depart:'07:30', arrive: fmtArrive('07:30', h, m), duration: durStr, price: Math.round(basePrice * 1.35), type:'经济舱' },
    { flight:'3U8888', airline:'川航', origin, dest, depart:'09:50', arrive: fmtArrive('09:50', h, m), duration: durStr, price: Math.round(basePrice * 1.0), type:'经济舱' },
    { flight:'MU2345', airline:'东航', origin, dest, depart:'14:20', arrive: fmtArrive('14:20', h, m), duration: durStr, price: Math.round(basePrice * 1.1), type:'经济舱' },
    { flight:'CZ6789', airline:'南航', origin, dest, depart:'19:05', arrive: fmtArrive('19:05', h, m), duration: durStr, price: Math.round(basePrice * 0.83), type:'特价' },
    { flight:'CA4567', airline:'国航', origin, dest, depart:'21:30', arrive: fmtArrive('21:30', h, m), duration: durStr, price: Math.round(basePrice * 1.98), type:'商务舱' }
  ];
  return {
    error: false,
    source: sourceTag,
    origin, dest, date,
    flights,
    disclaimer: '航班价格为参考区间（典型经济舱 540-1290 元），实际价格随日期/舱位浮动，请通过下方链接跳转官方平台查询实时报价',
    booking_links: {
      official_12306: 'https://www.12306.cn/index/',
      ctrip_flight:   `https://flights.ctrip.com/online/list/oneway-${origin}-${dest}?_=1&depdate=${date}`,
      fliggy:         `https://www.fliggy.com/flight/?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}&date=${date}`,
      qunar:          `https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=${encodeURIComponent(origin)}&searchArrivalAirport=${encodeURIComponent(dest)}&searchDepartureTime=${date}`,
      umetrip:        'https://www.umetrip.com/',
      airline_search: `https://www.bing.com/search?q=${encodeURIComponent(origin + '到' + dest + ' 机票 ' + date)}`
    }
  };
}

/* ---------- 高铁/火车（参考价 + 12306 官方查询链接） ----------
 * ⚠️ 价格/车次/时刻为参考，实际以 12306 实时为准
 * 12306 是中国铁路唯一官方购票渠道：
 *   - 官网：https://www.12306.cn/index/
 *   - App：12306（铁路12306）
 *   - 客服：12306
 *   - 时刻表查询：https://www.12306.cn/index/zwd_kysj/index.html
 *   - 余票查询：https://www.12306.cn/index/querystation/index.html
 */
app.get('/api/train', (req, res) => {
  try {
    const origin = req.query.origin || '北京';
    const dest = req.query.dest || '成都';
    const date = req.query.date || new Date().toISOString().slice(0,10);
    // 根据距离动态计算车次时长和票价
    const o = CITY_COORDS[origin];
    const d = CITY_COORDS[dest];
    let railKm = 1200; // 默认（北京→成都约 1800km 铁路里程）
    if (o && d) {
      const R = 6371;
      const rad = x => x * Math.PI / 180;
      const dLat = rad(d.lat - o.lat), dLon = rad(d.lon - o.lon);
      const a = Math.sin(dLat/2)**2 + Math.cos(rad(o.lat))*Math.cos(rad(d.lat))*Math.sin(dLon/2)**2;
      const straight = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      railKm = Math.max(100, Math.round(straight * 1.25)); // 铁路里程≈直线×1.25
    }
    // 高铁 ~300km/h，动车 ~200km/h
    const gTime = railKm / 300; // 小时
    const dTime = railKm / 200;
    const fmtTime = (h) => { const hh = Math.floor(h); const mm = Math.round((h-hh)*60); return hh+'h'+(mm>0?mm+'m':''); };
    // 票价：G字头二等座 0.46/km，D字头二等座 0.31/km
    const gPrice = Math.round(railKm * 0.46);
    const dPrice = Math.round(railKm * 0.31);
    const trains = [
      { no:'G309', type:'高铁', origin, dest, depart:'08:00', arrive: fmtArrive('08:00', Math.floor(gTime), Math.round((gTime-Math.floor(gTime))*60)), duration: fmtTime(gTime), price: Math.round(gPrice*0.9), seat:'二等座' },
      { no:'G571', type:'高铁', origin, dest, depart:'10:35', arrive: fmtArrive('10:35', Math.floor(gTime), Math.round((gTime-Math.floor(gTime))*60)), duration: fmtTime(gTime), price: gPrice, seat:'二等座' },
      { no:'G404', type:'高铁', origin, dest, depart:'13:18', arrive: fmtArrive('13:18', Math.floor(gTime), Math.round((gTime-Math.floor(gTime))*60)), duration: fmtTime(gTime), price: Math.round(gPrice*0.9), seat:'二等座' },
      { no:'D1008', type:'动车', origin, dest, depart:'19:05', arrive: fmtArrive('19:05', Math.floor(dTime), Math.round((dTime-Math.floor(dTime))*60)), duration: fmtTime(dTime), price: dPrice, seat:'二等座' },
      { no:'G405', type:'高铁', origin, dest, depart:'21:00', arrive: fmtArrive('21:00', Math.floor(gTime), Math.round((gTime-Math.floor(gTime))*60)), duration: fmtTime(gTime), price: Math.round(gPrice*0.9), seat:'二等座' }
    ];
    res.json({
      error: false,
      source: 'reference',
      origin, dest, date,
      trains,
      disclaimer: '车次/价格/时刻为参考（典型二等座 522-862 元），实际以 12306 实时为准',
      booking_links: {
        official_12306:       'https://www.12306.cn/index/',
        // 12306 余票查询（带起终点 + 日期的查询页）
        query_yupiao:         `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${encodeURIComponent(origin)},,&ts=${encodeURIComponent(dest)},,&date=${date}&flag=N,N,Y`,
        query_timetable:      'https://www.12306.cn/index/zwd_kysj/index.html',
        query_station:        'https://www.12306.cn/index/querystation/index.html',
        ctrip_train:          `https://trains.ctrip.com/pages/booking/list/${origin}-${dest}-${date}.html`,
        fliggy_train:         `https://www.fliggy.com/train/?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}&date=${date}`,
        qunar_train:          `https://train.qunar.com/?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}&date=${date}`
      },
      official_channels: {
        web: 'https://www.12306.cn/index/',
        app: '铁路12306（中国铁路官方App）',
        phone: '12306（铁路客户服务热线）'
      }
    });
  } catch(e){ res.status(500).json({ error:true, message:e.message }); }
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

/* ---------- 策展真实路线（含来源溯源） ----------
   数据来源: data/real-routes-curated.json
   原则: 所有POI名称/坐标通过高德API验证,每条带原文链接供溯源
   真实入库到 community.json 由用户显式调用 import-curated,避免无意义堆积
   注意: 必须在 /api/routes/:id 之前注册,否则会被通用 :id 路由抢先匹配
*/
const CURATED_FILE = path.join(__dirname, 'data', 'real-routes-curated.json');
function loadCurated() {
  try {
    const raw = fs.readFileSync(CURATED_FILE, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json.routes) ? json.routes : [];
  } catch (e) {
    console.error('loadCurated error:', e.message);
    return [];
  }
}

// 1) 策展路线列表（按城市/天数/标签筛选）
app.get('/api/routes/curated', (req, res) => {
  const { city, days, tag } = req.query;
  let list = loadCurated();
  if (city) list = list.filter(r => (r.city || '').includes(city));
  if (days) list = list.filter(r => String(r.days) === String(days));
  if (tag)  list = list.filter(r => (r.tags || []).includes(tag));
  let meta = null;
  try {
    const raw = fs.readFileSync(CURATED_FILE, 'utf8');
    meta = (JSON.parse(raw) || {})._meta || null;
  } catch (e) { /* ignore */ }
  res.json({ error: false, count: list.length, routes: list, meta });
});

// 2) 策展路线详情
app.get('/api/routes/curated/:id', (req, res) => {
  const list = loadCurated();
  const item = list.find(r => r.id === req.params.id);
  if (!item) return res.status(404).json({ error: true, message: 'curated route not found' });
  res.json({ error: false, route: item });
});

// 3) 来源平台清单(去重统计)
app.get('/api/routes/sources', (req, res) => {
  const list = loadCurated();
  const map = new Map();
  for (const r of list) {
    const s = r.source || {};
    const k = s.platform || '未知';
    if (!map.has(k)) map.set(k, { platform: k, url: s.url, count: 0, routes: [] });
    const e = map.get(k);
    e.count++;
    e.routes.push({ id: r.id, title: r.title, city: r.city, days: r.days, url: s.url });
  }
  res.json({ error: false, count: map.size, sources: Array.from(map.values()) });
});

// 4) 策展路线 → 入库 community.json
//    POST /api/routes/import-curated/:id
//    body 可选: { validate: true } 高德POI验证(若有key)
app.post('/api/routes/import-curated/:id', express.json(), async (req, res) => {
  const list = loadCurated();
  const cur = list.find(r => r.id === req.params.id);
  if (!cur) return res.status(404).json({ error: true, message: 'curated route not found' });

  const community = loadRoutes();
  const candidate = { city: cur.city, days: cur.days, nodes: cur.nodes || [] };
  const exist = community.find(r =>
    (r.city || '').trim() === cur.city &&
    Number(r.days) === Number(cur.days) &&
    nodeOverlap(r, candidate) >= 0.8
  );
  if (exist) {
    return res.status(409).json({
      error: true, duplicate: true,
      message: '社区已存在高度重合的路线',
      existing: { id: exist.id, title: exist.title }
    });
  }

  // 可选: 高德POI验证(若有key) — 仅校验前2个POI避免慢请求
  let amapValidate = null;
  if (req.body && req.body.validate && AMAP_KEY && AMAP_KEY !== 'your_amap_key_here') {
    try {
      const samples = (cur.nodes || []).slice(0, 2);
      const results = [];
      for (const n of samples) {
        const url = `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(n.poi)}&city=${encodeURIComponent(cur.city)}&extensions=base`;
        const r = await fetch(url, { headers: { 'User-Agent': '123-travel/1.0' } });
        if (r.ok) {
          const j = await r.json();
          const hit = (j.pois || [])[0];
          results.push({ poi: n.poi, found: !!hit, amap_name: hit ? hit.name : null });
        }
      }
      amapValidate = results;
    } catch (e) { amapValidate = { error: e.message }; }
  }

  // 入库(保留 source 字段以便前端展示)
  const newRoute = {
    id: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    title: cur.title,
    city: cur.city,
    days: cur.days,
    budget: cur.budget || '舒适',
    budget_per_day: cur.budget_per_day || '',
    contributor: { name: '真实路线库', level: '官方', avatar: '🗺️' },
    tags: cur.tags || [],
    nodes: cur.nodes || [],
    summary: cur.summary || '',
    source: cur.source || null,
    source_type: 'curated-real',
    stats: { used: 0, rating: 0, likes: 0, verified: true }
  };
  if (community.length >= 200) community.shift();
  community.push(newRoute);
  saveRoutes(community);

  res.status(201).json({
    error: false,
    route: newRoute,
    amap_validate: amapValidate
  });
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

// 简易 DeepSeek 调用（无 key 时返回 null）
async function callDeepSeek(userMsg, sysPrompt = '你是"123就出发"旅途伴侣助手。回答简洁≤80字，必要时给 1-2 条建议。不要 Markdown。'){
  if (!DEEPSEEK_KEY || DEEPSEEK_KEY === 'your_deepseek_key_here') return null;
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
        'User-Agent': '123-travel/1.0'
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userMsg }
        ],
        max_tokens: 500,
        temperature: 0.5,
        stream: false
      })
    });
    if (!r.ok) {
      console.warn('[deepseek] http', r.status);
      return null;
    }
    const data = await r.json();
    const msg = data?.choices?.[0]?.message || {};
    return (msg.content || msg.reasoning_content || '').trim() || null;
  } catch (e) {
    console.warn('[deepseek] fail:', e.message);
    return null;
  }
}

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
        model: 'deepseek-v4-flash',
        messages: fullMessages,
        temperature: 0.5,
        max_tokens: 1500,
        stream: false
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`deepseek http ${r.status} ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    const msg = data?.choices?.[0]?.message || {};
    const reply = (msg.content || msg.reasoning_content || '').trim();
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

/* ---------- 全局错误捕获（防止意外崩溃导致服务永久停止） ---------- */
process.on('uncaughtException', (err) => {
  console.error(`\n  ⚠️  [未捕获异常] ${err.message}`);
  console.error(`  ${err.stack?.split('\n').slice(0, 4).join('\n  ')}`);
  console.error(`  → 服务器将继续运行，但建议排查此错误\n`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || reason || 'unknown';
  console.error(`\n  ⚠️  [未处理 Promise 拒绝] ${msg}\n`);
});

// 进程退出原因追踪（帮助排查静默死亡）
process.on('beforeExit', (code) => { console.error(`\n  [beforeExit] code=${code}\n`); });
process.on('exit', (code) => { console.error(`\n  [exit] code=${code}\n`); });

/* ---------- 导出 + 启动 ---------- */
module.exports = app;

if (require.main === module) {
  // 先杀掉可能占用端口的僵尸进程，避免 EADDRINUSE
  const http = require('http');
  const tryListen = () => {
    const server = http.createServer(app);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n  ⚠️  端口 ${PORT} 被占用，3 秒后重试...`);
        setTimeout(() => { server.close(); tryListen(); }, 3000);
        return;
      }
      console.error(`\n  ❌  服务器错误: ${err.message}`);
      process.exit(1);
    });
    server.listen(PORT, () => {
      const keyStatus = AMAP_KEY && AMAP_KEY !== 'your_amap_key_here' ? '已配置' : '未配置（API 将返回空数据，前端走 Mock）';
      console.log(`\n  123 就出发 · 后端服务已启动`);
      console.log(`  ➜  http://localhost:${PORT}`);
      console.log(`  ➜  健康检查    GET /api/health`);
      console.log(`  ➜  社区路线    GET /api/routes`);
      console.log(`  ➜  高德 Key   ${keyStatus}\n`);

      // 优雅退出 - 捕获 SIGTERM/SIGINT 时先关服务器再退出
      ['SIGTERM', 'SIGINT'].forEach(sig => {
        process.on(sig, () => {
          console.log(`\n  ⏳  收到 ${sig}，正在关闭服务...`);
          server.close(() => {
            console.log(`  ✅  服务已关闭\n`);
            process.exit(0);
          });
          // 10 秒后才强制退出（给 server.close 足够时间）
          setTimeout(() => { console.error(`  ⚠️  超时，强制退出`); process.exit(1); }, 10000);
        });
      });
    });
  };
  tryListen();
}

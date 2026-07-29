/**
 * 携程机票真实价格爬虫
 * ─────────────────────────────────────────────
 * 学习自 https://github.com/Suysker/Ctrip-Crawler
 * 原方案: Python + Selenium + SeleniumWire
 * 本实现: Node.js + Puppeteer(CDP 拦截响应)
 *
 * 核心思路一致:
 *   1. 启动真实浏览器,避开携程 IP/UA/JS 加密拦截
 *   2. 打开 flight.ctrip.com 机票搜索页
 *   3. 填入出发/目的/日期 → 触发搜索
 *   4. **通过 page.on('response') 拦截浏览器发出的 XHR/fetch 响应**
 *      (等价于 SeleniumWire 的 request.response.body)
 *   5. 自动识别 gzip/JSON, 解压后提取航班数据
 *   6. 内存缓存(默认 2 小时), 避免重复爬取
 *
 * 关闭方式: 不设 ENABLE_FLIGHT_CRAWLER=1 时本模块不会被调用
 * 失败降级: 任何异常都会 throw, 由调用方(server.js)降级到参考价
 */
'use strict';

const zlib = require('zlib');

// 中国主要城市 → 携程使用的机场三字码 (IATA)
const CITY_TO_IATA = {
  '北京':'BJS','上海':'SHA','广州':'CAN','深圳':'SZX','成都':'CTU',
  '西安':'XIY','杭州':'HGH','重庆':'CKG','南京':'NKG','苏州':'SZV',
  '厦门':'XMN','青岛':'TAO','武汉':'WUH','长沙':'CSX','哈尔滨':'HRB',
  '大连':'DLC','沈阳':'SHE','天津':'TSN','济南':'TNA','郑州':'CGO',
  '昆明':'KMG','拉萨':'LXA','乌鲁木齐':'URC','兰州':'LHW','贵阳':'KWE',
  '南宁':'NNG','海口':'HAK','三亚':'SYX','宁波':'NGB','温州':'WNZ',
  '福州':'FOC','合肥':'HFE','南昌':'KHN','太原':'TYN','石家庄':'SJW',
  '呼和浩特':'HET','银川':'INC','西宁':'XNN','桂林':'KWL','丽江':'LJG',
  '九寨沟':'JZH','黄山':'TXN','敦煌':'DNH','喀什':'KHG','伊宁':'YIN',
  '烟台':'YNT','威海':'WEH','泉州':'JJN','珠海':'ZUH','汕头':'SWA'
};

const CACHE = new Map();   // key → { data, ts }
const CACHE_TTL = 2 * 60 * 60 * 1000;   // 2 小时

let _browser = null;
let _puppeteer = null;
let _puppeteerTried = false;

/** 懒加载 puppeteer (失败不抛, 由调用方降级) */
async function getPuppeteer() {
  if (_puppeteerTried) return _puppeteer;
  _puppeteerTried = true;
  try {
    _puppeteer = require('puppeteer');
    return _puppeteer;
  } catch (e) {
    console.warn('[flight-crawler] 未安装 puppeteer:', e.message);
    console.warn('  安装方法: npm i puppeteer   (会下载 ~170MB Chromium)');
    return null;
  }
}

/** 懒加载浏览器实例 (单例, 复用) */
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  const puppeteer = await getPuppeteer();
  if (!puppeteer) return null;
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=zh-CN,zh'
    ]
  });
  return _browser;
}

/** 把 gzip / deflate / json 响应统一还原成 JSON */
async function decodeResponse(resp) {
  const headers = resp.headers();
  const encoding = (headers['content-encoding'] || '').toLowerCase();
  const buffer = await resp.buffer();
  let raw;
  if (encoding === 'gzip') {
    raw = zlib.gunzipSync(buffer).toString('utf8');
  } else if (encoding === 'deflate') {
    raw = zlib.inflateSync(buffer).toString('utf8');
  } else if (encoding === 'br') {
    // brotli 较少, 退化用 utf8 (失败也不影响)
    raw = buffer.toString('utf8');
  } else {
    raw = buffer.toString('utf8');
  }
  try { return JSON.parse(raw); } catch { return null; }
}

/** 把爬到的原始数据归一化为前端需要的格式 */
function normalizeFlights(rawJson, origin, dest, date) {
  // 携程返回的字段在不同接口里命名不同, 这里做兼容抽取
  const list = []
    .concat(rawJson?.data?.flightItineraryList || [])
    .concat(rawJson?.data?.flightList || [])
    .concat(rawJson?.data?.oneWayFlightInfoList || [])
    .concat(rawJson?.flights || [])
    .concat(Array.isArray(rawJson?.data) ? rawJson.data : []);

  if (list.length === 0) return [];

  return list.slice(0, 12).map((f, i) => {
    // 价格: 兼容 price / lowestPrice / adultPrice / economyPrice
    const price = Number(f.price ?? f.lowestPrice ?? f.adultPrice
      ?? f.economyPrice ?? f.flightPrice ?? 0) || null;
    // 航班号: flightNo / flightCode
    const flightNo = f.flightNo || f.flightCode || f.flight || f.no || `XX${i+1}`;
    // 航司: airlineName / airline / carrier
    const airline = f.airlineName || f.airline || f.carrier || '';
    // 出发到达时间
    const depart = (f.departTime || f.depTime || f.depart || '').slice(0, 5);
    const arrive = (f.arriveTime || f.arrTime || f.arrive || '').slice(0, 5);
    // 时长: duration 是分钟数 或 "2h55m"
    let duration = f.duration || '';
    if (typeof duration === 'number') {
      const h = Math.floor(duration / 60);
      const m = duration % 60;
      duration = `${h}h${m}m`;
    }
    // 经停
    const stopNum = f.stopNum ?? f.stopCount ?? 0;
    return {
      flight: flightNo,
      airline,
      origin,
      dest,
      depart: depart || '--:--',
      arrive: arrive || '--:--',
      duration: duration || '--',
      price: price,
      type: f.cabinClassName || f.cabinType || f.seatType || '经济舱',
      stops: stopNum,
      aircraft: f.aircraft || f.planeType || '',
      _source: 'ctrip-crawler'
    };
  }).filter(f => f.price && f.price > 0);
}

/** 主入口: 爬取一次真实机票价格 */
async function searchFlights({ origin, dest, date, timeoutMs = 25000 } = {}) {
  if (!origin || !dest) throw new Error('origin/dest 必填');
  const d = date || new Date().toISOString().slice(0, 10);
  const oCode = CITY_TO_IATA[origin] || origin;
  const dCode = CITY_TO_IATA[dest] || dest;
  const key = `${oCode}->${dCode}@${d}`;

  // 命中缓存直接返回
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return { ...hit.data, cached: true };
  }

  const browser = await getBrowser();
  if (!browser) throw new Error('puppeteer unavailable');

  const page = await browser.newPage();
  // 拦截请求: 只放过文档/脚本/样式/图片, 加速加载
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'document' || t === 'script' || t === 'xhr' || t === 'fetch') {
      req.continue();
    } else {
      req.abort();
    }
  });
  // 真实 UA + 中文语言
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9'
  });

  // 收集所有 JSON 响应, 事后挑出含航班数据的那个
  const captures = [];
  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json') && !ct.includes('text/plain')) return;
      if (!/flight|itinerary|search/i.test(url)) return;
      const json = await decodeResponse(resp);
      if (json) captures.push({ url, json });
    } catch { /* ignore */ }
  };
  page.on('response', onResponse);

  try {
    // 直接打开单程搜索页 (带日期), 让页面自己触发搜索
    const url = `https://flights.ctrip.com/online/list/oneway-${oCode}-${dCode}?_=1&depdate=${d}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // 等结果区出现 (携程的航班卡片 class 是 .flight-item 或 [class*="flight"] )
    try {
      await page.waitForSelector(
        '.flight-item, [class*="flightItem"], [class*="flight_item"], [class*="FlightList"]',
        { timeout: 8000 }
      );
    } catch { /* 等不到也不一定失败 */ }

    // 额外等 3s 让异步接口全部回来
    await new Promise(r => setTimeout(r, 3000));
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  // 从捕获里挑数据最像"航班列表"的那一份
  let best = null;
  for (const c of captures) {
    const j = c.json;
    const flightCount = (j?.data?.flightItineraryList?.length
      || j?.data?.flightList?.length
      || j?.data?.oneWayFlightInfoList?.length
      || (Array.isArray(j?.data) ? j.data.length : 0)
      || 0);
    if (flightCount > 0 && (!best || flightCount > best.score)) {
      best = { ...j, score: flightCount, sourceUrl: c.url };
    }
  }
  if (!best) throw new Error('no flight data captured');

  const flights = normalizeFlights(best, origin, dest, d);
  if (flights.length === 0) throw new Error('normalize produced empty list');

  const data = {
    error: false,
    source: 'ctrip-real',
    source_url: best.sourceUrl,
    origin, dest, date: d,
    flights,
    disclaimer: '数据来自携程实时搜索(经爬虫抓取), 价格随库存/舱位实时变动, 请以下方链接到携程核对',
    fetched_at: new Date().toISOString()
  };
  CACHE.set(key, { data, ts: Date.now() });
  return { ...data, cached: false };
}

/** 关闭浏览器 (优雅退出) */
async function close() {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
  }
}

module.exports = { searchFlights, close, CITY_TO_IATA, CACHE };

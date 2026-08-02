/* =========================================================
   build-i18n-db.js — 构建固定文案预翻译数据库
   · 从 index.html 提取全部中文 UI 文案（HTML 文本节点 + 属性 +
     JS 字符串字面量），用 DeepSeek flash（经本地 /api/translate）
     批量翻译为 英文（美式）/ 繁體中文（香港），写入 js/i18n_db.json
   · 用法：
       node scripts/build-i18n-db.js --dry    # 仅统计待翻译条数，不调 API
       node scripts/build-i18n-db.js          # 执行翻译并写库（需本地服务运行中）
   ========================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const SERVER_SRC = path.join(ROOT, 'server.js');
const OUT = path.join(ROOT, 'js', 'i18n_db.json');
const API = 'http://localhost:3000/api/translate';
const CH_CHARS = 600;    // 按字符数分批（离线构建可慢但必须稳）：长文本 batch 过大会让 DeepSeek 响应超 45s（server 超时兜底原文）
const CH_MAX = 12;       // 单批最多条数
const MAX_LEN = 400;     // 超长文案交运行时时逐条翻译，不进库
const MAX_KEYS = 6000;   // 每语言最多入库条数（防库体膨胀）

const hasChinese = s => /[\u4e00-\u9fff]/.test(s);
const normKey = s => String(s).replace(/\s+/g, ' ').trim();
const cjkCount = s => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/* 代码痕迹过滤：半角花括号/等号/分号/尖括号/反引号/竖线及常见关键字，
   命中的多半是正则/模板/注释被误提取，而非界面文案。
   （半角括号 ()/[] 常见于文案（如"(16)"），不再视为代码痕迹） */
const CODE_JUNK = /[\{\}\=\;\<\>\`\|]|\b(function|const|var|let|return|document|window|Array|Object|JSON|console|catch|try|await|async|undefined|null|querySelector|getElementById)\b/;

function acceptable(key) {
  if (!key || key.length < 2 || key.length > MAX_LEN) return false;   // 排除单字危险键/超长
  if (!hasChinese(key)) return false;
  if (key.includes('${')) return false;   // 模板插值：运行时翻译
  if (CODE_JUNK.test(key)) return false;  // 疑似代码片段：跳过
  if (cjkCount(key) < 2) return false;    // 仅 1 个汉字（如"宜/忌"）跳过，防误伤
  return true;
}

/* ---------- 提取 HTML 文本节点 ---------- */
function extractHtmlText(html) {
  const out = [];
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const parts = body.split(/<[^>]+>/);
  for (const p of parts) {
    const t = normKey(p);
    if (acceptable(t)) out.push(t);
  }
  return out;
}

/* ---------- 提取 HTML 属性（placeholder/title/aria-label/alt） ---------- */
function extractAttrs(html) {
  const out = [];
  const re = /\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const t = normKey(m[1]);
    if (acceptable(t)) out.push(t);
  }
  return out;
}

/* ---------- 提取 JS 模板串静态文案 ----------
 * 非贪婪匹配模板串 + 剔除 ${...} 插值 + 按源码行拆分 + 剥 HTML 标签：
 * 今日推荐方法说明（每行一个 method-line）、权重标签、社区路线卡片模板等
 * 跨行模板里的纯静态文案（如 <summary>📊 六维多源智能计算方法…</summary>）
 * 在此被拆成独立键，切英文瞬间命中库。 */
function extractTemplateStrings(code) {
  const out = [];
  const tre = /`([\s\S]*?)`/g;
  let tm;
  while ((tm = tre.exec(code))) {
    const clean = tm[1].replace(/\$\{[^}]*\}/g, ' ');
    for (const ln of clean.split('\n')) {
      const t = normKey(ln.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
      if (!t) continue;
      if (/["']/.test(t)) continue;   // 剥标签后仍含引号 = 属性值残留/拼接碎片，丢弃
      if (acceptable(t)) out.push(t);
    }
  }
  return out;
}

/* ---------- 提取 JS 字符串字面量（引号/模板串，含中文） ---------- */
function extractJsStrings(html) {
  const out = [];
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  for (const code of scripts) {
    const pats = [
      /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g,   // 双引号（单行）
      /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'/g    // 单引号（单行）
    ];
    for (const pat of pats) {
      let mm;
      while ((mm = pat.exec(code))) {
        const t = normKey(mm[1].replace(/\\(.)/g, '$1'));
        if (acceptable(t)) out.push(t);
      }
    }
    out.push(...extractTemplateStrings(code));
  }
  return out;
}

/* ---------- 提取 server.js 中的城市/省份/节假日等中文数据键 ----------
   级联下拉（省份/地级市）、datalist（城市）、节假日倒计时、天气城市等
   都来自后端数据（PROVINCE_CITY_MAP / CITIES_DATA / CITY_COORDS / 节假日表），
   这些地名必须预翻译进库，切英文瞬间才完整（运行时逐词替换也能命中） */
function extractServerKeys(serverCode) {
  const out = new Set();
  const mapRe = /const\s+PROVINCE_CITY_MAP\s*=\s*\{([\s\S]*?)\n\};/;
  const m = serverCode.match(mapRe);
  if (m) {
    const entries = m[1].match(/'[^']{2,12}':\s*\[[^\]]*\]/g) || [];
    for (const e of entries) {
      const em = e.match(/'([^']{2,12})':\s*\[([^\]]*)\]/);
      if (!em) continue;
      if (hasChinese(em[1])) out.add(em[1]);           // 省份名
      const cities = em[2].match(/'([^']{2,12})'/g) || [];
      for (const c of cities) {
        const cn = c.slice(1, -1);
        if (hasChinese(cn)) out.add(cn);               // 地级市名
      }
    }
  }
  /* 其余中文数据键：CITIES_DATA / CITY_COORDS / 节假日等对象键（纯中文、≤10 字） */
  const keyRe = /'([^']{2,10})'\s*:/g;
  let km;
  while ((km = keyRe.exec(serverCode))) {
    const name = km[1];
    if (hasChinese(name) && /^[\u4e00-\u9fff·]+$/.test(name) && cjkCount(name) >= 2) out.add(name);
  }
  /* 节假日表（HOLIDAYS_2025_2027）的 name/desc/tip 字段值：节假日倒计时与介绍弹层文案 */
  const valRe = /\b(?:name|desc|tip):'([^']+)'/g;
  let vm;
  while ((vm = valRe.exec(serverCode))) {
    const v = normKey(vm[1]);
    if (acceptable(v)) out.add(v);
  }
  return [...out];
}

/* ---------- 翻译（经本地 /api/translate，与运行时同一模型同一提示词） ---------- */
async function translateBatch(lang, keys) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang, texts: keys })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.ok || !Array.isArray(j.texts)) throw new Error('bad response');
  return j.texts;
}

async function translateAll(lang, keys, seed) {
  const dict = Object.assign({}, seed || {});   // 继承旧库译文（同一模型同一提示词，直接复用）
  let todo = keys.filter(k => !dict[k]);        // 仅翻译新增键
  console.log(`  [${lang}] 继承旧库 ${Object.keys(dict).length} 条，新增待翻译 ${todo.length} 条`);
  if (!todo.length) return dict;
  const start = Date.now();
  const CONC = 2;      // 并发 2 路：并发过高易触发 DeepSeek 限流（HTTP 500）
  /* 最多补 2 轮：失败的 chunk 键收集后重分块再翻，尽量补齐缺失键 */
  for (let round = 0; round < 2 && todo.length; round++) {
    if (round > 0) console.log(`  [${lang}] 补翻第 ${round + 1} 轮：${todo.length} 条`);
    const chunks = [];
    let cur = [], len = 0;
    for (const k of todo) {
      cur.push(k); len += k.length;
      if (len >= CH_CHARS || cur.length >= CH_MAX) { chunks.push(cur); cur = []; len = 0; }
    }
    if (cur.length) chunks.push(cur);
    const failed = [];
    let idx = 0;
    const runOne = async () => {
      for (;;) {
        const c = idx++;
        if (c >= chunks.length) return;
        const chunk = chunks[c];
        let texts;
        let tries = 0;
        for (;;) {
          try { texts = await translateBatch(lang, chunk); break; }
          catch (e) {
            tries++;
            if (tries >= 3) { console.error('  batch fail (give up):', e.message); texts = null; break; }
            await new Promise(r => setTimeout(r, 4000 * tries));
          }
        }
        if (!texts) { failed.push(...chunk); continue; }
        let okCount = 0;
        for (let k = 0; k < chunk.length && k < texts.length; k++) {
          const key = chunk[k];
          const t = normKey(texts[k]);
          /* 繁体允许译文=原文（繁简同形词如"北京"，译文合法）；英文仍要求有改动 */
          const sameOk = lang === 'zh-Hant' && t === key;
          const sane = t && (sameOk || (t !== key && t.length <= (key.length * 6 + 120)));
          if (!sane) continue;
          if (lang === 'en' && hasChinese(t)) continue;   // 英文结果不允许残留中文
          if (lang === 'zh-Hant' && !hasChinese(t)) continue; // 繁体结果必须仍是中文
          dict[key] = t;
          okCount++;
        }
        if (okCount < chunk.length) {
          for (let k = 0; k < chunk.length; k++) if (!dict[chunk[k]]) failed.push(chunk[k]);
        }
        console.log(`  [${lang}] chunk ${c + 1}/${chunks.length} (${chunk.length}条) ok=${okCount} 累计=${Object.keys(dict).length}  ${((Date.now() - start) / 1000).toFixed(0)}s`);
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(CONC, chunks.length); w++) workers.push(runOne());
    await Promise.all(workers);
    todo = failed;
  }
  return dict;
}

/* ---------- 主流程 ---------- */
async function main() {
  const html = fs.readFileSync(SRC, 'utf8');
  const isDry = process.argv.includes('--dry');

  const set = new Set();
  for (const t of extractHtmlText(html)) set.add(t);
  for (const t of extractAttrs(html)) set.add(t);
  for (const t of extractJsStrings(html)) set.add(t);
  try {
    const serverCode = fs.readFileSync(SERVER_SRC, 'utf8');
    for (const t of extractServerKeys(serverCode)) set.add(t);
  } catch (e) { /* server.js 缺失不影响（跳过数据键提取） */ }

  const keys = [...set].sort((a, b) => b.length - a.length);
  console.log('提取到中文文案（去重）:', keys.length);
  if (isDry) {
    console.log('示例（前 30 条，长键优先）:');
    for (const k of keys.slice(0, 30)) console.log('  ' + k);
    console.log('（预翻译可入库 ' + keys.length + ' 条/语言。加 --dry 仅为预览，未调用 API）');
    return;
  }

  const enKeys = keys.slice(0, MAX_KEYS);
  /* 继承旧库译文（增量重建）：只翻译新增键，避免全量重翻耗时 */
  let oldDB = null;
  try { oldDB = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* 无旧库则全量 */ }
  const enSeed = (oldDB && oldDB.en) || {};
  const twSeed = (oldDB && oldDB['zh-Hant']) || {};
  console.log('开始翻译 English (US) … 共', enKeys.length, '条');
  const en = await translateAll('en', enKeys, enSeed);

  console.log('开始翻译 繁體中文（中國香港） … 共', enKeys.length, '条');
  const tw = await translateAll('zh-Hant', enKeys, twSeed);

  const db = {
    _meta: {
      generated_at: new Date().toISOString(),
      model: 'deepseek-v4-flash',
      en_count: Object.keys(en).length,
      tw_count: Object.keys(tw).length,
      note: '固定文案预翻译库；动态内容（AI 行程等）仍由前端实时调用 /api/translate'
    },
    en,
    'zh-Hant': tw
  };
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1), 'utf8');
  console.log('已写入', OUT, ' en=', Object.keys(en).length, ' zh-Hant=', Object.keys(tw).length);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });

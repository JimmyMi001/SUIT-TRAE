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
const OUT = path.join(ROOT, 'js', 'i18n_db.json');
const API = 'http://localhost:3000/api/translate';
const CH = 120;          // 与前端一致的块大小
const MAX_LEN = 200;     // 超长文案交运行时时逐条翻译，不进库
const MAX_KEYS = 6000;   // 每语言最多入库条数（防库体膨胀）

const hasChinese = s => /[\u4e00-\u9fff]/.test(s);
const normKey = s => String(s).replace(/\s+/g, ' ').trim();
const cjkCount = s => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/* 代码痕迹过滤：半角括号/花括号/等号/分号/尖括号/反引号及常见关键字，
   命中的多半是正则/模板/注释被误提取，而非界面文案 */
const CODE_JUNK = /[\{\}\(\)\[\]\=\;\<\>\`\|]|\b(function|const|var|let|return|document|window|Array|Object|JSON|console|catch|try|await|async|undefined|null|querySelector|getElementById)\b/;

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
      /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'/g,   // 单引号（单行）
      /`([^`\\\n]*(?:\\.[^`\\\n]*)*)`/g    // 模板串（单行、无插值）
    ];
    for (const pat of pats) {
      let mm;
      while ((mm = pat.exec(code))) {
        const t = normKey(mm[1].replace(/\\(.)/g, '$1'));
        if (acceptable(t)) out.push(t);
      }
    }
  }
  return out;
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

async function translateAll(lang, keys) {
  const dict = {};
  const start = Date.now();
  const chunks = [];
  for (let i = 0; i < keys.length; i += CH) chunks.push(keys.slice(i, i + CH));
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    let texts;
    let tries = 0;
    for (;;) {
      try { texts = await translateBatch(lang, chunk); break; }
      catch (e) {
        tries++;
        if (tries >= 3) { console.error('  batch fail (give up):', e.message); texts = null; break; }
        await new Promise(r => setTimeout(r, 3000 * tries));
      }
    }
    if (!texts) continue;
    let okCount = 0;
    for (let k = 0; k < chunk.length && k < texts.length; k++) {
      const key = chunk[k];
      const t = normKey(texts[k]);
      const sane = t && t !== key && t.length <= (key.length * 3 + 60);
      if (!sane) continue;
      if (lang === 'en' && hasChinese(t)) continue;   // 英文结果不允许残留中文
      if (lang === 'zh-TW' && !hasChinese(t)) continue; // 繁体结果必须仍是中文
      dict[key] = t;
      okCount++;
    }
    console.log(`  [${lang}] chunk ${c + 1}/${chunks.length} (${chunk.length}条) ok=${okCount} 累计=${Object.keys(dict).length}  ${((Date.now() - start) / 1000).toFixed(0)}s`);
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

  const keys = [...set].sort((a, b) => b.length - a.length);
  console.log('提取到中文文案（去重）:', keys.length);
  if (isDry) {
    console.log('示例（前 30 条，长键优先）:');
    for (const k of keys.slice(0, 30)) console.log('  ' + k);
    console.log('（预翻译可入库 ' + keys.length + ' 条/语言。加 --dry 仅为预览，未调用 API）');
    return;
  }

  const enKeys = keys.slice(0, MAX_KEYS);
  console.log('开始翻译 English (US) … 共', enKeys.length, '条');
  const en = await translateAll('en', enKeys);

  console.log('开始翻译 繁體中文（中國香港） … 共', enKeys.length, '条');
  const tw = await translateAll('zh-TW', enKeys);

  const db = {
    _meta: {
      generated_at: new Date().toISOString(),
      model: 'deepseek-v4-flash',
      en_count: Object.keys(en).length,
      tw_count: Object.keys(tw).length,
      note: '固定文案预翻译库；动态内容（AI 行程等）仍由前端实时调用 /api/translate'
    },
    en,
    'zh-TW': tw
  };
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1), 'utf8');
  console.log('已写入', OUT, ' en=', Object.keys(en).length, ' zh-TW=', Object.keys(tw).length);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });

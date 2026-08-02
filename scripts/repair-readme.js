/* =========================================================
   repair-readme.js — 修复 README.en.md / README.zh-Hant.md 中
   批量翻译残留的正文段落（DeepSeek 重翻 + 语言校验）
   · 跳过：代码块、标题行、含 HTML 标签的行
   · en：含汉字即视为待翻（品牌名按提示词英文化）
   · zh-Hant：含简体特征词 / 模板误入文本 / @@ %% 占位符 视为待翻
   · 从文件末尾向前替换行，避免行号漂移
   · 用法：
       node scripts/repair-readme.js --en
       node scripts/repair-readme.js --tw
   ========================================================= */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = process.argv.includes('--en') ? 'en' : (process.argv.includes('--tw') ? 'tw' : null);
if (!TARGET) { console.error('用法: node scripts/repair-readme.js --en|--tw'); process.exit(1); }
const FILE = path.join(ROOT, TARGET === 'en' ? 'README.en.md' : 'README.zh-Hant.md');
const TO = TARGET === 'en' ? 'English (US)' : '繁體中文（中國香港）';
const API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) { console.error('未找到 DEEPSEEK_KEY'); process.exit(1); }

const CHUNK = 3;    // 每批段数（含长表，取小值更稳）
const CONC = 4;     // 并发路数
const MAXC = 4200;  // 每批字符上限

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const TITLE_RE = /^(#{1,6})\s/;
const HTML_LINE = /^\s*</;   // 行首 HTML 标签（<img/<div/<table/<sub/...）

const hasCJK = s => /[\u4e00-\u9fff]/.test(s);
const cjkCount = s => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/* 简体特征双字词 + 模板误入特征 + 占位符特征 */
const SIMP_WORDS = ['软件','网络','数据','用户','服务器','页面','上传','下载','验证','缓存','内容','文档','菜单','点击','这里','里面','我们','实现','设计','支持','相关','信息','服务','功能','切换','显示','获取','生成','推荐','提供','使用','选择','输入','输出','更新','访问','打开','关闭','创建','删除','保存','添加','修改','调整','增加','减少','处理','完成','开始','继续','停止','发送','接收','请求','响应','代码','开发','编程','测试','部署','安装','配置','启动','运行','浏览','地址','密码','设置','记录','集合','数据源','来源','接口','开放','克隆','仓库','双击','浏览器','异常','自动','重新','编辑','填写','保存','密钥','控制台','创建','获取'];
const TEMPLATE_JUNK = /請提供|佔位符|請將待翻譯|尚未提供|翻譯成繁體|原文，我才能|目前的輸入|貼上您要翻譯/;
const PH_JUNK = /@@TITLE\d+@@|@@CODE\d+@@/;

function qualityOk(text) {
  if (!text) return false;
  const cjk = cjkCount(text);
  if (TARGET === 'en') {
    if (cjk >= 16) return false;
    if (cjk > 0 && cjk / Math.max(text.length, 1) > 0.3) return false;
    return true;
  }
  // zh-Hant
  if (cjk === 0) return false;
  if (TEMPLATE_JUNK.test(text) || PH_JUNK.test(text) || /^%%|%%$/.test(text)) return false;
  let simp = 0;
  for (const w of SIMP_WORDS) if (text.includes(w)) simp++;
  return simp < 2;
}

function needsRepair(text) {
  if (TARGET === 'en') return hasCJK(text);
  if (TEMPLATE_JUNK.test(text) || PH_JUNK.test(text)) return true;
  if (/^%%|%%$/.test(text)) return true;
  for (const w of SIMP_WORDS) if (text.includes(w)) return true;
  return false;
}

/* ---------- DeepSeek 直连 ---------- */
async function translateBatch(texts) {
  const multi = texts.length > 1;
  const prompt = multi
    ? texts.map((t, i) => `Paragraph ${i + 1}:\n${t}`).join('\n\n%%\n\n')
    : texts[0];
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    signal: AbortSignal.timeout(150000),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 16384
    })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && (j.choices[0].message.content || '')) || '';
  if (!content) throw new Error('empty content');
  if (multi) return content.split(/\s*%%\s*/).map(s => s.trim());
  return [content.trim()];
}

function systemPrompt() {
  const isEn = TARGET === 'en';
  const style = isEn
    ? 'Use natural American English, idiomatic and fluent, matching native speaker expression habits.'
    : '使用繁體中文（中國香港慣用語）翻譯：信息→資訊、软件→軟件、网络→網絡、支持→支援、用户→用戶、数据→數據、服务器→伺服器、上传→上傳、下载→下載、验证→驗證、缓存→緩存、内容→內容、文档→文檔、接口→介面、菜单→選單、点击→點擊、这里→這裡、打开→開啟、显示→顯示、设置→設定、项目→項目、提交→提交。';
  const properNoun = isEn
    ? '- 品牌/平台名给出英文常用名（高德→Amap、美团→Meituan、飞猪→Fliggy、途牛→Tuniu、携程→Ctrip、去哪儿→Qunar、小红书→Xiaohongshu、马蜂窝→Mafengwo、微博→Weibo、大众点评→Dianping、火山引擎→Volcano Engine）；城市名用拼音（北京→Beijing、广州→Guangzhou）；学校名用 Shenzhen University of Information Technology (SUIT)；其余文件名/命令/API/代码 保留原样'
    : '- 专有名词：城市名、品牌名（高德/美团/飞猪/途牛/DeepSeek/12306/去哪儿/携程/小红书/马蜂窝/微博/大众点评）、文件名、命令、JSON 字段保留原样（品牌名请用繁體寫法：美团→美團、飞猪→飛豬、大众点评→大眾點評、去哪儿→去哪兒、携程→攜程、小红书→小紅書、马蜂窝→馬蜂窩、微博→微博）';
  return `You are a professional ${TO} native translator who needs to fluently translate text into ${TO}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output; if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- Single paragraph input → Output translation directly (no separators, no extra text)
- Multi-paragraph input → Use %% as paragraph separator between translations

## Markdown 翻译约束（必须严格遵守）
- 保留全部 Markdown 语法：表格 | 和 ---、列表 - / 数字、引用 >、粗体 **、斜体 *、链接 [text](url)、行内代码 \`、分隔线 ---、HTML 标签
- 表格：保持行数、列数与 | 分隔符完全一致，只翻译单元格内文字；表头分隔行（|---|）原样保留
- 链接/图片：[text](url) 中 url 原样保留（不翻译、不改动），只翻译 text 部分；HTML <img> 的 src 原样保留
- 行内代码 \`...\` 内容不翻译，原样保留
- 保留全部 emoji 与特殊符号（🚀🌐📖🏗️🔑📊🤝⚠️💡🥇🥈🥉 等）
- ${properNoun}
- 产品名 "123 Let's Go"、副标题 *Travel Verified, Not Memorized* 保留英文原样
- ${style}
- 信达雅，地道自然，术语统一。`;
}

/* ---------- 解析文件：识别代码块行区间 ---------- */
function parseLines(text) {
  const lines = text.split('\n');
  const inCode = new Array(lines.length).fill(false);
  FENCE_RE.lastIndex = 0;
  let m;
  const raw = text;
  while ((m = FENCE_RE.exec(raw))) {
    const start = raw.slice(0, m.index).split('\n').length - 1;
    const seg = m[0];
    const end = start + seg.split('\n').length - 1;
    for (let i = start; i <= end; i++) inCode[i] = true;
  }
  return { lines, inCode };
}

/* ---------- 主流程 ---------- */
async function main() {
  const text = fs.readFileSync(FILE, 'utf8');
  const { lines, inCode } = parseLines(text);

  /* 分组：连续非空行（记录行区间） */
  const groups = [];
  let cur = [], curLines = [];
  const flush = () => {
    if (curLines.length) groups.push({ start: curLines[0], end: curLines[curLines.length - 1], text: cur.join('\n'), n: cur.length });
    cur = []; curLines = [];
  };
  lines.forEach((ln, i) => {
    if (!ln.trim()) { flush(); return; }
    cur.push(ln); curLines.push(i);
  });
  flush();

  /* 筛选待翻段（标题行保留原文，仅翻译正文行） */
  const todo = [];
  for (const g of groups) {
    const fullCode = g.n > 0 && g.text.split('\n').every((_, k) => inCode[g.start + k]);
    const hasHtml = g.text.split('\n').some(ln => HTML_LINE.test(ln));
    if (fullCode || hasHtml) continue;
    const linesArr = g.text.split('\n');
    const titleLines = linesArr.filter(ln => TITLE_RE.test(ln));
    const bodyLines = linesArr.filter(ln => !TITLE_RE.test(ln));
    const bodyText = bodyLines.join('\n');
    if (!bodyText.trim()) continue;
    if (!needsRepair(bodyText)) continue;
    todo.push({ ...g, titleLines, bodyText });
  }
  if (!todo.length) { console.log('没有需要修复的段落 ✓'); return; }
  console.log(`发现 ${todo.length} 个待修复段落，开始翻译…`);

  /* 翻译（批量 + 单段重翻） */
  const out = new Array(todo.length);
  const started = Date.now();
  const log = m => console.log(`  [${TARGET}] ${m} (${((Date.now() - started) / 1000).toFixed(0)}s)`);

  const batches = [];
  for (let s = 0; s < todo.length;) {
    const b = [];
    let chars = 0, e = s;
    for (; e < todo.length && b.length < CHUNK; e++) {
      if (chars + todo[e].bodyText.length > MAXC && b.length) break;
      b.push(todo[e].bodyText); chars += todo[e].bodyText.length;
    }
    batches.push([s, e]); s = e;
  }

  const BAD = [];
  let bi = 0;
  const workers = [];
  for (let w = 0; w < Math.min(CONC, batches.length); w++) {
    workers.push((async () => {
      for (;;) {
        const c = bi++;
        if (c >= batches.length) return;
        const [s0, e0] = batches[c];
        const items = todo.slice(s0, e0).map(g => g.bodyText);
        let texts = null;
        for (let t = 0; t < 3 && !texts; t++) {
          try {
            const r = await translateBatch(items);
            if (r.length === items.length) texts = r;
            else log(`段数不匹配 ${r.length}/${items.length}，重试 ${t + 1}`);
          } catch (err) {
            log(`batch fail: ${err.message.slice(0, 100)}，重试 ${t + 1}`);
            await new Promise(r => setTimeout(r, 3000 * (t + 1)));
          }
        }
        for (let k = 0; k < items.length; k++) {
          const idx = s0 + k;
          if (texts && texts[k]) {
            out[idx] = texts[k];
            if (!qualityOk(texts[k])) BAD.push(idx);
          } else BAD.push(idx);
        }
        log(`批 ${c + 1}/${batches.length} 完成`);
      }
    })());
  }
  await Promise.all(workers);

  /* 单段重翻 */
  if (BAD.length) {
    log(`单段重翻 ${BAD.length} 段…`);
    let bi2 = 0;
    const ws = [];
    for (let w = 0; w < Math.min(CONC, BAD.length); w++) {
      ws.push((async () => {
        for (;;) {
          const i = bi2++;
          if (i >= BAD.length) return;
          const idx = BAD[i];
          const orig = todo[idx].bodyText;
          let ok = null;
          for (let t = 0; t < 3 && !ok; t++) {
            try {
              const r = await translateBatch([orig]);
              if (r[0] && qualityOk(r[0])) ok = r[0];
            } catch (err) {
              await new Promise(r => setTimeout(r, 3000 * (t + 1)));
            }
          }
          if (ok) { out[idx] = ok; log(`重翻段 ${idx} ✓`); }
          else log(`重翻段 ${idx} 仍不合格 ⚠（保留原批量结果）`);
        }
      })());
    }
    await Promise.all(ws);
  }

  /* 从后往前替换行（标题行保留原文，译文接在标题行之后） */
  const newLines = [...lines];
  const indices = todo.map((g, i) => ({ g, i })).sort((a, b) => b.g.start - a.g.start);
  for (const { g, i } of indices) {
    const body = (out[i] ?? g.bodyText).split('\n');
    const rep = g.titleLines.length ? [...g.titleLines, ...body] : body;
    newLines.splice(g.start, g.n, ...rep);
  }
  fs.writeFileSync(FILE, newLines.join('\n'), 'utf8');
  console.log(`已写回 ${FILE} ✓ (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });

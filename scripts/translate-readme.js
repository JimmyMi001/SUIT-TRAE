/* =========================================================
   translate-readme.js — README 全文多语言翻译（DeepSeek 直连）
   · 简体中文 README.md → 英文 README.en.md / 繁體 README.zh-Hant.md
   · 保护：fenced code block、行内代码、链接 URL、HTML 标签
   · 标题单独翻译 → 重建 GitHub 锚点（TOC 链接随标题同步更新）
   · 质量保障：并发翻译 + 目标语言校验 + 不合格段落单段重翻（≤2 轮）
   · 用法：
       node scripts/translate-readme.js --dry     # 仅统计待翻译内容，不调用 API
       node scripts/translate-readme.js            # 执行翻译（en + zh-Hant）
   ========================================================= */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'README.md');
const OUTS = {
  en: path.join(ROOT, 'README.en.md'),
  'zh-Hant': path.join(ROOT, 'README.zh-Hant.md')
};
const API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const KEY = process.env.DEEPSEEK_KEY;
const TO_NAME = { en: 'English (US)', 'zh-Hant': '繁體中文（中國香港）' };

const CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;   // fenced code block
const TITLE_RE = /^(#{1,6}) (.+)$/;                  // 标题行

const CONC = 5;      // 并发路数
const CHUNK = 4;     // 每批段数（越小越稳定）

/* ---------- GitHub 锚点 slug（与 README 现有锚点规则一致） ---------- */
function ghSlug(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/\p{Extended_Pictographic}/gu, '')   // 移除 emoji
    .replace(/[\s_]+/g, '-')                       // 空白/下划线 → -
    .replace(/[^\p{L}\p{N}\-_]+/gu, '');           // 移除其余标点（保留中文/字母/数字/-/_）
}

/* ---------- 目标语言质量校验 ----------
   en:   英文段落允许保留少量中文专有名词（高德/美团等品牌名），
         但汉字过多（≥16 字或占比>30%）视为未翻译 → 需重翻
   zh-Hant: 检测简体特征双字词，出现 ≥2 个视为残留简体 → 需重翻 */
const SIMP_WORDS = ['软件','网络','数据','用户','服务器','页面','上传','下载','验证','缓存','内容','文档','菜单','点击','这里','里面','我们','实现','设计','支持','相关','信息','服务','功能','切换','显示','获取','生成','推荐','提供','使用','选择','输入','输出','更新','访问','打开','关闭','创建','删除','保存','添加','修改','调整','增加','减少','处理','完成','开始','继续','停止','发送','接收','请求','响应','代码','开发','编程','测试','部署','安装','配置','启动','运行','浏览','地址','密码','设置','记录','集合','数据源','来源'];
function qualityOk(lang, text) {
  if (!text) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (lang === 'en') {
    if (cjk >= 16) return false;
    if (cjk > 0 && cjk / Math.max(text.length, 1) > 0.3) return false;
    return true;
  }
  // zh-Hant
  if (cjk === 0) return false;  // 繁体段落必须含中文
  let simp = 0;
  for (const w of SIMP_WORDS) if (text.includes(w)) simp++;
  return simp < 2;
}

/* ---------- DeepSeek 直连（单批多段，%% 分隔） ---------- */
async function translateBatch(to, texts) {
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
        { role: 'system', content: systemPrompt(to) },
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

/* ---------- 系统提示词（用户模板 + README/Markdown 附加约束） ---------- */
function systemPrompt(to) {
  const isEn = to === 'English (US)';
  const style = isEn
    ? 'Use natural American English, idiomatic and fluent, matching native speaker expression habits.'
    : '使用繁體中文（中國香港慣用語）翻譯：信息→資訊、软件→軟件、网络→網絡、支持→支援、用户→用戶、数据→數據、服务器→伺服器、页面→頁面、上传→上傳、下载→下載、验证→驗證、缓存→緩存、内容→內容、文档→文檔、功能→功能、切换→切換、界面→介面、菜单→選單、刷新→重新整理、点击→點擊、这里→這裡、里面→裏面。';
  const properNoun = isEn
    ? '- 品牌/平台名尽量给出英文常用名（高德→Amap、美团→Meituan、飞猪→Fliggy、途牛→Tuniu、携程→Ctrip、12306 保留数字、DeepSeek 保留）；城市名用拼音（北京→Beijing、广州→Guangzhou、杭州→Hangzhou）；学校名 Shenzhen University of Information Technology (SUIT)。其余文件名/命令/API 保留原样'
    : '- 专有名词：城市名、品牌名（高德/美团/飞猪/途牛/DeepSeek/12306）、文件名、命令、JSON 字段保留原样（可保留简体字品牌名）';
  return `You are a professional ${to} native translator who needs to fluently translate text into ${to}.

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
- 保留全部 Markdown 语法：标题 #、表格 | 和 ---、列表 - / 数字、引用 >、粗体 **、斜体 *、链接 [text](url)、代码块 \`\`\`、行内代码 \`、分隔线 ---、HTML 标签
- 表格：保持行数、列数与 | 分隔符完全一致，只翻译单元格内文字；表头分隔行（|---|）原样保留
- 链接/图片：[text](url) 中 url 原样保留（不翻译、不改动），只翻译 text 部分；HTML <img> 的 src 原样保留
- 行内代码 \`...\` 与代码块 \`\`\` 内容不翻译，原样保留
- 保留全部 emoji 与特殊符号（🚀🌐📖🏗️🔑📊🤝⚠️💡 等）
- ${properNoun}
- 产品名 "123 就出发" 翻译为 "123 Let's Go"；副标题 *Travel Verified, Not Memorized* 保留英文
- ${style}
- 信达雅，地道自然，术语统一。`;
}

/* ---------- 内容解析：分成 代码块 / 标题 / 段落 ---------- */
function parseContent(md) {
  const codes = [];
  const text = md.replace(CODE_RE, (m) => { codes.push(m); return `@@CODE${codes.length - 1}@@`; });

  const lines = text.split('\n');
  const titles = [];
  lines.forEach((ln, i) => {
    const m = ln.match(TITLE_RE);
    if (m) {
      const level = m[1].length;
      const raw = m[2];
      const idx = titles.length;
      titles.push({ raw, level, anchor: ghSlug(raw) });
      lines[i] = `@@TITLE${idx}@@`;
    }
  });

  const blocks = [];
  let cur = [];
  let len = 0;
  const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; len = 0; } };
  for (const ln of lines) {
    if (!ln.trim()) { flush(); blocks.push(''); continue; }
    cur.push(ln); len += ln.length;
    if (len >= 2200) flush();
  }
  flush();
  return { codes, titles, segs: blocks.filter(b => b !== '') };
}

/* ---------- 并发翻译（批量 + 校验 + 单段重翻） ---------- */
async function translateAll(to, items) {
  const out = new Array(items.length);
  const BAD = new Set();        // 需单段重翻的索引
  const done = { n: 0 };
  const started = Date.now();

  const log = (msg) => console.log(`  [${to}] ${msg} (${((Date.now() - started) / 1000).toFixed(0)}s)`);

  /* 批量翻译：items[idx0..idx1) 一批 */
  async function batchTranslate(idx0, idx1) {
    const batch = items.slice(idx0, idx1);
    let texts = null;
    for (let t = 0; t < 3 && !texts; t++) {
      try {
        const r = await translateBatch(to, batch);
        if (r.length === batch.length) texts = r;
        else log(`段数不匹配 ${r.length}/${batch.length}，重试 ${t + 1}`);
      } catch (err) {
        log(`batch fail: ${err.message.slice(0, 100)}，重试 ${t + 1}`);
        await new Promise(r => setTimeout(r, 3000 * (t + 1)));
      }
    }
    if (texts) {
      for (let k = 0; k < batch.length; k++) {
        out[idx0 + k] = texts[k];
        if (!qualityOk(to, texts[k])) { BAD.add(idx0 + k); log(`段 ${idx0 + k} 语言不合格，标记重翻`); }
      }
    } else {
      for (let k = 0; k < batch.length; k++) BAD.add(idx0 + k);
    }
    done.n += batch.length;
    log(`${done.n}/${items.length} 段完成`);
  }

  /* 批量阶段 */
  const batches = [];
  for (let s = 0; s < items.length; s += CHUNK) {
    const b = [];
    let chars = 0;
    let e = s;
    for (; e < items.length && b.length < CHUNK; e++) {
      if (chars + items[e].length > 5000 && b.length) break;
      b.push(items[e]); chars += items[e].length;
    }
    batches.push([s, e]);
  }
  let bi = 0;
  const workers = [];
  for (let w = 0; w < Math.min(CONC, batches.length); w++) {
    workers.push((async () => {
      for (;;) {
        const c = bi++;
        if (c >= batches.length) return;
        await batchTranslate(batches[c][0], batches[c][1]);
      }
    })());
  }
  await Promise.all(workers);

  /* 单段重翻阶段（并发） */
  if (BAD.size) {
    log(`开始单段重翻 ${BAD.size} 个不合格段落…`);
    const list = [...BAD];
    let bi2 = 0;
    const runOne = async () => {
      for (;;) {
        const i = bi2++;
        if (i >= list.length) return;
        const idx = list[i];
        const orig = items[idx];
        let okText = null;
        for (let t = 0; t < 3 && !okText; t++) {
          try {
            const r = await translateBatch(to, [orig]);
            if (r[0] && qualityOk(to, r[0])) okText = r[0];
            else log(`重翻段 ${idx} 仍不合格，再试 ${t + 1}`);
          } catch (err) {
            log(`重翻段 ${idx} fail: ${err.message.slice(0, 80)}，重试 ${t + 1}`);
            await new Promise(r => setTimeout(r, 3000 * (t + 1)));
          }
        }
        if (okText) { out[idx] = okText; log(`重翻段 ${idx} ✓`); }
        else log(`重翻段 ${idx} 最终保留原批量结果 ⚠`);
      }
    };
    const ws = [];
    for (let w = 0; w < Math.min(CONC, list.length); w++) ws.push(runOne());
    await Promise.all(ws);
  }

  return out;
}

/* ---------- 重组：段落译文 + 标题译文 + 锚点重建 + 还原代码 ---------- */
function rebuild(md, codes, titles, transTitles, segs, transSegs) {
  const codes2 = [];
  const t2 = md.replace(CODE_RE, (m) => { codes2.push(m); return `@@CODE${codes2.length - 1}@@`; });
  const lines = t2.split('\n');
  lines.forEach((ln, i) => {
    const m = ln.match(TITLE_RE);
    if (m) { lines[i] = `@@TITLE${titles.findIndex(t => t.raw === m[2])}@@`; }
  });
  const blocks = [];
  let cur = [];
  let len = 0;
  const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; len = 0; } };
  for (const ln of lines) {
    if (!ln.trim()) { flush(); blocks.push(''); continue; }
    cur.push(ln); len += ln.length;
    if (len >= 2200) flush();
  }
  flush();

  const segIdx = new Map(segs.map((s, i) => [s, transSegs[i]]));
  const finalLines = blocks.map(b => (b === '' ? '' : (segIdx.get(b) ?? b)));

  let mdOut = finalLines.join('\n');

  mdOut = mdOut.replace(/@@TITLE(\d+)@@/g, (_, i) => {
    const t = titles[+i];
    return '#'.repeat(t.level) + ' ' + transTitles[+i];
  });

  const slugMap = {};
  titles.forEach((t, i) => { slugMap[t.anchor] = ghSlug(transTitles[i]); });
  mdOut = mdOut.replace(/\]\(#([^)]*)\)/g, (all, anchor) => {
    const a = anchor.trim();
    return slugMap[a] ? `](#${slugMap[a]})` : all;
  });

  mdOut = mdOut.replace(/@@CODE(\d+)@@/g, (_, i) => codes2[+i]);
  return mdOut;
}

/* ---------- 语言切换横幅（置于标题之后） ---------- */
function langHeader(lang) {
  // 顺序统一为：简体 → 繁體 → English（与链接顺序一致）
  const label = lang === 'en' ? 'Language' : '語言 / 语言 / Language';
  const sep = lang === 'en' ? ': ' : '：';
  const links = lang === 'en'
    ? '<a href="./README.md">Simplified Chinese</a> · <a href="./README.zh-Hant.md">Traditional Chinese</a> · <a href="./README.en.md">English</a>'
    : '<a href="./README.md">简体中文</a> · <a href="./README.zh-Hant.md">繁體中文</a> · <a href="./README.en.md">English</a>';
  return `<div align="center">

**🌐 ${label}${sep}${links}**

</div>

---
`;
}

/* ---------- 主流程 ---------- */
async function main() {
  const isDry = process.argv.includes('--dry');
  const langs = process.argv.includes('--en') ? ['en'] : process.argv.includes('--tw') ? ['zh-Hant'] : ['en', 'zh-Hant'];
  if (!KEY) { console.error('未找到 DEEPSEEK_KEY，请先配置 .env'); process.exit(1); }
  const md = fs.readFileSync(SRC, 'utf8');
  const { codes, titles, segs } = parseContent(md);

  console.log(`README 解析：代码块 ${codes.length} 个，标题 ${titles.length} 个，段落 ${segs.length} 段（总字符 ${segs.reduce((a, b) => a + b.length, 0)}）`);
  if (isDry) {
    titles.slice(0, 20).forEach(t => console.log('  ' + t.raw));
    console.log('（--dry 仅统计，未调用 API）');
    return;
  }

  for (const lang of langs) {
    console.log(`\n===== 翻译 ${TO_NAME[lang]} =====`);
    const t0 = Date.now();
    const transTitles = await translateAll(lang, titles.map(t => t.raw));
    console.log(`  [${lang}] 标题翻译完成 (${((Date.now() - t0) / 1000).toFixed(0)}s)，开始正文…`);
    const transSegs = await translateAll(lang, segs);

    const mdOut = rebuild(md, codes, titles, transTitles, segs, transSegs);
    const header = langHeader(lang);
    fs.writeFileSync(OUTS[lang], header + mdOut, 'utf8');
    console.log(`  [${lang}] 已写入 ${OUTS[lang]} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log('\n全部完成 ✓');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });

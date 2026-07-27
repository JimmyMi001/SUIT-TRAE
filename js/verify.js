/* =========================================================================
   验证页交互 — 对话 / 手风琴 / POI 标记 / 数字滚动
   ========================================================================= */
(function () {

  // ---- 对话发送 ----
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatMessages = document.getElementById('chatMessages');
  const typingEl = chatMessages.querySelector('.typing')?.closest('.msg');

  const SOURCES = [
    { tag: '高德实时', cls: 'msg__source--amap' },
    { tag: '社区路线', cls: 'msg__source--community' },
    { tag: 'China Travel MCP', cls: 'msg__source--mcp' },
  ];

  function appendUser(text) {
    const el = document.createElement('div');
    el.className = 'msg msg--user';
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    el.innerHTML = `<div class="msg__bubble">${escapeHtml(text)}</div><span class="msg__time">${hh}:${mm}</span>`;
    chatMessages.insertBefore(el, typingEl);
    scrollToBottom();
  }

  function appendAgent(text, source) {
    const el = document.createElement('div');
    el.className = 'msg msg--agent';
    const src = source || SOURCES[Math.floor(Math.random() * SOURCES.length)];
    el.innerHTML = `
      <span class="msg__source ${src.cls}"><span class="msg__source-dot"></span>${src.tag}</span>
      <div class="msg__bubble">${text}</div>`;
    chatMessages.insertBefore(el, typingEl);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const REPLIES = [
    { text: '已记录偏好，正在重新计算<b>最优动线</b>…', src: SOURCES[0] },
    { text: '社区中有 <b>2 条</b>相似路线与你匹配，已纳入参考。', src: SOURCES[1] },
    { text: '已更新地图路线，<i>风险点</i>同步刷新到右侧报告。', src: SOURCES[0] },
    { text: '基于实时数据，建议将<b>都江堰</b>调整至 Day3 周四前往。', src: SOURCES[0] },
  ];
  let replyIdx = 0;

  function send() {
    const text = chatInput.value.trim();
    if (!text) return;
    appendUser(text);
    chatInput.value = '';

    // 显示 typing
    typingEl.style.display = '';
    scrollToBottom();

    setTimeout(() => {
      typingEl.style.display = 'none';
      const r = REPLIES[replyIdx % REPLIES.length];
      replyIdx++;
      appendAgent(r.text, r.src);
    }, 1400);
  }

  if (sendBtn) sendBtn.addEventListener('click', send);
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }
  // 初始隐藏 typing，3秒后触发一次回复演示
  if (typingEl) {
    typingEl.style.display = 'none';
    setTimeout(() => {
      typingEl.style.display = '';
      scrollToBottom();
      setTimeout(() => {
        typingEl.style.display = 'none';
        appendAgent('路线已重新生成，可信度提升至 <b>87</b>。点击右下角"生成完整行程"继续。', SOURCES[2]);
      }, 1500);
    }, 2500);
  }

  // ---- 语音按钮 ----
  const voiceBtn = document.getElementById('voiceBtn');
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      voiceBtn.classList.toggle('chat__voice--active');
      if (voiceBtn.classList.contains('chat__voice--active')) {
        chatInput.placeholder = '正在聆听…';
        setTimeout(() => {
          voiceBtn.classList.remove('chat__voice--active');
          chatInput.placeholder = '补充你的偏好，或调整路线…';
        }, 3000);
      }
    });
  }

  // ---- 风险手风琴 ----
  document.querySelectorAll('.acc-item__head').forEach((head) => {
    head.addEventListener('click', () => {
      head.closest('.acc-item').classList.toggle('open');
    });
  });

  // ---- POI 标记点击切换浮动卡片 ----
  const poiCard = document.querySelector('.poi-card');
  document.querySelectorAll('.poi-marker').forEach((marker) => {
    marker.style.cursor = 'pointer';
    marker.addEventListener('click', () => {
      const idx = marker.dataset.poi;
      // 简单演示：闪烁卡片
      if (poiCard) {
        poiCard.style.animation = 'none';
        void poiCard.offsetWidth;
        poiCard.style.animation = 'fade-up 0.3s var(--ease-out) both';
      }
    });
  });

  // ---- 可信度数字滚动 ----
  const scoreEl = document.querySelector('.score-ring__val');
  if (scoreEl) {
    const target = parseInt(scoreEl.textContent, 10) || 0;
    let cur = 0;
    scoreEl.textContent = '0';
    const step = Math.max(1, Math.ceil(target / 40));
    const timer = setInterval(() => {
      cur += step;
      if (cur >= target) { cur = target; clearInterval(timer); }
      scoreEl.textContent = cur;
    }, 30);
  }

  // ---- 生成行程按钮 ----
  const genBtn = document.getElementById('generateBtn');
  if (genBtn) {
    genBtn.addEventListener('click', () => {
      genBtn.style.animation = 'none';
      genBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin-slow 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg> 正在生成…';
      setTimeout(() => {
        genBtn.innerHTML = '生成完整行程 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
        genBtn.style.animation = 'btn-pulse 2.4s var(--ease-in-out) infinite';
      }, 1800);
    });
  }

  // 从 URL 读取查询参数
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  if (q && chatInput) {
    setTimeout(() => appendAgent(`已为你加载 <b>${q}</b> 的路线验证，右侧报告已就绪。`, SOURCES[2]), 600);
  }
})();

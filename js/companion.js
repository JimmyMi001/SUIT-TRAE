/* =========================================================================
   旅途中 — 快捷按钮 / 应急 / 模板 / 对话
   ========================================================================= */
(function () {
  // 应急按钮震动反馈
  document.querySelectorAll('.emergency-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(80);
      const num = btn.querySelector('.emergency-btn__num').textContent.trim();
      if (num === '120' || num === '110') {
        alert(`正在为你拨打 ${num}…（演示）`);
      } else if (num === '↗') {
        alert('正在规划回酒店路线…（演示）');
      }
    });
  });

  // 快捷操作
  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.querySelector('.quick-btn__label').textContent;
      const wrap = document.getElementById('chatMessages');
      const el = document.createElement('div');
      el.className = 'companion__msg companion__msg--agent';
      el.innerHTML = `
        <div class="companion__avatar">AI</div>
        <div class="companion__bubble">正在为你查询 <b>${label}</b>…</div>`;
      wrap.appendChild(el);
      wrap.scrollTop = wrap.scrollHeight;
    });
  });

  // 模板
  document.querySelectorAll('.template-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('chatInput').value = chip.dataset.q;
    });
  });

  // 对话
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const wrap = document.getElementById('chatMessages');
  const send = () => {
    const v = input.value.trim();
    if (!v) return;
    // 用户消息
    const u = document.createElement('div');
    u.className = 'companion__msg companion__msg--user';
    u.innerHTML = `<div class="companion__bubble">${v}</div>`;
    wrap.appendChild(u);
    input.value = '';
    wrap.scrollTop = wrap.scrollHeight;
    // Agent 回声
    setTimeout(() => {
      const a = document.createElement('div');
      a.className = 'companion__msg companion__msg--agent';
      a.innerHTML = `<div class="companion__avatar">AI</div>
        <div class="companion__bubble">已为你处理：<b>${v}</b><br><span style="color:var(--c-text-3);font-size:0.8rem">演示回复</span></div>`;
      wrap.appendChild(a);
      wrap.scrollTop = wrap.scrollHeight;
    }, 800);
  };
  if (sendBtn) sendBtn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
})();

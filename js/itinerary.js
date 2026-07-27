/* =========================================================================
   行程规划 — 天数切换 / 交通方式 / 酒店比价
   ========================================================================= */
(function () {
  // 天数切换
  const dayTabs = document.querySelectorAll('#dayTabs .day-tab');
  dayTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('day-tab--plus')) return;
      dayTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });

  // 交通方式
  const transportOpts = document.querySelectorAll('#transport .transport__opt');
  transportOpts.forEach((opt) => {
    opt.addEventListener('click', () => {
      transportOpts.forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
    });
  });

  // 酒店比价切换
  document.querySelectorAll('.hotel__row').forEach((row) => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.hotel__row').forEach((r) => r.classList.remove('hotel__row--best'));
      row.classList.add('hotel__row--best');
    });
  });

  // 对话发送
  const input = document.getElementById('chatInput');
  const sendBtn = document.querySelector('.chat__send');
  if (input && sendBtn) {
    const send = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      // 简单回声演示
      const wrap = document.getElementById('chatMessages');
      const el = document.createElement('div');
      el.className = 'msg msg--user';
      el.innerHTML = `<div class="msg__bubble">${v}</div>`;
      wrap.appendChild(el);
      wrap.scrollTop = wrap.scrollHeight;
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
  }
})();

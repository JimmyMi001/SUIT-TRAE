/* =========================================================================
   首页交互 — 搜索占位符轮播 + 卡片磁吸效果
   ========================================================================= */
(function () {
  // ---- 搜索框 placeholder 轮播 ----
  const input = document.querySelector('.search__input');
  if (input) {
    const hints = [
      '想去哪里？输入城市名或旅行偏好...',
      '试试 "成都 三天 美食深度游"',
      '试试 "大理 环海 自驾"',
      '试试 "西安 历史人文 亲子"',
    ];
    let i = 0;
    let charIdx = 0;
    let typing = true;
    let timer = null;

    function tick() {
      const text = hints[i];
      if (typing) {
        charIdx++;
        input.placeholder = text.slice(0, charIdx);
        if (charIdx >= text.length) {
          typing = false;
          timer = setTimeout(tick, 2200);
          return;
        }
      } else {
        charIdx--;
        input.placeholder = text.slice(0, charIdx);
        if (charIdx <= 0) {
          typing = true;
          i = (i + 1) % hints.length;
        }
      }
      timer = setTimeout(tick, typing ? 55 : 28);
    }
    // 仅在未聚焦时轮播
    tick();
    input.addEventListener('focus', () => { clearTimeout(timer); input.placeholder = ''; });
    input.addEventListener('blur', () => {
      clearTimeout(timer);
      typing = true; charIdx = 0; i = 0;
      tick();
    });
  }

  // ---- 目的地卡片磁吸效果 ----
  const cards = document.querySelectorAll('.dest-card');
  cards.forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      // 限制位移 ≤ 8px
      const tx = (x / rect.width) * 8;
      const ty = (y / rect.height) * 8;
      card.style.transform = `translate(${tx}px, ${ty}px)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = 'translate(0, 0)';
    });
  });

  // ---- 搜索跳转 ----
  const form = document.querySelector('.search');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q) {
        window.location.href = `verify.html?q=${encodeURIComponent(q)}`;
      } else {
        window.location.href = 'verify.html';
      }
    });
  }

  // ---- 卡片点击跳转 ----
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      const city = card.dataset.city || '';
      window.location.href = `verify.html?q=${encodeURIComponent(city)}`;
    });
  });

  // ---- 滚动渐显 ----
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  document.querySelectorAll('.route-card').forEach((el, i) => {
    el.style.animation = `fade-up 0.6s var(--ease-out) ${i * 0.08}s both`;
    el.style.animationPlayState = 'paused';
    observer.observe(el);
  });
})();

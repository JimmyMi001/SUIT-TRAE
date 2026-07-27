/* =========================================================================
   旅行复盘 — Scroll-driven reveal + 数字滚动
   ========================================================================= */
(function () {
  // 数字滚动
  function animateCount(el, target, dur = 1600) {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target;
    };
    requestAnimationFrame(tick);
  }

  // IntersectionObserver 触发
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        // 数字滚动
        if (entry.target.matches('.section')) {
          entry.target.querySelectorAll('.stat-card__val').forEach((el) => {
            const target = parseInt(el.dataset.count, 10);
            if (target) animateCount(el, target);
          });
        }
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });

  document.querySelectorAll('[data-section]').forEach((el) => observer.observe(el));
})();

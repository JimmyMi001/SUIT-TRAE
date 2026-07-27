/* =========================================================================
   社区广场 — 筛选 / 模态框 / 适配切换
   ========================================================================= */
(function () {
  // 筛选
  const filterChips = document.querySelectorAll('.filter-chip');
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      // 同组切换
      const group = chip.parentElement;
      group.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      // 过滤卡片
      const budget = document.querySelector('.filter-chip[data-filter="budget"].active')?.dataset.value;
      const days = document.querySelector('.filter-chip[data-filter="days"].active')?.dataset.value;
      document.querySelectorAll('.croute').forEach((card) => {
        const cb = card.dataset.budget;
        const cd = parseInt(card.dataset.days, 10);
        const matchB = budget === 'all' || cb === budget;
        const matchD = days === 'all' ||
          (days === '2' && cd <= 2) ||
          (days === '3' && cd <= 3) ||
          (days === '5' && cd >= 4);
        card.style.display = matchB && matchD ? '' : 'none';
      });
    });
  });

  // 模态框
  const modal = document.getElementById('routeModal');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalSub = document.getElementById('modalSub');

  document.querySelectorAll('.croute').forEach((card) => {
    card.addEventListener('click', () => {
      const title = card.querySelector('.croute__title').textContent;
      const author = card.querySelector('.croute__author-name').textContent;
      const used = card.querySelector('.croute__used').textContent;
      modalTitle.textContent = title;
      modalSub.textContent = `由 ${author} 贡献 · ${used}`;
      modal.classList.add('open');
    });
  });

  if (modalClose) modalClose.addEventListener('click', () => modal.classList.remove('open'));
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('open');
  });

  // 适配选项
  document.querySelectorAll('.adapt__opts').forEach((group) => {
    group.querySelectorAll('.adapt__opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        group.querySelectorAll('.adapt__opt').forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
      });
    });
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) {
      modal.classList.remove('open');
    }
  });

  // 分享按钮
  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      alert('打开路线编辑器（演示）');
    });
  }
})();

/* =========================================================================
   行前准备 — 手风琴 / 打包清单 / 进度更新
   ========================================================================= */
(function () {
  // 手风琴
  document.querySelectorAll('.pcard__head').forEach((head) => {
    head.addEventListener('click', () => {
      head.closest('.pcard').classList.toggle('open');
    });
  });

  // 打包清单
  document.querySelectorAll('.pack-item').forEach((item) => {
    item.addEventListener('click', () => {
      item.classList.toggle('checked');
      const svg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>';
      const checkEl = item.querySelector('.pack-item__check');
      if (item.classList.contains('checked')) {
        checkEl.innerHTML = svg;
      } else {
        checkEl.innerHTML = '';
      }
    });
  });

  // 进度
  const totalCards = 7;
  const doneCards = document.querySelectorAll('.pcard--done').length;
  const updateProgress = () => {
    const pct = Math.round((doneCards / totalCards) * 100);
    const valEl = document.getElementById('progressVal');
    if (valEl) valEl.innerHTML = `${pct}<small>%</small>`;
    const bar = document.getElementById('barMini');
    if (bar) bar.style.width = pct + '%';
    // 环形 dashoffset：dasharray 314, 314*ratio
    const dashBar = document.querySelector('.progress-ring__bar');
    if (dashBar) dashBar.style.setProperty('--prog-offset', String(314 - 314 * pct / 100));
  };
  updateProgress();

  // 全部完成按钮
  const doneBtn = document.getElementById('doneBtn');
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      doneBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="animation:spin-slow 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg> 生成中…';
      setTimeout(() => {
        alert('已生成完整准备清单 PDF！');
        doneBtn.innerHTML = '全部完成 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>';
      }, 1200);
    });
  }
})();

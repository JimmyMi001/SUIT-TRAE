/* =========================================================================
   真实路线(策展·可溯源) — 加载/筛选/详情/导入
   ========================================================================= */
(function () {
  const grid = document.getElementById('realRoutesGrid');
  const subEl = document.getElementById('realRoutesSub');
  const citySel = document.getElementById('realCityFilter');
  const refreshBtn = document.getElementById('realRoutesRefresh');
  const modal = document.getElementById('curatedModal');
  const modalClose = document.getElementById('curatedModalClose');
  const modalTitle = document.getElementById('curatedTitle');
  const modalSub = document.getElementById('curatedSub');
  const modalNodes = document.getElementById('curatedNodes');
  const sourceLink = document.getElementById('curatedSourceLink');
  const openOriginalBtn = document.getElementById('curatedOpenOriginal');
  const importBtn = document.getElementById('curatedImport');

  if (!grid) return;

  let ALL_ROUTES = [];
  let CURRENT_ROUTE = null;

  // POI 类型 → emoji
  const TYPE_ICON = {
    '历史': '🏯', '文化': '🎭', '自然': '🌲', '亲子': '👶',
    '地标': '🏛', '美食': '🍜', '购物': '🛍', '夜生活': '🌃',
    '文艺': '🎨', '景点': '📍', '公园': '🌳', '历史古迹': '🏛',
    '海岛': '🏖', '主题': '🎢', '城市地标': '🏙', '博物馆': '🏛'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 加载策展路线
  async function loadCurated(city) {
    grid.innerHTML = '<div class="real-routes__loading">正在加载真实路线…</div>';
    try {
      const url = '/api/routes/curated' + (city ? '?city=' + encodeURIComponent(city) : '');
      const r = await fetch(url);
      const j = await r.json();
      if (!j.error) {
        ALL_ROUTES = j.routes || [];
        renderRoutes(ALL_ROUTES);
        // 加载来源统计
        const sr = await fetch('/api/routes/sources');
        const sj = await sr.json();
        if (!sj.error && sj.sources) {
          subEl.textContent = `共 ${ALL_ROUTES.length} 条真实路线,${sj.count} 个公开来源 · ${sj.sources.map(s => s.platform).join(' / ')}`;
        }
      } else {
        grid.innerHTML = '<div class="real-routes__empty">加载失败</div>';
      }
    } catch (e) {
      grid.innerHTML = `<div class="real-routes__empty">网络错误: ${esc(e.message)}</div>`;
    }
  }

  // 加载城市筛选选项
  async function loadCityOptions() {
    try {
      const r = await fetch('/api/routes/curated');
      const j = await r.json();
      if (j.error || !j.routes) return;
      const cities = Array.from(new Set(j.routes.map(x => x.city))).sort();
      cities.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        citySel.appendChild(opt);
      });
    } catch (e) { /* ignore */ }
  }

  // 渲染路线卡片
  function renderRoutes(list) {
    if (list.length === 0) {
      grid.innerHTML = '<div class="real-routes__empty">没有符合条件的真实路线</div>';
      return;
    }
    grid.innerHTML = list.map(r => {
      const platform = (r.source && r.source.platform) || '未知来源';
      const url = (r.source && r.source.url) || '#';
      const tagBadges = (r.tags || []).slice(0, 3).map(t =>
        `<span class="real-routes__tag">${esc(t)}</span>`).join('');
      const pois = (r.nodes || []).slice(0, 5).map(n =>
        `<span class="real-routes__poi">${TYPE_ICON[n.type] || '📍'} ${esc(n.poi)}</span>`
      ).join('');
      return `
        <article class="rr-card" data-id="${esc(r.id)}">
          <div class="rr-card__head">
            <span class="rr-card__platform">📚 ${esc(platform)}</span>
            <span class="rr-card__city">${esc(r.city)} · ${r.days}天</span>
          </div>
          <h3 class="rr-card__title">${esc(r.title)}</h3>
          <div class="rr-card__summary">${esc(r.summary || '')}</div>
          <div class="rr-card__pois">${pois}${(r.nodes || []).length > 5 ? `<span class="real-routes__poi">+${(r.nodes || []).length - 5}</span>` : ''}</div>
          <div class="rr-card__meta">
            <span>${esc(r.budget || '舒适')}</span>
            <span>·</span>
            <span>${(r.nodes || []).length} POI</span>
          </div>
          <div class="rr-card__tags">${tagBadges}</div>
          <div class="rr-card__actions">
            <button class="rr-card__btn rr-card__btn--ghost" data-act="open" data-url="${esc(url)}">查看原文</button>
            <button class="rr-card__btn rr-card__btn--primary" data-act="detail">路线详情</button>
            <button class="rr-card__btn rr-card__btn--gold" data-act="import">导入</button>
          </div>
        </article>
      `;
    }).join('');

    // 绑定事件
    grid.querySelectorAll('.rr-card').forEach(card => {
      const id = card.dataset.id;
      const r = ALL_ROUTES.find(x => x.id === id);
      if (!r) return;
      card.querySelector('[data-act="open"]').onclick = (e) => {
        e.stopPropagation();
        const u = e.currentTarget.dataset.url;
        if (u && u !== '#') window.open(u, '_blank', 'noopener');
      };
      card.querySelector('[data-act="detail"]').onclick = (e) => {
        e.stopPropagation();
        showDetail(r);
      };
      card.querySelector('[data-act="import"]').onclick = (e) => {
        e.stopPropagation();
        importRoute(r);
      };
    });
  }

  // 显示详情
  function showDetail(r) {
    CURRENT_ROUTE = r;
    modalTitle.textContent = r.title;
    modalSub.textContent = `${r.city} · ${r.days}天 · ${r.budget || '舒适'} · ${(r.tags || []).join(' / ')}`;

    // 来源
    const src = r.source || {};
    sourceLink.href = src.url || '#';
    sourceLink.textContent = `${src.platform || '未知'} · ${src.author || ''} · ${src.fetched_at || ''}`;

    // POI 节点
    modalNodes.innerHTML = (r.nodes || []).map((n, i) => `
      <div class="mnode">
        <div class="mnode__name">${i + 1}. ${TYPE_ICON[n.type] || '📍'} ${esc(n.poi)}</div>
        <div class="mnode__meta">${esc(n.type || '')}${n.official_url ? ' · <a href="' + esc(n.official_url) + '" target="_blank" rel="noopener" style="color:var(--accent)">官网 ↗</a>' : ''}</div>
      </div>
    `).join('');

    // 原文按钮
    openOriginalBtn.onclick = () => {
      if (src.url) window.open(src.url, '_blank', 'noopener');
    };
    importBtn.onclick = () => importRoute(r);

    modal.classList.add('open');
  }

  // 导入到 community.json
  async function importRoute(r) {
    if (!confirm(`确定要把「${r.title}」导入社区路线吗?\n来源: ${(r.source || {}).platform || '未知'}`)) return;
    importBtn.disabled = true;
    importBtn.textContent = '导入中…';
    try {
      const resp = await fetch('/api/routes/import-curated/' + encodeURIComponent(r.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validate: true })
      });
      const j = await resp.json();
      if (j.error) {
        if (j.duplicate) {
          alert('已存在相似路线:\n' + (j.existing && j.existing.title));
        } else {
          alert('导入失败: ' + (j.message || '未知错误'));
        }
      } else {
        alert('✓ 导入成功! 路线已加入社区');
        if (modal.classList.contains('open')) modal.classList.remove('open');
      }
    } catch (e) {
      alert('网络错误: ' + e.message);
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '导入到我的规划';
    }
  }

  // 事件
  if (citySel) {
    citySel.onchange = () => loadCurated(citySel.value);
  }
  if (refreshBtn) {
    refreshBtn.onclick = () => loadCurated(citySel ? citySel.value : '');
  }
  if (modalClose) {
    modalClose.onclick = () => modal.classList.remove('open');
  }
  if (modal) {
    modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('open'); };
  }

  // 初始化
  loadCurated();
  loadCityOptions();
})();

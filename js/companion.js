/* =========================================================================
   旅途中 — 快捷按钮 / 应急 / 模板 / 对话（真实API调用版本）
   ========================================================================= */
(function () {
  // API 客户端（简化版）
  const API = {
    async get(path) {
      try {
        const r = await fetch(path);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        return { __error: true, message: e.message };
      }
    },
    poiNearby: (type, city, keywords) => API.get('/api/poi/nearby?type=' + encodeURIComponent(type || '') + '&city=' + encodeURIComponent(city || '') + '&keywords=' + encodeURIComponent(keywords || '')),
    poiAggregate: (type, city, limit) => API.get('/api/poi/aggregate?type=' + encodeURIComponent(type || '景点') + '&city=' + encodeURIComponent(city || '') + '&limit=' + (limit || 8)),
    weather: (city) => API.get('/api/amap/weather?city=' + encodeURIComponent(city || '')),
    fx: (from, to) => API.get('/api/fx?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)),
    chat: (msg) => API.get('/api/chat?q=' + encodeURIComponent(msg))
  };

  // 获取当前城市（从URL参数或默认广州）
  const urlParams = new URLSearchParams(window.location.search);
  const currentCity = urlParams.get('city') || '广州';

  // 应急按钮
  document.querySelectorAll('.emergency-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(80);
      const num = btn.querySelector('.emergency-btn__num').textContent.trim();
      if (num === '120' || num === '110') {
        alert('正在为你拨打 ' + num + '…（演示）');
      } else if (num === '↗') {
        alert('正在规划回酒店路线…（演示）');
      }
    });
  });

  // 快捷操作按钮 → 映射到实际API查询
  const quickBtnMap = {
    '附近美食': { type: '美食', keywords: '美食|餐厅|小吃|特色菜', icon: '🍜' },
    '找厕所': { type: '生活服务', keywords: '厕所|洗手间|公厕|卫生间', icon: '🚻' },
    '天气预警': null,
    '实时汇率': null,
    '航班动态': null,
    '紧急求助': null
  };

  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = btn.querySelector('.quick-btn__label').textContent.trim();
      const wrap = document.getElementById('chatMessages');
      if (!wrap) return;

      // 用户消息
      addMsg(wrap, 'user', label);

      const handler = quickBtnMap[label];
      if (handler && handler.type) {
        // POI查询
        showTyping(wrap);
        const r = await API.poiNearby(handler.type, currentCity, handler.keywords);
        let pois = r?.pois || [];
        if (pois.length < 3 && handler.type !== '生活服务') {
          const r2 = await API.poiAggregate(handler.type, currentCity, 6);
          if (r2?.pois?.length) pois = pois.concat(r2.pois).slice(0, 8);
        }
        removeTyping(wrap);
        if (pois.length) {
          const list = pois.slice(0, 8).map(p =>
            '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
            '<div style="flex:1;min-width:0"><div style="font-weight:600">' + handler.icon + ' ' + escHtml(p.name) + '</div>' +
            '<div style="color:var(--c-text-2);font-size:12px">' + escHtml(p.address || '') + '</div>' +
            (p.type ? '<div style="color:var(--c-gold);font-size:11px;margin-top:2px">' + escHtml(p.type) + '</div>' : '') +
            '</div>' + (p.distance ? '<div style="color:var(--c-gold);font-size:12px;white-space:nowrap">' + p.distance + 'm</div>' : '') +
            '</div>'
          ).join('');
          addMsg(wrap, 'agent',
            '<strong>' + currentCity + ' · ' + label + '</strong>（' + pois.length + ' 条）<br>' + list,
            '高德地图 · 实时数据');
        } else {
          addMsg(wrap, 'agent', currentCity + ' 暂无' + label + '数据，试试其他城市', '');
        }
      } else if (label === '天气预警') {
        showTyping(wrap);
        const r = await API.weather(currentCity);
        removeTyping(wrap);
        const w = r?.data?.lives?.[0];
        if (w) {
          addMsg(wrap, 'agent',
            '<strong>' + currentCity + '</strong><br>🌡 温度：<strong>' + (w.temperature || '—') + '°C</strong><br>' +
            '☁ 天气：' + (w.weather || '—') + '<br>💧 湿度：' + (w.humidity || '—') + '%<br>' +
            '💨 风力：' + (w.winddirection || '—') + ' ' + (w.windpower || ''),
            '高德天气 · 实时');
        } else {
          addMsg(wrap, 'agent', '查不到' + currentCity + '天气，请稍后重试', '');
        }
      } else if (label === '实时汇率') {
        showTyping(wrap);
        const r = await API.fx('CNY', 'USD');
        removeTyping(wrap);
        const rate = r?.data?.rates?.USD;
        if (rate) {
          addMsg(wrap, 'agent',
            '💱 <strong>CNY → USD</strong><br>1 人民币 ≈ <strong style="color:var(--c-gold)">' + rate + '</strong> 美元<br>100 人民币 ≈ ' + (100 * rate).toFixed(2) + ' 美元<br>' +
            '<small style="color:var(--c-text-2)">Frankfurter 实时汇率 · 每分钟更新</small>',
            'Frankfurter API');
        } else {
          addMsg(wrap, 'agent', '汇率查询失败，请稍后重试', '');
        }
      } else if (label === '航班动态') {
        addMsg(wrap, 'agent', '✈️ 航班动态功能需指定出发地和目的地<br>请使用下方「智能问答」输入具体航班号或路线', '');
      } else if (label === '紧急求助') {
        addMsg(wrap, 'agent', '🚨 如遇紧急情况请立即拨打：<br>· 报警 110<br>· 急救 120<br>· 火警 119<br>· 交通事故 122', '');
      } else {
        addMsg(wrap, 'agent', '正在为你查询 <b>' + label + '</b>…', '');
      }
    });
  });

  // 模板
  document.querySelectorAll('.template-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('chatInput').value = chip.dataset.q;
    });
  });

  // 对话（真实API）
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const wrap = document.getElementById('chatMessages');

  const send = async () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    addMsg(wrap, 'user', v);
    showTyping(wrap);

    // POI 相关 → 调高德
    let handled = false;
    let type = '', keywords = '';
    if (/奶茶|咖啡|饮品|星巴克|瑞幸|喜茶|奈雪|蜜雪|茶百道|古茗|MANNER/.test(v)) {
      type = '饮品'; keywords = '奶茶|咖啡|饮品|星巴克|瑞幸|喜茶|奈雪|蜜雪冰城|茶百道|MANNER|一点点|CoCo都可|霸王茶姬|古茗';
    } else if (/美食|吃|餐厅|小吃|早茶|川菜|湘菜|粤菜|海鲜|烧烤|火锅|面馆/.test(v)) {
      type = '美食'; keywords = '美食|餐厅|小吃|特色菜';
    } else if (/厕所|卫生间|公厕|洗手间/.test(v)) {
      type = '生活服务'; keywords = '厕所|洗手间|公厕|卫生间';
    } else if (/天气|温度|下雨|晴|阴/.test(v)) {
      removeTyping(wrap);
      const r = await API.weather(currentCity);
      const w = r?.data?.lives?.[0];
      if (w) {
        addMsg(wrap, 'agent',
          '<strong>' + currentCity + '</strong><br>🌡 温度：<strong>' + (w.temperature || '—') + '°C</strong><br>' +
          '☁ 天气：' + (w.weather || '—') + '<br>💧 湿度：' + (w.humidity || '—') + '%',
          '高德天气 · 实时');
      } else {
        addMsg(wrap, 'agent', '天气查询失败', '');
      }
      handled = true;
    } else if (/汇率|换汇|美元|欧元|日元/.test(v)) {
      removeTyping(wrap);
      const r = await API.fx('CNY', 'USD');
      const rate = r?.data?.rates?.USD;
      if (rate) {
        addMsg(wrap, 'agent', '💱 1 人民币 ≈ <strong>' + rate + '</strong> 美元', 'Frankfurter · 实时');
      } else {
        addMsg(wrap, 'agent', '汇率查询失败', '');
      }
      handled = true;
    }

    if (type && !handled) {
      removeTyping(wrap);
      const r = await API.poiNearby(type, currentCity, keywords);
      let pois = r?.pois || [];
      if (pois.length < 3) {
        const r2 = await API.poiAggregate(type, currentCity, 6);
        if (r2?.pois?.length) pois = pois.concat(r2.pois).slice(0, 8);
      }
      if (pois.length) {
        const iconMap = { '饮品': '🧋', '美食': '🍜', '生活服务': '🚻' };
        const icon = iconMap[type] || '📍';
        const list = pois.slice(0, 8).map(p =>
          '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
          '<div style="flex:1;min-width:0"><div style="font-weight:600">' + icon + ' ' + escHtml(p.name) + '</div>' +
          '<div style="color:var(--c-text-2);font-size:12px">' + escHtml(p.address || '') + '</div>' +
          '</div>' + (p.distance ? '<div style="color:var(--c-gold);font-size:12px;white-space:nowrap">' + p.distance + 'm</div>' : '') +
          '</div>'
        ).join('');
        addMsg(wrap, 'agent', '<strong>' + currentCity + ' · ' + type + '</strong>（' + pois.length + ' 条）<br>' + list, '高德地图 · 实时数据');
      } else {
        addMsg(wrap, 'agent', currentCity + ' 没搜到 ' + type + '，试试附近美食 / 附近饮品 / 找厕所', '');
      }
      handled = true;
    }

    // AI 兜底
    if (!handled) {
      removeTyping(wrap);
      try {
        const r = await API.chat(v);
        const reply = r?.reply || r?.data?.reply;
        if (reply) {
          addMsg(wrap, 'agent', reply.replace(/\n/g, '<br>'), 'DeepSeek AI');
        } else {
          addMsg(wrap, 'agent', '暂未理解。试试：<br>· 附近美食 / 附近饮品<br>· 明天天气 / 当前汇率<br>· 任何旅行问题', '');
        }
      } catch (e) {
        addMsg(wrap, 'agent', '对话服务暂不可用，请稍后重试', '');
      }
    }
  };

  if (sendBtn) sendBtn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });

  // 辅助函数
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addMsg(wrap, role, text, source) {
    const el = document.createElement('div');
    el.className = 'companion__msg companion__msg--' + role;
    let inner = '';
    if (role === 'agent') {
      inner = '<div class="companion__avatar">AI</div>';
    }
    inner += '<div class="companion__bubble">' + text + '</div>';
    if (source) {
      inner += '<div style="font-size:10px;color:var(--c-text-2);margin-top:4px;padding-left:8px">🔍 ' + source + '</div>';
    }
    el.innerHTML = inner;
    wrap.appendChild(el);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function showTyping(wrap) {
    const el = document.createElement('div');
    el.className = 'companion__msg companion__msg--agent';
    el.id = 'typing-indicator';
    el.innerHTML = '<div class="companion__avatar">AI</div><div class="companion__bubble"><span style="color:var(--c-text-2);font-size:13px">正在查询中…</span></div>';
    wrap.appendChild(el);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function removeTyping(wrap) {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  // 初始化：更新状态栏城市
  (function init() {
    const cityEl = document.getElementById('statusCity');
    if (cityEl) {
      cityEl.textContent = currentCity + ' · 实时位置';
      // 也更新 title
      document.title = '旅途中 · ' + currentCity + ' — 123就出发';
    }
    // 更新模板中的城市
    document.querySelectorAll('.template-chip').forEach(chip => {
      const q = chip.dataset.q;
      if (q && q.includes('酒店')) {
        chip.textContent = currentCity + '有什么好吃的？';
      }
    });
    // 尝试获取天气更新状态栏
    API.weather(currentCity).then(r => {
      const w = r?.data?.lives?.[0];
      if (w) {
        const tempEl = document.querySelector('.status-bar__temp');
        if (tempEl) tempEl.textContent = (w.temperature || '—') + '°';
        const condEl = tempEl?.parentElement?.querySelector('span:last-child');
        if (condEl) condEl.textContent = w.weather || '—';
      }
    }).catch(() => {});
  })();
})();

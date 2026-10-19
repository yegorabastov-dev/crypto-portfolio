/* Мой портфель: страница работает без сервера и без регистрации.
 * Портфель лежит в localStorage браузера, цены берутся из data/coins.json,
 * который раз в час обновляет скрипт scripts/update_data.py. */
(function () {
  'use strict';

  var R = window.Rebalance;

  var PERIODS = [
    ['1w', '1 нед'], ['2w', '2 нед'], ['3w', '3 нед'], ['1m', '1 мес'], ['2m', '2 мес'], ['3m', '3 мес'],
    ['6m', '6 мес'], ['1y', '1 год'], ['2y', '2 года'], ['3y', '3 года'], ['4y', '4 года'], ['5y', '5 лет']
  ];
  var KEYS = { portfolio: 'cp.portfolio.v1', settings: 'cp.settings.v1', targets: 'cp.targets.v1' };
  var REFRESH_MS = 10 * 60 * 1000;
  var MAX_HOLDINGS = 200;
  var NBSP = ' ';

  var state = {
    ready: false,
    data: null,
    byId: Object.create(null),
    holdings: [],
    targets: Object.create(null),
    settings: { mode: 'equal', capPct: '40', trade: 'sell', cash: '', band: '0', fee: '0,1' }
  };
  var combo = { items: [], active: -1, selected: null };

  /* ------------------------------------------------------------------ */
  /* Мелкие помощники                                                   */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  function parseNum(s) {
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    s = String(s === null || s === undefined ? '' : s).replace(/[\s  ]/g, '').replace(',', '.');
    if (s === '') return NaN;
    if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /** Пустое поле = значение по умолчанию; мусор = NaN. */
  function numOr(s, dflt) {
    if (String(s === null || s === undefined ? '' : s).trim() === '') return dflt;
    return parseNum(s);
  }

  /* Цвет монеты: у монет портфеля оттенки разнесены «золотым углом»,
   * чтобы соседние сегменты полосы не сливались; для остальных — по хешу id. */
  function hueOf(id) {
    for (var j = 0; j < state.holdings.length; j++) {
      if (state.holdings[j].id === id) return Math.round((j * 137.508 + 25) % 360);
    }
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  var formatters = {};
  function nf(key, opts) {
    if (!formatters[key]) formatters[key] = new Intl.NumberFormat('ru-RU', opts);
    return formatters[key];
  }

  function fmtMoney(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var s = Math.abs(v) >= 1000
      ? nf('m0', { maximumFractionDigits: 0 }).format(v)
      : nf('m2', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    return s + NBSP + '$';
  }

  function fmtPrice(p) {
    if (p === null || p === undefined || !isFinite(p)) return '—';
    var s = p >= 1
      ? nf('p2', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p)
      : nf('ps', { minimumSignificantDigits: 2, maximumSignificantDigits: 4 }).format(p);
    return s + NBSP + '$';
  }

  function fmtQty(q) {
    var abs = Math.abs(q);
    var key = abs >= 1000 ? 'q2' : abs >= 1 ? 'q6' : 'q8';
    var digits = abs >= 1000 ? 2 : abs >= 1 ? 6 : 8;
    return nf(key, { maximumFractionDigits: digits }).format(q);
  }

  function fmtCap(v) {
    if (!(v > 0)) return '—';
    var s;
    if (v >= 1e12) s = nf('c2', { maximumFractionDigits: 2 }).format(v / 1e12) + NBSP + 'трлн';
    else if (v >= 1e9) s = nf('c1', { maximumFractionDigits: 1 }).format(v / 1e9) + NBSP + 'млрд';
    else if (v >= 1e6) s = nf('c0', { maximumFractionDigits: 0 }).format(v / 1e6) + NBSP + 'млн';
    else s = nf('m0', { maximumFractionDigits: 0 }).format(v);
    return s + NBSP + '$';
  }

  function fmtShare(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return nf('s1', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x * 100) + '%';
  }

  function pctParts(v) {
    if (v === null || v === undefined || !isFinite(v)) return { text: '—', cls: 'na' };
    var abs = Math.abs(v);
    var digits = abs >= 100 ? 0 : 1;
    var rounded = Number(abs.toFixed(digits));
    var s = nf('pc' + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded);
    if (rounded === 0) return { text: s + '%', cls: 'zero' };
    return v > 0 ? { text: '+' + s + '%', cls: 'pos' } : { text: '−' + s + '%', cls: 'neg' };
  }

  function fmtPlainPct(v) {
    return nf('pp', { maximumFractionDigits: 2 }).format(v) + '%';
  }

  var dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /* ------------------------------------------------------------------ */
  /* Хранилище                                                          */
  /* ------------------------------------------------------------------ */

  function storageGet(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      $('storage-warning').hidden = false;
      return false;
    }
  }

  function cleanHoldings(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    var seen = new Set();
    for (var i = 0; i < list.length && out.length < MAX_HOLDINGS; i++) {
      var it = list[i];
      if (!it || typeof it !== 'object') continue;
      var id = typeof it.id === 'string' ? it.id.trim().slice(0, 100) : '';
      var amount = typeof it.amount === 'number' ? it.amount : parseNum(it.amount);
      if (!id || seen.has(id) || !isFinite(amount) || amount <= 0) continue;
      seen.add(id);
      out.push({ id: id, amount: amount, sym: str(it.sym, 20), name: str(it.name, 60) });
    }
    return out;
  }

  function saveHoldings() { storageSet(KEYS.portfolio, state.holdings); }
  function saveSettings() { storageSet(KEYS.settings, state.settings); }
  function saveTargets() { storageSet(KEYS.targets, state.targets); }

  function loadState() {
    state.holdings = cleanHoldings(storageGet(KEYS.portfolio));

    var s = storageGet(KEYS.settings);
    if (s && typeof s === 'object') {
      if (['equal', 'cap', 'custom'].indexOf(s.mode) >= 0) state.settings.mode = s.mode;
      if (['sell', 'buyonly'].indexOf(s.trade) >= 0) state.settings.trade = s.trade;
      ['capPct', 'cash', 'band', 'fee'].forEach(function (k) {
        if (typeof s[k] === 'string' && s[k].length <= 20) state.settings[k] = s[k];
      });
    }

    var t = storageGet(KEYS.targets);
    if (t && typeof t === 'object') {
      Object.keys(t).forEach(function (k) {
        if (typeof t[k] === 'number' && isFinite(t[k]) && t[k] >= 0 && t[k] <= 100) state.targets[k] = t[k];
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Данные о рынке                                                     */
  /* ------------------------------------------------------------------ */

  function applyData(data) {
    state.data = data;
    state.byId = Object.create(null);
    data.coins.forEach(function (c) {
      if (c && typeof c.id === 'string') state.byId[c.id] = c;
    });
    $('demo-banner').hidden = !data.demo;
    $('load-error').hidden = true;
  }

  function loadData() {
    return fetch('data/coins.json?v=' + Math.floor(Date.now() / 60000), { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.coins)) throw new Error('неверный формат файла');
        applyData(data);
      })
      .catch(function (err) {
        if (!state.data) {
          var box = $('load-error');
          box.textContent = 'Не удалось загрузить цены (' + err.message + '). Обновите страницу чуть позже. Ваш портфель сохранён.';
          box.hidden = false;
        }
      })
      .then(function () {
        state.ready = true;
      });
  }

  function isTyping() {
    var a = document.activeElement;
    return !!a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
  }

  function renderUpdated() {
    var node = $('updated');
    var t = state.data && state.data.updated ? Date.parse(state.data.updated) : NaN;
    if (isNaN(t)) { node.textContent = ''; return; }
    var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    var rel;
    if (mins < 1) rel = 'только что';
    else if (mins < 60) rel = mins + ' мин назад';
    else if (mins < 48 * 60) rel = Math.round(mins / 60) + ' ч назад';
    else rel = Math.round(mins / 1440) + ' дн. назад';
    var text = 'Цены обновлены ' + rel + ' (' + dateFmt.format(t) + ')';
    if (!state.data.demo && mins > 6 * 60) text += '. Данные давно не обновлялись';
    node.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* Расчёт портфеля                                                    */
  /* ------------------------------------------------------------------ */

  function compute() {
    var rows = state.holdings.map(function (h) {
      var coin = state.byId[h.id] || null;
      var price = coin && typeof coin.price === 'number' && coin.price > 0 ? coin.price : null;
      return {
        h: h,
        coin: coin,
        price: price,
        value: price ? h.amount * price : null,
        sym: coin ? coin.symbol : (h.sym || h.id),
        name: coin ? coin.name : (h.name || h.id)
      };
    });
    var total = rows.reduce(function (s, r) { return s + (r.value || 0); }, 0);
    rows.forEach(function (r) { r.share = r.value !== null && total > 0 ? r.value / total : null; });
    rows.sort(function (a, b) { return (b.value === null ? -1 : b.value) - (a.value === null ? -1 : a.value); });
    return { rows: rows, total: total };
  }

  /** Изменение стоимости портфеля за период при текущем составе. */
  function portfolioChange(rows, key) {
    var now = 0, then = 0, used = 0, missing = 0;
    rows.forEach(function (r) {
      if (r.value === null) return;
      var c = r.coin && r.coin.change ? r.coin.change[key] : null;
      if (typeof c !== 'number' || c <= -100) { missing++; return; }
      now += r.value;
      then += r.value / (1 + c / 100);
      used++;
    });
    if (!used || then <= 0) return { pct: null, partial: false };
    return { pct: (now / then - 1) * 100, partial: missing > 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Отрисовка: общее                                                   */
  /* ------------------------------------------------------------------ */

  function avatar(sym, id, image) {
    function fallback() {
      return el('span', {
        class: 'avatar',
        'aria-hidden': 'true',
        style: 'background:hsl(' + hueOf(id) + ' 50% var(--seg-l))',
        text: (sym || '?').charAt(0).toUpperCase()
      });
    }
    if (typeof image === 'string' && /^https:\/\//.test(image)) {
      var img = el('img', { class: 'avatar', src: image, alt: '', width: 24, height: 24, loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(fallback(), img);
      });
      return img;
    }
    return fallback();
  }

  function renderBar(host, items) {
    host.textContent = '';
    items.forEach(function (it) {
      if (!(it.share > 0)) return;
      var seg = el('span', {
        class: 'seg',
        style: 'flex-grow:' + (it.share * 1000).toFixed(3) + ';background:hsl(' + hueOf(it.id) + ' 50% var(--seg-l))',
        title: it.sym + ' ' + fmtShare(it.share)
      });
      if (it.share >= 0.07) seg.textContent = it.sym;
      host.appendChild(seg);
    });
  }

  function renderSummary(model) {
    var anyPriced = model.rows.some(function (r) { return r.value !== null; });
    $('total').textContent = anyPriced ? fmtMoney(model.total) : '—';
    renderBar($('alloc-bar'), model.rows.map(function (r) { return { id: r.h.id, sym: r.sym, share: r.share }; }));
  }

  function say(text, undo, isError) {
    var node = $('status');
    node.textContent = text;
    node.classList.toggle('is-error', !!isError);
    if (undo) node.appendChild(el('button', { class: 'btn btn-small', type: 'button', text: 'Вернуть', onclick: undo }));
  }

  /* ------------------------------------------------------------------ */
  /* Вкладка «Портфель»                                                 */
  /* ------------------------------------------------------------------ */

  function renderPortfolio(model) {
    var table = $('portfolio-table');
    Array.prototype.slice.call(table.querySelectorAll('thead,tbody,tfoot')).forEach(function (n) { n.remove(); });

    var oldNote = $('partial-note');
    if (oldNote) oldNote.remove();

    var has = state.holdings.length > 0;
    $('empty').hidden = has;
    $('portfolio-wrap').hidden = !has;
    if (!has) return;

    var head = el('tr', null, [
      el('th', { scope: 'col', text: 'Монета' }),
      el('th', { scope: 'col', text: 'Количество' }),
      el('th', { scope: 'col', text: 'Цена' }),
      el('th', { scope: 'col', text: 'Стоимость' }),
      el('th', { scope: 'col', text: 'Доля' }),
      el('th', { scope: 'col', text: 'Капитализация' })
    ]);
    PERIODS.forEach(function (p) { head.appendChild(el('th', { scope: 'col', text: p[1] })); });
    head.appendChild(el('th', { scope: 'col', class: 'col-gap' }, [el('span', { class: 'sr-only', text: 'Убрать' })]));
    table.appendChild(el('thead', null, [head]));

    var body = el('tbody');
    model.rows.forEach(function (r) {
      var change = r.coin && r.coin.change ? r.coin.change : {};
      var tr = el('tr');

      tr.appendChild(el('td', null, [
        el('div', { class: 'coin' }, [
          avatar(r.sym, r.h.id, r.coin ? r.coin.image : null),
          el('div', { class: 'coin-text' }, [
            el('span', { class: 'coin-sym', text: r.sym }),
            el('span', { class: 'coin-name', text: r.coin ? r.name : 'нет данных' })
          ])
        ])
      ]));

      var qty = el('input', {
        class: 'qty',
        type: 'text',
        inputmode: 'decimal',
        value: String(r.h.amount).replace('.', ','),
        'aria-label': 'Количество ' + r.sym
      });
      qty.addEventListener('change', function () { onQtyChange(r.h, qty); });
      tr.appendChild(el('td', null, [qty]));

      tr.appendChild(el('td', { text: fmtPrice(r.price), class: r.price === null ? 'na' : null }));
      tr.appendChild(el('td', { text: fmtMoney(r.value), class: r.value === null ? 'na' : null }));
      tr.appendChild(el('td', { text: fmtShare(r.share), class: r.share === null ? 'na' : null }));
      tr.appendChild(el('td', { text: fmtCap(r.coin ? r.coin.market_cap : null), class: r.coin && r.coin.market_cap > 0 ? null : 'na' }));

      PERIODS.forEach(function (p) {
        var parts = pctParts(change[p[0]]);
        tr.appendChild(el('td', { class: parts.cls, text: parts.text }));
      });

      tr.appendChild(el('td', { class: 'col-gap' }, [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Убрать ' + r.sym,
          title: 'Убрать из портфеля',
          text: '×',
          onclick: function () { removeHolding(r.h.id); }
        })
      ]));
      body.appendChild(tr);
    });
    table.appendChild(body);

    var foot = el('tr', null, [
      el('td', { text: 'Итого' }),
      el('td'),
      el('td'),
      el('td', { text: fmtMoney(model.total) }),
      el('td', { text: model.total > 0 ? '100%' : '—' }),
      el('td')
    ]);
    var anyPartial = false;
    PERIODS.forEach(function (p) {
      var ch = portfolioChange(model.rows, p[0]);
      var parts = pctParts(ch.pct);
      if (ch.partial) anyPartial = true;
      var cell = el('td', {
        class: parts.cls,
        text: parts.text + (ch.partial ? '*' : ''),
        title: ch.partial ? 'Без монет, по которым нет данных за этот период' : null
      });
      foot.appendChild(cell);
    });
    foot.appendChild(el('td', { class: 'col-gap' }));
    table.appendChild(el('tfoot', null, [foot]));

    if (anyPartial) {
      $('portfolio-wrap').insertAdjacentElement('afterend', el('p', {
        class: 'hint',
        id: 'partial-note',
        text: '* Итог за период посчитан без монет, по которым нет данных за этот период (например, монета появилась позже). Расчёт показывает, как изменилась бы стоимость нынешнего набора монет.'
      }));
    }
  }

  function onQtyChange(holding, input) {
    var v = parseNum(input.value);
    if (!(v > 0)) {
      input.value = String(holding.amount).replace('.', ',');
      say('Количество должно быть числом больше нуля. Чтобы убрать монету, нажмите ×.', null, true);
      return;
    }
    holding.amount = v;
    saveHoldings();
    say('');
    renderAll();
  }

  function removeHolding(id) {
    var idx = -1;
    state.holdings.forEach(function (h, i) { if (h.id === id) idx = i; });
    if (idx < 0) return;
    var removed = state.holdings.splice(idx, 1)[0];
    var label = (state.byId[removed.id] ? state.byId[removed.id].symbol : (removed.sym || removed.id));
    saveHoldings();
    renderAll();
    say(label + ' убран из портфеля.', function () {
      state.holdings.splice(Math.min(idx, state.holdings.length), 0, removed);
      saveHoldings();
      renderAll();
      say(label + ' возвращён.');
    });
  }

  /* ---- поиск монеты ---- */

  function searchCoins(q) {
    q = q.trim().toLowerCase();
    if (!q || !state.data) return [];
    var scored = [];
    state.data.coins.forEach(function (c, i) {
      var sym = String(c.symbol || '').toLowerCase();
      var name = String(c.name || '').toLowerCase();
      var id = String(c.id || '').toLowerCase();
      var score = -1;
      if (sym === q || id === q) score = 0;
      else if (sym.indexOf(q) === 0) score = 1;
      else if (name.indexOf(q) === 0) score = 2;
      else if (name.indexOf(q) >= 0 || id.indexOf(q) >= 0) score = 3;
      if (score >= 0) scored.push({ c: c, score: score, i: i });
    });
    scored.sort(function (a, b) { return a.score - b.score || a.i - b.i; });
    return scored.slice(0, 8).map(function (s) { return s.c; });
  }

  function exactMatch(text) {
    var t = text.trim().toLowerCase();
    if (!t || !state.data) return null;
    var found = null;
    state.data.coins.some(function (c) {
      if (String(c.symbol).toLowerCase() === t || String(c.name).toLowerCase() === t || String(c.id).toLowerCase() === t) {
        found = c;
        return true;
      }
      return false;
    });
    return found;
  }

  function setupCombo() {
    var input = $('coin-input');
    var list = $('coin-list');

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      combo.active = -1;
    }

    function paint() {
      list.textContent = '';
      if (!combo.items.length) {
        if (input.value.trim() && !combo.selected) {
          list.appendChild(el('li', {
            class: 'combo-empty',
            role: 'presentation',
            text: state.data ? 'Ничего не найдено среди ' + state.data.coins.length + ' монет' : 'Цены ещё загружаются'
          }));
          list.hidden = false;
          input.setAttribute('aria-expanded', 'true');
        } else {
          close();
        }
        return;
      }
      var inPortfolio = new Set(state.holdings.map(function (h) { return h.id; }));
      combo.items.forEach(function (c, i) {
        var li = el('li', { role: 'option', id: 'opt-' + i, 'aria-selected': i === combo.active ? 'true' : 'false' }, [
          avatar(c.symbol, c.id, c.image),
          el('span', { class: 'opt-sym', text: c.symbol }),
          el('span', { class: 'opt-name', text: c.name }),
          inPortfolio.has(c.id) ? el('span', { class: 'opt-note', text: 'уже в портфеле' }) : null
        ]);
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(c); });
        list.appendChild(li);
        if (i === combo.active) {
          input.setAttribute('aria-activedescendant', 'opt-' + i);
          if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
        }
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function choose(c) {
      combo.selected = c;
      input.value = c.symbol + ' — ' + c.name;
      close();
      $('amount-input').focus();
    }

    input.addEventListener('input', function () {
      combo.selected = null;
      combo.items = searchCoins(input.value);
      combo.active = combo.items.length ? 0 : -1;
      paint();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!combo.items.length) return;
        e.preventDefault();
        var step = e.key === 'ArrowDown' ? 1 : -1;
        combo.active = (combo.active + step + combo.items.length) % combo.items.length;
        paint();
      } else if (e.key === 'Enter') {
        if (!list.hidden && combo.active >= 0 && combo.items[combo.active]) {
          e.preventDefault();
          choose(combo.items[combo.active]);
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('focus', function () {
      if (input.value.trim() && !combo.selected) {
        combo.items = searchCoins(input.value);
        combo.active = combo.items.length ? 0 : -1;
        paint();
      }
    });
  }

  function onAdd(e) {
    e.preventDefault();
    var coin = combo.selected || exactMatch($('coin-input').value);
    if (!coin) {
      say(state.data ? 'Выберите монету из списка подсказок.' : 'Цены ещё загружаются, попробуйте через пару секунд.', null, true);
      return;
    }
    var amount = parseNum($('amount-input').value);
    if (!(amount > 0)) {
      say('Укажите, сколько у вас монет: число больше нуля, например 0,5.', null, true);
      $('amount-input').focus();
      return;
    }
    var existing = null;
    state.holdings.forEach(function (h) { if (h.id === coin.id) existing = h; });
    if (existing) {
      existing.amount = amount;
      say(coin.symbol + ' уже был в портфеле, количество обновлено.');
    } else {
      if (state.holdings.length >= MAX_HOLDINGS) {
        say('В портфеле не может быть больше ' + MAX_HOLDINGS + ' монет.', null, true);
        return;
      }
      state.holdings.push({ id: coin.id, amount: amount, sym: str(coin.symbol, 20), name: str(coin.name, 60) });
      say(coin.symbol + ' добавлен в портфель.');
    }
    saveHoldings();
    $('coin-input').value = '';
    $('amount-input').value = '';
    combo.selected = null;
    combo.items = [];
    renderAll();
    $('coin-input').focus();
  }

  /* ---- копия портфеля ---- */

  function exportPortfolio() {
    if (!state.holdings.length) {
      say('Портфель пуст, копировать нечего.', null, true);
      return;
    }
    var payload = { app: 'crypto-portfolio', version: 1, exported: new Date().toISOString(), holdings: state.holdings };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'portfolio-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    say('Копия скачана.');
  }

  function importPortfolio(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      say('Файл слишком большой для портфеля.', null, true);
      return;
    }
    file.text().then(function (text) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) {
        say('Не удалось прочитать файл: это не копия портфеля.', null, true);
        return;
      }
      var cleaned = cleanHoldings(Array.isArray(parsed) ? parsed : (parsed && parsed.holdings));
      if (!cleaned.length) {
        say('В файле нет монет с количеством.', null, true);
        return;
      }
      if (state.holdings.length &&
          !window.confirm('Заменить текущий портфель (' + state.holdings.length + ' монет) монетами из файла (' + cleaned.length + ')?')) {
        return;
      }
      state.holdings = cleaned;
      saveHoldings();
      renderAll();
      say('Загружено монет: ' + cleaned.length + '.');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Вкладка «Ребалансировка»                                           */
  /* ------------------------------------------------------------------ */

  function distributeTenths(weights) {
    var tenths = weights.map(function (w) { return w * 1000; });
    var floors = tenths.map(Math.floor);
    var rest = 1000 - floors.reduce(function (a, b) { return a + b; }, 0);
    var order = tenths.map(function (t, i) { return { i: i, f: t - Math.floor(t) }; })
      .sort(function (a, b) { return b.f - a.f; });
    for (var k = 0; k < rest && k < order.length; k++) floors[order[k].i]++;
    return floors.map(function (x) { return x / 10; });
  }

  function notice(text, kind) {
    return el('div', { class: 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-warn'), text: text });
  }

  function readSettingsFromDom() {
    var s = state.settings;
    s.mode = $('mode').value;
    s.capPct = $('cap-pct').value;
    s.trade = $('trade').value;
    s.cash = $('cash').value;
    s.band = $('band').value;
    s.fee = $('fee').value;
  }

  function writeSettingsToDom() {
    var s = state.settings;
    $('mode').value = s.mode;
    $('cap-pct').value = s.capPct;
    $('trade').value = s.trade;
    $('cash').value = s.cash;
    $('band').value = s.band;
    $('fee').value = s.fee;
  }

  function setTargets(entries, percents) {
    entries.forEach(function (r, i) { state.targets[r.h.id] = percents[i]; });
    saveTargets();
    renderRebalance();
  }

  function updateSumLine() {
    var sumNode = $('sum-value');
    if (!sumNode) return;
    var sum = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.pct-input'), function (inp) {
      var v = parseNum(inp.value);
      if (isFinite(v)) sum += v;
    });
    var ok = Math.abs(sum - 100) < 0.01;
    sumNode.textContent = fmtPlainPct(Math.round(sum * 100) / 100);
    sumNode.className = ok ? 'sum-ok' : 'sum-bad';
  }

  function renderRebalance() {
    var host = $('rebalance-result');
    host.textContent = '';
    var s = state.settings;
    $('cap-field').hidden = s.mode !== 'cap';

    if (!state.holdings.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('p', { text: 'В портфеле пока нет монет.' }),
        el('p', { text: 'Добавьте их во вкладке «Портфель», и здесь появятся варианты ребалансировки.' })
      ]));
      return;
    }

    var model = compute();
    var priced = model.rows.filter(function (r) { return r.value !== null; });
    var excluded = model.rows.filter(function (r) { return r.value === null; });
    var entries = priced;
    if (s.mode === 'cap') {
      entries = priced.filter(function (r) { return r.coin.market_cap > 0; });
      excluded = excluded.concat(priced.filter(function (r) { return !(r.coin.market_cap > 0); }));
    }

    if (excluded.length) {
      host.appendChild(notice('Не учтены монеты без нужных данных: ' + excluded.map(function (r) { return r.sym; }).join(', ') + '.'));
    }
    if (!entries.length) {
      host.appendChild(notice('Нет монет, для которых можно посчитать ребалансировку.', 'error'));
      return;
    }

    // Доли считаем только среди монет, которые участвуют в расчёте
    var entTotal = entries.reduce(function (sum, r) { return sum + r.value; }, 0);
    entries = entries.map(function (r) {
      return Object.assign({}, r, { share: r.value / entTotal });
    });

    var cash = numOr(s.cash, 0);
    var band = numOr(s.band, 0);
    var fee = numOr(s.fee, 0);
    var inputError = null;
    if (isNaN(cash) || cash < 0) inputError = 'Поле «Добавить новых денег»: нужно число, например 500.';
    else if (isNaN(band) || band < 0) inputError = 'Поле «Порог отклонения»: нужно число, например 3.';
    else if (isNaN(fee) || fee < 0) inputError = 'Поле «Комиссия биржи»: нужно число, например 0,1.';

    var weights = null;
    var weightError = null;
    var weightNote = null;
    var customSum = null;

    if (s.mode === 'equal') {
      weights = R.equalWeights(entries.length);
    } else if (s.mode === 'cap') {
      var capPct = numOr(s.capPct, 40);
      if (!(capPct > 0 && capPct <= 100)) {
        weightError = 'Поле «Максимум на одну монету»: число от 1 до 100.';
      } else {
        weights = R.marketCapWeights(entries.map(function (r) { return r.coin.market_cap; }), capPct / 100);
        if ((capPct / 100) * entries.length < 1 - 1e-12) {
          weightNote = 'При ' + entries.length + ' монетах лимит ' + fmtPlainPct(capPct) + ' невыполним, поэтому доли выровнены поровну.';
        }
      }
    } else {
      var untouched = entries.every(function (r) { return state.targets[r.h.id] === undefined; });
      if (untouched) {
        var start = distributeTenths(entries.map(function (r) { return r.share; }));
        entries.forEach(function (r, i) { state.targets[r.h.id] = start[i]; });
        saveTargets();
      }
      var pcts = entries.map(function (r) { return state.targets[r.h.id] || 0; });
      var cw = R.customWeights(pcts);
      customSum = cw.sum;
      if (cw.ok) weights = cw.weights;
      else weightError = 'Сумма целевых долей сейчас ' + fmtPlainPct(Math.round(cw.sum * 100) / 100) + ', а нужно 100%.';
    }

    var plan = null;
    if (!inputError && weights) {
      plan = R.plan({
        holdings: entries.map(function (r) { return { id: r.h.id, amount: r.h.amount, price: r.price }; }),
        weights: weights,
        cash: cash,
        mode: s.trade,
        band: band,
        feePct: fee
      });
    }

    if (inputError) host.appendChild(notice(inputError, 'error'));
    else if (weightError) host.appendChild(notice(weightError, 'error'));
    else if (plan && !plan.ok) host.appendChild(notice(plan.reason, 'error'));
    if (weightNote) host.appendChild(notice(weightNote));

    /* Сводка */
    if (plan && plan.ok) {
      var summary = el('p', { class: 'result-summary' });
      var sub = [];
      if (plan.balanced) {
        summary.textContent = 'Ребалансировка не нужна: самая большая монета отклонилась от цели на ' +
          nf('dev', { maximumFractionDigits: 1 }).format(plan.maxDeviation) + ' п.' + NBSP + 'п., это меньше порога.';
      } else if (plan.buyTotal < 0.005 && plan.sellTotal < 0.005) {
        summary.textContent = 'Доли уже совпадают с целью, ничего делать не нужно.';
      } else {
        var parts = [];
        if (plan.sellTotal >= 0.005) parts.push('продать на ' + fmtMoney(plan.sellTotal));
        if (plan.buyTotal >= 0.005) parts.push((plan.mode === 'buyonly' ? 'докупить на ' : 'купить на ') + fmtMoney(plan.buyTotal));
        var line = parts.join(', ');
        summary.textContent = line.charAt(0).toUpperCase() + line.slice(1) + '.';
        if (plan.mode === 'buyonly') sub.push('Ничего не продаём: распределяем только новые деньги.');
        else if (plan.cash > 0) sub.push('В том числе используем ' + fmtMoney(plan.cash) + ' новых денег.');
        if (fee > 0) sub.push('Комиссия ' + fmtPlainPct(fee) + ' от оборота: примерно ' + fmtMoney(plan.fees) + '.');
      }
      sub.forEach(function (t) { summary.appendChild(el('span', { class: 'sub', text: t })); });
      host.appendChild(summary);
    }

    /* Полосы «сейчас» и «после» */
    var nowBar = el('div', { class: 'bar', role: 'img', 'aria-label': 'Доли сейчас' });
    renderBar(nowBar, entries.map(function (r) { return { id: r.h.id, sym: r.sym, share: r.share }; }));
    var afterItems = null;
    var afterName = 'После';
    if (plan && plan.ok) {
      afterItems = plan.rows.map(function (pr, i) { return { id: entries[i].h.id, sym: entries[i].sym, share: pr.shareAfter }; });
    } else if (weights) {
      afterItems = entries.map(function (r, i) { return { id: r.h.id, sym: r.sym, share: weights[i] }; });
      afterName = 'Цель';
    }
    var bars = el('div', { class: 'bars' }, [
      el('div', { class: 'bar-row' }, [el('span', { class: 'bar-name', text: 'Сейчас' }), nowBar])
    ]);
    if (afterItems) {
      var afterBar = el('div', { class: 'bar', role: 'img', 'aria-label': 'Доли: ' + afterName.toLowerCase() });
      renderBar(afterBar, afterItems);
      bars.appendChild(el('div', { class: 'bar-row' }, [el('span', { class: 'bar-name', text: afterName }), afterBar]));
    }
    host.appendChild(bars);

    /* Помощники для своих процентов */
    if (s.mode === 'custom') {
      var sumValue = el('strong', { id: 'sum-value' });
      host.appendChild(el('div', { class: 'sum-line' }, [
        el('span', { text: 'Сумма целевых долей:' }),
        sumValue,
        el('button', {
          class: 'btn btn-small', type: 'button', text: 'Поровну',
          onclick: function () { setTargets(entries, distributeTenths(R.equalWeights(entries.length))); }
        }),
        el('button', {
          class: 'btn btn-small', type: 'button', text: 'Как сейчас',
          onclick: function () { setTargets(entries, distributeTenths(entries.map(function (r) { return r.share; }))); }
        })
      ]));
    }

    /* Таблица */
    var table = el('table', { class: 'grid' }, [
      el('caption', { class: 'sr-only', text: 'Что нужно сделать с каждой монетой, чтобы доли совпали с целью' }),
      el('thead', null, [el('tr', null, [
        el('th', { scope: 'col', text: 'Монета' }),
        el('th', { scope: 'col', text: 'Сейчас' }),
        el('th', { scope: 'col', text: 'Цель' }),
        el('th', { scope: 'col', text: 'Сейчас, $' }),
        el('th', { scope: 'col', text: 'После, $' }),
        el('th', { scope: 'col', text: 'Что сделать' })
      ])])
    ]);
    var tbody = el('tbody');
    entries.forEach(function (r, i) {
      var tr = el('tr');
      tr.appendChild(el('td', null, [
        el('div', { class: 'coin' }, [
          avatar(r.sym, r.h.id, r.coin ? r.coin.image : null),
          el('div', { class: 'coin-text' }, [
            el('span', { class: 'coin-sym', text: r.sym }),
            el('span', { class: 'coin-name', text: r.name })
          ])
        ])
      ]));
      tr.appendChild(el('td', { text: fmtShare(r.share) }));

      if (s.mode === 'custom') {
        var inp = el('input', {
          class: 'pct-input', type: 'text', inputmode: 'decimal',
          value: String(state.targets[r.h.id] === undefined ? 0 : state.targets[r.h.id]).replace('.', ','),
          'aria-label': 'Целевая доля ' + r.sym + ', %'
        });
        inp.addEventListener('input', updateSumLine);
        inp.addEventListener('change', function () {
          var v = parseNum(inp.value);
          if (!(v >= 0 && v <= 100)) {
            inp.value = String(state.targets[r.h.id] || 0).replace('.', ',');
            updateSumLine();
            return;
          }
          state.targets[r.h.id] = Math.round(v * 100) / 100;
          saveTargets();
          renderRebalance();
        });
        tr.appendChild(el('td', null, [inp, ' %']));
      } else {
        tr.appendChild(el('td', { text: weights ? fmtShare(weights[i]) : '—', class: weights ? null : 'na' }));
      }

      tr.appendChild(el('td', { text: fmtMoney(r.value) }));

      if (plan && plan.ok) {
        var pr = plan.rows[i];
        tr.appendChild(el('td', { text: fmtMoney(pr.valueAfter) }));
        var action;
        if (pr.action === 'buy') {
          action = el('td', { class: 'act-buy' }, ['Купить ' + fmtQty(pr.deltaQty) + ' ' + r.sym, el('span', { class: 'act-sub', text: '≈ ' + fmtMoney(pr.deltaUsd) })]);
        } else if (pr.action === 'sell') {
          action = el('td', { class: 'act-sell' }, ['Продать ' + fmtQty(-pr.deltaQty) + ' ' + r.sym, el('span', { class: 'act-sub', text: '≈ ' + fmtMoney(-pr.deltaUsd) })]);
        } else {
          action = el('td', { class: 'muted', text: 'Не менять' });
        }
        tr.appendChild(action);
      } else {
        tr.appendChild(el('td', { text: '—', class: 'na' }));
        tr.appendChild(el('td', { text: '—', class: 'na' }));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var totalTarget = plan && plan.ok ? plan.totalTarget : null;
    table.appendChild(el('tfoot', null, [el('tr', null, [
      el('td', { text: 'Итого' }),
      el('td', { text: '100%' }),
      el('td', { text: weights ? '100%' : '—' }),
      el('td', { text: fmtMoney(entTotal) }),
      el('td', { text: totalTarget === null ? '—' : fmtMoney(totalTarget) }),
      el('td')
    ])]));

    host.appendChild(el('div', { class: 'table-wrap' }, [table]));
    host.appendChild(el('p', { class: 'hint', text: 'Расчёт приблизительный: он не учитывает спред, минимальные размеры ордеров и налоги. Продажа монет может быть налогооблагаемым событием.' }));
    updateSumLine();
  }

  /* ------------------------------------------------------------------ */
  /* Общее                                                              */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    if (!state.ready) return;
    var model = compute();
    renderUpdated();
    renderSummary(model);
    renderPortfolio(model);
    renderRebalance();
  }

  function selectTab(name) {
    ['portfolio', 'rebalance'].forEach(function (t) {
      var on = t === name;
      $('tab-' + t).hidden = !on;
      $('tab-btn-' + t).setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function init() {
    loadState();
    writeSettingsToDom();

    $('tab-btn-portfolio').addEventListener('click', function () { selectTab('portfolio'); });
    $('tab-btn-rebalance').addEventListener('click', function () { selectTab('rebalance'); });
    $('add-form').addEventListener('submit', onAdd);
    $('export-btn').addEventListener('click', exportPortfolio);
    $('import-btn').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function (e) {
      importPortfolio(e.target.files && e.target.files[0]);
      e.target.value = '';
    });

    ['mode', 'cap-pct', 'trade', 'cash', 'band', 'fee'].forEach(function (id) {
      var node = $(id);
      var handler = function () {
        readSettingsFromDom();
        saveSettings();
        if (state.ready) renderRebalance();
      };
      node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', handler);
    });

    setupCombo();

    loadData().then(renderAll);
    setInterval(function () {
      if (isTyping()) return;
      loadData().then(renderAll);
    }, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

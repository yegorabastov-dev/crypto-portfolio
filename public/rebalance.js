/*
 * Расчёт ребалансировки. Работает и в браузере (window.Rebalance), и в Node (require).
 * Никаких запросов в сеть: на вход подаются количества и цены, на выходе — список действий.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rebalance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS_USD = 0.005; // меньше полцента считаем «ничего делать не нужно»

  /** Равные доли для n монет. */
  function equalWeights(n) {
    var w = [];
    for (var i = 0; i < n; i++) w.push(1 / n);
    return w;
  }

  /**
   * Ограничивает максимальную долю одной монеты (cap — от 0 до 1).
   * Излишек делится между остальными пропорционально их долям.
   * Если cap * n < 1, ограничение невыполнимо — возвращаем равные доли.
   */
  function capWeights(weights, cap) {
    var n = weights.length;
    if (!n) return [];
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    var w = weights.map(function (x) { return x / sum; });
    if (!(cap > 0) || cap >= 1) return w;
    if (cap * n < 1 - 1e-12) return equalWeights(n);

    var capped = new Array(n).fill(false);
    for (var iter = 0; iter < n + 1; iter++) {
      var excess = 0;
      var freeSum = 0;
      for (var i = 0; i < n; i++) {
        if (capped[i]) continue;
        if (w[i] > cap + 1e-12) {
          excess += w[i] - cap;
          w[i] = cap;
          capped[i] = true;
        }
      }
      if (excess <= 1e-12) break;
      for (var j = 0; j < n; j++) if (!capped[j]) freeSum += w[j];
      if (freeSum <= 0) break;
      for (var k = 0; k < n; k++) if (!capped[k]) w[k] += excess * (w[k] / freeSum);
    }
    return w;
  }

  /** Доли пропорционально капитализации, с ограничением на одну монету. */
  function marketCapWeights(caps, cap) {
    return capWeights(caps, cap);
  }

  /** Свои проценты (в процентах, 0..100) -> доли; ok=false, если сумма не 100. */
  function customWeights(percents) {
    var sum = percents.reduce(function (a, b) { return a + b; }, 0);
    return {
      ok: Math.abs(sum - 100) < 0.01,
      sum: sum,
      weights: percents.map(function (p) { return p / 100; })
    };
  }

  /**
   * Строит план ребалансировки.
   *
   * opts.holdings : [{ id, amount, price }]  (price > 0, amount >= 0)
   * opts.weights  : [доля, ...] в том же порядке, сумма = 1
   * opts.cash     : сколько новых денег добавить (по умолчанию 0)
   * opts.mode     : 'sell'    — можно и продавать, и покупать
   *                 'buyonly' — только докупать на сумму cash
   * opts.band     : порог в процентных пунктах; если cash = 0 и ни одна монета
   *                 не отклонилась сильнее, ребалансировка не нужна (по умолчанию 0)
   * opts.feePct   : комиссия в процентах от оборота (по умолчанию 0)
   */
  function plan(opts) {
    var holdings = opts.holdings || [];
    var weights = opts.weights || [];
    var cash = opts.cash > 0 ? opts.cash : 0;
    var mode = opts.mode === 'buyonly' ? 'buyonly' : 'sell';
    var band = opts.band > 0 ? opts.band : 0;
    var feePct = opts.feePct > 0 ? opts.feePct : 0;
    var n = holdings.length;

    if (!n) return { ok: false, reason: 'В портфеле нет монет с известной ценой.' };
    if (weights.length !== n) return { ok: false, reason: 'Число долей не совпадает с числом монет.' };

    var wSum = weights.reduce(function (a, b) { return a + b; }, 0);
    if (Math.abs(wSum - 1) > 1e-6) return { ok: false, reason: 'Сумма целевых долей должна быть 100%.' };
    for (var i = 0; i < n; i++) {
      if (!(holdings[i].price > 0)) return { ok: false, reason: 'У монеты ' + holdings[i].id + ' нет цены.' };
      if (!(weights[i] >= 0)) return { ok: false, reason: 'Доля не может быть отрицательной.' };
    }

    var values = holdings.map(function (h) { return h.amount * h.price; });
    var totalNow = values.reduce(function (a, b) { return a + b; }, 0);
    var totalTarget = totalNow + cash;
    if (!(totalTarget > 0)) return { ok: false, reason: 'Стоимость портфеля равна нулю.' };

    if (mode === 'buyonly' && !(cash > 0)) {
      return { ok: false, reason: 'Для режима «только докупать» укажите, сколько денег добавить.' };
    }

    var shares = values.map(function (v) { return totalNow > 0 ? v / totalNow : 0; });
    var maxDev = 0;
    for (var d = 0; d < n; d++) maxDev = Math.max(maxDev, Math.abs(shares[d] - weights[d]) * 100);

    var rows = [];
    var balanced = cash === 0 && maxDev < band;

    var deltas = new Array(n).fill(0);
    if (!balanced) {
      var targets = weights.map(function (w) { return w * totalTarget; });
      if (mode === 'sell') {
        for (var a = 0; a < n; a++) deltas[a] = targets[a] - values[a];
      } else {
        var deficits = targets.map(function (t, idx) { return Math.max(0, t - values[idx]); });
        var defSum = deficits.reduce(function (x, y) { return x + y; }, 0);
        if (defSum > 0) for (var b = 0; b < n; b++) deltas[b] = cash * deficits[b] / defSum;
      }
    }

    var buyTotal = 0;
    var sellTotal = 0;
    for (var r = 0; r < n; r++) {
      var delta = deltas[r];
      var action = 'hold';
      if (delta > EPS_USD) action = 'buy';
      else if (delta < -EPS_USD) action = 'sell';
      else delta = 0;
      if (action === 'buy') buyTotal += delta;
      if (action === 'sell') sellTotal += -delta;
      rows.push({
        id: holdings[r].id,
        price: holdings[r].price,
        amount: holdings[r].amount,
        valueNow: values[r],
        shareNow: shares[r],
        weight: weights[r],
        valueAfter: values[r] + delta,
        shareAfter: (values[r] + delta) / totalTarget,
        deltaUsd: delta,
        deltaQty: delta / holdings[r].price,
        action: action
      });
    }

    return {
      ok: true,
      balanced: balanced,
      mode: mode,
      totalNow: totalNow,
      totalTarget: totalTarget,
      cash: cash,
      maxDeviation: maxDev,
      buyTotal: buyTotal,
      sellTotal: sellTotal,
      fees: (buyTotal + sellTotal) * feePct / 100,
      rows: rows
    };
  }

  return {
    equalWeights: equalWeights,
    capWeights: capWeights,
    marketCapWeights: marketCapWeights,
    customWeights: customWeights,
    plan: plan
  };
});

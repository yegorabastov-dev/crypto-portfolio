const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/rebalance.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

test('equalWeights: сумма равна 1', () => {
  const w = R.equalWeights(4);
  assert.equal(w.length, 4);
  near(sum(w), 1);
  near(w[0], 0.25);
});

test('пример из чата: 70/20/10 -> 50/30/20 на портфеле 10 000 $', () => {
  const p = R.plan({
    holdings: [
      { id: 'btc', amount: 0.07, price: 100000 }, // 7 000 $
      { id: 'eth', amount: 1, price: 2000 },      // 2 000 $
      { id: 'sol', amount: 10, price: 100 }       // 1 000 $
    ],
    weights: [0.5, 0.3, 0.2]
  });
  assert.ok(p.ok);
  near(p.totalNow, 10000);
  near(p.rows[0].deltaUsd, -2000);
  near(p.rows[1].deltaUsd, 1000);
  near(p.rows[2].deltaUsd, 1000);
  near(p.rows[0].deltaQty, -0.02);
  near(p.rows[1].deltaQty, 0.5);
  near(p.rows[2].deltaQty, 10);
  assert.deepEqual(p.rows.map(r => r.action), ['sell', 'buy', 'buy']);
  near(p.sellTotal, 2000);
  near(p.buyTotal, 2000);
  near(sum(p.rows.map(r => r.deltaUsd)), 0);
  near(sum(p.rows.map(r => r.shareAfter)), 1);
});

test('комиссия считается от всего оборота', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 70, price: 100 }, { id: 'b', amount: 30, price: 100 }],
    weights: [0.5, 0.5],
    feePct: 0.1
  });
  near(p.buyTotal, 2000);
  near(p.sellTotal, 2000);
  near(p.fees, 4);
});

test('добавление денег в режиме «с продажами»', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 1, price: 600 }, { id: 'b', amount: 1, price: 400 }],
    weights: [0.5, 0.5],
    cash: 1000
  });
  // итого 2000 $ -> по 1000 $ на монету
  near(p.rows[0].deltaUsd, 400);
  near(p.rows[1].deltaUsd, 600);
  near(p.buyTotal, 1000);
  near(p.sellTotal, 0);
});

test('«только докупать»: ничего не продаёт, тратит ровно cash', () => {
  const p = R.plan({
    holdings: [
      { id: 'a', amount: 1, price: 700 },
      { id: 'b', amount: 1, price: 200 },
      { id: 'c', amount: 1, price: 100 }
    ],
    weights: [0.5, 0.3, 0.2],
    cash: 500,
    mode: 'buyonly'
  });
  assert.ok(p.ok);
  assert.ok(p.rows.every(r => r.deltaUsd >= 0), 'нет продаж');
  near(p.sellTotal, 0);
  near(p.buyTotal, 500);
  // итого после докупки 1500 $: цели 750/450/300, дефициты a=50, b=250, c=200, деньги делятся пропорционально
  near(p.rows[0].deltaUsd, 500 * 50 / 500);
  near(p.rows[1].deltaUsd, 500 * 250 / 500);
  near(p.rows[2].deltaUsd, 500 * 200 / 500);
});

test('«только докупать»: монета выше цели не получает денег', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 1, price: 900 }, { id: 'b', amount: 1, price: 100 }],
    weights: [0.5, 0.5],
    cash: 100,
    mode: 'buyonly'
  });
  near(p.rows[0].deltaUsd, 0);
  near(p.rows[1].deltaUsd, 100);
  assert.equal(p.rows[0].action, 'hold');
});

test('«только докупать» без денег — понятная ошибка', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 1, price: 1 }],
    weights: [1],
    mode: 'buyonly'
  });
  assert.equal(p.ok, false);
  assert.match(p.reason, /добавить/);
});

test('порог: отклонения меньше порога — ребалансировка не нужна', () => {
  const holdings = [{ id: 'a', amount: 1, price: 52 }, { id: 'b', amount: 1, price: 48 }];
  const small = R.plan({ holdings, weights: [0.5, 0.5], band: 5 });
  assert.ok(small.ok && small.balanced);
  assert.ok(small.rows.every(r => r.action === 'hold'));
  near(small.maxDeviation, 2);

  const big = R.plan({ holdings, weights: [0.5, 0.5], band: 1 });
  assert.equal(big.balanced, false);
  assert.equal(big.rows[0].action, 'sell');
});

test('порог не мешает, когда добавляются деньги', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 1, price: 50 }, { id: 'b', amount: 1, price: 50 }],
    weights: [0.5, 0.5],
    cash: 100,
    band: 10
  });
  assert.equal(p.balanced, false);
  near(p.buyTotal, 100);
});

test('capWeights: ограничение 40% и перераспределение излишка', () => {
  const w = R.capWeights([80, 10, 6, 4], 0.4);
  near(sum(w), 1);
  near(w[0], 0.4);
  assert.ok(w.every(x => x <= 0.4 + 1e-9));
  // остальные сохраняют пропорции 10:6:4
  near(w[1] / w[2], 10 / 6);
  near(w[2] / w[3], 6 / 4);
});

test('capWeights: каскадное ограничение', () => {
  const w = R.capWeights([50, 40, 5, 5], 0.35);
  near(sum(w), 1);
  assert.ok(w.every(x => x <= 0.35 + 1e-9));
});

test('capWeights: невыполнимый лимит -> равные доли', () => {
  const w = R.capWeights([90, 10], 0.4); // 2 * 0.4 < 1
  near(w[0], 0.5);
  near(w[1], 0.5);
});

test('marketCapWeights без лимита — просто пропорции', () => {
  const w = R.marketCapWeights([3, 1], 1);
  near(w[0], 0.75);
  near(w[1], 0.25);
});

test('customWeights: проверка суммы 100%', () => {
  assert.ok(R.customWeights([50, 30, 20]).ok);
  assert.equal(R.customWeights([50, 30, 10]).ok, false);
  near(R.customWeights([50, 30, 20]).weights[1], 0.3);
});

test('ошибки: пустой портфель, нет цены, неверная сумма долей', () => {
  assert.equal(R.plan({ holdings: [], weights: [] }).ok, false);
  assert.equal(R.plan({ holdings: [{ id: 'a', amount: 1, price: 0 }], weights: [1] }).ok, false);
  assert.equal(R.plan({ holdings: [{ id: 'a', amount: 1, price: 1 }, { id: 'b', amount: 1, price: 1 }], weights: [0.5, 0.4] }).ok, false);
});

test('одна монета: делать нечего', () => {
  const p = R.plan({ holdings: [{ id: 'a', amount: 2, price: 10 }], weights: [1] });
  assert.ok(p.ok);
  assert.equal(p.rows[0].action, 'hold');
});

test('очень мелкие позиции не ломают расчёт', () => {
  const p = R.plan({
    holdings: [{ id: 'a', amount: 1e-8, price: 0.0001 }, { id: 'b', amount: 1e-8, price: 0.0001 }],
    weights: [0.5, 0.5]
  });
  assert.ok(p.ok);
  assert.ok(p.rows.every(r => r.action === 'hold'));
});

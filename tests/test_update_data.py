import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "update_data.py"
spec = importlib.util.spec_from_file_location("update_data", SCRIPT)
ud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ud)

DAY = ud.DAY_MS
TODAY = 1_800_000_000_000 - (1_800_000_000_000 % DAY)  # любая полночь UTC


def make_candles(first_days_ago: int, price_fn, skip_days=()):
    """Дневные свечи от first_days_ago дней назад до сегодня включительно."""
    out = []
    for d in range(first_days_ago, -1, -1):
        if d in skip_days:
            continue
        t = TODAY - d * DAY
        p = price_fn(d)
        out.append([t, str(p), str(p), str(p), str(p), "1"])
    return out


class PctChange(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(ud.pct_change(150, 100), 50.0)
        self.assertEqual(ud.pct_change(50, 100), -50.0)

    def test_none_and_zero(self):
        self.assertIsNone(ud.pct_change(None, 100))
        self.assertIsNone(ud.pct_change(100, None))
        self.assertIsNone(ud.pct_change(100, 0))
        self.assertIsNone(ud.pct_change(100, -5))
        self.assertIsNone(ud.pct_change(float("nan"), 1))

    def test_rounding(self):
        self.assertEqual(ud.pct_change(100.12345, 100), 0.12)


class PickHistory(unittest.TestCase):
    def test_all_periods_found_for_old_coin(self):
        # цена в день d назад = 1000 - d, чтобы легко проверять
        candles = make_candles(1900, lambda d: 1000 - d / 10)
        prices = ud.pick_history_prices(candles, TODAY)
        for key, days in ud.PERIODS:
            self.assertAlmostEqual(prices[key], 1000 - days / 10, places=6, msg=key)

    def test_young_coin_has_none_for_long_periods(self):
        candles = make_candles(100, lambda d: 5.0)  # торгуется 100 дней
        prices = ud.pick_history_prices(candles, TODAY)
        self.assertEqual(prices["1w"], 5.0)
        self.assertEqual(prices["3m"], 5.0)   # 90 дней
        self.assertIsNone(prices["6m"])       # 180 дней
        self.assertIsNone(prices["5y"])

    def test_gap_is_filled_by_neighbour(self):
        candles = make_candles(400, lambda d: 10 + d, skip_days={30})
        prices = ud.pick_history_prices(candles, TODAY)
        # день 30 пропущен -> берём соседний (31 или 29)
        self.assertIn(prices["1m"], (10 + 29, 10 + 31))

    def test_big_gap_gives_none(self):
        candles = make_candles(400, lambda d: 10 + d, skip_days={28, 29, 30, 31, 32})
        prices = ud.pick_history_prices(candles, TODAY)
        self.assertIsNone(prices["1m"])

    def test_empty_and_garbage(self):
        self.assertTrue(all(v is None for v in ud.pick_history_prices([], TODAY).values()))
        self.assertTrue(all(v is None for v in ud.pick_history_prices([["x", "y"]], TODAY).values()))

    def test_listing_boundary(self):
        # первая свеча ровно 90 дней назад -> 3m есть, 6m нет
        candles = make_candles(90, lambda d: 2.0)
        prices = ud.pick_history_prices(candles, TODAY)
        self.assertEqual(prices["3m"], 2.0)
        self.assertIsNone(prices["6m"])


class Mapping(unittest.TestCase):
    def test_highest_cap_wins_ticker(self):
        coins = [
            {"id": "fake-btc", "symbol": "btc", "market_cap_rank": 250},
            {"id": "bitcoin", "symbol": "btc", "market_cap_rank": 1},
            {"id": "ethereum", "symbol": "eth", "market_cap_rank": 2},
            {"id": "tether", "symbol": "usdt", "market_cap_rank": 3},
        ]
        m = ud.map_binance_pairs(coins, {"BTC", "ETH"})
        self.assertEqual(m, {"bitcoin": "BTCUSDT", "ethereum": "ETHUSDT"})


class BuildCoin(unittest.TestCase):
    ITEM = {
        "id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "image": "https://x/y.png",
        "market_cap_rank": 1, "current_price": 200.0, "market_cap": 4000.0,
        "price_change_percentage_7d_in_currency": 3.456,
        "price_change_percentage_14d_in_currency": -2.0,
        "price_change_percentage_30d_in_currency": 10.0,
        "price_change_percentage_1y_in_currency": 55.5,
    }

    def test_uses_history_when_available(self):
        hist = {k: 100.0 for k, _ in ud.PERIODS}
        rec = ud.build_coin(self.ITEM, hist)
        self.assertEqual(rec["symbol"], "BTC")
        self.assertEqual(rec["change"]["1w"], 100.0)   # 200/100 - 1
        self.assertEqual(rec["change"]["5y"], 100.0)
        self.assertEqual(len(rec["change"]), 12)

    def test_falls_back_to_coingecko(self):
        rec = ud.build_coin(self.ITEM, None)
        self.assertEqual(rec["change"]["1w"], 3.46)
        self.assertEqual(rec["change"]["2w"], -2.0)
        self.assertEqual(rec["change"]["1m"], 10.0)
        self.assertEqual(rec["change"]["1y"], 55.5)
        # для остальных периодов данных нет
        self.assertIsNone(rec["change"]["3w"])
        self.assertIsNone(rec["change"]["5y"])

    def test_partial_history_mixes_sources(self):
        hist = {k: None for k, _ in ud.PERIODS}
        hist["2y"] = 50.0
        rec = ud.build_coin(self.ITEM, hist)
        self.assertEqual(rec["change"]["2y"], 300.0)
        self.assertEqual(rec["change"]["1w"], 3.46)

    def test_zero_market_cap_becomes_none(self):
        item = dict(self.ITEM, market_cap=0)
        self.assertIsNone(ud.build_coin(item, None)["market_cap"])


class Misc(unittest.TestCase):
    def test_history_staleness(self):
        self.assertTrue(ud.history_is_stale(None, "2026-10-17"))
        self.assertTrue(ud.history_is_stale({"base_date": "2026-10-16"}, "2026-10-17"))
        self.assertFalse(ud.history_is_stale({"base_date": "2026-10-17"}, "2026-10-17"))

    def test_atomic_write_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "a" / "b.json"
            ud.write_json_atomic(p, {"x": "Привет", "n": [1, 2]})
            self.assertEqual(ud.read_json(p), {"x": "Привет", "n": [1, 2]})
            self.assertFalse(p.with_suffix(".json.tmp").exists())
            self.assertIsNone(ud.read_json(Path(tmp) / "missing.json"))

    def test_day_start_is_midnight_utc(self):
        ms = ud.utc_day_start_ms()
        self.assertEqual(ms % DAY, 0)


if __name__ == "__main__":
    unittest.main()

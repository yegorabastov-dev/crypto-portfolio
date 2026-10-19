#!/usr/bin/env python3
"""
Обновляет данные для сайта:

  public/data/coins.json    - цена, капитализация и изменение цены за 12 периодов
  public/data/history.json  - кэш исторических цен (обновляется раз в сутки)

Источники:
  * CoinGecko (бесплатный ключ Demo): текущая цена, капитализация, топ монет.
  * Binance (публичные дневные свечи, без ключа): цены за 5 лет назад.

Запуск:
  python scripts/update_data.py --mode auto

Ключ CoinGecko берётся из переменной окружения COINGECKO_API_KEY (необязательно,
но без ключа CoinGecko режет запросы сильнее).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# (ключ периода, число дней назад)
PERIODS = [
    ("1w", 7), ("2w", 14), ("3w", 21), ("1m", 30), ("2m", 60), ("3m", 90),
    ("6m", 180), ("1y", 365), ("2y", 730), ("3y", 1095), ("4y", 1460), ("5y", 1825),
]

# Если истории с Binance нет (стейблкоины, малые монеты), для этих периодов
# берём готовые проценты от CoinGecko.
CG_FALLBACK = {"1w": "7d", "2w": "14d", "1m": "30d", "1y": "1y"}

CG_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets"
# Первый хост — публичные рыночные данные; он обычно доступен и из облака GitHub.
BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"]
DAY_MS = 86_400_000
USER_AGENT = "crypto-portfolio-updater/1.0"

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "public" / "data"


class FetchError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# ----------------------------------------------------------------------------
# Чистые функции (их проверяют тесты)
# ----------------------------------------------------------------------------

def pct_change(now, then):
    """Процент изменения от then к now; None, если считать нечего."""
    if now is None or then is None:
        return None
    try:
        now = float(now)
        then = float(then)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(now) and math.isfinite(then)) or then <= 0:
        return None
    return round((now / then - 1.0) * 100.0, 2)


def utc_day_start_ms(ts: datetime | None = None) -> int:
    ts = ts or datetime.now(timezone.utc)
    start = ts.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)


def pick_history_prices(candles, today_start_ms: int, periods=PERIODS, tolerance_days: int = 2):
    """
    candles: список свечей Binance [openTime, open, high, low, close, ...].
    Возвращает {ключ_периода: цена_открытия_дня | None}.

    Цена за период N дней назад — цена открытия дневной свечи с датой «сегодня - N».
    Если монета тогда ещё не торговалась, значение None. Небольшие дыры в данных
    (до tolerance_days) закрываются соседним днём.
    """
    by_open = {}
    for c in candles:
        try:
            by_open[int(c[0])] = float(c[1])
        except (TypeError, ValueError, IndexError):
            continue
    if not by_open:
        return {key: None for key, _ in periods}
    first_open = min(by_open)

    result = {}
    for key, days in periods:
        target = today_start_ms - days * DAY_MS
        if target < first_open:
            result[key] = None
            continue
        price = None
        for shift in range(0, tolerance_days + 1):
            for sign in ((1,) if shift == 0 else (1, -1)):
                p = by_open.get(target + sign * shift * DAY_MS)
                if p is not None and p > 0:
                    price = p
                    break
            if price is not None:
                break
        result[key] = price
    return result


def map_binance_pairs(cg_coins, binance_bases):
    """
    Сопоставляет монеты CoinGecko и пары Binance по тикеру.
    Тикеры на CoinGecko повторяются, поэтому пару получает монета с наибольшей капитализацией.
    Возвращает {coingecko_id: 'BTCUSDT'}.
    """
    ordered = sorted(
        cg_coins,
        key=lambda c: (c.get("market_cap_rank") is None, c.get("market_cap_rank") or 10**9),
    )
    claimed = set()
    mapping = {}
    for coin in ordered:
        sym = (coin.get("symbol") or "").upper()
        if sym and sym in binance_bases and sym not in claimed:
            claimed.add(sym)
            mapping[coin["id"]] = sym + "USDT"
    return mapping


def build_coin(cg_item: dict, hist_prices: dict | None) -> dict:
    """Собирает запись монеты для сайта."""
    price = cg_item.get("current_price")
    change = {}
    for key, _days in PERIODS:
        then = hist_prices.get(key) if hist_prices else None
        pct = pct_change(price, then)
        if pct is None and key in CG_FALLBACK:
            raw = cg_item.get("price_change_percentage_%s_in_currency" % CG_FALLBACK[key])
            if isinstance(raw, (int, float)) and math.isfinite(raw):
                pct = round(float(raw), 2)
        change[key] = pct
    return {
        "id": cg_item["id"],
        "symbol": (cg_item.get("symbol") or "").upper(),
        "name": cg_item.get("name") or cg_item["id"],
        "image": cg_item.get("image"),
        "rank": cg_item.get("market_cap_rank"),
        "price": price,
        "market_cap": cg_item.get("market_cap") or None,
        "change": change,
    }


def history_is_stale(history: dict | None, today_utc: str) -> bool:
    """Историю обновляем один раз за календарный день (UTC)."""
    return not history or history.get("base_date") != today_utc


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ----------------------------------------------------------------------------
# Работа с сетью
# ----------------------------------------------------------------------------

def http_get_json(url: str, params=None, headers=None, retries: int = 3, timeout: int = 30):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", "0") or 0) or 20 * (attempt + 1)
                log("  429 от %s, жду %s с" % (urllib.parse.urlsplit(url).netloc, wait))
                time.sleep(wait)
            elif e.code >= 500:
                time.sleep(2 ** attempt)
            else:
                raise FetchError("HTTP %s для %s" % (e.code, urllib.parse.urlsplit(url).netloc)) from e
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last_err = e
            time.sleep(2 ** attempt)
    raise FetchError("Не удалось получить %s: %s" % (urllib.parse.urlsplit(url).netloc, last_err))


def fetch_markets(top_n: int, api_key: str | None):
    headers = {"x-cg-demo-api-key": api_key} if api_key else {}
    coins = []
    pages = math.ceil(top_n / 250)
    for page in range(1, pages + 1):
        per_page = min(250, top_n - len(coins))
        data = http_get_json(
            CG_MARKETS_URL,
            params={
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": per_page,
                "page": page,
                "sparkline": "false",
                "price_change_percentage": "7d,14d,30d,1y",
            },
            headers=headers,
        )
        if not isinstance(data, list):
            raise FetchError("CoinGecko вернул неожиданный ответ")
        coins.extend(c for c in data if isinstance(c, dict) and c.get("id"))
        if page < pages:
            time.sleep(2)
    if not coins:
        raise FetchError("CoinGecko вернул пустой список монет")
    return coins


def find_binance_host():
    """Возвращает (хост, множество тикеров с парой к USDT) или (None, set())."""
    for host in BINANCE_HOSTS:
        try:
            data = http_get_json(host + "/api/v3/ticker/price", retries=2)
        except FetchError as e:
            log("  Binance %s недоступен: %s" % (host, e))
            continue
        bases = {
            item["symbol"][:-4]
            for item in data
            if isinstance(item, dict) and item.get("symbol", "").endswith("USDT")
        }
        if bases:
            return host, bases
    return None, set()


def fetch_daily_candles(host: str, pair: str, start_ms: int):
    out = []
    cursor = start_ms
    while True:
        data = http_get_json(
            host + "/api/v3/klines",
            params={"symbol": pair, "interval": "1d", "startTime": cursor, "limit": 1000},
        )
        if not data:
            break
        out.extend(data)
        if len(data) < 1000:
            break
        cursor = int(data[-1][0]) + DAY_MS
    return out


def refresh_history(cg_coins, old_history: dict | None, today_utc: str):
    """Скачивает дневные свечи Binance и считает цены на 12 дат в прошлом."""
    old_coins = (old_history or {}).get("coins", {})
    new_coins = dict(old_coins)  # при сбое оставляем прежние значения

    host, bases = find_binance_host()
    if not host:
        log("Binance недоступен — историю не обновляю, использую прежнюю и проценты CoinGecko.")
        return old_history

    mapping = map_binance_pairs(cg_coins, bases)
    log("Историю цен получим для %d из %d монет (остальных нет на Binance)." % (len(mapping), len(cg_coins)))

    today_start = utc_day_start_ms()
    start_ms = today_start - (max(d for _, d in PERIODS) + 3) * DAY_MS
    ok = failed = 0
    for i, (coin_id, pair) in enumerate(mapping.items(), 1):
        try:
            candles = fetch_daily_candles(host, pair, start_ms)
            new_coins[coin_id] = pick_history_prices(candles, today_start)
            ok += 1
        except FetchError as e:
            failed += 1
            log("  %s: пропускаю (%s)" % (pair, e))
        if i % 50 == 0:
            log("  обработано %d/%d" % (i, len(mapping)))
        time.sleep(0.12)  # вежливая пауза между запросами

    log("История: успешно %d, с ошибками %d." % (ok, failed))
    if ok == 0:
        return old_history
    return {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_date": today_utc,
        "coins": new_coins,
    }


# ----------------------------------------------------------------------------
# Точка входа
# ----------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["auto", "prices", "history"], default="auto",
                    help="auto: цены всегда, историю раз в сутки; prices: только цены; history: принудительно и историю")
    ap.add_argument("--top", type=int, default=300, help="сколько монет по капитализации брать (по умолчанию 300)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="папка для JSON-файлов")
    args = ap.parse_args(argv)

    api_key = os.environ.get("COINGECKO_API_KEY") or None
    if not api_key:
        log("Предупреждение: COINGECKO_API_KEY не задан, лимиты CoinGecko будут жёстче.")

    now = datetime.now(timezone.utc)
    today_utc = now.strftime("%Y-%m-%d")
    history_path = args.out / "history.json"
    coins_path = args.out / "coins.json"

    log("Загружаю топ-%d монет с CoinGecko…" % args.top)
    try:
        cg_coins = fetch_markets(args.top, api_key)
    except FetchError as e:
        log("Ошибка: %s. Файл coins.json не тронут." % e)
        return 1
    log("Получено монет: %d" % len(cg_coins))

    history = read_json(history_path)
    need_history = args.mode == "history" or (args.mode == "auto" and history_is_stale(history, today_utc))
    if need_history:
        history = refresh_history(cg_coins, history, today_utc)
        if history:
            write_json_atomic(history_path, history)

    hist_coins = (history or {}).get("coins", {})
    records = [build_coin(item, hist_coins.get(item["id"])) for item in cg_coins]
    # Монеты без цены на сайте бесполезны
    records = [r for r in records if r["price"] is not None]

    write_json_atomic(coins_path, {
        "updated": now.isoformat(timespec="seconds"),
        "currency": "usd",
        "demo": False,
        "periods": [k for k, _ in PERIODS],
        "coins": records,
    })
    log("Готово: записано %d монет в %s" % (len(records), coins_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())

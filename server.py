import csv
import io
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
import http.cookiejar
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}
COOKIE_JAR = http.cookiejar.CookieJar()
YAHOO_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIE_JAR))
YAHOO_CRUMB = None
ALPHA_VANTAGE_API_KEY = (
    os.environ.get("ALPHA_VANTAGE_API_KEY")
    or os.environ.get("ALPHAVANTAGE_API_KEY", "")
).strip()
EARNINGS_CACHE_TTL_SECONDS = 6 * 60 * 60
EARNINGS_RETRY_SECONDS = 5 * 60
EARNINGS_CACHE = {
    "expires_at": 0,
    "by_symbol": {},
    "status": "not_loaded",
    "message": None,
}
EARNINGS_LOCK = threading.Lock()
NASDAQ_EARNINGS_CACHE = {"expires_at": 0, "by_symbol": {}}
NASDAQ_EARNINGS_LOCK = threading.Lock()
YAHOO_EARNINGS_CACHE = {}
YAHOO_EARNINGS_LOCK = threading.Lock()
YAHOO_EARNINGS_CACHE_MAX_ENTRIES = 512
MARKET_LOSERS_CACHE_TTL_SECONDS = 5 * 60
MARKET_LOSERS_CACHE = {"expires_at": 0, "quotes": []}
MARKET_LOSERS_LOCK = threading.Lock()
COMPANY_CLASSIFICATION_CACHE_TTL_SECONDS = 6 * 60 * 60
COMPANY_CLASSIFICATION_RETRY_SECONDS = 5 * 60
COMPANY_CLASSIFICATION_CACHE_MAX_ENTRIES = 512
COMPANY_CLASSIFICATION_CACHE = {}
COMPANY_CLASSIFICATION_LOCK = threading.Lock()
OPTION_ROWS_CACHE_TTL_SECONDS = 2 * 60
OPTION_ROWS_CACHE_MAX_ENTRIES = 64
OPTION_ROWS_CACHE = {}
OPTION_ROWS_CACHE_LOCK = threading.Lock()
CBOE_SYMBOL_LOCKS = tuple(threading.Lock() for _ in range(16))
CBOE_FETCH_SEMAPHORE = threading.BoundedSemaphore(2)
MARKET_SCAN_SEMAPHORE = threading.BoundedSemaphore(1)


def earnings_calendar():
    """Return upcoming earnings keyed by symbol, with a shared six-hour cache."""
    if not ALPHA_VANTAGE_API_KEY:
        EARNINGS_CACHE.update({
            "status": "missing_api_key",
            "message": "ALPHA_VANTAGE_API_KEY is not available to this service.",
        })
        return {}

    now = time.time()
    if EARNINGS_CACHE["expires_at"] > now:
        return EARNINGS_CACHE["by_symbol"]

    with EARNINGS_LOCK:
        now = time.time()
        if EARNINGS_CACHE["expires_at"] > now:
            return EARNINGS_CACHE["by_symbol"]

        query = urllib.parse.urlencode({
            "function": "EARNINGS_CALENDAR",
            "horizon": "3month",
            "apikey": ALPHA_VANTAGE_API_KEY,
        })
        request = urllib.request.Request(
            "https://www.alphavantage.co/query?" + query,
            headers=YAHOO_HEADERS,
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content = response.read().decode("utf-8-sig")

            by_symbol = {}
            today = datetime.now().date()
            for row in csv.DictReader(io.StringIO(content)):
                symbol = (row.get("symbol") or "").upper().strip()
                report_date_text = (row.get("reportDate") or "").strip()
                try:
                    report_date = datetime.strptime(report_date_text, "%Y-%m-%d").date()
                except ValueError:
                    continue
                if not symbol or report_date < today:
                    continue

                current = by_symbol.get(symbol)
                if current and current["date"] <= report_date_text:
                    continue
                by_symbol[symbol] = {
                    "date": report_date_text,
                    "fiscalDateEnding": (row.get("fiscalDateEnding") or "").strip() or None,
                    "estimate": (row.get("estimate") or "").strip() or None,
                    "currency": (row.get("currency") or "").strip() or None,
                }

            if not by_symbol:
                raise ValueError("Alpha Vantage returned no earnings-calendar rows")

            EARNINGS_CACHE.update({
                "expires_at": now + EARNINGS_CACHE_TTL_SECONDS,
                "by_symbol": by_symbol,
                "status": "ok",
                "message": None,
            })
            print("Alpha Vantage earnings calendar loaded: %d symbols" % len(by_symbol))
        except Exception as error:
            # Keep stock/option data available if Alpha Vantage is unavailable.
            EARNINGS_CACHE.update({
                "expires_at": now + EARNINGS_RETRY_SECONDS,
                "status": "error",
                "message": "%s: %s" % (type(error).__name__, str(error)[:180]),
            })
            print("Alpha Vantage earnings calendar error: %s" % EARNINGS_CACHE["message"])

        return EARNINGS_CACHE["by_symbol"]


def nasdaq_earnings_calendar(days=14):
    """Keyless fallback for earnings scheduled in the next two weeks."""
    now = time.time()
    if NASDAQ_EARNINGS_CACHE["expires_at"] > now:
        return NASDAQ_EARNINGS_CACHE["by_symbol"]

    with NASDAQ_EARNINGS_LOCK:
        now = time.time()
        if NASDAQ_EARNINGS_CACHE["expires_at"] > now:
            return NASDAQ_EARNINGS_CACHE["by_symbol"]

        by_symbol = {}
        successful_days = 0
        today = datetime.now().date()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        }

        report_dates = [
            today + timedelta(days=offset)
            for offset in range(days + 1)
            if (today + timedelta(days=offset)).weekday() < 5
        ]

        def fetch_date(report_date):
            query = urllib.parse.urlencode({"date": report_date.isoformat()})
            request = urllib.request.Request(
                "https://api.nasdaq.com/api/calendar/earnings?" + query,
                headers=headers,
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return report_date, payload.get("data", {}).get("rows") or []

        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(fetch_date, report_date) for report_date in report_dates]
            for future in as_completed(futures):
                try:
                    report_date, rows = future.result()
                except Exception:
                    continue
                successful_days += 1

                for row in rows:
                    symbol = (row.get("symbol") or "").upper().strip()
                    if not symbol:
                        continue
                    current = by_symbol.get(symbol)
                    if current and current["date"] <= report_date.isoformat():
                        continue
                    estimate_text = (row.get("epsForecast") or "").strip()
                    negative = estimate_text.startswith("(") and estimate_text.endswith(")")
                    estimate_text = estimate_text.strip("()$,")
                    try:
                        estimate = float(estimate_text) * (-1 if negative else 1)
                    except ValueError:
                        estimate = None
                    by_symbol[symbol] = {
                        "date": report_date.isoformat(),
                        "fiscalDateEnding": (row.get("fiscalQuarterEnding") or "").strip() or None,
                        "estimate": estimate,
                        "currency": "USD",
                        "timeOfDay": (row.get("time") or "").strip() or None,
                    }

        NASDAQ_EARNINGS_CACHE.update({
            "expires_at": now + (
                EARNINGS_CACHE_TTL_SECONDS if successful_days else EARNINGS_RETRY_SECONDS
            ),
            "by_symbol": by_symbol,
        })
        if successful_days:
            print("Nasdaq earnings fallback loaded: %d symbols" % len(by_symbol))
        return by_symbol


def yahoo_earnings(symbol):
    """Return Yahoo's announced or estimated earnings date for one symbol."""
    now = time.time()
    with YAHOO_EARNINGS_LOCK:
        cached = YAHOO_EARNINGS_CACHE.get(symbol)
        if cached and cached["expires_at"] > now:
            return cached["value"]

    value = None
    try:
        encoded = urllib.parse.quote(symbol)
        request = urllib.request.Request(
            "https://finance.yahoo.com/quote/" + encoded + "/",
            headers=YAHOO_HEADERS,
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            page = response.read().decode("utf-8", "ignore").replace('\\"', '"')

        calendar_match = re.search(
            r'"earningsDate":\[(.*?)\],"isEarningsDateEstimate":(true|false)',
            page,
        )
        if calendar_match:
            date_match = re.search(r'"fmt":"(\d{4}-\d{2}-\d{2})"', calendar_match.group(1))
            if date_match:
                value = {
                    "date": date_match.group(1),
                    "fiscalDateEnding": None,
                    "estimate": None,
                    "currency": "USD",
                    "isEstimate": calendar_match.group(2) == "true",
                    "source": "Yahoo Finance",
                }
    except Exception as error:
        print("Yahoo earnings fallback error for %s: %s" % (symbol, str(error)[:180]))

    with YAHOO_EARNINGS_LOCK:
        expired_symbols = [
            cached_symbol
            for cached_symbol, cached in YAHOO_EARNINGS_CACHE.items()
            if cached["expires_at"] <= now
        ]
        for cached_symbol in expired_symbols:
            YAHOO_EARNINGS_CACHE.pop(cached_symbol, None)
        while len(YAHOO_EARNINGS_CACHE) >= YAHOO_EARNINGS_CACHE_MAX_ENTRIES:
            oldest_symbol = min(
                YAHOO_EARNINGS_CACHE,
                key=lambda cached_symbol: YAHOO_EARNINGS_CACHE[cached_symbol]["expires_at"],
            )
            YAHOO_EARNINGS_CACHE.pop(oldest_symbol, None)
        YAHOO_EARNINGS_CACHE[symbol] = {
            "expires_at": now + (
                EARNINGS_CACHE_TTL_SECONDS if value else EARNINGS_RETRY_SECONDS
            ),
            "value": value,
        }
    return value


def yahoo_json(url):
    global YAHOO_CRUMB
    if YAHOO_CRUMB is None:
        try:
            YAHOO_OPENER.open(urllib.request.Request("https://fc.yahoo.com", headers=YAHOO_HEADERS), timeout=10)
            crumb_request = urllib.request.Request(
                "https://query1.finance.yahoo.com/v1/test/getcrumb", headers=YAHOO_HEADERS
            )
            with YAHOO_OPENER.open(crumb_request, timeout=10) as crumb_response:
                YAHOO_CRUMB = crumb_response.read().decode("utf-8")
        except Exception:
            YAHOO_CRUMB = ""
    separator = "&" if "?" in url else "?"
    request_url = url + separator + urllib.parse.urlencode({"crumb": YAHOO_CRUMB}) if YAHOO_CRUMB else url
    request = urllib.request.Request(request_url, headers=YAHOO_HEADERS)
    with YAHOO_OPENER.open(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def uncached_cboe_json(symbol):
    url = "https://cdn.cboe.com/api/global/delayed_quotes/options/" + urllib.parse.quote(symbol) + ".json"
    request = urllib.request.Request(url, headers=YAHOO_HEADERS)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def market_loser_candidates(minimum_market_cap, drop_percent, limit=10):
    """Return today's steepest equity decliners matching configurable filters."""
    now = time.time()
    if MARKET_LOSERS_CACHE["expires_at"] <= now:
        with MARKET_LOSERS_LOCK:
            now = time.time()
            if MARKET_LOSERS_CACHE["expires_at"] <= now:
                query = urllib.parse.urlencode({
                    "formatted": "false",
                    "scrIds": "day_losers",
                    "count": 250,
                    "start": 0,
                })
                payload = yahoo_json(
                    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?" + query
                )
                results = payload.get("finance", {}).get("result") or []
                quotes = results[0].get("quotes", []) if results else []
                MARKET_LOSERS_CACHE.update({
                    "expires_at": now + MARKET_LOSERS_CACHE_TTL_SECONDS,
                    "quotes": quotes,
                })

    candidates = []
    for quote in MARKET_LOSERS_CACHE["quotes"]:
        symbol = (quote.get("symbol") or "").upper().strip()
        market_cap = quote.get("marketCap") or 0
        change = quote.get("regularMarketChangePercent")
        if (
            symbol
            and quote.get("quoteType") == "EQUITY"
            and market_cap >= minimum_market_cap
            and change is not None
            and change < -drop_percent
        ):
            candidates.append({
                "symbol": symbol,
                "name": quote.get("longName") or quote.get("shortName") or symbol,
                "marketCap": market_cap,
                "change": change,
                "price": quote.get("regularMarketPrice"),
                "priceChange": quote.get("regularMarketChange"),
            })

    candidates.sort(key=lambda item: item["change"])
    return candidates[:limit]


def yahoo_company_classification(symbol):
    """Return Yahoo's sector and industry classification with a bounded cache."""
    now = time.time()
    with COMPANY_CLASSIFICATION_LOCK:
        cached = COMPANY_CLASSIFICATION_CACHE.get(symbol)
        if cached and cached["expires_at"] > now:
            return cached["value"]

    value = None
    try:
        query = urllib.parse.urlencode({
            "q": symbol,
            "quotesCount": 6,
            "newsCount": 0,
        })
        payload = yahoo_json("https://query2.finance.yahoo.com/v1/finance/search?" + query)
        quote = next(
            (
                item for item in payload.get("quotes", [])
                if (item.get("symbol") or "").upper() == symbol
                and item.get("quoteType") == "EQUITY"
            ),
            None,
        )
        if quote:
            value = {
                "sector": quote.get("sector") or quote.get("sectorDisp"),
                "industry": quote.get("industry") or quote.get("industryDisp"),
            }
    except Exception as error:
        print("Company classification error for %s: %s" % (symbol, str(error)[:180]))

    with COMPANY_CLASSIFICATION_LOCK:
        expired_symbols = [
            cached_symbol
            for cached_symbol, cached in COMPANY_CLASSIFICATION_CACHE.items()
            if cached["expires_at"] <= now
        ]
        for cached_symbol in expired_symbols:
            COMPANY_CLASSIFICATION_CACHE.pop(cached_symbol, None)
        while len(COMPANY_CLASSIFICATION_CACHE) >= COMPANY_CLASSIFICATION_CACHE_MAX_ENTRIES:
            oldest_symbol = min(
                COMPANY_CLASSIFICATION_CACHE,
                key=lambda cached_symbol: COMPANY_CLASSIFICATION_CACHE[cached_symbol]["expires_at"],
            )
            COMPANY_CLASSIFICATION_CACHE.pop(oldest_symbol, None)
        COMPANY_CLASSIFICATION_CACHE[symbol] = {
            "expires_at": now + (
                COMPANY_CLASSIFICATION_CACHE_TTL_SECONDS
                if value else COMPANY_CLASSIFICATION_RETRY_SECONDS
            ),
            "value": value,
        }
    return value


def is_biotechnology_or_pharmaceutical(classification):
    if not classification:
        return False
    industry = (classification.get("industry") or "").strip().lower()
    return (
        industry == "biotechnology"
        or "pharmaceutical" in industry
        or industry.startswith("drug manufacturer")
    )


def closest_option(options, target_ratio):
    if not options:
        return None
    ranked = []
    for option in options:
        strike = option.get("strike", 0) or 0
        premium = option.get("lastPrice", 0) or option.get("mark", 0) or 0
        if strike <= 0 or premium <= 0:
            continue
        ratio = premium / strike
        ranked.append((abs(ratio - target_ratio), option))
    if not ranked:
        return None
    return min(ranked, key=lambda item: item[0])[1]


def option_view(option):
    if not option:
        return None
    return {
        "premium": option.get("lastPrice", 0) or option.get("mark", 0) or 0,
        "strike": option.get("strike", 0) or 0,
        "change": option.get("percentChange", 0) or 0,
        "volume": option.get("volume", 0) or 0,
        "ratio": ((option.get("lastPrice", 0) or option.get("mark", 0) or 0) / (option.get("strike", 1) or 1)) * 100,
    }


def cboe_option_view(option):
    bid = option.get("bid", 0) or 0
    last = option.get("last_trade_price", 0) or 0
    # For a cash-secured put sale, the bid is the currently available
    # premium. The bid/ask midpoint is not an executable seller price.
    premium = bid if bid > 0 else last
    strike = option.get("strike", 0) or 0
    return {
        "premium": premium,
        "strike": strike,
        "change": option.get("percent_change", 0) or 0,
        "volume": option.get("volume", 0) or 0,
        "ratio": (premium / strike) * 100 if strike else 0,
        "openInterest": option.get("open_interest", 0) or 0,
        "impliedVolatility": option.get("iv", 0) or 0,
    }


def qualifying_puts(puts, target_percent):
    valid_puts = [
        put for put in puts
        if (put.get("bid", 0) or 0) > 0
        and (put.get("volume", 0) or 0) > 0
        and (put.get("open_interest", 0) or 0) > 0
    ]
    target_ratio = target_percent / 100
    nearest = min(
        valid_puts,
        key=lambda put: abs(((put.get("bid", 0) or 0) / put["strike"]) - target_ratio),
    ) if valid_puts else None
    return {
        "middle": cboe_option_view(nearest) if nearest else None,
    }


def cached_option_rows(symbol, today):
    """Return only the two useful put expirations, never the full Cboe chain.

    A full chain can be several megabytes once decoded into Python objects. The
    old cache retained that entire object graph for every scanned ticker. This
    cache stores a bounded set of compact rows instead.
    """
    cache_key = (symbol, today.isoformat())
    now = time.time()
    stale_value = None
    with OPTION_ROWS_CACHE_LOCK:
        cached = OPTION_ROWS_CACHE.get(cache_key)
        if cached:
            stale_value = cached["value"]
            if cached["expires_at"] > now:
                return stale_value

    symbol_lock = CBOE_SYMBOL_LOCKS[hash(symbol) % len(CBOE_SYMBOL_LOCKS)]
    with symbol_lock:
        now = time.time()
        with OPTION_ROWS_CACHE_LOCK:
            cached = OPTION_ROWS_CACHE.get(cache_key)
            if cached:
                stale_value = cached["value"]
                if cached["expires_at"] > now:
                    return stale_value

        try:
            with CBOE_FETCH_SEMAPHORE:
                cboe_rows = uncached_cboe_json(symbol)["data"]["options"]

            expiration_dates = set()
            for row in cboe_rows:
                contract = row.get("option", "")
                suffix = contract[len(symbol):]
                if len(suffix) != 15 or suffix[6] != "P":
                    continue
                try:
                    expiration_date = datetime.strptime(suffix[:6], "%y%m%d").date()
                except (TypeError, ValueError):
                    continue
                if expiration_date >= today:
                    expiration_dates.add(expiration_date)

            expiration_dates = sorted(expiration_dates)
            days_to_friday = (4 - today.weekday()) % 7 or 7
            targets = (
                ("nextFriday", today + timedelta(days=days_to_friday)),
                ("followingFriday", today + timedelta(days=days_to_friday + 7)),
            )
            selected_dates = {}
            for key, target in targets:
                # A contract belongs in a column only when its expiration is
                # exactly the date printed in that column. Do not substitute a
                # later monthly expiration for a missing weekly expiration.
                selected_dates[key] = target if target in expiration_dates else None

            rows_by_expiration = {
                expiration: [] for expiration in set(selected_dates.values()) if expiration
            }
            for row in cboe_rows:
                contract = row.get("option", "")
                suffix = contract[len(symbol):]
                if len(suffix) != 15 or suffix[6] != "P":
                    continue
                try:
                    expiration_date = datetime.strptime(suffix[:6], "%y%m%d").date()
                    strike = int(suffix[7:]) / 1000
                except (TypeError, ValueError):
                    continue
                if expiration_date not in rows_by_expiration:
                    continue
                rows_by_expiration[expiration_date].append({
                    "bid": row.get("bid", 0) or 0,
                    "last_trade_price": row.get("last_trade_price", 0) or 0,
                    "percent_change": row.get("percent_change", 0) or 0,
                    "volume": row.get("volume", 0) or 0,
                    "open_interest": row.get("open_interest", 0) or 0,
                    "iv": row.get("iv", 0) or 0,
                    "strike": strike,
                })

            value = {}
            for key, expiration in selected_dates.items():
                value[key] = {
                    "rows": rows_by_expiration.get(expiration, []),
                    "date": f"{expiration:%b} {expiration.day}" if expiration else None,
                }
        except Exception:
            if stale_value is not None:
                return stale_value
            raise

        with OPTION_ROWS_CACHE_LOCK:
            expired_keys = [
                key for key, entry in OPTION_ROWS_CACHE.items()
                if entry["expires_at"] <= now and key != cache_key
            ]
            for key in expired_keys:
                OPTION_ROWS_CACHE.pop(key, None)
            while len(OPTION_ROWS_CACHE) >= OPTION_ROWS_CACHE_MAX_ENTRIES:
                oldest_key = min(
                    OPTION_ROWS_CACHE,
                    key=lambda key: OPTION_ROWS_CACHE[key]["expires_at"],
                )
                OPTION_ROWS_CACHE.pop(oldest_key, None)
            OPTION_ROWS_CACHE[cache_key] = {
                "expires_at": now + OPTION_ROWS_CACHE_TTL_SECONDS,
                "value": value,
            }
        return value


def option_signals(symbol, target_percent, today):
    cached_rows = cached_option_rows(symbol, today)
    return {
        key: {
            "puts": qualifying_puts(expiration["rows"], target_percent),
            "date": expiration["date"],
        }
        for key, expiration in cached_rows.items()
    }


def previous_trading_close(meta, timestamps, closes, current_price):
    """Return the close immediately before the regular-market price session.

    Yahoo can publish a live regularMarketPrice before today's daily candle is
    appended to the chart. In that case, the final candle is already the prior
    close and must not be skipped.
    """
    dated_closes = [
        (timestamp, close)
        for timestamp, close in zip(timestamps, closes)
        if close is not None
    ]
    if not dated_closes:
        return meta.get("chartPreviousClose", 0) or 0

    last_timestamp, last_close = dated_closes[-1]
    market_timestamp = meta.get("regularMarketTime")
    utc_offset = int(meta.get("gmtoffset", 0) or 0)

    if market_timestamp:
        market_date = datetime.utcfromtimestamp(market_timestamp + utc_offset).date()
        last_bar_date = datetime.utcfromtimestamp(last_timestamp + utc_offset).date()
        if last_bar_date != market_date:
            return last_close
        if len(dated_closes) >= 2:
            return dated_closes[-2][1]

    price_tolerance = max(0.01, abs(current_price or 0) * 0.001)
    if abs((current_price or 0) - last_close) <= price_tolerance and len(dated_closes) >= 2:
        return dated_closes[-2][1]
    return last_close


def fetch_stock(symbol, target_percent=1.0):
    symbol = symbol.upper().strip()
    encoded = urllib.parse.quote(symbol)
    chart_url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/" + encoded
        + "?range=1y&interval=1d&events=div%2Csplits"
    )
    chart_payload = yahoo_json(chart_url)["chart"]["result"][0]
    meta = chart_payload.get("meta", {})
    timestamps = chart_payload.get("timestamp", [])
    closes = chart_payload.get("indicators", {}).get("quote", [{}])[0].get("close", [])
    clean_closes = [value for value in closes if value is not None]
    
    price = meta.get("regularMarketPrice") or (
        clean_closes[-1] if clean_closes else 0
    )
    
    # chartPreviousClose is the close before the one-year window, not the
    # previous trading day. Match daily candles to the live quote session so
    # intraday requests work whether today's candle exists yet or not.
    previous_price = previous_trading_close(meta, timestamps, closes, price)
    
    change_percent = (
        ((price - previous_price) / previous_price) * 100
        if previous_price
        else 0
    )
    price_change = price - previous_price if previous_price else 0

    def average(period):
        values = clean_closes[-period:]
        return sum(values) / len(values) if values else None

    today = datetime.now().date()
    options = {
        "nextFriday": {"puts": {"middle": None}, "date": None},
        "followingFriday": {"puts": {"middle": None}, "date": None},
    }
    try:
        options = option_signals(symbol, target_percent, today)
    except Exception:
        pass

    calendar = earnings_calendar()
    next_earnings = calendar.get(symbol)
    earnings_status = EARNINGS_CACHE["status"]
    earnings_message = EARNINGS_CACHE["message"]
    if not next_earnings:
        next_earnings = nasdaq_earnings_calendar().get(symbol)
        if next_earnings:
            earnings_status = "ok_nasdaq_fallback"
            earnings_message = "Nasdaq supplied the date because Alpha Vantage was unavailable."
    if not next_earnings:
        next_earnings = yahoo_earnings(symbol)
        if next_earnings:
            earnings_status = (
                "ok_yahoo_estimate" if next_earnings.get("isEstimate") else "ok_yahoo_fallback"
            )
            earnings_message = (
                "Yahoo Finance supplied an estimated date."
                if next_earnings.get("isEstimate")
                else "Yahoo Finance supplied the announced date."
            )
    return {
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "price": price,
        "priceChange": price_change,
        "change": change_percent,
        "currency": meta.get("currency", "USD"),
        "moving15": average(15),
        "moving30": average(30),
        "moving50": average(50),
        "moving70": average(70),
        "moving90": average(90),
        "moving100": average(100),
        "moving120": average(120),
        "nextEarnings": next_earnings,
        "earningsStatus": earnings_status,
        "earningsMessage": earnings_message,
        "options": options,
    }


def fetch_market_losers(
    target_percent=1.0,
    minimum_market_cap=10_000_000_000,
    drop_percent=10,
    rank_expiration="nextFriday",
    minimum_return_percent=0.8,
    limit=10,
):
    """Filter and rank daily losers before applying the final row limit."""
    candidate_limit = 50
    candidates = market_loser_candidates(
        minimum_market_cap,
        drop_percent,
        candidate_limit,
    )
    if not candidates:
        return []

    classified_candidates = []
    classification_workers = min(6, len(candidates))
    with ThreadPoolExecutor(max_workers=classification_workers) as executor:
        futures = {
            executor.submit(yahoo_company_classification, candidate["symbol"]): candidate
            for candidate in candidates
        }
        for future in as_completed(futures):
            candidate = futures[future]
            try:
                classification = future.result()
            except Exception:
                classification = None
            if is_biotechnology_or_pharmaceutical(classification):
                continue
            if classification:
                candidate.update(classification)
            classified_candidates.append(candidate)

    candidates = classified_candidates
    if not candidates:
        return []

    stocks = []
    worker_count = min(4, len(candidates))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(fetch_stock, candidate["symbol"], target_percent): candidate
            for candidate in candidates
        }
        for future in as_completed(futures):
            candidate = futures[future]
            try:
                stock = future.result()
            except Exception as error:
                print("Market loser detail error for %s: %s" % (
                    candidate["symbol"], str(error)[:180]
                ))
                continue

            # Use the screener snapshot for the fields that define membership,
            # so every displayed row continues to match the advertised filter.
            stock["marketCap"] = candidate["marketCap"]
            stock["change"] = candidate["change"]
            stock["sector"] = candidate.get("sector")
            stock["industry"] = candidate.get("industry")
            if candidate["price"] is not None:
                stock["price"] = candidate["price"]
            if candidate["priceChange"] is not None:
                stock["priceChange"] = candidate["priceChange"]
            stocks.append(stock)

    def selected_option(stock):
        return (
            stock.get("options", {})
            .get(rank_expiration, {})
            .get("puts", {})
            .get("middle")
        )

    def juice_score(stock):
        option = selected_option(stock)
        if not option:
            return float("-inf")
        price = stock.get("price") or 0
        strike = option.get("strike") or 0
        premium = option.get("premium") or 0
        if price <= 0 or strike <= 0 or premium <= 0:
            return float("-inf")
        premium_yield = premium / strike
        strike_distance = abs((price - strike) / price)
        score = (premium_yield * (2 / 3)) + (strike_distance * (1 / 3))
        return -score if strike > price else score

    qualifying_stocks = [
        stock for stock in stocks
        if selected_option(stock)
        and (selected_option(stock).get("ratio") or 0) > minimum_return_percent
    ]
    qualifying_stocks.sort(key=juice_score, reverse=True)
    return qualifying_stocks[:min(limit, 10)]


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Prevent a traffic spike from creating an unbounded number of threads."""
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, server_address, handler_class, maximum_threads=16):
        super().__init__(server_address, handler_class)
        self.request_slots = threading.BoundedSemaphore(maximum_threads)

    def process_request(self, request, client_address):
        self.request_slots.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/market-losers":
            query = urllib.parse.parse_qs(parsed.query)
            target = query.get("target", ["1.0"])[0]
            market_cap_billions = query.get("marketCapBillions", ["10"])[0]
            drop_percent = query.get("dropPercent", ["10"])[0]
            rank_expiration = query.get("rankExpiration", ["nextFriday"])[0]
            minimum_return_percent = query.get("minimumReturnPercent", ["0.8"])[0]
            scan_acquired = False
            status = 200
            try:
                target = float(target)
                market_cap_billions = float(market_cap_billions)
                drop_percent = float(drop_percent)
                minimum_return_percent = float(minimum_return_percent)
                if rank_expiration not in ("nextFriday", "followingFriday"):
                    raise ValueError("Rank expiration must be nextFriday or followingFriday")
                if market_cap_billions <= 0 or drop_percent <= 0 or minimum_return_percent < 0:
                    raise ValueError("Market cap and filter percentages must be valid")
                scan_acquired = MARKET_SCAN_SEMAPHORE.acquire(timeout=5)
                if not scan_acquired:
                    raise TimeoutError("The market scanner is busy; please try again shortly.")
                minimum_market_cap = int(market_cap_billions * 1_000_000_000)
                payload = {
                    "stocks": fetch_market_losers(
                        target,
                        minimum_market_cap,
                        drop_percent,
                        rank_expiration,
                        minimum_return_percent,
                        10,
                    ),
                    "criteria": {
                        "changePercentBelow": -drop_percent,
                        "minimumMarketCap": minimum_market_cap,
                        "minimumReturnPercent": minimum_return_percent,
                        "rankExpiration": rank_expiration,
                        "limit": 10,
                    },
                }
                body = json.dumps(payload).encode("utf-8")
            except TimeoutError as error:
                status = 503
                body = json.dumps({"error": str(error)}).encode("utf-8")
            except ValueError as error:
                status = 400
                body = json.dumps({"error": str(error)}).encode("utf-8")
            except Exception as error:
                status = 502
                body = json.dumps({"error": str(error)}).encode("utf-8")
            finally:
                if scan_acquired:
                    MARKET_SCAN_SEMAPHORE.release()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/stock":
            symbol = urllib.parse.parse_qs(parsed.query).get("symbol", [""])[0]
            target = urllib.parse.parse_qs(parsed.query).get("target", ["1.0"])[0]
            try:
                payload = fetch_stock(symbol, float(target))
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
            except Exception as error:
                body = json.dumps({"error": str(error), "symbol": symbol.upper()}).encode("utf-8")
                self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    os.chdir(ROOT)
    port = int(os.environ.get("PORT", "8765"))
    print("Stockoption running on port %d" % port)
    BoundedThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

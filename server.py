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


def cboe_json(symbol):
    url = "https://cdn.cboe.com/api/global/delayed_quotes/options/" + urllib.parse.quote(symbol) + ".json"
    request = urllib.request.Request(url, headers=YAHOO_HEADERS)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


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
    ask = option.get("ask", 0) or 0
    last = option.get("last_trade_price", 0) or 0
    premium = (bid + ask) / 2 if bid > 0 and ask > 0 else last
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
        key=lambda put: abs((put["lastPrice"] / put["strike"]) - target_ratio),
    ) if valid_puts else None
    return {
        "middle": cboe_option_view(nearest) if nearest else None,
    }


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
    
    # For a one-year chart, chartPreviousClose is the close before the
    # one-year window, not the previous trading day's close.
    previous_price = (
        clean_closes[-2]
        if len(clean_closes) >= 2
        else meta.get("chartPreviousClose", 0)
    )
    
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
    options = {}
    try:
        cboe_rows = cboe_json(symbol)["data"]["options"]
        parsed_rows = []
        for row in cboe_rows:
            contract = row.get("option", "")
            suffix = contract[len(symbol):]
            if len(suffix) != 15 or suffix[6] not in ("C", "P"):
                continue
            expiration_date = datetime.strptime(suffix[:6], "%y%m%d").date()
            row["expiration_date"] = expiration_date
            row["type"] = suffix[6]
            row["strike"] = int(suffix[7:]) / 1000
            bid = row.get("bid", 0) or 0
            ask = row.get("ask", 0) or 0
            row["lastPrice"] = (bid + ask) / 2 if bid > 0 and ask > 0 else row.get("last_trade_price", 0)
            row["percentChange"] = row.get("percent_change", 0) or 0
            parsed_rows.append(row)
    except Exception:
        parsed_rows = []

    days_to_friday = (4 - today.weekday()) % 7 or 7
    target_expirations = (
        ("nextFriday", today + timedelta(days=days_to_friday)),
        ("followingFriday", today + timedelta(days=days_to_friday + 7)),
    )
    expiration_dates = sorted({row["expiration_date"] for row in parsed_rows if row["expiration_date"] >= today})
    for key, target in target_expirations:
        expiration = min(expiration_dates, key=lambda value: abs(value - target)) if expiration_dates else None
        puts = [row for row in parsed_rows if row["expiration_date"] == expiration and row["type"] == "P"]
        options[key] = {
            "puts": qualifying_puts(puts, target_percent),
            "date": f"{expiration:%b} {expiration.day}" if expiration else None,
        }

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


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
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
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

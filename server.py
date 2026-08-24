import json
import os
import urllib.parse
import urllib.request
import http.cookiejar
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}
COOKIE_JAR = http.cookiejar.CookieJar()
YAHOO_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIE_JAR))
YAHOO_CRUMB = None


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

    return {
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "price": price,
        "change": change_percent,
        "currency": meta.get("currency", "USD"),
        "moving15": average(15),
        "moving30": average(30),
        "moving50": average(50),
        "moving70": average(70),
        "moving90": average(90),
        "moving100": average(100),
        "moving120": average(120),
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
    port = int(os.environ.get("PORT", "8000"))
    print("Stockoption running on port %d" % port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

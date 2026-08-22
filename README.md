# stkopt

A local watchlist for Yahoo Finance quotes/moving averages and Cboe delayed options signals.

## Run

Requires Python 3.9+.

```sh
python3 server.py
```

Open http://localhost:8000. Add ticker symbols to persist them in your browser. Quotes are from Yahoo Finance; delayed options are from Cboe. To enable earnings dates, create a free Finnhub account, set `FINNHUB_API_KEY`, and then run `python3 server.py`. Data may be delayed or rate-limited.

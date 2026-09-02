# stkopt

A local watchlist for Yahoo Finance quotes/moving averages and Cboe delayed options signals.

## Run

Requires Python 3.9+.

```sh
python3 server.py
```

Open http://localhost:8765. Add ticker symbols to persist them in your browser. Quotes are from Yahoo Finance; delayed options are from Cboe. Data may be delayed or rate-limited.

To use a different port, set the `PORT` environment variable before starting the server.

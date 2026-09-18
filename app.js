function initializeGoogleAnalytics() {
  const measurementId = 'G-JMDS9WBL6F';

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', measurementId);

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);
}

function initializeKofiButton() {
  const container = document.createElement('div');
  container.id = 'kofi-support-button';
  container.setAttribute('aria-label', 'Support this site on Ko-fi');
  Object.assign(container.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: '1000',
  });
  document.body.appendChild(container);

  const script = document.createElement('script');
  script.src = 'https://storage.ko-fi.com/cdn/widget/Widget_2.js';
  script.onload = () => {
    window.kofiwidget2.init('Buy me a coffee ☕', '#a54dff', 'S6G525XNFX');
    container.innerHTML = window.kofiwidget2.getHTML();
  };
  document.head.appendChild(script);
}

initializeGoogleAnalytics();
initializeKofiButton();

const list = document.querySelector('#watchlist');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#watch-count');
const input = document.querySelector('#symbol-input');
const refreshButton = document.querySelector('#refresh');
const lastRefresh = document.querySelector('#last-refresh');
const targetSelect = document.querySelector('#target-select');
const juiceSortSelect = document.querySelector('#juice-sort-select');
const marketJuiceSortSelect = document.querySelector('#market-juice-sort-select');
const marketLosersList = document.querySelector('#market-losers');
const marketLosersEmpty = document.querySelector('#market-losers-empty');
const marketLosersEmptyMessage = document.querySelector('#market-losers-empty-message');
const marketLosersCount = document.querySelector('#market-losers-count');
const marketLosersShell = document.querySelector('#market-losers-shell');
const marketCapSelect = document.querySelector('#market-cap-select');
const dropPercentSelect = document.querySelector('#drop-percent-select');

const storageKey = 'stockoption-watchlist';
const targetStorageKey = 'stockoption-target-percent';
const juiceSortStorageKey = 'stockoption-juice-sort-expiration';
const marketJuiceSortStorageKey = 'stockoption-market-juice-sort-expiration';
const marketCapStorageKey = 'stockoption-minimum-market-cap-billions';
const dropPercentStorageKey = 'stockoption-minimum-drop-percent';
const minimumOptionReturnPercent = 0.80;
const defaultSymbols = ['OKLO', 'IREN', 'ASTS', 'INTC', 'CBRS', 'BE', 'NVDA', 'ALAB', 'TSLA', 'AAOI', 'CRDO', 'NBIS', 'MRVL', 'LUNR'];

function storedSymbols() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(saved) ? saved.filter((symbol) => typeof symbol === 'string') : defaultSymbols;
  } catch {
    return defaultSymbols;
  }
}

let symbols = storedSymbols();
let targetPercent = Number(localStorage.getItem(targetStorageKey) || '1.00');
let minimumMarketCapBillions = Number(localStorage.getItem(marketCapStorageKey) || '10');
let minimumDropPercent = Number(localStorage.getItem(dropPercentStorageKey) || '10');
let watchlistJuiceSortExpiration = localStorage.getItem(juiceSortStorageKey) === 'followingFriday'
  ? 'followingFriday'
  : 'nextFriday';
let marketJuiceSortExpiration = localStorage.getItem(marketJuiceSortStorageKey) === 'followingFriday'
  ? 'followingFriday'
  : 'nextFriday';
let requestSequence = 0;
let marketLosersRequestSequence = 0;
let latestResults = [];
let latestMarketLosers = [];

const nextFriday = new Date();
const daysToFriday = (5 - nextFriday.getDay() + 7) % 7 || 7;
nextFriday.setDate(nextFriday.getDate() + daysToFriday);
const followingFriday = new Date(nextFriday);
followingFriday.setDate(followingFriday.getDate() + 7);
const formatFriday = (date) => `${date.toLocaleDateString('en-US', { month: 'short' })} ${String(date.getDate()).padStart(2, '0')}`;
document.querySelector('#next-friday-date').textContent = formatFriday(nextFriday);
document.querySelector('#following-friday-date').textContent = formatFriday(followingFriday);
document.querySelector('#losers-next-friday-date').textContent = formatFriday(nextFriday);
document.querySelector('#losers-following-friday-date').textContent = formatFriday(followingFriday);

for (let value = 0.1; value <= 5; value += 0.1) {
  const percent = value.toFixed(2);
  targetSelect.insertAdjacentHTML('beforeend', `<option value="${percent}">${percent}%</option>`);
}

targetSelect.value = targetPercent.toFixed(2);
juiceSortSelect.value = watchlistJuiceSortExpiration;
marketJuiceSortSelect.value = marketJuiceSortExpiration;
marketCapSelect.value = String(minimumMarketCapBillions);
dropPercentSelect.value = String(minimumDropPercent);

if (!marketCapSelect.value) {
  minimumMarketCapBillions = 10;
  marketCapSelect.value = '10';
}
if (!dropPercentSelect.value) {
  minimumDropPercent = 10;
  dropPercentSelect.value = '10';
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[character]));

const money = (value) => value == null || Number.isNaN(Number(value)) ? '—' : `$${Number(value).toFixed(2)}`;

const marketCap = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number >= 1e12) return `$${(number / 1e12).toFixed(2)}T`;
  return `$${(number / 1e9).toFixed(1)}B`;
};

const signedPercent = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
};

const signedMoney = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : '-'}$${Math.abs(number).toFixed(2)}`;
};

const movingDistance = (price, average) => {
  if (!price || !average) return '—';
  return `${money(Math.abs(price - average))} / ${signedPercent(((price - average) / average) * 100)}`;
};

const movingClass = (price, average) => !price || !average ? '' : price >= average ? 'positive' : 'negative';

const downsideClass = (stockPrice, strike) => Number(strike) <= Number(stockPrice) ? '' : 'negative';

const strikeDistance = (stockPrice, strike) => {
  if (!stockPrice || !strike) return { label: '—' };
  const percent = ((Number(stockPrice) - Number(strike)) / Number(stockPrice)) * 100;
  return { label: `${Math.abs(percent).toFixed(2)}% ${percent >= 0 ? 'below' : 'above'}` };
};

const optionJuice = (stock, expirationKey) => {
  const option = stock?.options?.[expirationKey]?.puts?.middle;
  if (!stock?.price || !option?.strike || !option?.premium) return null;
  const premiumYield = option.premium / option.strike;
  const strikeDistanceRatio = Math.abs((stock.price - option.strike) / stock.price);
  const score = (premiumYield * (2 / 3)) + (strikeDistanceRatio * (1 / 3));
  return option.strike > stock.price ? -score : score;
};

const juiceCell = (stock, expirationKey) => {
  const option = stock?.options?.[expirationKey]?.puts?.middle;
  const juice = optionJuice(stock, expirationKey);
  if (juice == null) return '<span>—</span><small>No rank</small>';
  const distance = strikeDistance(stock.price, option.strike);
  const juiceClass = juice < 0 ? 'negative' : '';
  return `<span class="${juiceClass}">${(juice * 100).toFixed(2)}%</span><small class="${downsideClass(stock.price, option.strike)}">${money(option.premium)} · ${distance.label}</small>`;
};

const earningsCell = (earnings) => {
  if (!earnings?.date) return '<span>—</span><small>No date available</small>';
  const [year, month, day] = earnings.date.split('-').map(Number);
  const earningsDate = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((earningsDate - today) / 86400000);
  const formattedDate = earningsDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
  const timing = daysUntil === 0
    ? 'Today'
    : daysUntil === 1
      ? 'Tomorrow'
      : daysUntil > 1
        ? `${daysUntil} days`
        : `${Math.abs(daysUntil)} days ago`;
  const status = earnings.isEstimate ? `Estimated · ${timing}` : timing;
  const urgencyClass = daysUntil >= 0 && daysUntil <= 14 ? 'negative' : 'positive';
  return `<span class="${urgencyClass}">${escapeHtml(formattedDate)}</span><small>${escapeHtml(status)}</small>`;
};

const rowOption = (option, stockPrice) => {
  const distance = strikeDistance(stockPrice, option.strike);
  return `<div class="put-line">
    <span class="option-main"><b>${money(option.premium)}</b><em>/</em>${money(option.strike)}</span>
    <span class="option-underlying ${downsideClass(stockPrice, option.strike)}">Spot ${money(stockPrice)} · ${distance.label}</span>
    <span class="option-stats">V ${Number(option.volume || 0).toLocaleString()} · OI ${Number(option.openInterest || 0).toLocaleString()} · IV ${signedPercent(Number(option.impliedVolatility || 0) * 100)} · R ${Number(option.ratio || 0).toFixed(2)}%</span>
  </div>`;
};

const rowOptions = (puts, stockPrice) => puts?.middle
  ? rowOption(puts.middle, stockPrice)
  : '<span class="option-empty">No qualifying put</span>';

const metricGroupCell = (stock, periods) => `<td class="metric-cell metric-group-cell">
  <div class="metric-group">
    ${periods.map((period) => {
      const average = stock[`moving${period}`];
      return `<div class="metric-line"><b>MA ${period}</b><span class="${movingClass(stock.price, average)}">${money(average)}</span><small>${movingDistance(stock.price, average)}</small></div>`;
    }).join('')}
  </div>
</td>`;

const rowTemplate = (stock) => {
  const nextOptions = stock.options?.nextFriday || {};
  const followingOptions = stock.options?.followingFriday || {};
  const changeClass = Number(stock.change) >= 0 ? 'positive' : 'negative';
  const safeSymbol = escapeHtml(stock.symbol);

  return `<tr>
    <td class="stock-cell"><strong>${safeSymbol}</strong><span title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span><div class="stock-earnings"><b>Earnings</b>${earningsCell(stock.nextEarnings)}</div></td>
    <td class="price-cell"><span class="${changeClass}">${money(stock.price)}</span><small class="${changeClass}">${signedMoney(stock.priceChange)} / ${signedPercent(stock.change)}</small></td>
    <td class="option-cell">${rowOptions(nextOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'nextFriday')}</td>
    <td class="option-cell">${rowOptions(followingOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'followingFriday')}</td>
    ${metricGroupCell(stock, [15, 30, 50])}
    ${metricGroupCell(stock, [90, 120])}
    <td class="remove-cell"><button class="remove" data-symbol="${safeSymbol}" title="Remove ${safeSymbol}" aria-label="Remove ${safeSymbol}">×</button></td>
  </tr>`;
};

const marketLoserRowTemplate = (stock) => {
  const nextOptions = stock.options?.nextFriday || {};
  const followingOptions = stock.options?.followingFriday || {};
  const safeSymbol = escapeHtml(stock.symbol);

  return `<tr>
    <td class="stock-cell"><strong>${safeSymbol}</strong><span title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span><div class="stock-earnings"><b>Earnings</b>${earningsCell(stock.nextEarnings)}</div></td>
    <td class="price-cell"><span class="negative">${money(stock.price)}</span><small class="negative">${signedMoney(stock.priceChange)} / ${signedPercent(stock.change)}</small></td>
    <td class="market-cap-cell"><span>${marketCap(stock.marketCap)}</span><small>Minimum $${minimumMarketCapBillions}B</small></td>
    <td class="option-cell">${rowOptions(nextOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'nextFriday')}</td>
    <td class="option-cell">${rowOptions(followingOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'followingFriday')}</td>
    ${metricGroupCell(stock, [15, 30, 50])}
    ${metricGroupCell(stock, [90, 120])}
  </tr>`;
};

function renderLoading(symbol) {
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${escapeHtml(symbol)}">
    <td class="stock-cell"><strong>${escapeHtml(symbol)}</strong><span>Scanning market data…</span></td>
    <td colspan="7"><div class="loading-bar"></div></td><td></td>
  </tr>`);
}

function compareByJuice(left, right, expirationKey) {
  const leftJuice = optionJuice(left, expirationKey);
  const rightJuice = optionJuice(right, expirationKey);
  if (leftJuice == null && rightJuice == null) return 0;
  if (leftJuice == null) return 1;
  if (rightJuice == null) return -1;
  return rightJuice - leftJuice;
}

function renderResults(results) {
  const stocks = results
    .filter((result) => result.data)
    .map((result) => result.data)
    .sort((left, right) => compareByJuice(left, right, watchlistJuiceSortExpiration));
  const errors = results.filter((result) => result.error);

  list.innerHTML = [
    ...stocks.map(rowTemplate),
    ...errors.map((result) => `<tr class="error-row"><td colspan="9">${escapeHtml(result.symbol)}: ${escapeHtml(result.error)}. Check the ticker and refresh.</td></tr>`),
  ].join('');
}

function renderMarketLosers(stocks, error = '') {
  const expirationLabel = marketJuiceSortExpiration === 'followingFriday' ? 'second' : 'first';
  marketLosersEmptyMessage.textContent = `No stocks with a market cap of at least $${minimumMarketCapBillions}B are currently down more than ${minimumDropPercent}% with a ${expirationLabel}-expiration option return above ${minimumOptionReturnPercent.toFixed(2)}%.`;
  if (error) {
    latestMarketLosers = [];
    marketLosersList.innerHTML = `<tr class="error-row"><td colspan="9">Daily-drop scan: ${escapeHtml(error)}. Try refreshing.</td></tr>`;
    marketLosersEmpty.hidden = true;
    marketLosersCount.textContent = 'Scan unavailable';
    return;
  }

  latestMarketLosers = [...stocks];
  const rankedStocks = stocks
    .filter((stock) => {
      const option = stock.options?.[marketJuiceSortExpiration]?.puts?.middle;
      return option && Number(option.ratio) > minimumOptionReturnPercent;
    })
    .sort((left, right) => compareByJuice(left, right, marketJuiceSortExpiration))
    .slice(0, 10);
  marketLosersList.innerHTML = rankedStocks.map(marketLoserRowTemplate).join('');
  marketLosersEmpty.hidden = rankedStocks.length > 0;
  marketLosersCount.textContent = `${rankedStocks.length} ${rankedStocks.length === 1 ? 'match' : 'matches'} today`;
}

async function loadMarketLosers() {
  const sequence = ++marketLosersRequestSequence;
  marketLosersList.innerHTML = `<tr class="loading">
    <td class="stock-cell"><strong>TOP 10</strong><span>Scanning daily declines...</span></td>
    <td colspan="8"><div class="loading-bar"></div></td>
  </tr>`;
  marketLosersEmpty.hidden = true;
  marketLosersCount.textContent = 'Scanning market...';
  marketLosersShell.setAttribute('aria-busy', 'true');

  const query = new URLSearchParams({
    target: String(targetPercent),
    marketCapBillions: String(minimumMarketCapBillions),
    dropPercent: String(minimumDropPercent),
    rankExpiration: marketJuiceSortExpiration,
  });

  try {
    const response = await fetch(`/api/market-losers?${query}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Market feed returned no data');
    if (sequence !== marketLosersRequestSequence) return;
    renderMarketLosers(Array.isArray(data.stocks) ? data.stocks : []);
  } catch (error) {
    if (sequence !== marketLosersRequestSequence) return;
    renderMarketLosers([], error.message);
  } finally {
    if (sequence === marketLosersRequestSequence) {
      marketLosersShell.setAttribute('aria-busy', 'false');
    }
  }
}

function setLoading(isLoading) {
  refreshButton.classList.toggle('is-loading', isLoading);
  refreshButton.disabled = isLoading;
  document.querySelector('.table-shell').setAttribute('aria-busy', String(isLoading));
}

function updateCounts() {
  count.textContent = `${symbols.length} ${symbols.length === 1 ? 'stock' : 'stocks'}`;
}

async function loadAll() {
  const sequence = ++requestSequence;
  latestResults = [];
  list.innerHTML = '';
  emptyState.hidden = symbols.length > 0;
  updateCounts();

  setLoading(true);
  symbols.forEach(renderLoading);

  const watchlistRequest = Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&target=${targetPercent}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Market feed returned no data');
      return { symbol, data };
    } catch (error) {
      return { symbol, error: error.message };
    }
  }));

  const marketLosersRequest = loadMarketLosers();

  const [results] = await Promise.all([watchlistRequest, marketLosersRequest]);

  if (sequence !== requestSequence) return;
  latestResults = results;
  renderResults(results);
  const refreshedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  lastRefresh.textContent = refreshedAt;
  setLoading(false);
}

document.querySelector('#add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const symbol = input.value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  if (!symbol || symbols.includes(symbol)) {
    input.value = '';
    return;
  }
  symbols.push(symbol);
  localStorage.setItem(storageKey, JSON.stringify(symbols));
  input.value = '';
  loadAll();
});

list.addEventListener('click', (event) => {
  const button = event.target.closest('.remove');
  if (!button) return;
  symbols = symbols.filter((symbol) => symbol !== button.dataset.symbol);
  localStorage.setItem(storageKey, JSON.stringify(symbols));
  loadAll();
});

refreshButton.addEventListener('click', loadAll);
targetSelect.addEventListener('change', () => {
  targetPercent = Number(targetSelect.value);
  localStorage.setItem(targetStorageKey, targetPercent.toFixed(2));
  loadAll();
});

marketCapSelect.addEventListener('change', () => {
  minimumMarketCapBillions = Number(marketCapSelect.value);
  localStorage.setItem(marketCapStorageKey, String(minimumMarketCapBillions));
  loadMarketLosers();
});

dropPercentSelect.addEventListener('change', () => {
  minimumDropPercent = Number(dropPercentSelect.value);
  localStorage.setItem(dropPercentStorageKey, String(minimumDropPercent));
  loadMarketLosers();
});

juiceSortSelect.addEventListener('change', () => {
  watchlistJuiceSortExpiration = juiceSortSelect.value;
  localStorage.setItem(juiceSortStorageKey, watchlistJuiceSortExpiration);
  if (latestResults.length) renderResults(latestResults);
});

marketJuiceSortSelect.addEventListener('change', () => {
  marketJuiceSortExpiration = marketJuiceSortSelect.value;
  localStorage.setItem(marketJuiceSortStorageKey, marketJuiceSortExpiration);
  loadMarketLosers();
});

loadAll();

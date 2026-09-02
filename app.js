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

const storageKey = 'stockoption-watchlist';
const targetStorageKey = 'stockoption-target-percent';
const juiceSortStorageKey = 'stockoption-juice-sort-expiration';
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
let juiceSortExpiration = localStorage.getItem(juiceSortStorageKey) === 'followingFriday'
  ? 'followingFriday'
  : 'nextFriday';
let requestSequence = 0;
let latestResults = [];

const nextFriday = new Date();
const daysToFriday = (5 - nextFriday.getDay() + 7) % 7 || 7;
nextFriday.setDate(nextFriday.getDate() + daysToFriday);
const followingFriday = new Date(nextFriday);
followingFriday.setDate(followingFriday.getDate() + 7);
const formatFriday = (date) => `${date.toLocaleDateString('en-US', { month: 'short' })} ${String(date.getDate()).padStart(2, '0')}`;
document.querySelector('#next-friday-date').textContent = formatFriday(nextFriday);
document.querySelector('#following-friday-date').textContent = formatFriday(followingFriday);

for (let value = 0.1; value <= 5; value += 0.1) {
  const percent = value.toFixed(2);
  targetSelect.insertAdjacentHTML('beforeend', `<option value="${percent}">${percent}%</option>`);
}

targetSelect.value = targetPercent.toFixed(2);
juiceSortSelect.value = juiceSortExpiration;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[character]));

const money = (value) => value == null || Number.isNaN(Number(value)) ? '—' : `$${Number(value).toFixed(2)}`;

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

const optionJuice = (stock, expirationKey) => {
  const option = stock?.options?.[expirationKey]?.puts?.middle;
  if (!stock?.price || !option?.strike || !option?.premium) return null;
  const premiumYield = option.premium / option.strike;
  const downsideCushion = Math.max((stock.price - option.strike) / stock.price, 0);
  return (premiumYield * (2 / 3)) + (downsideCushion * (1 / 3));
};

const juiceCell = (stock, expirationKey) => {
  const option = stock?.options?.[expirationKey]?.puts?.middle;
  const juice = optionJuice(stock, expirationKey);
  if (juice == null) return '<span>—</span><small>No rank</small>';
  const downsideCushion = Math.max(((stock.price - option.strike) / stock.price) * 100, 0);
  return `<span>${(juice * 100).toFixed(2)}%</span><small>${money(option.premium)} · ${downsideCushion.toFixed(2)}% below</small>`;
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
  const downside = Math.max(((stockPrice - option.strike) / stockPrice) * 100, 0).toFixed(2);
  return `<div class="put-line">
    <span class="option-main"><b>${money(option.premium)}</b><em>/</em>${money(option.strike)}</span>
    <span class="option-underlying">Spot ${money(stockPrice)} · ${downside}% below</span>
    <span class="option-stats">V ${Number(option.volume || 0).toLocaleString()} · OI ${Number(option.openInterest || 0).toLocaleString()} · IV ${signedPercent(Number(option.impliedVolatility || 0) * 100)} · R ${Number(option.ratio || 0).toFixed(2)}%</span>
  </div>`;
};

const rowOptions = (puts, stockPrice) => puts?.middle
  ? rowOption(puts.middle, stockPrice)
  : '<span class="option-empty">No qualifying put</span>';

const metricCell = (stock, period) => {
  const average = stock[`moving${period}`];
  return `<td class="metric-cell"><span class="${movingClass(stock.price, average)}">${money(average)}</span><small>${movingDistance(stock.price, average)}</small></td>`;
};

const rowTemplate = (stock) => {
  const nextOptions = stock.options?.nextFriday || {};
  const followingOptions = stock.options?.followingFriday || {};
  const changeClass = Number(stock.change) >= 0 ? 'positive' : 'negative';
  const safeSymbol = escapeHtml(stock.symbol);

  return `<tr>
    <td class="stock-cell"><strong>${safeSymbol}</strong><span title="${escapeHtml(stock.name)}">${escapeHtml(stock.name)}</span></td>
    <td class="price-cell"><span class="${changeClass}">${money(stock.price)}</span><small class="${changeClass}">${signedMoney(stock.priceChange)} / ${signedPercent(stock.change)}</small></td>
    <td class="option-cell">${rowOptions(nextOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'nextFriday')}</td>
    <td class="metric-cell earnings-cell">${earningsCell(stock.nextEarnings)}</td>
    <td class="option-cell">${rowOptions(followingOptions.puts, stock.price)}</td>
    <td class="juice-cell">${juiceCell(stock, 'followingFriday')}</td>
    ${[15, 30, 50, 70, 90, 100, 120].map((period) => metricCell(stock, period)).join('')}
    <td class="remove-cell"><button class="remove" data-symbol="${safeSymbol}" title="Remove ${safeSymbol}" aria-label="Remove ${safeSymbol}">×</button></td>
  </tr>`;
};

function renderLoading(symbol) {
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${escapeHtml(symbol)}">
    <td class="stock-cell"><strong>${escapeHtml(symbol)}</strong><span>Scanning market data…</span></td>
    <td colspan="13"><div class="loading-bar"></div></td><td></td>
  </tr>`);
}

function compareByJuice(left, right) {
  const leftJuice = optionJuice(left, juiceSortExpiration);
  const rightJuice = optionJuice(right, juiceSortExpiration);
  if (leftJuice == null && rightJuice == null) return 0;
  if (leftJuice == null) return 1;
  if (rightJuice == null) return -1;
  return rightJuice - leftJuice;
}

function renderResults(results) {
  const stocks = results.filter((result) => result.data).map((result) => result.data).sort(compareByJuice);
  const errors = results.filter((result) => result.error);

  list.innerHTML = [
    ...stocks.map(rowTemplate),
    ...errors.map((result) => `<tr class="error-row"><td colspan="15">${escapeHtml(result.symbol)}: ${escapeHtml(result.error)}. Check the ticker and refresh.</td></tr>`),
  ].join('');
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

  if (!symbols.length) {
    setLoading(false);
    return;
  }

  setLoading(true);
  symbols.forEach(renderLoading);

  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&target=${targetPercent}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Market feed returned no data');
      return { symbol, data };
    } catch (error) {
      return { symbol, error: error.message };
    }
  }));

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

juiceSortSelect.addEventListener('change', () => {
  juiceSortExpiration = juiceSortSelect.value;
  localStorage.setItem(juiceSortStorageKey, juiceSortExpiration);
  if (latestResults.length) renderResults(latestResults);
});

loadAll();

const list = document.querySelector('#watchlist');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#watch-count');
const input = document.querySelector('#symbol-input');
const refreshButton = document.querySelector('#refresh');
const lastRefresh = document.querySelector('#last-refresh');
const targetSelect = document.querySelector('#target-select');
const storageKey = 'stockoption-watchlist';
const targetStorageKey = 'stockoption-target-percent';
let symbols = JSON.parse(localStorage.getItem(storageKey) || '["OKLO", "IREN", "ASTS", "INTC", "CBRS", "BE", "NVDA", "ALAB", "TSLA", "AAOI", "CRDO", "NBIS", "MRVL", "LUNR"]');
let targetPercent = Number(localStorage.getItem(targetStorageKey) || '1.00');

const nextFriday = new Date();
const daysToFriday = (5 - nextFriday.getDay() + 7) % 7 || 7;
nextFriday.setDate(nextFriday.getDate() + daysToFriday);
const followingFriday = new Date(nextFriday);
followingFriday.setDate(followingFriday.getDate() + 7);
const formatFriday = (date) => `${date.toLocaleDateString('en-US', { month: 'short' })}-${String(date.getDate()).padStart(2, '0')}`;
document.querySelector('#next-friday-date').textContent = formatFriday(nextFriday);
document.querySelector('#following-friday-date').textContent = formatFriday(followingFriday);

for (let value = 0.1; value <= 5; value += 0.1) {
  const percent = value.toFixed(2);
  targetSelect.insertAdjacentHTML('beforeend', `<option value="${percent}">${percent}%</option>`);
}
targetSelect.value = targetPercent.toFixed(2);

const money = (value) => value == null ? '—' : `$${Number(value).toFixed(2)}`;
const signedPercent = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
};
const movingDistance = (price, average) => {
  if (!price || !average) return '—';
  return `${money(Math.abs(price - average))} / ${signedPercent(((price - average) / average) * 100)}`;
};
const movingClass = (price, average) => !price || !average ? '' : price >= average ? 'positive' : 'negative';
const nextFridayJuice = (stock) => {
  const option = stock?.options?.nextFriday?.puts?.middle;
  if (!stock?.price || !option?.strike || !option?.premium) return null;
  const premiumYield = option.premium / option.strike;
  const downsideCushion = Math.max((stock.price - option.strike) / stock.price, 0);
  return (premiumYield * (2 / 3)) + (downsideCushion * (1 / 3));
};
const juiceCell = (stock) => {
  const option = stock?.options?.nextFriday?.puts?.middle;
  const juice = nextFridayJuice(stock);
  if (juice == null) return '<span>—</span><small>No rank</small>';
  const premiumYield = option.premium;
  const downsideCushion = Math.max(((stock.price - option.strike) / stock.price) * 100, 0);
  return `<span>${(juice * 100).toFixed(2)}%</span><small>${premiumYield.toFixed(2)}% * ${downsideCushion.toFixed(1)}% away</small>`;
};
const rowOption = (option, stockPrice) => `<div class="put-line"><span class="option-main"><b>${money(option.premium)}</b><em>/</em>${money(option.strike)}</span><span class="option-underlying">// ${money(stockPrice)} // ${signedPercent(((stockPrice - option.strike) / option.strike) * 100)} away</span><span class="option-stats">V ${Number(option.volume).toLocaleString()} · OI ${Number(option.openInterest).toLocaleString()} · IV ${signedPercent(option.impliedVolatility * 100)} · R ${Number(option.ratio).toFixed(2)}%</span></div>`;
const rowOptions = (puts, stockPrice) => {
  return puts?.middle ? rowOption(puts.middle, stockPrice) : '<span class="option-empty">No qualifying put</span>';
};
const rowTemplate = (stock) => {
  const options = stock.options || {};
  const nextFriday = options.nextFriday || {};
  const followingFriday = options.followingFriday || {};
  const changeClass = stock.change >= 0 ? 'positive' : 'negative';
  return `<tr>
    <td class="stock-cell"><strong>${stock.symbol}</strong><span>${stock.name}</span></td>
      <td class="price-cell"><span class="${changeClass}">${money(stock.price)}</span><small class="${changeClass}">${signedPercent(stock.change)}</small></td>
      <td class="option-cell">${rowOptions(nextFriday.puts, stock.price)}</td>
      <td class="juice-cell">${juiceCell(stock)}</td>
      <td class="option-cell">${rowOptions(followingFriday.puts, stock.price)}</td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving15)}">${money(stock.moving15)}</span><small>${movingDistance(stock.price, stock.moving15)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving30)}">${money(stock.moving30)}</span><small>${movingDistance(stock.price, stock.moving30)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving50)}">${money(stock.moving50)}</span><small>${movingDistance(stock.price, stock.moving50)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving70)}">${money(stock.moving70)}</span><small>${movingDistance(stock.price, stock.moving70)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving90)}">${money(stock.moving90)}</span><small>${movingDistance(stock.price, stock.moving90)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving100)}">${money(stock.moving100)}</span><small>${movingDistance(stock.price, stock.moving100)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving120)}">${money(stock.moving120)}</span><small>${movingDistance(stock.price, stock.moving120)}</small></td>
    <td class="remove-cell"><button class="remove" data-symbol="${stock.symbol}" title="Remove ${stock.symbol}" aria-label="Remove ${stock.symbol}">×</button></td>
  </tr>`;
};

function renderLoading(symbol) {
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${symbol}"><td class="stock-cell"><strong>${symbol}</strong><span>Loading market data...</span></td><td colspan="11"><div class="loading-bar"></div></td><td></td></tr>`);
}

async function loadSymbol(symbol) {
  renderLoading(symbol);
  try {
    const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&target=${targetPercent}`);
    const data = await response.json();
    const loading = list.querySelector(`[data-loading="${symbol}"]`);
    if (!response.ok || data.error) throw new Error(data.error || 'Yahoo Finance returned no data');
    loading.outerHTML = rowTemplate(data);
  } catch (error) {
    const loading = list.querySelector(`[data-loading="${symbol}"]`);
    if (loading) loading.outerHTML = `<tr class="error-row"><td colspan="13">${symbol}: ${error.message}. Check the ticker and refresh.</td></tr>`;
  }
}

async function loadAll() {
  list.innerHTML = '';
  emptyState.hidden = symbols.length > 0;
  count.textContent = `${symbols.length} ${symbols.length === 1 ? 'stk' : 'stks'}`;
  if (!symbols.length) return;
  symbols.forEach(renderLoading);
  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&target=${targetPercent}`);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Yahoo Finance returned no data');
      return { symbol, data };
    } catch (error) {
      return { symbol, error: error.message };
    }
  }));
  results.sort((left, right) => {
    const leftJuice = nextFridayJuice(left.data);
    const rightJuice = nextFridayJuice(right.data);
    if (leftJuice == null && rightJuice == null) return 0;
    if (leftJuice == null) return 1;
    if (rightJuice == null) return -1;
    return rightJuice - leftJuice;
  });
  list.innerHTML = results.map((result) => result.data
    ? rowTemplate(result.data)
    : `<tr class="error-row"><td colspan="13">${result.symbol}: ${result.error}. Check the ticker and refresh.</td></tr>`
  ).join('');
  lastRefresh.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

document.querySelector('#add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const symbol = input.value.trim().toUpperCase();
  if (!symbol || symbols.includes(symbol)) { input.value = ''; return; }
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
loadAll();

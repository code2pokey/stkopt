const list = document.querySelector('#watchlist');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#watch-count');
const input = document.querySelector('#symbol-input');
const refreshButton = document.querySelector('#refresh');
const lastRefresh = document.querySelector('#last-refresh');
const targetSelect = document.querySelector('#target-select');
const storageKey = 'stockoption-watchlist';
const targetStorageKey = 'stockoption-target-percent';
let symbols = JSON.parse(localStorage.getItem(storageKey) || '["OLO", "IREN", "ASTS", "INTC", "CBRS", "BE", "NVDA", "ALAB", "TSLA", "AAOI", "CRDO", "NBIS"]');
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
const rowOption = (option, stockPrice) => option ? `<div class="option-main"><b>${money(option.premium)}</b><em>/</em>${money(option.strike)}</div><span class="option-underlying">// ${money(stockPrice)} // ${signedPercent(((stockPrice - option.strike) / option.strike) * 100)} away</span><span class="option-change ${option.change >= 0 ? 'positive' : 'negative'}">${signedPercent(option.change)} day</span>` : '<span class="option-empty">No chain</span>';
const rowTemplate = (stock) => {
  const options = stock.options || {};
  const nextFriday = options.nextFriday || {};
  const followingFriday = options.followingFriday || {};
  const changeClass = stock.change >= 0 ? 'positive' : 'negative';
  return `<tr>
    <td class="stock-cell"><strong>${stock.symbol}</strong><span>${stock.name}</span><div class="stock-price"><span class="positive">${money(stock.price)}</span> <small class="${changeClass}">${signedPercent(stock.change)}</small></div></td>
      <td class="option-cell">${rowOption(nextFriday.puts, stock.price)}</td>
      <td class="option-cell">${rowOption(followingFriday.puts, stock.price)}</td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving15)}">${money(stock.moving15)}</span><small class="${movingClass(stock.price, stock.moving15)}">${movingDistance(stock.price, stock.moving15)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving30)}">${money(stock.moving30)}</span><small class="${movingClass(stock.price, stock.moving30)}">${movingDistance(stock.price, stock.moving30)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving50)}">${money(stock.moving50)}</span><small class="${movingClass(stock.price, stock.moving50)}">${movingDistance(stock.price, stock.moving50)}</small></td>
      <td class="metric-cell"><span class="${movingClass(stock.price, stock.moving100)}">${money(stock.moving100)}</span><small class="${movingClass(stock.price, stock.moving100)}">${movingDistance(stock.price, stock.moving100)}</small></td>
    <td class="remove-cell"><button class="remove" data-symbol="${stock.symbol}" title="Remove ${stock.symbol}" aria-label="Remove ${stock.symbol}">×</button></td>
  </tr>`;
};

function renderLoading(symbol) {
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${symbol}"><td class="stock-cell"><strong>${symbol}</strong><span>Loading market data...</span></td><td colspan="6"><div class="loading-bar"></div></td><td></td></tr>`);
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
    if (loading) loading.outerHTML = `<tr class="error-row"><td colspan="8">${symbol}: ${error.message}. Check the ticker and refresh.</td></tr>`;
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
    const leftStrike = left.data?.options?.nextFriday?.puts?.strike;
    const rightStrike = right.data?.options?.nextFriday?.puts?.strike;
    if (leftStrike == null && rightStrike == null) return 0;
    if (leftStrike == null) return 1;
    if (rightStrike == null) return -1;
    return leftStrike - rightStrike;
  });
  list.innerHTML = results.map((result) => result.data
    ? rowTemplate(result.data)
    : `<tr class="error-row"><td colspan="8">${result.symbol}: ${result.error}. Check the ticker and refresh.</td></tr>`
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

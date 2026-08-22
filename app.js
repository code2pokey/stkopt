const list = document.querySelector('#watchlist');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#watch-count');
const input = document.querySelector('#symbol-input');
const refreshButton = document.querySelector('#refresh');
const lastRefresh = document.querySelector('#last-refresh');
const storageKey = 'stockoption-watchlist';
let symbols = JSON.parse(localStorage.getItem(storageKey) || '["AAPL", "MSFT", "NVDA"]');

const money = (value) => value == null ? '—' : `$${Number(value).toFixed(2)}`;
const signedPercent = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
};
const rowOption = (option) => option ? `<div class="option-main"><b>${money(option.premium)}</b><em>/</em>${money(option.strike)}</div><span class="option-change ${option.change >= 0 ? 'positive' : 'negative'}">${signedPercent(option.change)} day</span>` : '<span class="option-empty">No chain</span>';
const rowTemplate = (stock) => {
  const options = stock.options || {};
  const seven = options['7'] || {};
  const fourteen = options['14'] || {};
  const changeClass = stock.change >= 0 ? 'positive' : 'negative';
  return `<tr>
    <td class="stock-cell"><strong>${stock.symbol}</strong><span>${stock.name}</span><div class="stock-price">${money(stock.price)} <small class="${changeClass}">${signedPercent(stock.change)}</small></div></td>
    <td class="option-cell">${rowOption(seven.puts)}</td>
    <td class="option-cell">${rowOption(fourteen.puts)}</td>
    <td class="metric-cell">${stock.earnings || '—'}<small>next report</small></td>
    <td class="metric-cell">${money(stock.moving50)}<small>${stock.price && stock.moving50 ? (stock.price >= stock.moving50 ? 'above' : 'below') : '—'} price</small></td>
    <td class="metric-cell">${money(stock.moving100)}<small>${stock.price && stock.moving100 ? (stock.price >= stock.moving100 ? 'above' : 'below') : '—'} price</small></td>
    <td class="remove-cell"><button class="remove" data-symbol="${stock.symbol}" title="Remove ${stock.symbol}" aria-label="Remove ${stock.symbol}">×</button></td>
  </tr>`;
};

function renderLoading(symbol) {
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${symbol}"><td class="stock-cell"><strong>${symbol}</strong><span>Loading market data...</span></td><td colspan="5"><div class="loading-bar"></div></td><td></td></tr>`);
}

async function loadSymbol(symbol) {
  renderLoading(symbol);
  try {
    const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}`);
    const data = await response.json();
    const loading = list.querySelector(`[data-loading="${symbol}"]`);
    if (!response.ok || data.error) throw new Error(data.error || 'Yahoo Finance returned no data');
    loading.outerHTML = rowTemplate(data);
  } catch (error) {
    const loading = list.querySelector(`[data-loading="${symbol}"]`);
    if (loading) loading.outerHTML = `<tr class="error-row"><td colspan="7">${symbol}: ${error.message}. Check the ticker and refresh.</td></tr>`;
  }
}

async function loadAll() {
  list.innerHTML = '';
  emptyState.hidden = symbols.length > 0;
  count.textContent = `${symbols.length} ${symbols.length === 1 ? 'stock' : 'stocks'}`;
  if (!symbols.length) return;
  symbols.forEach(renderLoading);
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}`);
      const data = await response.json();
      const loading = list.querySelector(`[data-loading="${symbol}"]`);
      if (!response.ok || data.error) throw new Error(data.error || 'Yahoo Finance returned no data');
      loading.outerHTML = rowTemplate(data);
    } catch (error) {
      const loading = list.querySelector(`[data-loading="${symbol}"]`);
      if (loading) loading.outerHTML = `<tr class="error-row"><td colspan="7">${symbol}: ${error.message}. Check the ticker and refresh.</td></tr>`;
    }
  }));
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
loadAll();

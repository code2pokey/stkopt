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

initializeGoogleAnalytics();

function initializeKofiButton() {
  const container = document.createElement('div');
  container.id = 'kofi-support-button';
  container.setAttribute('aria-label', 'Support this site on Ko-fi');
  Object.assign(container.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '1000',
  });
  document.body.appendChild(container);

  const script = document.createElement('script');
  script.src = 'https://storage.ko-fi.com/cdn/widget/Widget_2.js';
  script.onload = () => {
    window.kofiwidget2.init('Buy me a coffee ☕', '#72a4f2', 'S6G525XNFX');
    container.innerHTML = window.kofiwidget2.getHTML();
  };
  document.head.appendChild(script);
}

initializeKofiButton();

const list = document.querySelector('#watchlist');
const emptyState = document.querySelector('#empty-state');
const count = document.querySelector('#watch-count');
const input = document.querySelector('#symbol-input');
const refreshButton = document.querySelector('#refresh');
const lastRefresh = document.querySelector('#last-refresh');
const targetSelect = document.querySelector('#target-select');
const targetControl = targetSelect.closest('label') || targetSelect;
const storageKey = 'stockoption-watchlist';
const targetStorageKey = 'stockoption-target-percent';
const juiceSortStorageKey = 'stockoption-juice-sort-expiration';
let symbols = JSON.parse(localStorage.getItem(storageKey) || '["OKLO", "IREN", "ASTS", "INTC", "CBRS", "BE", "NVDA", "ALAB", "TSLA", "AAOI", "CRDO", "NBIS", "MRVL", "LUNR"]');
let targetPercent = Number(localStorage.getItem(targetStorageKey) || '1.00');
let juiceSortExpiration = localStorage.getItem(juiceSortStorageKey) === 'followingFriday'
  ? 'followingFriday'
  : 'nextFriday';

const nextFriday = new Date();
const daysToFriday = (5 - nextFriday.getDay() + 7) % 7 || 7;
nextFriday.setDate(nextFriday.getDate() + daysToFriday);
const followingFriday = new Date(nextFriday);
followingFriday.setDate(followingFriday.getDate() + 7);
const formatFriday = (date) => `${date.toLocaleDateString('en-US', { month: 'short' })}-${String(date.getDate()).padStart(2, '0')}`;
document.querySelector('#next-friday-date').textContent = formatFriday(nextFriday);
document.querySelector('#following-friday-date').textContent = formatFriday(followingFriday);

const followingFridayHeader = document.querySelector('#following-friday-date').closest('th');
if (followingFridayHeader && !document.querySelector('#following-friday-juice-header')) {
  followingFridayHeader.insertAdjacentHTML('afterend', '<th id="following-friday-juice-header">Juice</th>');
}
const followingFridayJuiceHeader = document.querySelector('#following-friday-juice-header');
if (followingFridayJuiceHeader) followingFridayJuiceHeader.style.fontWeight = 'normal';

document.querySelectorAll('th').forEach((header) => {
  if (header.textContent.trim() === 'JUICE') header.textContent = 'Juice';
});

const sortControl = document.createElement('label');
sortControl.className = targetControl.className || '';
sortControl.innerHTML = `Sort by
  <select id="juice-sort-select" aria-label="Juice column used to sort stocks">
    <option value="nextFriday">First Juice</option>
    <option value="followingFriday">Second Juice</option>
  </select>`;
targetControl.insertAdjacentElement('afterend', sortControl);
const juiceSortSelect = document.querySelector('#juice-sort-select');
juiceSortSelect.value = juiceSortExpiration;
const targetControlStyle = window.getComputedStyle(targetControl);
const targetSelectStyle = window.getComputedStyle(targetSelect);
Object.assign(sortControl.style, {
  fontSize: '0.8rem',
  fontWeight: targetControlStyle.fontWeight,
  lineHeight: targetControlStyle.lineHeight,
});
Object.assign(juiceSortSelect.style, {
  boxSizing: targetSelectStyle.boxSizing,
  width: `${targetSelect.getBoundingClientRect().width}px`,
  height: `${targetSelect.getBoundingClientRect().height}px`,
  padding: targetSelectStyle.padding,
  fontSize: '0.8rem',
  fontWeight: targetSelectStyle.fontWeight,
  lineHeight: targetSelectStyle.lineHeight,
});

const juiceNote = document.createElement('aside');
juiceNote.id = 'juice-note';
juiceNote.setAttribute('role', 'note');
juiceNote.innerHTML = '<strong>About Juice:</strong> Juice is a comparison score that weights put-premium yield (two-thirds) and downside cushion (one-third). It is a screening aid based on available market data, not financial advice. Always verify quotes and evaluate the risks before trading.<br><strong>Your ticker list:</strong> Tickers are stored locally in this browser, so your list persists between visits but does not sync or refresh across browsers or devices. Clearing this site\'s browser data will reset the list. Market quotes refresh separately.';
Object.assign(juiceNote.style, {
  margin: '0',
  padding: '10px 12px',
  borderLeft: '3px solid #72a4f2',
  fontSize: '0.8rem',
  lineHeight: '1.45',
  flex: '1 1 480px',
});
const juiceInfoRow = document.createElement('div');
juiceInfoRow.id = 'juice-info-row';
Object.assign(juiceInfoRow.style, {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '16px',
  flexWrap: 'wrap',
  margin: '12px 0',
});
const juiceControls = document.createElement('div');
juiceControls.id = 'juice-controls';
Object.assign(juiceControls.style, {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '6px',
  flex: '0 0 auto',
});
targetControl.insertAdjacentElement('beforebegin', juiceInfoRow);
juiceControls.append(targetControl, sortControl);
juiceInfoRow.append(juiceControls, juiceNote);

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
  return `<span>${(juice * 100).toFixed(2)}%</span><small>${money(option.premium)} * ${downsideCushion.toFixed(1)}% below</small>`;
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
      <td class="price-cell"><span class="${changeClass}">${money(stock.price)}</span><small class="${changeClass}">${signedMoney(stock.priceChange)} / ${signedPercent(stock.change)}</small></td>
      <td class="option-cell">${rowOptions(nextFriday.puts, stock.price)}</td>
      <td class="juice-cell">${juiceCell(stock, 'nextFriday')}</td>
      <td class="option-cell">${rowOptions(followingFriday.puts, stock.price)}</td>
      <td class="juice-cell">${juiceCell(stock, 'followingFriday')}</td>
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
  list.insertAdjacentHTML('beforeend', `<tr class="loading" data-loading="${symbol}"><td class="stock-cell"><strong>${symbol}</strong><span>Loading market data...</span></td><td colspan="12"><div class="loading-bar"></div></td><td></td></tr>`);
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
    if (loading) loading.outerHTML = `<tr class="error-row"><td colspan="14">${symbol}: ${error.message}. Check the ticker and refresh.</td></tr>`;
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
    const leftJuice = optionJuice(left.data, juiceSortExpiration);
    const rightJuice = optionJuice(right.data, juiceSortExpiration);
    if (leftJuice == null && rightJuice == null) return 0;
    if (leftJuice == null) return 1;
    if (rightJuice == null) return -1;
    return rightJuice - leftJuice;
  });
  list.innerHTML = results.map((result) => result.data
    ? rowTemplate(result.data)
    : `<tr class="error-row"><td colspan="14">${result.symbol}: ${result.error}. Check the ticker and refresh.</td></tr>`
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
juiceSortSelect.addEventListener('change', () => {
  juiceSortExpiration = juiceSortSelect.value;
  localStorage.setItem(juiceSortStorageKey, juiceSortExpiration);
  loadAll();
});
loadAll();

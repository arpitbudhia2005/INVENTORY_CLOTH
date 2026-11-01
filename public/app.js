const token = localStorage.getItem('kc_token');
if (!token) location.href = '/login.html';
const $ = id => document.getElementById(id);
const SZ = { S: 'Small', M: 'Medium', L: 'Large' };
const money = n => '₹' + Number(n).toFixed(2);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function logout() { localStorage.removeItem('kc_token'); location.href = '/login.html'; }

async function api(url, opt = {}) {
  const r = await fetch('/api' + url, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opt.body ? JSON.stringify(opt.body) : undefined });
  if (r.status === 401) { logout(); throw new Error('Signed out'); }
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

let products = [], stats = null, cart = [];
const charts = {};
const PAL = ['#7c3aed', '#c9b8ff', '#9d6bff', '#4c2a99', '#e0d4ff', '#6d5bd0', '#3b2a73'];

/* ---------- navigation ---------- */
$('nav').onclick = e => {
  const v = e.target.dataset.v; if (!v) return;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b === e.target));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === v));
  if (v === 'sales') loadSales();
};

async function refresh() {
  [products, stats] = await Promise.all([api('/products'), api('/stats')]);
  drawDashboard(); drawInventory(); drawProductCards(); fillRefill();
}

/* ---------- charts ---------- */
Chart.defaults.color = '#9a8fc0';
Chart.defaults.borderColor = '#2e2354';
Chart.defaults.font.family = "'DM Sans', sans-serif";
function chart(id, type, labels, datasets, opts = {}) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), { type, data: { labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, ...opts } });
}

function drawDashboard() {
  const s = stats;
  $('kpis').innerHTML = [['Revenue', money(s.revenue)], ['Profit', money(s.profit)], ['Units sold', s.units], ['Bills made', s.bills]]
    .map(([a, b]) => `<div class="kpi"><span>${a}</span><b>${b}</b></div>`).join('') +
    `<div class="kpi ${s.lowCount ? 'warn' : ''}"><span>Low stock lines</span><b>${s.lowCount}</b></div>`;

  // season graph: units (bars) with revenue (line on second axis)
  const seasons = ['Summer', 'Monsoon', 'Winter', 'All-Season'];
  chart('cSeason', 'bar', seasons, [
    { label: 'Units sold', data: seasons.map(k => s.season[k]?.units || 0), backgroundColor: '#7c3aed', borderRadius: 3, yAxisID: 'y' },
    { label: 'Revenue (₹)', data: seasons.map(k => s.season[k]?.revenue || 0), type: 'line', borderColor: '#c9b8ff', backgroundColor: '#c9b8ff', tension: .3, yAxisID: 'y1' }
  ], { scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } } });

  const gk = ['Men', 'Women', 'Unisex'];
  chart('cGender', 'bar', gk, [
    { label: 'Units sold', data: gk.map(k => s.gender[k]?.units || 0), backgroundColor: '#7c3aed', borderRadius: 3 },
    { label: 'Units in stock', data: gk.map(k => s.stockByGender[k] || 0), backgroundColor: '#c9b8ff', borderRadius: 3 }
  ], { scales: { y: { beginAtZero: true } } });

  chart('cSize', 'bar', ['Small', 'Medium', 'Large'], [
    { label: 'Sold', data: ['S', 'M', 'L'].map(k => s.sizeSold[k]), backgroundColor: '#7c3aed', borderRadius: 3 },
    { label: 'In stock', data: ['S', 'M', 'L'].map(k => s.sizeStock[k]), backgroundColor: '#c9b8ff', borderRadius: 3 }
  ], { scales: { y: { beginAtZero: true } } });

  const ck = Object.keys(s.colour);
  chart('cColour', 'doughnut', ck, [{ data: ck.map(k => s.colour[k].units), backgroundColor: PAL, borderColor: '#16102a', borderWidth: 2 }],
    { plugins: { legend: { position: 'right' } }, cutout: '58%' });

  const cat = Object.keys(s.category);
  chart('cCat', 'bar', cat, [{ label: 'Units sold', data: cat.map(k => s.category[k].units), backgroundColor: '#9d6bff', borderRadius: 3 }],
    { indexAxis: 'y', plugins: { legend: { display: false } } });

  const max = Math.max(...s.topSelling.map(t => t.sold), 1);
  $('top').innerHTML = s.topSelling.map(t => `<div class="top"><img src="${t.image}" alt="${esc(t.name)}">
    <div class="n">${esc(t.name)}<div class="bar"><i style="width:${t.sold / max * 100}%"></i></div></div><b>${t.sold} sold</b></div>`).join('');

  $('lowHint').textContent = `Showing sizes with ${s.lowLimit} or fewer pieces left.`;
  $('low').innerHTML = ['S', 'M', 'L'].map(k => `<div><h4>${SZ[k]} (${s.low[k].length})</h4>` +
    (s.low[k].length ? s.low[k].map(i => `<div class="li"><span>${esc(i.name)} <small>${esc(i.colour)}</small></span><span class="${i.stock ? 'low' : 'zero'}">${i.stock ? i.stock + ' left' : 'Out'}</span></div>`).join('')
      : '<div class="empty">All good in this size.</div>') + '</div>').join('');
}

/* ---------- inventory ---------- */
function drawInventory() {
  const q = $('q').value.toLowerCase(), g = $('g').value;
  const cell = n => `<td class="${n === 0 ? 'zero' : n <= stats.lowLimit ? 'low' : ''}">${n}</td>`;
  $('invBody').innerHTML = products.filter(p => (!g || p.gender === g) && (p.name + p.colour + p.category).toLowerCase().includes(q))
    .map(p => `<tr><td><div class="cell"><img src="${p.image}" alt=""><div>${esc(p.name)}<br><span class="tag">${esc(p.category)}</span></div></div></td>
      <td>${p.gender}</td><td>${esc(p.colour)}</td><td>${p.season}</td>${cell(p.stock.S)}${cell(p.stock.M)}${cell(p.stock.L)}<td>${money(p.price)}</td><td>${p.soldCount}</td></tr>`).join('');
}
$('q').oninput = $('g').onchange = drawInventory;

/* ---------- billing ---------- */
function drawProductCards() {
  $('pgrid').innerHTML = products.map(p => `<div class="pc"><img src="${p.image}" alt="${esc(p.name)}"><div>
    <h4>${esc(p.name)}</h4><span class="m">${p.gender} · ${esc(p.colour)} · ${p.season}</span><span class="price">${money(p.price)}</span>
    <div class="row"><select id="sz-${p._id}" aria-label="Size">${['S', 'M', 'L'].map(k =>
      `<option value="${k}" ${p.stock[k] > 0 ? '' : 'disabled'}>${SZ[k]} (${p.stock[k] || 0} left)</option>`).join('')}</select>
      <input id="qt-${p._id}" type="number" min="1" value="1" aria-label="Quantity"></div>
    <button class="btn" onclick="addToCart('${p._id}')">Add to bill</button></div></div>`).join('');
  products.forEach(p => { const first = ['S', 'M', 'L'].find(k => p.stock[k] > 0); const el = $('sz-' + p._id); if (first) el.value = first; });
  drawCart();
}

function addToCart(id) {
  const p = products.find(x => x._id === id), size = $('sz-' + id).value, qty = parseInt($('qt-' + id).value, 10);
  $('be').textContent = '';
  if (!SZ[size]) { $('be').textContent = 'This product is out of stock in every size.'; return; }
  if (!(qty > 0)) { $('be').textContent = 'Enter a quantity of 1 or more.'; return; }
  const have = p.stock[size] - (cart.find(c => c.id === id && c.size === size)?.qty || 0);
  if (qty > have) { $('be').textContent = `Only ${have} ${SZ[size].toLowerCase()} piece(s) of ${p.name} available.`; return; }
  const line = cart.find(c => c.id === id && c.size === size);
  line ? line.qty += qty : cart.push({ id, size, qty });
  drawCart();
}
function removeLine(i) { cart.splice(i, 1); drawCart(); }
function drawCart() {
  let total = 0;
  $('cart').innerHTML = cart.length ? cart.map((c, i) => {
    const p = products.find(x => x._id === c.id); total += p.price * c.qty;
    return `<div class="cl"><span>${esc(p.name)}<br><small>${SZ[c.size]} × ${c.qty}</small></span><b>${money(p.price * c.qty)}</b><button onclick="removeLine(${i})">Remove</button></div>`;
  }).join('') : '<div class="empty">No items yet. Pick a size and add products from the left.</div>';
  $('tot').textContent = money(total);
}

$('gen').onclick = async () => {
  $('be').textContent = '';
  try {
    const sale = await api('/bill', { method: 'POST', body: { customerName: $('cn').value, phone: $('cp').value,
      items: cart.map(c => ({ productId: c.id, size: c.size, qty: c.qty })) } });
    showInvoice(sale); cart = []; $('cn').value = ''; $('cp').value = ''; await refresh();
  } catch (e) { $('be').textContent = e.message; }
};

function showInvoice(s) {
  $('invoice').innerHTML = `<h2>KIIT CLOTHINGS</h2>
    <div class="meta"><span>Invoice ${s.invoiceNo}</span><span>${new Date(s.createdAt).toLocaleString()}</span></div>
    <div><b>${esc(s.customerName)}</b><br>Phone: ${esc(s.phone)}</div>
    <table style="margin-top:.8rem"><thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Amount</th></tr></thead><tbody>
    ${s.items.map(i => `<tr><td>${esc(i.name)}</td><td>${SZ[i.size]}</td><td>${i.qty}</td><td>${money(i.price * i.qty)}</td></tr>`).join('')}</tbody></table>
    <div class="gt"><span>Total</span><span>${money(s.total)}</span></div>
    <div class="acts"><button class="btn" onclick="window.print()">Print</button><button class="btn ghost" style="color:#5b21b6" onclick="$('modal').classList.remove('on')">Close</button></div>`;
  $('modal').classList.add('on');
}

/* ---------- refill ---------- */
function fillRefill() {
  const cur = $('rp').value;
  $('rp').innerHTML = products.map(p => `<option value="${p._id}">${esc(p.name)} (${esc(p.colour)})</option>`).join('');
  if (cur) $('rp').value = cur;
}
$('rb').onclick = async () => {
  $('re').textContent = ''; $('rm').textContent = '';
  try {
    const p = await api('/refill', { method: 'POST', body: { productId: $('rp').value, size: $('rs').value, qty: $('rq').value } });
    $('rm').textContent = `${p.name} now has ${p.stock[$('rs').value]} ${SZ[$('rs').value].toLowerCase()} piece(s).`;
    await refresh();
  } catch (e) { $('re').textContent = e.message; }
};

/* ---------- sales history ---------- */
async function loadSales() {
  const sales = await api('/sales');
  $('sBody').innerHTML = sales.map(s => `<tr><td>${s.invoiceNo}</td><td>${new Date(s.createdAt).toLocaleDateString()}</td><td>${esc(s.customerName)}</td><td>${esc(s.phone)}</td>
    <td>${s.items.map(i => `${esc(i.name)} (${i.size}×${i.qty})`).join(', ')}</td><td>${money(s.total)}</td></tr>`).join('');
}

refresh().catch(e => console.error(e));

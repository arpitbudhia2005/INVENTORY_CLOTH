require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const SIZES = ['S', 'M', 'L'];
const LOW = parseInt(process.env.LOW_STOCK_LIMIT || '3', 10);
const SECRET = process.env.JWT_SECRET || 'dev-secret';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- models ---------- */
const Product = mongoose.model('Product', new mongoose.Schema({
  name: String, category: String, gender: String, colour: String, season: String,
  price: Number, costPrice: Number, image: String,
  stock: { S: { type: Number, default: 0 }, M: { type: Number, default: 0 }, L: { type: Number, default: 0 } },
  soldCount: { type: Number, default: 0 }
}));

const Sale = mongoose.model('Sale', new mongoose.Schema({
  invoiceNo: String, customerName: String, phone: String, total: Number,
  items: [{ product: mongoose.Schema.Types.ObjectId, name: String, size: String, qty: Number,
            price: Number, cost: Number, gender: String, season: String, colour: String, category: String }],
  createdAt: { type: Date, default: Date.now }
}));

const Admin = mongoose.model('Admin', new mongoose.Schema({ username: String, hash: String }));

/* ---------- auth ---------- */
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await Admin.findOne({ username: String(username || '').trim() });
  if (!admin || !(await bcrypt.compare(String(password || ''), admin.hash)))
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: jwt.sign({ u: admin.username }, SECRET, { expiresIn: '8h' }), username: admin.username });
});

/* ---------- products ---------- */
app.get('/api/products', auth, async (req, res) => res.json(await Product.find().sort({ name: 1 })));

app.post('/api/refill', auth, async (req, res) => {
  const qty = parseInt(req.body.qty, 10);
  const { productId, size } = req.body;
  if (!SIZES.includes(size) || !(qty > 0)) return res.status(400).json({ error: 'Choose a size and a quantity above zero.' });
  try {
    const p = await Product.findByIdAndUpdate(productId, { $inc: { ['stock.' + size]: qty } }, { new: true });
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    res.json(p);
  } catch { res.status(400).json({ error: 'Invalid product.' }); }
});

/* ---------- billing ---------- */
app.post('/api/bill', auth, async (req, res) => {
  const { customerName, phone, items } = req.body || {};
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'Enter the customer name.' });
  if (!/^\d{10}$/.test(phone || '')) return res.status(400).json({ error: 'Phone number must be 10 digits.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item to the bill.' });

  const done = [], lines = [];
  try {
    for (const it of items) {
      const qty = parseInt(it.qty, 10);
      if (!SIZES.includes(it.size) || !(qty > 0)) throw new Error('Invalid item in bill.');
      // atomic: only decrements if enough stock exists for that size
      const p = await Product.findOneAndUpdate(
        { _id: it.productId, ['stock.' + it.size]: { $gte: qty } },
        { $inc: { ['stock.' + it.size]: -qty, soldCount: qty } }, { new: true });
      if (!p) throw new Error('Not enough stock for one of the selected items.');
      done.push({ id: p._id, size: it.size, qty });
      lines.push({ product: p._id, name: p.name, size: it.size, qty, price: p.price, cost: p.costPrice,
                   gender: p.gender, season: p.season, colour: p.colour, category: p.category });
    }
  } catch (e) {
    for (const d of done) await Product.updateOne({ _id: d.id }, { $inc: { ['stock.' + d.size]: d.qty, soldCount: -d.qty } });
    return res.status(400).json({ error: e.message });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const n = await Sale.countDocuments();
  const sale = await Sale.create({ invoiceNo: 'KC-' + (1001 + n), customerName: customerName.trim(), phone, items: lines, total });
  res.json(sale);
});

app.get('/api/sales', auth, async (req, res) => res.json(await Sale.find().sort({ createdAt: -1 }).limit(100)));


app.get('/api/stats', auth, async (req, res) => {
  const [products, sales] = await Promise.all([Product.find().lean(), Sale.find().lean()]);
  let revenue = 0, profit = 0, units = 0;
  const season = {}, gender = {}, colour = {}, category = {};
  const sizeSold = { S: 0, M: 0, L: 0 }, sizeStock = { S: 0, M: 0, L: 0 };
  const bump = (o, k, q, r) => { o[k] = o[k] || { units: 0, revenue: 0 }; o[k].units += q; o[k].revenue += r; };

  sales.forEach(s => s.items.forEach(i => {
    const r = i.price * i.qty;
    revenue += r; profit += (i.price - i.cost) * i.qty; units += i.qty; sizeSold[i.size] += i.qty;
    bump(season, i.season, i.qty, r); bump(gender, i.gender, i.qty, r);
    bump(colour, i.colour, i.qty, r); bump(category, i.category, i.qty, r);
  }));

  const low = { S: [], M: [], L: [] };
  const stockByGender = {};
  products.forEach(p => SIZES.forEach(sz => {
    sizeStock[sz] += p.stock[sz];
    stockByGender[p.gender] = (stockByGender[p.gender] || 0) + p.stock[sz];
    if (p.stock[sz] <= LOW) low[sz].push({ id: p._id, name: p.name, colour: p.colour, stock: p.stock[sz] });
  }));
  SIZES.forEach(sz => low[sz].sort((a, b) => a.stock - b.stock));

  const topSelling = [...products].sort((a, b) => b.soldCount - a.soldCount).slice(0, 5)
    .map(p => ({ name: p.name, image: p.image, sold: p.soldCount, price: p.price }));

  res.json({ revenue, profit, units, bills: sales.length, lowLimit: LOW,
             lowCount: SIZES.reduce((n, s) => n + low[s].length, 0),
             low, topSelling, season, gender, colour, category, sizeSold, sizeStock, stockByGender });
});


const seedProducts = [
  { name: "Classic Blue Jeans", category: "Denim", gender: "Men", colour: "Blue", season: "All-Season", price: 45, costPrice: 20, stock: { S: 4, M: 7, L: 4 }, soldCount: 40, image: "https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=400" },
  { name: "Oversized Black T-Shirt", category: "Tops", gender: "Unisex", colour: "Black", season: "Summer", price: 20, costPrice: 8, stock: { S: 1, M: 2, L: 1 }, soldCount: 85, image: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=400" },
  { name: "Denim Jacket", category: "Outerwear", gender: "Unisex", colour: "Blue", season: "Winter", price: 65, costPrice: 30, stock: { S: 4, M: 5, L: 3 }, soldCount: 25, image: "https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=400" },
  { name: "Formal Cotton Shirt", category: "Shirts", gender: "Men", colour: "White", season: "All-Season", price: 35, costPrice: 15, stock: { S: 1, M: 1, L: 1 }, soldCount: 50, image: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=400" },
  { name: "Fleece Hoodie", category: "Outerwear", gender: "Unisex", colour: "Grey", season: "Winter", price: 50, costPrice: 22, stock: { S: 6, M: 8, L: 6 }, soldCount: 60, image: "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=400" },
  { name: "Chino Trousers", category: "Bottoms", gender: "Men", colour: "Beige", season: "Monsoon", price: 40, costPrice: 18, stock: { S: 2, M: 4, L: 2 }, soldCount: 30, image: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=400" },
  { name: "Summer Floral Dress", category: "Dresses", gender: "Women", colour: "Pink", season: "Summer", price: 55, costPrice: 24, stock: { S: 0, M: 1, L: 1 }, soldCount: 45, image: "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=400" },
  { name: "Casual Polo Tee", category: "Tops", gender: "Men", colour: "Green", season: "Summer", price: 25, costPrice: 10, stock: { S: 8, M: 10, L: 7 }, soldCount: 35, image: "https://images.unsplash.com/photo-1581655353564-df123a1eb820?w=400" }
];

async function seed() {
  if (!(await Admin.countDocuments()))
    await Admin.create({ username: process.env.ADMIN_USER || 'admin', hash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Kiit@2026', 10) });

  const raw = await Product.collection.find({}).toArray();
  const ok = p => p.stock && typeof p.stock === 'object' && SIZES.every(k => typeof p.stock[k] === 'number')
    && p.colour && ['Men', 'Women', 'Unisex'].includes(p.gender) && ['Summer', 'Monsoon', 'Winter', 'All-Season'].includes(p.season);
  if (raw.length && !raw.every(ok)) {
    console.log('Old product data found - resetting products and sales to the new size-wise format.');
    await Product.deleteMany({}); await Sale.deleteMany({});
  }

  if (!(await Product.countDocuments())) {
    const made = await Product.insertMany(seedProducts);
    // opening sales history so the charts have data from day one (split S/M/L, spread over 60 days)
    const split = { S: 0.25, M: 0.5, L: 0.25 };
    let n = 1001; const docs = [];
    made.forEach(p => SIZES.forEach(sz => {
      const qty = Math.round(p.soldCount * split[sz]); if (!qty) return;
      docs.push({ invoiceNo: 'KC-' + n++, customerName: 'Opening record', phone: '0000000000', total: p.price * qty,
        createdAt: new Date(Date.now() - Math.random() * 60 * 864e5),
        items: [{ product: p._id, name: p.name, size: sz, qty, price: p.price, cost: p.costPrice, gender: p.gender, season: p.season, colour: p.colour, category: p.category }] });
    }));
    await Sale.insertMany(docs);
    console.log('Sample clothing items and opening sales added.');
  }
}

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kiit_clothings')
  .then(seed)
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('KIIT CLOTHINGS running')))
  .catch(e => {
    console.error('Could not start. Is MongoDB running?\n', e.message);
    process.exit(1);
  });

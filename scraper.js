import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ============================ ARGUMEN CLI ============================ */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const pick = (argKey, envKey, fallback) =>
  ARGS[argKey] !== undefined ? ARGS[argKey] : process.env[envKey] !== undefined ? process.env[envKey] : fallback;

/* ============================ KONFIGURASI ============================ */
const ORIGIN = 'https://openlibrary.telkomuniversity.ac.id';
const CATALOG_URL = `${ORIGIN}/home/catalog.html`;

// Parameter advanced search
const PUBLISHER = pick('publisher', 'OPENLIB_PUBLISHER', 'Kampus Jakarta');

// Folder hasil download.
// Default: %USERPROFILE%\openlib-download (mengikuti user yang menjalankan script).
const DOWNLOAD_DIR = pick('out', 'OPENLIB_OUT', path.join(os.homedir(), 'openlib-download'));

// Profil browser lokal (biar login SSO cukup sekali). Tetap di komputer kamu.
const PROFILE_DIR = path.join(__dirname, '.profile');

// 0 = semua halaman / semua item
const MAX_PAGES = Number(pick('pages', 'OPENLIB_MAX_PAGES', 0));
const MAX_ITEMS = Number(pick('items', 'OPENLIB_MAX_ITEMS', 0));

// Rentang urutan item (1-based, inklusif). --from 51 --to 100
const START_INDEX = Number(pick('from', 'OPENLIB_FROM', 1));
const END_INDEX = Number(pick('to', 'OPENLIB_TO', 0)); // 0 = sampai habis

// Crawl ulang daftar (abaikan _order.json)
const REFRESH_ORDER = ['1', 'true', 'yes'].includes(String(pick('refresh', 'OPENLIB_REFRESH', '')).toLowerCase());

// Jeda antar request (sopan ke server)
const DELAY_MS = Number(pick('delay', 'OPENLIB_DELAY_MS', 400));

// Mode headless (tanpa jendela browser). Default: headless.
// Login SSO butuh interaksi, jadi kalau sesi belum ada script akan membuka
// jendela sebentar HANYA untuk login, lalu lanjut headless lagi.
const boolPick = (argKey, envKey, fallback) =>
  ['1', 'true', 'yes', 'on'].includes(String(pick(argKey, envKey, fallback)).toLowerCase());
const HEADLESS = boolPick('headless', 'OPENLIB_HEADLESS', true) && !boolPick('headed', 'OPENLIB_HEADED', false);

// Hanya login (simpan sesi) lalu keluar. Selalu pakai jendela biar bisa SSO/MFA.
const LOGIN_ONLY = boolPick('login', 'OPENLIB_LOGIN', false);

// Jenis berkas yang diambil: --types "bab3,bab4" | "16,17" (nomor dari daftar) | "16-21" | "all".
// Kosong = tampilkan daftar dan tanya (kalau dijalankan di terminal).
const TYPES_ARG = pick('types', 'OPENLIB_TYPES', '');
// Dipakai saat tidak ada --types dan tidak ada terminal interaktif.
const DEFAULT_TYPES = ['bab1', 'bab2', 'bab3'];
// Scan semua jenis berkas yang tersedia di situs -> _catalog.json, lalu berhenti (tanpa login).
const DISCOVER_ONLY = boolPick('discover', 'OPENLIB_DISCOVER', false);
// --full: pindai ulang semua dokumen, abaikan cache _catalog.json.
const FULL_DISCOVER = boolPick('full', 'OPENLIB_FULL', false);
let TYPES = []; // diisi di main() setelah memilih

const MANIFEST_PATH = path.join(DOWNLOAD_DIR, '_manifest.json');
const ORDER_PATH = path.join(DOWNLOAD_DIR, '_order.json');
const CATALOG_PATH = path.join(DOWNLOAD_DIR, '_catalog.json');
// Cookie sesi disimpan terpisah: cookie login situs ini adalah session cookie
// (expires = -1) yang TIDAK ikut tersimpan saat browser ditutup, jadi harus
// di-inject ulang tiap start supaya mode headless tetap terautentikasi.
const SESSION_PATH = path.join(__dirname, '.session.json');
/* ==================================================================== */

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  log('\n[PAUSE] Diminta berhenti. Menyelesaikan item yang sedang berjalan... (Ctrl+C lagi untuk paksa keluar)');
});


const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- sesi login (cookie persistence) ---------------- */
function loadSessionCookies() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
    return Array.isArray(data.cookies) ? data.cookies : [];
  } catch {
    return [];
  }
}

function saveSessionCookies(cookies) {
  try {
    fs.writeFileSync(
      SESSION_PATH,
      JSON.stringify({ saved_at: new Date().toISOString(), cookies }, null, 1),
      'utf-8'
    );
    return true;
  } catch {
    return false;
  }
}

/** Cek akses sungguhan: user dianggap login hanya kalau link BAB 1 muncul. */
function sampleDetailUrl() {
  const order = loadOrder();
  if (order?.items?.length) {
    const it = order.items.find((x) => x && x.url);
    if (it) return it.url;
  }
  return null;
}

async function hasChapterAccess(context) {
  let url = sampleDetailUrl();
  if (!url) {
    const r = await context.request.get(CATALOG_URL, { timeout: 60000 }).catch(() => null);
    const html = r ? await r.text().catch(() => '') : '';
    const m = html.match(/\/home\/catalog\/id\/\d+\/slug\/[^"']+\.html/);
    if (!m) return false;
    url = new URL(m[0], ORIGIN).href;
  }
  const r = await context.request.get(url, { timeout: 60000 }).catch(() => null);
  if (!r || !r.ok()) return false;
  const html = await r.text().catch(() => '');
  return /\/bab1\//i.test(html);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(s, max = 60) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

function short(s, n = 70) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    return { created: new Date().toISOString(), publisher: PUBLISHER, items: {} };
  }
}

function saveManifest(m) {
  ensureDir(DOWNLOAD_DIR);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf-8');
}

function loadOrder() {
  try {
    const data = JSON.parse(fs.readFileSync(ORDER_PATH, 'utf-8'));
    if (!Array.isArray(data.items) || data.items.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function saveOrder(items) {
  ensureDir(DOWNLOAD_DIR);
  fs.writeFileSync(
    ORDER_PATH,
    JSON.stringify(
      { publisher: PUBLISHER, created_at: new Date().toISOString(), total: items.length, items },
      null,
      2
    ),
    'utf-8'
  );
}

async function isLoggedIn(page) {
  try {
    if (!page.url().includes('openlibrary.telkomuniversity.ac.id')) return false;
    return await page.evaluate(() => {
      const hasLogout = !!document.querySelector(
        'a.btn-logout, .btn-logout, a[href*="logout"], a[href*="signout"]'
      );
      const hasLoginBtn = !!document.querySelector('button[data-target="#loginModal"]');
      // Anggap login kalau ada tombol logout, atau tombol "Login (SSO)" sudah hilang
      return hasLogout || !hasLoginBtn;
    });
  } catch {
    return false;
  }
}

async function waitForLogin(page, context, timeoutMs = 15 * 60 * 1000) {
  if ((await isLoggedIn(page)) && (await hasChapterAccess(context))) {
    log('[LOGIN] Sesi login terdeteksi. Lanjut otomatis.');
    return true;
  }

  log('');
  log('==============================================================');
  log(' SILAKAN LOGIN SSO DI BROWSER YANG TERBUKA');
  log(' Script akan lanjut OTOMATIS begitu login terdeteksi.');
  log(' (MFA/OTP juga boleh, semua di browser lokal kamu)');
  log('==============================================================');
  log('');

  const start = Date.now();
  let lastNotice = 0;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    if (await isLoggedIn(page)) {
      // Verifikasi sungguhan: link BAB 1 harus bisa diakses.
      if (await hasChapterAccess(context)) {
        log('[LOGIN] Berhasil. Lanjut otomatis...');
        return true;
      }
    }
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed - lastNotice >= 30) {
      lastNotice = elapsed;
      log(`[LOGIN] Menunggu login... (${elapsed}s) — URL: ${short(page.url(), 90)}`);
    }
  }
  return false;
}

async function runAdvancedSearch(page) {
  log(`[SEARCH] Membuka katalog: ${CATALOG_URL}`);
  await page.goto(CATALOG_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(800);

  try {
    log('[SEARCH] Buka modal Advanced ...');
    await page.locator('button[data-target="#modal-filter"]').first().click({ timeout: 15000 });
    await page.locator('#modal-filter').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#search-publisher').fill(PUBLISHER);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
      page.locator('#modal-filter input[type="submit"]').first().click(),
    ]);
  } catch (err) {
    log(`[SEARCH] Fallback submit langsung (${err.message})`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
      page.evaluate((publisher) => {
        const input = document.getElementById('search-publisher');
        input.value = publisher;
        input.form.requestSubmit();
      }, PUBLISHER),
    ]);
  }

  await page.waitForTimeout(1200);
  const summary = await page
    .locator('.search-summary-modern')
    .innerText()
    .catch(() => '');
  log(`[SEARCH] Penerbit = "${PUBLISHER}"`);
  log(`[SEARCH] ${summary.replace(/\s+/g, ' ').trim() || '(ringkasan tidak terbaca)'}`);
}

async function crawlListing(page) {
  const items = [];
  const seen = new Set();
  let pageNo = 1;
  let totalPages = 1;
  let filteredOut = 0;

  while (true) {
    if (pageNo > 1) {
      const url = `${ORIGIN}/home/catalog/page/${pageNo}.html`;
      log(`[LIST] Halaman ${pageNo}/${totalPages || '?'} → ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(700);
    }

    const cards = page.locator('.card-horizontal');
    const count = await cards.count();
    if (count === 0) {
      log(`[LIST] Halaman ${pageNo} kosong. Selesai crawl.`);
      break;
    }

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const link = card.locator('h3.card-title-hoz a').first();
      const href = await link.getAttribute('href').catch(() => null);
      if (!href) continue;

      const title = (await link.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const publisher = (
        await card
          .locator('.meta-list-hoz > div')
          .first()
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      const code = (await card.locator('.kode-badge').innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();

      const url = new URL(href, ORIGIN).href;
      const id = (url.match(/\/id\/(\d+)\//) || [])[1] || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      if (!publisher.toLowerCase().includes(PUBLISHER.toLowerCase())) {
        filteredOut++;
        continue;
      }

      items.push({ id, url, title, publisher, code });
    }

    const lastHref = await page
      .locator('.pagination li:last-child a')
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (lastHref) {
      const n = Number((lastHref.match(/\/page\/(\d+)\.html/) || [])[1]);
      if (n) totalPages = n;
    }

    if (pageNo >= totalPages) break;
    if (MAX_PAGES > 0 && pageNo >= MAX_PAGES) {
      log(`[LIST] Berhenti di MAX_PAGES=${MAX_PAGES}`);
      break;
    }
    pageNo++;
    await sleep(DELAY_MS);
  }

  log(`[LIST] Kandidat cocok: ${items.length} item (dilewati karena penerbit lain: ${filteredOut})`);
  return items;
}

function decodePayloadName(urlLike) {
  try {
    const m = String(urlLike).match(/\/(?:flippingbook|flippingbook_url_download)\/([^/?#]+)/);
    if (!m) return null;
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const json = JSON.parse(Buffer.from(b, 'base64').toString('utf-8'));
    return json?.dwn?.name || json?.name || null;
  } catch {
    return null;
  }
}

/**
 * Ambil satu file bab.
 * Alur situs: /pustaka/files/{id}/bab1/<slug>.pdf
 *   -> 302 /open/index.php/download/files/<payload>
 *   -> 302 /open/index.php/download/flippingbook/<payload>  (halaman viewer)
 *   -> di dalam JS halaman ada: pdfUrl: "/open/index.php/download/flippingbook_url_download/<payload>"
 */
async function downloadBab(context, href, destNoExt) {
  const viewer = await context.newPage();
  try {
    const startUrl = new URL(href, ORIGIN).href;
    let resp = null;
    try {
      resp = await viewer.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      // Server membalas sebagai attachment (unduhan langsung), goto melempar "Download is starting".
      if (!/Download is starting/i.test(e.message)) throw e;
      const r = await context.request.get(startUrl, { timeout: 180000 });
      if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
      const buf = pdfBytes(await r.body());
      if (!buf) throw new Error('respons bukan PDF (kemungkinan sesi/login)');
      const dest = `${destNoExt}.pdf`;
      fs.writeFileSync(dest, buf);
      return { path: dest, bytes: buf.length };
    }

    // Kadang server langsung mengembalikan PDF
    let raw = null;
    try {
      raw = await resp?.body();
    } catch {
      raw = null;
    }
    if (raw && raw.subarray(0, 4).toString() === '%PDF') {
      const dest = `${destNoExt}.pdf`;
      fs.writeFileSync(dest, raw);
      return { path: dest, bytes: raw.length };
    }

    const html = await viewer.content();
    const m = html.match(/pdfUrl\s*:\s*"([^"]+)"/);
    if (!m) throw new Error('pdfUrl tidak ditemukan di halaman flipbook');
    const pdfUrl = new URL(m[1], ORIGIN).href;

    const isPdf = (buf) => buf && buf.length > 4 && buf.subarray(0, 4).toString() === '%PDF';

    // 1) fetch dari dalam halaman (paling mirip perilaku viewer + bawa cookie)
    try {
      const b64 = await viewer.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!buf.length) throw new Error('kosong');
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        }
        return btoa(bin);
      }, pdfUrl);

      const buf = Buffer.from(b64, 'base64');
      if (!isPdf(buf)) throw new Error('respons bukan PDF (kemungkinan sesi/login)');
      const dest = `${destNoExt}.pdf`;
      fs.writeFileSync(dest, buf);
      return { path: dest, bytes: buf.length };
    } catch (e1) {
      log(`    [WARN] in-page fetch gagal (${e1.message}), coba request context...`);
    }

    // 2) request context (cookie ikut)
    const ua = await viewer.evaluate(() => navigator.userAgent).catch(() => undefined);
    const r = await context.request.get(pdfUrl, {
      headers: { Referer: viewer.url(), ...(ua ? { 'User-Agent': ua } : {}) },
      timeout: 180000,
    });
    if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
    const buf2 = await r.body();
    if (!isPdf(buf2)) throw new Error('respons bukan PDF (kemungkinan sesi/login)');
    const dest2 = `${destNoExt}.pdf`;
    fs.writeFileSync(dest2, buf2);
    return { path: dest2, bytes: buf2.length };
  } finally {
    await viewer.close().catch(() => {});
  }
}

/* ---------------- katalog jenis berkas ---------------- */
// Dijalankan di halaman detail. Mengambil semua baris panel "File Digital",
// termasuk yang masih "Perlu Login" (tanpa href).
// Harus mandiri (tanpa variabel luar) karena dikirim ke browser.
function collectFileRows() {
  const map = new Map();
  document.querySelectorAll('.file_download_list .file-access-row').forEach((r) => {
    const text = (r.innerText || '').replace(/\s+/g, ' ').trim();
    const ms = [...text.matchAll(/\(([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)\)/g)];
    const last = ms[ms.length - 1];
    if (!last) return;
    const key = `${last[1]}.${last[2]}`.toLowerCase();
    const label = text.slice(0, last.index).replace(/^\s*\d+\.\s*/, '').trim() || key;
    const a = r.querySelector('a[href*="/pustaka/files/"]');
    const href = a ? a.getAttribute('href') || '' : '';
    const prev = map.get(key);
    if (!prev || (!prev.href && href)) map.set(key, { key, label, href });
  });
  return [...map.values()];
}

// Potong byte kosong di depan sebelum "%PDF" (server kadang menyisipkannya). Null kalau bukan PDF.
function pdfBytes(buf) {
  if (!buf || !buf.length) return null;
  const idx = buf.subarray(0, 1024).indexOf('%PDF');
  return idx === -1 ? null : buf.subarray(idx);
}

// Ambil entri file di manifest. Mendukung format lama (kunci "bab1") dan baru ("bab1.pdf").
function fileEntry(files, key) {
  if (!files) return null;
  return files[key] || (key.endsWith('.pdf') ? files[key.slice(0, -4)] : null) || null;
}

function loadCatalog() {
  try {
    const c = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    return Array.isArray(c.types) && c.types.length ? c : null;
  } catch {
    return null;
  }
}

function saveCatalog(c) {
  ensureDir(DOWNLOAD_DIR);
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(c, null, 2), 'utf-8');
  const lines = [
    '# Jenis berkas yang tersedia di OpenLib',
    '',
    `Diperbarui: ${c.created_at} · Dokumen dipindai: ${c.total_docs}`,
    '',
    '| No | Kode berkas | Nama | Jumlah dokumen |',
    '|---|---|---|---|',
    ...c.types.map(
      (t, i) => `| ${i + 1} | ${t.key} | ${t.label.replace(/\|/g, '\\|')} | ${t.count} |`
    ),
    '',
  ];
  fs.writeFileSync(path.join(DOWNLOAD_DIR, '_available.md'), lines.join('\n'), 'utf-8');
}

async function ensureOrder(page) {
  const cached = loadOrder();
  if (cached && !REFRESH_ORDER && cached.publisher === PUBLISHER) {
    log(
      `[ORDER] Pakai urutan tersimpan: ${cached.items.length} item (dibuat ${new Date(
        cached.created_at
      ).toLocaleString('id-ID')}). Pakai --refresh untuk crawl ulang.`
    );
    return cached.items;
  }
  await runAdvancedSearch(page);
  const items = await crawlListing(page);
  if (items.length) saveOrder(items);
  log(`[ORDER] Urutan disimpan ke ${ORDER_PATH}`);
  return items;
}

/** Kunjungi semua dokumen, kumpulkan semua jenis berkas yang ada, simpan ke _catalog.json. */
async function discover(context, page) {
  const items = await ensureOrder(page);
  log(`[DISCOVER] Memindai ${items.length} dokumen...`);

  // Cache: dokumen yang sudah ada di _catalog.json (tanpa error) tidak dikunjungi ulang.
  const prev = FULL_DISCOVER ? null : loadCatalog();
  const cachedById = new Map(
    (prev?.docs || []).filter((d) => !d.error).map((d) => [String(d.id), d])
  );

  const docs = [];
  let visited = 0;
  for (let i = 0; i < items.length; i++) {
    if (stopping) break;
    const item = items[i];
    const hit = cachedById.get(String(item.id));
    if (hit) {
      docs.push(hit);
      log(`[DISCOVER ${i + 1}/${items.length}] (cache) ${short(item.title, 70)}`);
      continue;
    }

    visited++;
    const d = await context.newPage();
    try {
      await d.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      const rows = await d.evaluate(collectFileRows);
      docs.push({
        id: item.id,
        title: item.title,
        code: item.code,
        url: item.url,
        files: rows.map((r) => ({ key: r.key, label: r.label, downloadable: !!r.href })),
      });
      log(`[DISCOVER ${i + 1}/${items.length}] ${rows.length} berkas — ${short(item.title, 70)}`);
    } catch (e) {
      log(`[DISCOVER ${i + 1}/${items.length}] [WARN] ${e.message}`);
      docs.push({ id: item.id, title: item.title, code: item.code, url: item.url, files: [], error: e.message });
    } finally {
      await d.close().catch(() => {});
    }
    await sleep(DELAY_MS);
  }

  // Hitung ulang jenis berkas dari semua dokumen (cache + yang baru dipindai).
  const typeMap = new Map(); // key -> { key, label, count }
  for (const doc of docs) {
    for (const f of doc.files || []) {
      const t = typeMap.get(f.key) || { key: f.key, label: f.label, count: 0 };
      t.count++;
      typeMap.set(f.key, t);
    }
  }

  const catalog = {
    created_at: new Date().toISOString(),
    publisher: PUBLISHER,
    total_docs: items.length,
    types: [...typeMap.values()],
    docs,
  };
  saveCatalog(catalog);

  log('');
  log(
    `[DISCOVER] Selesai. ${catalog.types.length} jenis berkas. Dari cache: ${items.length - visited}, dipindai: ${visited}.`
  );
  log(`[DISCOVER] Daftar: ${path.join(DOWNLOAD_DIR, '_available.md')}`);
  catalog.types.forEach((t, i) =>
    log(`  ${String(i + 1).padStart(3)}. ${t.key.padEnd(28)} ${short(t.label, 55).padEnd(56)} ${t.count} dok`)
  );
}

/** Ubah token pilihan (nomor, rentang, kode, atau "all") jadi daftar jenis berkas. */
function resolveTokens(tokens, all) {
  const out = [];
  const add = (t) => {
    if (!out.some((x) => x.key === t.key)) out.push(t);
  };
  for (const raw of tokens) {
    const tok = String(raw).trim().toLowerCase();
    if (!tok) continue;
    if (tok === 'all') {
      all.forEach(add);
      continue;
    }
    const range = tok.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) if (all[n - 1]) add(all[n - 1]);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      if (all[Number(tok) - 1]) add(all[Number(tok) - 1]);
      else log(`[WARN] Nomor ${tok} tidak ada di daftar`);
      continue;
    }
    const base = tok.replace(/\.[a-z0-9]+$/, '');
    const hits = all.filter((t) => t.key === tok || t.key.replace(/\.[a-z0-9]+$/, '') === base);
    if (hits.length) hits.forEach(add);
    else if (!all.length) add({ key: tok.includes('.') ? tok : `${tok}.pdf`, label: tok.toUpperCase() });
    else log(`[WARN] "${tok}" tidak ada di daftar jenis berkas`);
  }
  return out;
}

async function chooseTypes(catalog) {
  const all = catalog.types;
  if (TYPES_ARG) return resolveTokens(TYPES_ARG.split(','), all);
  if (!process.stdin.isTTY) return resolveTokens(DEFAULT_TYPES, all);

  log('');
  log('Jenis berkas yang tersedia:');
  all.forEach((t, i) =>
    log(`  ${String(i + 1).padStart(3)}. ${t.key.padEnd(28)} ${short(t.label, 55).padEnd(56)} ${t.count} dok`)
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) =>
    rl.question('\nPilih (contoh: 16,17 | 16-21 | bab3,bab4 | all): ', r)
  );
  rl.close();
  return resolveTokens(answer.split(','), all);
}

async function resolveTypesForRun(context, page) {
  let catalog = loadCatalog();
  if (!catalog && (TYPES_ARG || process.stdin.isTTY)) {
    log('[CATALOG] Daftar jenis berkas belum ada. Memindai dulu...');
    await discover(context, page);
    catalog = loadCatalog();
  }
  TYPES = catalog ? await chooseTypes(catalog) : resolveTokens(TYPES_ARG ? TYPES_ARG.split(',') : DEFAULT_TYPES, []);
  if (!TYPES.length) {
    log('[FATAL] Tidak ada jenis berkas yang dipilih.');
    process.exit(1);
  }
  log(`[TYPE ] Diambil: ${TYPES.map((t) => `${t.key} (${short(t.label, 40)})`).join(', ')}`);
}

async function processItem(context, item, manifest) {
  const folderName = `${item.id}_${slugify(item.title) || 'dokumen'}`;
  const folder = path.join(DOWNLOAD_DIR, folderName);
  ensureDir(folder);

  const detail = await context.newPage();
  // Auto-accept dialog bawaan (confirm() pada link file)
  detail.on('dialog', (d) => d.accept().catch(() => {}));

  try {
    await detail.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await detail.waitForTimeout(500);

    const meta = await detail.evaluate(() => {
      const rows = {};
      document.querySelectorAll('.data-row').forEach((r) => {
        const l = r.querySelector('.data-label')?.innerText?.trim();
        const v = r.querySelector('.data-value')?.innerText?.trim();
        if (l) rows[l] = (v || '').replace(/\s+/g, ' ');
      });
      return rows;
    });

    const publisher = meta['Penerbit'] || item.publisher || '';
    if (publisher && !publisher.toLowerCase().includes(PUBLISHER.toLowerCase())) {
      log(`  [SKIP] Penerbit bukan "${PUBLISHER}": ${short(publisher, 80)}`);
      return { status: 'skipped-publisher' };
    }

    const rows = await detail.evaluate(collectFileRows);

    const files = {};
    for (const target of TYPES) {
      const match = rows.find((r) => r.key === target.key && r.href);

      if (!match) {
        log(`  [MISS] ${target.label} tidak tersedia (atau perlu login)`);
        continue;
      }

      const guessed = decodePayloadName(match.href);
      const baseName = guessed
        ? guessed.replace(/\.pdf$/i, '')
        : `${item.code || item.id}_${target.key.replace(/\.[a-z0-9]+$/, '')}`;

      log(`  [GET ] ${short(target.label, 60)} (${target.key})`);

      let result = null;
      for (let attempt = 1; attempt <= 2 && !result; attempt++) {
        try {
          result = await downloadBab(context, match.href, path.join(folder, baseName));
        } catch (e) {
          log(`  [WARN] ${target.label} gagal (attempt ${attempt}): ${e.message}`);
          await sleep(1200 * attempt);
        }
      }

      if (result) {
        log(`  [OK  ] ${path.basename(result.path)} (${(result.bytes / 1024 / 1024).toFixed(2)} MB)`);
        files[target.key] = {
          file: path.basename(result.path),
          bytes: result.bytes,
          fetched_at: new Date().toISOString(),
        };
      }
    }

    // metadata.md per dokumen
    const md = [
      `# ${meta['Judul'] || item.title}`,
      '',
      `- Katalog ID: ${item.id}`,
      `- Kode: ${meta['Kode'] || item.code || '-'}`,
      `- Pengarang: ${meta['Nama'] || '-'}`,
      `- Pembimbing: ${meta['Pembimbing'] || '-'}`,
      `- Penerbit: ${publisher || '-'}`,
      `- Tahun: ${meta['Tahun'] || '-'}`,
      `- Jenis: ${meta['Jenis'] || '-'}`,
      `- Subjek: ${meta['Subjek'] || '-'}`,
      `- URL: ${item.url}`,
      '',
      '## Berkas',
      ...(Object.keys(files).length
        ? Object.entries(files).map(
            ([k, v]) => `- ${k}: \`${v.file}\` (${(v.bytes / 1024 / 1024).toFixed(2)} MB)`
          )
        : ['- (tidak ada file yang berhasil diunduh)']),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(folder, 'metadata.md'), md, 'utf-8');

    manifest.items[item.id] = {
      title: meta['Judul'] || item.title,
      code: meta['Kode'] || item.code || '',
      author: meta['Nama'] || '',
      publisher,
      year: meta['Tahun'] || '',
      url: item.url,
      folder: folderName,
      files,
      updated_at: new Date().toISOString(),
    };
    saveManifest(manifest);

    const wanted = TYPES.length;
    const got = Object.keys(files).length;
    return { status: got === wanted ? 'complete' : got > 0 ? 'partial' : 'none', got, wanted };
  } finally {
    await detail.close().catch(() => {});
  }
}

function writeIndex(manifest) {
  const order = loadOrder();
  const orderIds = order?.items?.map((it) => String(it.id)) || [];
  const entries = Object.entries(manifest.items || {});
  entries.sort((a, b) => {
    const ia = orderIds.indexOf(String(a[0]));
    const ib = orderIds.indexOf(String(b[0]));
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const lines = [
    `# OpenLib ${PUBLISHER} — ${TYPES.map((t) => short(t.label, 30)).join(' / ')}`,
    '',
    `Total dokumen: ${entries.length}`,
    `Diperbarui: ${new Date().toISOString()}`,
    '',
    `| No | ID | Kode | Judul | Tahun | ${TYPES.map((t) => short(t.label, 30).replace(/\|/g, '\\|')).join(' | ')} |`,
    `|${Array(5 + TYPES.length).fill('---').join('|')}|`,
  ];
  entries.forEach(([id, it], idx) => {
    const f = it.files || {};
    const link = (v) =>
      v ? `[pdf](${encodeURI(it.folder || '')}/${encodeURIComponent(v.file)})` : '–';
    const no = orderIds.indexOf(String(id));
    lines.push(
      `| ${no >= 0 ? no + 1 : idx + 1} | ${id} | ${it.code || '-'} | ${(it.title || '').replace(
        /\|/g,
        '\\|'
      )} | ${it.year || '-'} | ${TYPES.map((t) => link(fileEntry(f, t.key))).join(' | ')} |`
    );
  });
  fs.writeFileSync(path.join(DOWNLOAD_DIR, '_index.md'), lines.join('\n') + '\n', 'utf-8');
}

function launchBrowser(headless) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    acceptDownloads: true,
    viewport: { width: 1360, height: 900 },
    slowMo: headless ? 0 : 60,
  });
}

async function openOnOrigin(context) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return page;
}

/**
 * Buka context yang sudah login.
 * - Kalau sesi tersimpan masih valid: langsung pakai (headless).
 * - Kalau belum login: buka jendela browser sebentar untuk SSO, simpan cookie,
 *   lalu coba lanjut headless tanpa membuang sesi yang sudah didapat.
 */
async function prepareContext(headless) {
  const context = await launchBrowser(headless);
  // Cookie tersimpan hanya dipakai untuk run headless; saat membuka jendela login
  // jangan inject cookie lama supaya tidak mengganggu proses SSO.
  if (headless) {
    const cookies = loadSessionCookies();
    if (cookies.length) await context.addCookies(cookies).catch(() => {});
  }
  const page = await openOnOrigin(context);
  return { context, page };
}

async function openAuthenticatedContext() {
  // 1) Coba langsung headless dengan cookie tersimpan.
  const first = await prepareContext(HEADLESS);
  if (await hasChapterAccess(first.context)) {
    log('[LOGIN] Sesi login tersimpan masih valid.');
    return first;
  }

  // 2) Butuh login (SSO/MFA tidak bisa di headless) → buka jendela sekali.
  if (HEADLESS) log('[LOGIN] Sesi tidak ada/kedaluwarsa. Membuka jendela browser untuk login...');
  await first.context.close().catch(() => {});
  const headed = await prepareContext(false);

  const ok = await waitForLogin(headed.page, headed.context);
  if (!ok) {
    log('[FATAL] Login tidak terdeteksi dalam batas waktu. Browser dibiarkan terbuka.');
    return null;
  }

  // 3) Simpan cookie (termasuk session cookie) supaya run berikutnya headless.
  const cookies = await headed.context.cookies();
  log(
    saveSessionCookies(cookies)
      ? `[LOGIN] Sesi disimpan ke ${SESSION_PATH}`
      : '[LOGIN] Gagal menyimpan sesi, lanjut dengan sesi aktif.'
  );

  if (!HEADLESS) return headed;

  // 4) Coba pindah ke headless. Kalau sesi tidak terbawa, JANGAN scrape tanpa akses.
  const headlessRun = await prepareContext(true);
  if (await hasChapterAccess(headlessRun.context)) {
    await headed.context.close().catch(() => {});
    log('[LOGIN] Lanjut mode headless.');
    return headlessRun;
  }

  await headlessRun.context.close().catch(() => {});
  log('[WARN] Sesi tidak terbawa ke headless. Lanjut pakai jendela browser yang sudah login.');
  return headed;
}

async function main() {
  log('==============================================================');
  log(' OPENLIB TELKOM — AUTO SCRAPER BAB 1, 2 & 3');
  log('==============================================================');
  log(`Penerbit : ${PUBLISHER}`);
  log(`Output   : ${DOWNLOAD_DIR}`);
  log('');
  log(`Profil   : ${PROFILE_DIR}`);
  log(`Mode     : ${HEADLESS ? 'headless (tanpa jendela)' : 'headed (dengan jendela)'}`);
  log(`Halaman  : ${MAX_PAGES ? `maks ${MAX_PAGES}` : 'semua'}`);
  log(`Mode run : ${DISCOVER_ONLY ? 'discover (cari semua jenis berkas)' : 'unduh'}`);
  log(`Rentang  : ${START_INDEX} → ${END_INDEX || 'akhir'}`);
  log('');

  if (LOGIN_ONLY) {
    const { context, page } = await prepareContext(false);
    const ok = await waitForLogin(page, context);
    if (ok) saveSessionCookies(await context.cookies());
    await context.close().catch(() => {});
    log(ok ? '[LOGIN] Sesi disimpan. Sekarang bisa jalankan tanpa login lagi.' : '[LOGIN] Gagal login.');
    process.exit(ok ? 0 : 1);
  }

  try {
    ensureDir(DOWNLOAD_DIR);
  } catch (e) {
    log(`[FATAL] Tidak bisa membuat folder output: ${DOWNLOAD_DIR}`);
    log(`        ${e.message}`);
    log('        Tentukan folder lain yang bisa ditulis, contoh:');
    log('        npm start -- --out "D:\\\\openlib-download"');
    log('        (atau set env OPENLIB_OUT)');
    process.exit(1);
  }
  const manifest = loadManifest();
  manifest.publisher = PUBLISHER;

  if (DISCOVER_ONLY) {
    const { context, page } = await prepareContext(true);
    try {
      await discover(context, page);
    } finally {
      await context.close().catch(() => {});
    }
    return;
  }

  const auth = await openAuthenticatedContext();
  if (!auth) return;
  const { context, page } = auth;
  context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));

  // Daftar urutan item: pakai cache _order.json kalau ada (biar nomor urut stabil saat pause/lanjut)
  const items = await ensureOrder(page);
  await resolveTypesForRun(context, page);

  const total = items.length;
  const startIdx = Math.max(1, START_INDEX || 1);
  const endIdx = END_INDEX > 0 ? Math.min(total, END_INDEX) : total;
  let targets = startIdx > total ? [] : items.slice(startIdx - 1, endIdx);
  if (MAX_ITEMS > 0) targets = targets.slice(0, MAX_ITEMS);

  if (targets.length === 0) {
    log('[INFO] Tidak ada item pada rentang tersebut.');
    return;
  }

  log(`[RANGE] Memproses urutan ${startIdx}–${endIdx} dari total ${total} (${targets.length} item)`);

  log('');
  log('==============================================================');
  log(` MULAI UNDUH ${targets.length} DOKUMEN`);
  log('==============================================================');

  const stats = { complete: 0, partial: 0, none: 0, skipped: 0, already: 0 };
  let lastIndex = startIdx - 1;

  for (let i = 0; i < targets.length; i++) {
    if (stopping) break;
    const item = targets[i];
    const absIndex = startIdx + i;
    const tag = `[${absIndex}/${total}]`;
    lastIndex = absIndex;
    const existing = manifest.items[item.id];
    if (
      existing?.folder &&
      TYPES.every((t) => {
        const f = fileEntry(existing.files, t.key);
        return f && fs.existsSync(path.join(DOWNLOAD_DIR, existing.folder, f.file));
      })
    ) {
      stats.already++;
      log(`${tag} [SKIP] Sudah lengkap: ${short(existing.title || item.title)}`);
      continue;
    }

    log('');
    log(`${tag} ${short(item.title, 95)}`);
    log(`        kode=${item.code || '-'} id=${item.id}`);

    try {
      const res = await processItem(context, item, manifest);
      if (res.status === 'complete') stats.complete++;
      else if (res.status === 'partial') stats.partial++;
      else if (res.status === 'skipped-publisher') stats.skipped++;
      else stats.none++;
    } catch (e) {
      stats.none++;
      log(`  [ERROR] ${e.message}`);
      manifest.items[item.id] = {
        title: item.title,
        url: item.url,
        code: item.code,
        folder: null,
        files: {},
        error: e.message,
        updated_at: new Date().toISOString(),
      };
      saveManifest(manifest);
    }

    await sleep(DELAY_MS);
  }

  writeIndex(manifest);
  saveManifest(manifest);

  // Simpan ulang cookie sesi (mungkin diperbarui server selama run).
  saveSessionCookies(await context.cookies());

  log('');
  log('==============================================================');
  log(stopping ? ' DIJEDA' : ' SELESAI');
  log(` Lengkap       : ${stats.complete}`);
  log(` Sebagian      : ${stats.partial}`);
  log(` Gagal/kosong  : ${stats.none}`);
  log(` Sudah ada     : ${stats.already}`);
  log(` Skip penerbit : ${stats.skipped}`);
  log(` Output        : ${DOWNLOAD_DIR}`);
  log('==============================================================');
  if (stats.complete + stats.partial === 0 && stats.none > 0) {
    log('[WARN] Tidak ada file yang berhasil diunduh sama sekali.');
    log('       Kemungkinan sesi login tidak valid. Jalankan: npm run login');
    log('       lalu ulangi. Kalau masih kosong, cek bagian "Catatan teknis" di README.');
  }

  const next = lastIndex + 1;
  if (stopping && next <= total) {
    log(`[PAUSE] Berhenti di urutan ${lastIndex} dari ${total}.`);
    log(`[PAUSE] Lanjut nanti dengan perintah:`);
    log(`        npm start -- --from ${next}`);
  } else if (lastIndex < total) {
    log(`[NEXT ] Sisa urutan ${next}–${total}. Lanjut: npm start -- --from ${next}`);
  }
  await context.close().catch(() => {});
  log(HEADLESS ? 'Browser headless ditutup.' : 'Browser ditutup.');
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

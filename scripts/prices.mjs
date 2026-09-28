/**
 * ЦЕНЫ ПОЗИЦИЙ: ЛИСТ ДЛЯ ЗАПОЛНЕНИЯ И ВОЗВРАТ ЗАПОЛНЕННОГО В ТАБЛИЦУ
 * ============================================================================
 *   node scripts/prices.mjs            # сколько позиций без цены, что делать
 *   node scripts/prices.mjs --list     # собрать catalog/import/ceny.csv
 *   node scripts/prices.mjs --apply    # перенести заполненное в seed/*.csv
 *
 * ЗАЧЕМ. Цены проставляются руками — и это не лень, а единственный рабочий
 * способ. Выгружать прайс магазина скриптом нельзя (чужая витрина), да
 * и технически бесполезно: «Ситилинк» разбивает цифры цены по элементам
 * и подмешивает невидимые символы именно против такого чтения — проверено
 * 28.09.2026. Поэтому скрипт делает не «сбор цен», а лист: одна строка —
 * одна позиция, рядом готовые адреса поиска в «Ситилинке» и DNS. Человеку
 * остаётся открыть ссылку и вписать число.
 *
 * Правило заполнения: сначала DNS — у него цена лежит в разметке `Product`
 * и читается человеком и инструментом одинаково; нет — «Ситилинк» глазами;
 * нет — любой другой магазин. Дата проверки обязательна. Почему именно
 * в таком порядке — README.
 *
 * `--apply` переносит заполненное обратно в таблицы товаров (те, что
 * перечислены в products.json). Таблица разбирается и собирается целиком,
 * поэтому перед записью делается проверка обратным разбором: если хоть
 * одна ячейка не совпала, скрипт ничего не пишет.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const seedDir = path.join(root, 'catalog', 'seed');
const sheetFile = path.join(root, 'catalog', 'import', 'ceny.csv');

const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : args.includes('--list') ? 'list' : 'report';

const SHEET_COLUMNS = ['таблица', 'строка', 'марка', 'артикул', 'наименование',
  'цена', 'цена проверена', 'источник цены', 'искать в Ситилинке', 'искать в DNS'];

// ── Разбор и сборка CSV ─────────────────────────────────────────────────────

function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const head = src.split('\n')[0];
  const delimiter = (head.match(/;/g) || []).length >= (head.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let cur = [''];
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else { quoted = false; }
      } else { cur[cur.length - 1] += c; }
    } else if (c === '"') { quoted = true; }
    else if (c === delimiter) { cur.push(''); }
    else if (c === '\n') { rows.push(cur); cur = ['']; }
    else if (c !== '\r') { cur[cur.length - 1] += c; }
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return { rows, delimiter };
}

const cell = (v, d) => (new RegExp(`[${d}"\n\r]`).test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

// Перевод строки — \n, как в уже лежащих таблицах: Excel их читает,
// а смена на \r\n дала бы diff на весь файл при правке одной цены.
const buildCsv = (rows, d = ';') => '﻿' + rows.map((r) => r.map((v) => cell(String(v ?? ''), d)).join(d)).join('\n') + '\n';

const isComment = (row) => String(row[0] ?? '').trim().startsWith('#');

/** Строки таблицы товаров с номерами строк — чтобы потом вернуть цену на место. */
async function readTables() {
  const seed = JSON.parse(await readFile(path.join(seedDir, 'products.json'), 'utf8'));
  const tables = [];

  for (const name of seed.csv ?? []) {
    const file = path.join(seedDir, name);
    const { rows, delimiter } = parseCsv(await readFile(file, 'utf8'));
    const header = rows[0].map((c) => c.replace(/^﻿/, '').trim());
    const at = (title) => header.indexOf(title);

    for (const need of ['цена', 'цена проверена', 'источник цены']) {
      if (at(need) < 0) {
        throw new Error(`${name}: нет столбца «${need}» — добавьте его, образец в catalog/import/template.csv`);
      }
    }

    tables.push({ name, file, rows, header, delimiter, at });
  }

  return tables;
}

// ── Лист для заполнения ─────────────────────────────────────────────────────

const searchLinks = (brand, mpn, title) => {
  const q = encodeURIComponent([brand, mpn].filter(Boolean).join(' ') || title);
  return [`https://www.citilink.ru/search/?text=${q}`, `https://www.dns-shop.ru/search/?q=${q}`];
};

async function makeSheet(tables) {
  const out = [SHEET_COLUMNS.slice()];
  let empty = 0;

  for (const t of tables) {
    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2 || isComment(row)) continue;
      const title = (row[t.at('наименование')] ?? '').trim();
      if (!title) continue;
      if ((row[t.at('цена')] ?? '').trim()) continue;          // цена уже стоит

      const brand = (row[t.at('марка')] ?? '').trim();
      const mpn = (row[t.at('артикул')] ?? '').trim();
      const [citilink, dns] = searchLinks(brand, mpn, title);
      out.push([t.name, i + 1, brand, mpn, title, '', '', '', citilink, dns]);
      empty++;
    }
  }

  await writeFile(sheetFile, buildCsv(out), 'utf8');
  console.log(`Лист собран: catalog/import/ceny.csv, позиций без цены — ${empty}.`);
  console.log('');
  console.log('Что делать: открыть в Excel, пройти по ссылкам, заполнить три столбца —');
  console.log('«цена», «цена проверена» — дата, когда смотрели, в виде 29.09.2026,');
  console.log('«источник цены» — где смотрели: сначала DNS, нет — «Ситилинк», нет — любой.');
  console.log('Строки, где цена не нашлась, оставить пустыми и не удалять.');
  console.log('');
  console.log('Потом: node scripts/prices.mjs --apply');
}

// ── Возврат заполненного ────────────────────────────────────────────────────

async function applySheet(tables) {
  if (!existsSync(sheetFile)) {
    console.error('Нет catalog/import/ceny.csv — сначала node scripts/prices.mjs --list');
    process.exit(1);
  }

  const { rows } = parseCsv(await readFile(sheetFile, 'utf8'));
  const header = rows[0].map((c) => c.replace(/^﻿/, '').trim());
  const at = (title) => {
    const i = header.indexOf(title);
    if (i < 0) throw new Error(`ceny.csv: нет столбца «${title}» — заголовки менять нельзя`);
    return i;
  };

  const byTable = new Map(tables.map((t) => [t.name, t]));
  let filled = 0;
  let skipped = 0;
  const problems = [];

  for (let n = 1; n < rows.length; n++) {
    const r = rows[n];
    if (r.length < 2) continue;

    const price = (r[at('цена')] ?? '').trim();
    if (price === '') { skipped++; continue; }

    const where = `ceny.csv, строка ${n + 1}`;
    const table = byTable.get((r[at('таблица')] ?? '').trim());
    if (!table) { problems.push(`${where}: неизвестная таблица «${r[at('таблица')]}»`); continue; }

    const line = Number(r[at('строка')]);
    const target = table.rows[line - 1];
    if (!target) { problems.push(`${where}: в ${table.name} нет строки ${line}`); continue; }

    // Сверяем артикул: строки могли сдвинуться, пока лист заполняли.
    const mpn = (target[table.at('артикул')] ?? '').trim();
    if (mpn !== (r[at('артикул')] ?? '').trim()) {
      problems.push(`${where}: в ${table.name} строке ${line} артикул «${mpn}», а в листе «${r[at('артикул')]}» — таблица сдвинулась`);
      continue;
    }

    const number = price.replace(/[\s ]/g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(number) || Number(number) <= 0) {
      problems.push(`${where}: цена «${price}» — нужно число`);
      continue;
    }

    const checked = (r[at('цена проверена')] ?? '').trim();
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(checked)) {
      problems.push(`${where}: дата проверки «${checked}» — нужно в виде 29.09.2026`);
      continue;
    }

    while (target.length < table.header.length) target.push('');
    target[table.at('цена')] = String(Math.round(Number(number)));
    target[table.at('цена проверена')] = checked;
    target[table.at('источник цены')] = (r[at('источник цены')] ?? '').trim();
    filled++;
  }

  if (problems.length) {
    console.error(`Ничего не записано, разберитесь сначала (${problems.length}):`);
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }

  for (const t of tables) {
    const text = buildCsv(t.rows, t.delimiter);
    // Проверка обратным разбором: таблица пересобирается целиком,
    // и молча испортить её в 84 строках нельзя.
    const back = parseCsv(text).rows;
    if (JSON.stringify(back) !== JSON.stringify(t.rows)) {
      console.error(`${t.name}: таблица не сошлась после сборки — ничего не записано`);
      process.exit(1);
    }
    await writeFile(t.file, text, 'utf8');
  }

  console.log(`Цены перенесены: ${filled}. Осталось без цены в листе: ${skipped}.`);
  console.log('Дальше: php catalog/build-db.php и обычная выкладка.');
}

// ── Отчёт ───────────────────────────────────────────────────────────────────

async function report(tables) {
  let total = 0;
  let withPrice = 0;
  let withDate = 0;

  for (const t of tables) {
    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2 || isComment(row)) continue;
      if (!(row[t.at('наименование')] ?? '').trim()) continue;
      total++;
      if ((row[t.at('цена')] ?? '').trim()) withPrice++;
      if ((row[t.at('цена проверена')] ?? '').trim()) withDate++;
    }
  }

  console.log(`В таблицах позиций ${total}: с ценой ${withPrice}, без цены ${total - withPrice}.`);
  if (withPrice !== withDate) {
    console.log(`Внимание: цен с датой проверки — ${withDate}. Сборка не пропустит цену без даты.`);
  }
  console.log('');
  console.log('Собрать лист для заполнения:  node scripts/prices.mjs --list');
  console.log('Перенести заполненное:        node scripts/prices.mjs --apply');
}

const tables = await readTables();
if (mode === 'list') await makeSheet(tables);
else if (mode === 'apply') await applySheet(tables);
else await report(tables);

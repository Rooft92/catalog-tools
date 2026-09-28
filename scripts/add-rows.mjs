/**
 * Дописывает позиции в таблицу товаров каталога.
 *
 *   node scripts/add-rows.mjs catalog/seed/tovary.csv партия.mjs [ещё.mjs …]
 *
 * Партия — модуль, который экспортирует по умолчанию массив позиций:
 *
 *   export default [{
 *     cat: 'kartridzhi', brand: 'Kyocera', mpn: 'TK-1170', codes: '', model: '',
 *     title: 'Тонер-картридж Kyocera TK-1170, чёрный, 7 200 стр.',
 *     slug: 'toner-kartridzh-kyocera-tk-1170',
 *     specs: [['Тип', 'тонер-картридж'], ['Ресурс', '7 200 стр.']],
 *     fits: ['ECOSYS M2040dn', 'ECOSYS M2540dn'],
 *     desc: 'Своё описание — только факты со страницы производителя.',
 *     src: 'https://… официальная страница',
 *   }];
 *
 * Необязательные поля: `group` — подпись блока в таблице (по умолчанию
 * раздел), `image` и `rights` — свой снимок заказчика, `price`,
 * `priceCheckedAt` и `priceSource` — если цена известна сразу; обычно
 * её проставляет `prices.mjs` отдельным проходом.
 *
 * Скрипт только дописывает строки в конец, таблицу целиком не пересобирает:
 * правки, сделанные в Excel, остаются на месте. Повторы адресов и артикулов
 * ловит сборка базы (src/Seeder.php) — с именем файла и номером строки.
 *
 * Формат таблицы — для Excel: UTF-8 с BOM, разделитель «;», строки через
 * CRLF, переносы внутри ячеек — LF. Столбцы — как в readSeedCsv().
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [target, ...batches] = process.argv.slice(2);
if (!target || !batches.length) {
  console.error('Запуск: node scripts/add-rows.mjs <таблица.csv> <партия.mjs> […]');
  process.exit(1);
}

// Порядок и состав — ровно как в template.csv и в readSeedCsv(): скрипт
// дописывает строки в конец существующей таблицы, и «почти такой же» набор
// столбцов здесь означает молча съехавшие значения. Так уже было: без
// «цена проверена» и «источник цены» адрес позиции уезжал в дату проверки,
// а столбец «адрес» оставался пустым.
const columns = ['статус', 'раздел', 'марка', 'артикул', 'другие обозначения', 'модель', 'наименование',
  'характеристики', 'подходит к', 'описание', 'источник', 'фото', 'права на фото',
  'цена', 'цена проверена', 'источник цены', 'адрес'];

const cell = (value) => {
  const text = String(value ?? '');
  return /[;"\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};

const lines = [];
let count = 0;

for (const batch of batches) {
  const { default: rows } = await import(pathToFileURL(path.resolve(batch)).href);
  let group = null;

  for (const r of rows) {
    for (const key of ['cat', 'brand', 'mpn', 'title', 'slug']) {
      if (!r[key]) throw new Error(`${batch}: у позиции ${r.mpn ?? '?'} не заполнено «${key}»`);
    }
    for (const [key, value] of r.specs ?? []) {
      if (!key || !value || key.includes(':')) throw new Error(`${batch}: плохая характеристика у ${r.mpn}: «${key}»`);
    }

    // Строка-комментарий перед каждой группой: в Excel таблица так
    // читается блоками, а сборка такие строки пропускает.
    const g = `${r.brand}: ${r.group ?? r.cat}`;
    if (g !== group) {
      lines.push(cell('# ' + g));
      group = g;
    }

    lines.push([
      r.status ?? '', r.cat, r.brand, r.mpn, r.codes ?? '', r.model ?? '', r.title,
      (r.specs ?? []).map(([k, v]) => `${k}: ${v}`).join('\n'),
      (r.fits ?? []).join('\n'),
      r.desc ?? '', r.src ?? '', r.image ?? '', r.rights ?? '',
      r.price ?? '', r.priceCheckedAt ?? '', r.priceSource ?? '', r.slug,
    ].map(cell).join(';'));
    count++;
  }
}

let text = existsSync(target) ? readFileSync(target, 'utf8') : '﻿' + columns.join(';') + '\r\n';
if (!text.endsWith('\n')) text += '\r\n';
writeFileSync(target, text + lines.join('\r\n') + '\r\n', 'utf8');

console.log(`Дописано позиций: ${count} → ${target}`);
console.log('Дальше: npm run photos — снимки, npm run prices -- --list — цены.');

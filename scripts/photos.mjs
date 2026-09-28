/**
 * СНИМКИ ТОВАРОВ С ОФИЦИАЛЬНЫХ СТРАНИЦ ПРОИЗВОДИТЕЛЕЙ
 * ============================================================================
 *   node scripts/photos.mjs                 # отчёт: что найдётся, ничего не пишет
 *   node scripts/photos.mjs --write         # скачать, привести к формату, сохранить
 *   node scripts/photos.mjs --only=kyocera  # одна марка
 *   node scripts/photos.mjs --slug=xxx      # одна позиция
 *   node scripts/photos.mjs --loose         # брать и снимки «под вопросом»
 *   node scripts/photos.mjs --squarify      # привести уже лежащие снимки к формату
 *   node scripts/photos.mjs --slug=xxx --from=<адрес снимка> --write
 *                                           # снимок, выбранный человеком
 *
 * ЗАЧЕМ. В таблице каталога у каждой позиции уже стоит ссылка на официальную
 * страницу производителя — оттуда брали характеристики. Снимок товара лежит
 * на той же странице. Скрипт идёт по этой ссылке и забирает его, чтобы
 * тысячу позиций не скачивать руками.
 *
 * ОТКУДА БРАТЬ МОЖНО, А ОТКУДА НЕЛЬЗЯ. Скрипт ходит только на сайты
 * производителей — список ниже, `MANUFACTURERS`. Витрины магазинов
 * (DNS, «Ситилинк», «Онлайн Трейд», Wildberries, Ozon и прочие) в список
 * не входят и никогда не войдут: их карточки снимает и обрабатывает
 * сам магазин, это его произведение. Уменьшение, обрезка и «изменение
 * пикселей» — переработка, на неё нужно то же разрешение, что и на копию.
 * Компенсация по ст. 1301 ГК — от 10 000 ₽ за одно изображение, и на каталоге
 * в тысячу позиций это не абстракция. Подробнее — README.
 *
 * ЧТО СКРИПТ ЗАПИСЫВАЕТ. Файл `<адрес>.jpg` в `catalog/public/assets/products/`
 * и строку в `catalog/seed/photos.json` — откуда снимок, когда взят, какой
 * у файла отпечаток. Таблицу товаров скрипт не трогает: её ведут руками
 * в Excel, и портить её разбором-сборкой нельзя. Столбцы «фото» и «права
 * на фото» остаются для снимков, которые прислал заказчик, — они сильнее
 * того, что нашёл скрипт.
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const seedDir = path.join(root, 'catalog', 'seed');
const photosDir = path.join(root, 'catalog', 'public', 'assets', 'products');
const manifestFile = path.join(seedDir, 'photos.json');

const args = process.argv.slice(2);
const write = args.includes('--write');
const loose = args.includes('--loose');
const squarify = args.includes('--squarify');
const onlyBrand = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.toLowerCase() ?? null;
const onlySlug = args.find((a) => a.startsWith('--slug='))?.split('=')[1] ?? null;
const fromUrl = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? null;

/**
 * Формат снимка в каталоге: квадрат на белом. Квадрат у всех одинаковый —
 * иначе сетка раздела выглядит как свалка из чужих карточек.
 *
 * Сторона квадрата подбирается под исходник и не превышает его: растянутый
 * снимок — мыло, а вписанный в заведомо большой квадрат теряется в белом
 * поле. Brother отдаёт 542×340 — он ляжет в квадрат 600, Canon 800×800 —
 * в квадрат 800.
 */
const SIDE_MAX = 1000;
const SIDE_MIN = 600;
const QUALITY = 82;
const MAX_BYTES = 220 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Разрешённые источники снимков. Ключ — окончание имени хоста.
 * Добавлять сюда можно только сайт производителя или дистрибьютора,
 * с которым у компании есть договор.
 */
const MANUFACTURERS = [
  'kyoceradocumentsolutions.ru', 'kyoceradocumentsolutions.eu', 'kyoceradocumentsolutions.com',
  'pantum.ru', 'pantum.com',
  'hp.com', 'hp.widen.net',
  'brother.ru', 'brother.eu', 'brother.com',
  'xerox.com',
  'canon.ru', 'canon.co.uk', 'canon-europe.com', 'canon.com',
  'epson.ru', 'epson.eu', 'epson.com',
  // Периферия и рабочее место, партия 29.09.2026.
  'onkron.ru',            // включая shop.onkron.ru — магазин производителя
  'westerndigital.com', 'toshiba-storage.com',
  'logitech.com', 'eposaudio.com', 'a4tech.com',
  'samsung.com', 'lg.com', 'acer.com', 'asus.com', 'mi.com', 'aoc.com',
  'msi.com',          // включая storage-asset.msi.com — их хранилище снимков
  'appmifile.com',    // хранилище снимков Xiaomi, адреса из og:image mi.com
  'adis.ws',          // библиотека снимков Canon
  'scene7.com',       // библиотека снимков Xerox и ряда других
];

/** Магазины и агрегаторы. Названы явно, чтобы отказ был внятным. */
const SHOPS = [
  'dns-shop.ru', 'citilink.ru', 'onlinetrade.ru', 'regard.ru', 'ozon.ru',
  'wildberries.ru', 'market.yandex.ru', 'sbermegamarket.ru', 'ulmart.ru',
  'komus.ru', 'vseinstrumenti.ru', 'avito.ru', 'aliexpress.ru',
];

/**
 * Страницы, на которых заведомо один товар. Для них og:image и разметка
 * товара считаются надёжными, даже если артикула в имени файла нет:
 * HP держит снимки в своей медиатеке под кодами вида `uzoubfclhe.png`,
 * и совпасть с артикулом они не могут в принципе.
 */
const ONE_PRODUCT_PAGES = [
  /\/\/(?:www\.)?hp\.com\/[^/]+\/products\/[^/]+\/product-details\/\d+/i,
  // Мониторы, партия 29.09.2026. У всех четверых снимок лежит под кодом
  // или хэшем — сопоставить с артикулом нечем, зато страница про один
  // товар, и в og:image у них именно снимок товара, а не баннер.
  /\/\/(?:www\.)?msi\.com\/[^/]+\/[^/]+\/Specification\/?$/i,
  /\/\/(?:www\.)?mi\.com\/[a-z-]+\/product\/[^/]+\/specs\/?$/i,
  /\/\/(?:www\.)?lg\.com\/[a-z-]+\/monitors\/[a-z0-9-]+\/?$/i,
  /\/\/(?:www\.)?acer\.com\/[a-z-]+\/monitors\/[^/]+\/[^/]+\/pdp\/[A-Za-z0-9.]+\/?$/i,
];

/**
 * Правила под отдельные сайты — когда снимок узнаётся не по артикулу
 * и не по разметке, а по своему признаку.
 *
 * Заводить такое правило стоит только там, где сайт ведёт себя
 * предсказуемо, и обязательно с объяснением: через полгода никто
 * не вспомнит, откуда взялся регэксп.
 *
 * Поля правила:
 *   page        — на какие страницы распространяется;
 *   image       — что на них считается снимком товара: выражение или
 *                 функция `(адрес, позиция) => да/нет`, если выбор зависит
 *                 от самой позиции (у накопителей — от ёмкости);
 *   anyStatus   — терпеть код ответа, если содержимое пришло полностью;
 *   sharedImage — производитель выкладывает один снимок на несколько
 *                 исполнений; повтор адреса у таких позиций законен
 *                 и заглушкой не считается.
 */
const SITE_RULES = [
  {
    name: 'магазин производителя ONKRON',
    // Сам onkron.ru источником быть не может: страницы товаров из его
    // карты сайта показывают «Product not found», а og:image пустой.
    // Рабочий источник — их же магазин, он отдаёт готовый HTML.
    page: /\/\/shop\.onkron\.ru\/product\//i,
    // Снимки лежат под числовыми именами: popup_images/27_0.png.
    // Совпасть с артикулом нечему, зато страница заведомо про один
    // товар, а `_0` — первый кадр галереи, то есть основной.
    image: /\/product_images\/popup_images\/\d+_0\.(?:png|jpe?g|webp)$/i,
    // Магазин отвечает кодом 404 при полном содержимом страницы.
    anyStatus: true,
  },
  {
    name: 'Western Digital: снимок на типоразмер корпуса, а не на ёмкость',
    page: /\/\/(?:www\.)?westerndigital\.com\/[a-z-]+\/products\//i,
    // Одна страница держит весь ряд: и 1 ТБ, и 5 ТБ. В галерее снимок
    // не на каждую ёмкость, а на корпус: папка `1tb` — это диски 1 и 2 ТБ,
    // `4tb` — от 3 ТБ и выше (у My Passport то же самое папками
    // `black/1-2tb` и `black/4-5tb`), и это честно: корпуса одинаковые.
    // Кадр берём тот, что WD сам ставит в og:image: `front` у Elements,
    // `Hero` у My Passport. Ёмкость читается из наименования позиции.
    image: (url, position) => {
      if (!/\/gallery\//i.test(url) || !/-(?:front|hero)\.png/i.test(url)) return false;
      const tb = Number(String(position.title).match(/(\d+)\s*ТБ/iu)?.[1] ?? 0);
      if (!tb) return false;
      return tb <= 2 ? /\/(?:1tb|1-2tb)\//i.test(url) : /\/(?:4tb|4-5tb)\//i.test(url);
    },
    sharedImage: true,
  },
  {
    name: 'Toshiba Storage: снимок товара отдельно от баннера',
    page: /\/\/(?:www\.)?toshiba-storage\.com\/products\//i,
    // В og:image у Toshiba рекламный баннер 1440×480, а снимок товара
    // лежит рядом под своим именем: `Main_Packshot_…` у Canvio Basics,
    // `…_canvio_ready_product.png` у Canvio Ready, `…_Gallery_Image_…`
    // у Canvio Flex. `Highlight_Product_Image` не берём намеренно —
    // на нём поверх снимка наклеена награда журнала.
    image: /\/uploads\/[^"']*(?:Main_Packshot|Gallery_Image|_canvio_[a-z]+_product)[^/]*\.png$/i,
    // Страница ряда общая, и снимок у 1, 2 и 4 ТБ тоже общий.
    sharedImage: true,
  },
  {
    name: 'A4Tech: снимок товара в галерее расцветки',
    page: /\/\/ru\.a4tech\.com\/product\.aspx/i,
    // og:image на странице нет вовсе, а в боковом меню висят миниатюры
    // соседних моделей (`/alanUpload/product/…`) — по ним скрипт брал бы
    // чужой товар. Снимки самого товара лежат отдельной папкой.
    image: /\/alanUpload\/colorImg\/img\//i,
  },
];

const ruleFor = (pageUrl) => SITE_RULES.find((r) => r.page.test(String(pageUrl ?? '')));

/** Проверка правила: выражение или функция от позиции. */
const ruleMatches = (rule, url, position) => (typeof rule.image === 'function'
  ? rule.image(url, position)
  : rule.image.test(url));

/**
 * Scene7 (`/is/image/…`) по умолчанию отдаёт мелкую рендицию: у Acer это
 * 400×336, хотя тот же адрес с `wid` даёт 1200×1007. Снимок от этого
 * не меняется — меняется размер, который просим. Библиотекой Scene7
 * пользуются Acer и Xerox, так что правило общее.
 */
const biggerIfScene7 = (url) => (/\/is\/image\//i.test(url) && !/[?&](?:wid|hei|w|h)=/i.test(url)
  ? url + (url.includes('?') ? '&' : '?') + 'wid=1200'
  : url);

/** Служебная графика: флаги, логотипы, иконки, баннеры, кнопки магазинов. */
const JUNK = /(favicon|apple-touch|sprite|logo|flag-|icon|banner|placeholder|no-?image|nav|mega-|hero-|\/themes\/|\/assets\/img\/|social|share|arrow|pixel|spacer|loader|_blank|dns\.png|wb\.png|ozon|shop\.png)/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const hostAllowed = (host) => MANUFACTURERS.some((d) => host === d || host.endsWith('.' + d));
const hostIsShop = (host) => SHOPS.some((d) => host === d || host.endsWith('.' + d));

// ── Чтение таблиц ───────────────────────────────────────────────────────────

/** Разбор CSV с точкой с запятой и переносами внутри ячеек — как у Seeder.php. */
function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const delimiter = (src.split('\n')[0].match(/;/g) || []).length
    >= (src.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
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
  return rows;
}

/** Латиница из названия — как slugify в Seeder.php, коротко. */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};
const slugify = (s, limit = 100) => s.toLowerCase()
  .replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, limit)
  .replace(/-+$/g, '');

async function readPositions() {
  const seed = JSON.parse(await readFile(path.join(seedDir, 'products.json'), 'utf8'));
  const list = [];

  for (const p of seed.products) {
    list.push({
      where: 'products.json',
      slug: p.slug,
      title: p.title,
      brand: p.brand ?? '',
      mpn: p.mpn ?? '',
      codes: '',
      model: p.model ?? '',
      source: '',                     // позиции из ВК — снимки свои, источник не нужен
      image: p.image ?? '',
      rights: 'own',
    });
  }

  for (const name of seed.csv ?? []) {
    const rows = parseCsv(await readFile(path.join(seedDir, name), 'utf8'));
    const header = rows[0].map((c) => c.replace(/^﻿/, '').trim().toLowerCase());
    const col = (k) => header.indexOf(k);
    const [iBrand, iMpn, iCodes, iModel, iTitle, iSpecs, iSource, iImage, iRights, iSlug] =
      ['марка', 'артикул', 'другие обозначения', 'модель', 'наименование', 'характеристики',
        'источник', 'фото', 'права на фото', 'адрес'].map(col);

    rows.slice(1).forEach((r, n) => {
      if (r.length < 2 || String(r[0]).trim().startsWith('#')) return;
      const title = (r[iTitle] ?? '').trim();
      if (!title) return;
      list.push({
        where: `${name}, строка ${n + 2}`,
        slug: (r[iSlug] ?? '').trim() || slugify(title),
        title,
        brand: (r[iBrand] ?? '').trim(),
        mpn: (r[iMpn] ?? '').trim(),
        codes: (r[iCodes] ?? '').trim(),
        model: (r[iModel] ?? '').trim(),
        yield: pagesYield((r[iSpecs] ?? '') + ' ' + title),
        source: (r[iSource] ?? '').trim(),
        image: (r[iImage] ?? '').trim(),
        rights: (r[iRights] ?? '').trim(),
      });
    });
  }

  return list;
}

// ── Поиск снимка на странице ────────────────────────────────────────────────

/** Все адреса картинок со страницы, с пометкой, откуда взялись. */
function collectCandidates(html, base) {
  const out = [];
  const seen = new Set();
  const push = (u, why) => {
    if (!u) return;
    let abs;
    try { abs = new URL(u.trim(), base).href; } catch { return; }
    if (!/^https?:/i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, why });
  };

  for (const m of html.matchAll(/<meta[^>]*>/gi)) {
    if (!/og:image|twitter:image/i.test(m[0])) continue;
    push(m[0].match(/content=["']([^"']+)["']/i)?.[1], 'og:image');
  }

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.image) {
          const v = n.image;
          if (typeof v === 'string') push(v, 'разметка товара');
          else if (Array.isArray(v)) v.forEach((x) => push(typeof x === 'string' ? x : x?.url, 'разметка товара'));
          else push(v.url ?? v.contentUrl, 'разметка товара');
        }
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch { /* чужая разметка бывает битой — это не наша забота */ }
  }

  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]
      ?? tag.match(/\sdata-(?:src|original|lazy)=["']([^"']+)["']/i)?.[1]
      ?? tag.match(/\ssrcset=["']([^"'\s,]+)/i)?.[1];
    if (src && /\.(jpe?g|png|webp)/i.test(src)) push(src, 'img');
  }

  // Прямые адреса в коде страницы: галереи часто собираются скриптом.
  for (const m of html.matchAll(/(?:https?:)?\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\)]*)?/gi)) {
    push(m[0], 'в коде страницы');
  }
  for (const m of html.matchAll(/["'](\/[^\s"'<>]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?)["']/gi)) {
    push(m[1], 'в коде страницы');
  }

  return out;
}

/**
 * Ресурс в страницах — из характеристик или названия («7 200 стр.»).
 *
 * Нужен потому, что часть производителей называет файлы не артикулом,
 * а ресурсом: у Pantum тонер-картридж TL-5120HP на 6 000 страниц лежит
 * под именем `4020-6000-1png.png` — «платформа 4020, 6000 страниц».
 * Совпасть с артикулом там нечему, а с ресурсом — есть.
 */
function pagesYield(text) {
  const m = String(text).match(/(\d[\d\s ]{2,})\s*стр/iu);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s ]/g, ''));
  return n >= 1000 ? n : null;
}

/** Обозначения позиции, по которым производитель называет файлы. */
const keysOf = (position) => [position.mpn, ...position.codes.split(/[,;\n]/), position.model]
  .map((k) => norm(k))
  .filter((k) => k.length >= 4);

/**
 * Насколько адрес похож на снимок именно этой позиции.
 *
 * Надёжный признак ровно один — обозначение товара в имени файла.
 * Производитель называет файлы по артикулу: TN2375_main.webp, TK1170.png,
 * 3484B002_CRG-725. Годятся и «другие обозначения»: у Pantum страница
 * картриджа PC-211P, а файл называется pc-211ev — тот же товар.
 *
 * Совпадения по одним цифрам мы НЕ берём. На проверке 84 позиций такое
 * совпадение трижды подставило чужой снимок: TL-420HP получил картинку
 * от TL-420X, а фотобарабан DL-420 — картинку тонера. Неверный снимок
 * в каталоге хуже отсутствующего: отсутствующий видно, неверный — нет.
 *
 * Всё остальное (og:image, разметка товара) идёт как «под вопросом»:
 * страница та самая, но производитель кладёт в og:image что угодно,
 * вплоть до снимка принтера на странице картриджа. Такие показываются
 * в отчёте и без `--loose` не скачиваются.
 */
function scoreCandidate(url, position) {
  const n = norm(url);
  const why = position._why?.get?.(url);
  const marked = why === 'og:image' || why === 'разметка товара';
  const onePage = ONE_PRODUCT_PAGES.some((re) => re.test(position.source));
  const byMpn = keysOf(position).some((k) => n.includes(k));
  // Ресурс засчитываем только у расходников: у аппарата «30 стр./мин»
  // и «до 5000 страниц в месяц» — числа из другой оперы.
  const byYield = position.yield !== null && position.yield !== undefined
    && /картридж|тонер|фотобарабан|драм/iu.test(position.title)
    && n.includes(String(position.yield));
  // Правило сайта сильнее совпадения по артикулу и отменяет его.
  // У ONKRON код модели стоит и в адресах рекламных баннеров
  // (`g120-b-header-desc.webp`), и по артикулу скрипт хватал именно их
  // вместо снимка товара. Раз для сайта известно, где лежит снимок, —
  // всё остальное на нём не снимок, каким бы похожим ни выглядел адрес.
  const rule = ruleFor(position.source);
  const byRule = rule ? ruleMatches(rule, url, position) : false;
  if (rule && !byRule) return { score: -1000, exact: false };

  const exact = byRule || (!rule && (byMpn || byYield || (onePage && marked)));
  const via = byRule ? 'правило сайта' : byMpn ? 'по артикулу' : byYield ? 'по ресурсу'
    : exact ? 'разметка страницы' : (why ?? '');

  let score = exact ? 100 : 0;
  if (byMpn && !rule) score += 20;        // артикул надёжнее ресурса
  if (JUNK.test(url)) return { score: -1000, exact: false };
  if (why === 'og:image') score += 40;
  if (why === 'разметка товара') score += 35;
  if (!exact && !why) return { score: -1000, exact: false };

  // Размер в имени файла: 540x540, 600x600, w=800 — берём, что крупнее.
  const dims = [...url.matchAll(/(\d{3,4})\s*[x×]\s*(\d{3,4})/g)].map((m) => Math.max(+m[1], +m[2]));
  const wq = Number(url.match(/[?&](?:w|width)=(\d{3,4})/)?.[1] ?? 0);
  score += Math.min(30, Math.round(Math.max(0, ...dims, wq) / 40));

  return { score, exact, via };
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'ru,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const html = decodeEntities(await r.text());

  // Код ответа игнорируем только там, где это записано правилом сайта,
  // и только если страница действительно пришла: магазин ONKRON отдаёт
  // 404 вместе с полным содержимым карточки.
  const rule = ruleFor(url);
  if (!r.ok && !(rule?.anyStatus && html.length > 2000)) {
    throw new Error(`страница ответила ${r.status}`);
  }
  return { html, finalUrl: r.url };
}

async function fetchImage(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/*,*/*' },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`снимок ответил ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2048) throw new Error('файл подозрительно мал');
  return buf;
}

/** Квадрат SIDE×SIDE на белом, JPEG. Прозрачный фон становится белым. */
async function toCatalogJpeg(buf) {
  const meta = await sharp(buf).metadata();
  if ((meta.width ?? 0) < 300 || (meta.height ?? 0) < 300) {
    throw new Error(`мелкий снимок ${meta.width}×${meta.height}`);
  }

  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const side = Math.min(SIDE_MAX, Math.max(SIDE_MIN, longest));

  const fitted = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const { width, height } = fitted.info;
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);

  let quality = QUALITY;
  let out;
  do {
    out = await sharp(fitted.data)
      .extend({
        top, left,
        bottom: side - height - top,
        right: side - width - left,
        background: '#ffffff',
      })
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer();
    quality -= 8;
  } while (out.length > MAX_BYTES && quality >= 50);

  return { buffer: out, side, source: `${meta.width}×${meta.height} ${meta.format}` };
}

// ── Работа ──────────────────────────────────────────────────────────────────

async function loadManifest() {
  if (!existsSync(manifestFile)) return { _comment: '', photos: {} };
  return JSON.parse(await readFile(manifestFile, 'utf8'));
}

async function saveManifest(manifest) {
  manifest._comment = 'Снимки, снятые scripts/photos.mjs с официальных страниц производителей. '
    + 'Файл ведёт скрипт, руками не править. Происхождение каждого снимка нужно, '
    + 'чтобы через полгода можно было ответить, откуда он взят.';
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Привести уже лежащие снимки к общему формату. */
async function runSquarify() {
  const files = (await readdir(photosDir)).filter((f) => f.endsWith('.jpg'));
  let changed = 0;

  for (const f of files) {
    const file = path.join(photosDir, f);
    const before = await readFile(file);
    const meta = await sharp(before).metadata();
    if (meta.width === meta.height) continue;          // квадрат уже есть

    const { buffer, side } = await toCatalogJpeg(before);
    console.log(`  ${f}: ${meta.width}×${meta.height} → ${side}×${side}, `
      + `${Math.round(before.length / 1024)} → ${Math.round(buffer.length / 1024)} КБ`);
    if (write) await writeFile(file, buffer);
    changed++;
  }

  console.log(changed
    ? `\n${write ? 'Приведено' : 'Привести к формату'}: ${changed} из ${files.length}.`
      + (write ? '' : ' Повторите с --write.')
    : '\nВсе снимки уже в формате.');
}

async function run() {
  const positions = await readPositions();
  const manifest = await loadManifest();

  const todo = positions.filter((p) => {
    if (onlySlug && p.slug !== onlySlug) return false;
    if (onlyBrand && p.brand.toLowerCase() !== onlyBrand) return false;
    if (p.image) return false;                                  // снимок прислал заказчик
    if (existsSync(path.join(photosDir, p.slug + '.jpg'))) return false;
    return true;
  });

  const without = positions.filter((p) => !p.image
    && !existsSync(path.join(photosDir, p.slug + '.jpg'))).length;

  console.log(`Позиций всего ${positions.length}, со снимком ${positions.length - without}, без снимка ${without}.`);
  if (onlyBrand || onlySlug) console.log(`Отобрано по ключу: ${todo.length}.`);
  console.log(write ? '\nРежим записи.\n' : '\nОтчёт. Ничего не скачивается, для записи — --write.\n');

  const stats = { ok: 0, shop: 0, foreign: 0, doubtful: 0, failed: 0 };
  const misses = [];
  const doubts = [];
  const picks = [];

  // ── Первый проход: выбрать снимок, ничего не скачивая ─────────────────────
  for (const p of todo) {
    const label = `${p.brand} ${p.mpn}`.trim() || p.slug;

    if (!p.source) {
      misses.push([label, 'нет ссылки на официальную страницу', p.where]);
      continue;
    }

    let host;
    try { host = new URL(p.source).host.replace(/^www\./, ''); }
    catch { stats.failed++; misses.push([label, 'битая ссылка в столбце «источник»', p.where]); continue; }

    if (hostIsShop(host)) {
      stats.shop++;
      misses.push([label, `${host} — витрина магазина, снимки оттуда не берём`, p.where]);
      continue;
    }
    if (!hostAllowed(host)) {
      stats.foreign++;
      misses.push([label, `${host} — не в списке официальных источников`, p.where]);
      continue;
    }

    try {
      const { html, finalUrl } = await fetchText(p.source);
      const candidates = collectCandidates(html, finalUrl);
      p._why = new Map(candidates.map((c) => [c.url, c.why]));

      const ranked = candidates
        .map((c) => ({ ...c, ...scoreCandidate(c.url, p) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);

      if (!ranked.length) {
        // Pantum называет файлы `21.png` и `4020-6000-1png.png` — совпасть
        // с артикулом тут нечему. Показываем, что на странице вообще есть,
        // чтобы человек открыл три ссылки, а не искал снимок по сайту.
        const maybe = candidates
          .filter((c) => c.why !== 'в коде страницы' && !JUNK.test(c.url))
          .slice(0, 3)
          .map((c) => c.url);
        misses.push([label, 'на странице не нашёлся снимок этой позиции', p.source, maybe]);
        continue;
      }

      picks.push({ p, label, best: ranked[0] });
    } catch (e) {
      stats.failed++;
      misses.push([label, e.message, p.source]);
    }
  }

  // ── Заглушки: один и тот же файл у разных позиций ─────────────────────────
  // Xerox отдаёт TONER_600x600.jpg и картриджу 106R02773, и 006R04403.
  // Это не снимок товара, а картинка «тонер вообще». Ловится тем, что адрес
  // повторяется: у настоящих снимков он у каждой позиции свой.
  //
  // Исключение — сайты с пометкой `sharedImage`: у накопителей корпус
  // на 1 и 2 ТБ один и тот же, и производитель выкладывает на них один
  // снимок. Это не заглушка, а настоящая фотография товара, просто общая
  // для нескольких ёмкостей.
  const seenUrl = new Map();
  for (const pick of picks) seenUrl.set(pick.best.url, (seenUrl.get(pick.best.url) ?? 0) + 1);
  for (const pick of picks) {
    if (ruleFor(pick.p.source)?.sharedImage) continue;
    const n = seenUrl.get(pick.best.url);
    if (n > 1) {
      pick.best.exact = false;
      pick.best.duplicate = n;
    }
  }

  // ── Второй проход: отчёт или запись ───────────────────────────────────────
  for (const { p, label, best } of picks) {
    if (!best.exact && !loose) {
      stats.doubtful++;
      doubts.push([label, best.url, p.source,
        best.duplicate ? `тот же файл ещё у ${best.duplicate - 1} позиц. — похоже на заглушку` : '']);
      continue;
    }

    if (!write) {
      console.log(`  ${label.padEnd(24)} ${(best.via || best.why).padEnd(16)} ${best.url.slice(0, 92)}`);
      stats.ok++;
      continue;
    }

    try {
      const imageUrl = biggerIfScene7(best.url);
      const raw = await fetchImage(imageUrl);
      const { buffer, source } = await toCatalogJpeg(raw);
      await mkdir(photosDir, { recursive: true });
      await writeFile(path.join(photosDir, p.slug + '.jpg'), buffer);

      manifest.photos[p.slug] = {
        page: p.source,
        image: imageUrl,
        rights: 'manufacturer',
        match: best.exact ? (best.via || 'по артикулу') : 'под вопросом, взято с --loose',
        taken: new Date().toISOString().slice(0, 10),
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
      };

      console.log(`  ${label.padEnd(24)} ${source} → ${Math.round(buffer.length / 1024)} КБ  ${p.slug}.jpg`);
      stats.ok++;
    } catch (e) {
      stats.failed++;
      misses.push([label, e.message, best.url]);
    }
  }

  if (write) await saveManifest(manifest);

  console.log(`\n${write ? 'Снято' : 'Нашлось'}: ${stats.ok} из ${todo.length}.`);

  if (doubts.length) {
    console.log(`\nНашлось, но артикула в имени файла нет — посмотрите глазами (${doubts.length}).`
      + ' Снимок открывается по ссылке; если он верный, скачайте его и положите'
      + ' в catalog/public/assets/products/ под именем позиции, либо запустите с --loose:');
    for (const [label, image, page, note] of doubts) {
      console.log(`  ${label}${note ? ` — ${note}` : ''}`);
      console.log(`     снимок: ${image}`);
      console.log(`     страница: ${page}`);
    }
  }

  if (misses.length) {
    console.log('\nОстаётся руками:');
    for (const [label, why, where, maybe] of misses) {
      console.log(`  ${label.padEnd(24)} ${why}`);
      console.log(`  ${''.padEnd(24)} ${where}`);
      for (const m of maybe ?? []) console.log(`  ${''.padEnd(24)} ? ${m}`);
    }
  }

  const refused = stats.shop + stats.foreign;
  if (refused) {
    console.log(`\nОтказов по источнику: ${refused}. Снимки берём только с сайтов`
      + ' производителей — список в начале scripts/photos.mjs.');
  }
}

/**
 * Один снимок по прямому адресу: `--slug=<адрес> --from=<адрес снимка>`.
 *
 * Нужен там, где сопоставить автоматически нечем. Pantum называет файлы
 * `21.png` и `4020-6000-1png.png` — скрипт такие не берёт и вместо этого
 * показывает по три ссылки-кандидата. Человек открывает их, выбирает
 * верную и закрывает позицию этой командой. Источник всё равно проверяется
 * по списку разрешённых хостов: из магазина снимок не возьмётся и так.
 */
async function runFrom() {
  if (!onlySlug) {
    console.error('С --from нужен и --slug=<адрес позиции>.');
    process.exit(1);
  }

  const host = new URL(fromUrl).host.replace(/^www\./, '');
  if (hostIsShop(host) || !hostAllowed(host)) {
    console.error(`${host} — не сайт производителя. Снимки берём только оттуда`
      + ' (список в начале scripts/photos.mjs, причины в README).');
    process.exit(1);
  }

  const positions = await readPositions();
  const position = positions.find((p) => p.slug === onlySlug);
  if (!position) {
    console.error(`Нет позиции с адресом «${onlySlug}» — проверьте столбец «адрес» в таблице.`);
    process.exit(1);
  }

  const { buffer, side, source } = await toCatalogJpeg(await fetchImage(biggerIfScene7(fromUrl)));
  console.log(`${position.title}\n  ${source} → ${side}×${side}, ${Math.round(buffer.length / 1024)} КБ`);

  if (!write) {
    console.log('\nНичего не записано. Повторите с --write.');
    return;
  }

  await mkdir(photosDir, { recursive: true });
  await writeFile(path.join(photosDir, onlySlug + '.jpg'), buffer);

  const manifest = await loadManifest();
  manifest.photos[onlySlug] = {
    page: position.source,
    image: fromUrl,
    rights: 'manufacturer',
    match: 'выбрано человеком',
    taken: new Date().toISOString().slice(0, 10),
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
  };
  await saveManifest(manifest);

  console.log(`\nСохранено: ${onlySlug}.jpg`);
}

if (squarify) await runSquarify();
else if (fromUrl) await runFrom();
else await run();

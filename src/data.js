/**
 * data.js — генерация данных магазина.
 *
 * В прототипе нет статического JSON: все магазины создаются во время запуска
 * функцией `generateShopData()`. Генератор использует «сид» (seed), поэтому
 * результат воспроизводится от запуска к запуску — так удобно сравнивать
 * 2D-план с 3D-видом и отлаживать алгоритм раскладки.
 *
 * Структура одного магазина (техническое задание v1.3):
 *   { id, name, width, depth, color }
 * где `width`/`depth` — размер «пятна» магазина на плоскости XZ, а высота у
 * всех магазинов одинаковая и равна `SHOP_HEIGHT`.
 */

/** Высота объёма каждого магазина (юниты, ось Y). */
export const SHOP_HEIGHT = 2;

/** Границы случайных размеров магазина (включительно). */
export const SHOP_MIN_SIZE = 2;
export const SHOP_MAX_SIZE = 8;

/** Сколько магазинов создаём по умолчанию. */
export const SHOP_COUNT = 100;

/**
 * Палитра. Вручную подобранные цвета (а не случайный HSL) дают читаемую
 * картинку: соседние магазины не превращаются в неоновую кашу, и на любом
 * цвете хорошо читается белая подпись.
 */
const PALETTE = [
  0xff6b6b, 0xffa94d, 0xffd43b, 0xa9e34b, 0x51cf66, 0x38d9a9,
  0x3bc9db, 0x4dabf7, 0x5c7cfa, 0x845ef7, 0xcc5de8, 0xf06595,
  0xff8787, 0xff922b, 0xe8c547, 0x94d82d, 0x20c997, 0x22b8cf,
  0x339af0, 0x7048e8, 0xbe4bdb, 0xe64980, 0xc2255c, 0x0ca678
];

/**
 * Каталог брендов: пары [название, категория]. 120 уникальных брендов, чтобы
 * магазин из 100 единиц никогда не потребовал дублировать названия.
 */
const CATALOGUE = [
  ['Nike Store', 'Fashion'], ['Zara Boutique', 'Fashion'], ['H&M Fashion', 'Fashion'],
  ['Uniqlo Corner', 'Fashion'], ['Adidas Originals', 'Fashion'], ['Supreme Vault', 'Fashion'],
  ['Gucci Gallery', 'Fashion'], ['Prada House', 'Fashion'], ['Versace Room', 'Fashion'],
  ['Burberry Lodge', 'Fashion'], ["Levi's Denim Co.", 'Fashion'], ['Urban Threads', 'Fashion'],
  ['Velvet & Co.', 'Fashion'], ["Trendy Moda's", 'Fashion'], ['Silk Route', 'Fashion'],
  ['Leather Loft', 'Fashion'], ['Denim District', 'Fashion'], ['Style Street', 'Fashion'],
  ['Fashion Hub', 'Fashion'], ['Runners Footwear', 'Fashion'], ['Linen & Co.', 'Fashion'],
  ['Apple Store', 'Electronics'], ['Samsung Galaxy', 'Electronics'], ['Sony Experience', 'Electronics'],
  ['Microsoft Zone', 'Electronics'], ['Dell Showcase', 'Electronics'], ['HP Pavilion', 'Electronics'],
  ['Tech Haven', 'Electronics'], ['Gadget Garage', 'Electronics'], ['PlayStation Vault', 'Electronics'],
  ['Xbox Arena', 'Electronics'], ['Nintendo Corner', 'Electronics'], ['Drone World', 'Electronics'],
  ['Circuit City', 'Electronics'], ['Byte Electronics', 'Electronics'], ['Robot Lab', 'Electronics'],
  ['VR Universe', 'Electronics'], ['Phone Repair', 'Services'], ['Electric Living', 'Electronics'],
  ['Starbucks Coffee', 'Food & Drink'], ["McDonald's Corner", 'Food & Drink'],
  ['Pizza Express', 'Food & Drink'], ['Sushi Zen', 'Food & Drink'], ['Burger Kingdom', 'Food & Drink'],
  ['Tacos El Sol', 'Food & Drink'], ['Donut Delight', 'Food & Drink'], ['Cold Brew Co.', 'Food & Drink'],
  ['Tea Garden', 'Food & Drink'], ['Noodle House', 'Food & Drink'], ['Grill & Smoke', 'Food & Drink'],
  ['Waffle Works', 'Food & Drink'], ['Gelato Heaven', 'Food & Drink'], ['Juice Bar', 'Food & Drink'],
  ['Bubble Tea Lab', 'Food & Drink'], ['Curry House', 'Food & Drink'], ['BBQ Junction', 'Food & Drink'],
  ['Fresh Baked Co.', 'Food & Drink'], ['The Coffee Bean', 'Food & Drink'], ['Aroma Bakery', 'Food & Drink'],
  ['Sephora Beauty', 'Beauty & Health'], ["L'Oreal Paris", 'Beauty & Health'],
  ['Bath & Body', 'Beauty & Health'], ['Glossier Lab', 'Beauty & Health'],
  ['The Body Shop', 'Beauty & Health'], ['Pure Essence', 'Beauty & Health'], ['Glow Pharmacy', 'Beauty & Health'],
  ['FitLife Gym', 'Beauty & Health'], ['Yoga Haven', 'Beauty & Health'], ['Barber & Blade', 'Beauty & Health'],
  ['Nail Art Studio', 'Beauty & Health'], ['Optic Vision', 'Beauty & Health'],
  ['Hearing Health', 'Beauty & Health'], ['Wellness Spa', 'Beauty & Health'],
  ['IKEA Showroom', 'Home'], ['Home Depot Pro', 'Home'], ['Pottery Barn', 'Home'],
  ['West Elm Decor', 'Home'], ['Crate & Barrel', 'Home'], ['Bed Bath Beyond', 'Home'],
  ['Williams Sonoma', 'Home'], ['Rayon Furniture', 'Home'], ['Lush Garden Center', 'Home'],
  ['Plant Haven', 'Home'], ['Tidy Tools', 'Home'], ['Kitchen Craft', 'Home'],
  ['GameStop', 'Entertainment'], ['Toys R Us Fun', 'Entertainment'], ['LEGO World', 'Entertainment'],
  ['Mattel Corner', 'Entertainment'], ['Disney Store', 'Entertainment'], ['F1 Merch Shop', 'Entertainment'],
  ['Movie Tickets', 'Entertainment'], ['Music Records', 'Entertainment'], ['Comic Store', 'Entertainment'],
  ['Book Shop', 'Entertainment'], ['Art Supply', 'Entertainment'], ['Toy Bazaar', 'Entertainment'],
  ['Sports Direct', 'Sports'], ['Bike World', 'Sports'], ['Golf Corner', 'Sports'],
  ['Outdoor Depot', 'Sports'], ['Swimming Pool Supply', 'Sports'], ['Yoga Mat Shop', 'Sports'],
  ['Pro Fitness Store', 'Sports'], ['Ski & Board', 'Sports'], ['Court Side Sports', 'Sports'],
  ['First Bank', 'Services'], ['Travel Agency', 'Services'], ['Post Office', 'Services'],
  ['Dry Cleaners', 'Services'], ['Florist', 'Services'], ['Gift Corner', 'Services'],
  ['Stationery Express', 'Services'], ['Pet Store', 'Services'], ['Auto Accessories', 'Services'],
  ['Jewelry Atelier', 'Services'], ['Watch Boutique', 'Services'], ['Perfume House', 'Services'],
  ['Antiques Row', 'Services'], ['Souvenir Stand', 'Services'], ['Key Cutting', 'Services']
];

/**
 * Первый магазин зафиксирован, чтобы данные всегда начинались с примера из
 * технического задания.
 */
const FLAGSHIP = { id: 'shop_001', name: 'Apple Store', width: 4, depth: 4, color: 0xffaa00, category: 'Electronics' };

/**
 * Генератор случайных чисел mulberry32 — маленький, быстрый и
 * воспроизводимый: одинаковый seed всегда даёт одинаковую последовательность.
 * @param {number} seed
 * @returns {() => number} функция, возвращающая число из [0, 1)
 */
export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Случайное целое число из диапазона [min, max].
 * @param {() => number} random
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Перемешать массив в случайном порядке (алгоритм Фишера — Йетса).
 * @param {Array} array
 * @param {() => number} random
 */
function shuffle(array, random) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

/**
 * Немного изменить цвет, чтобы два магазина с одинаковым базовым цветом не
 * выглядели клонами, но оставались в одной цветовой семье.
 *
 * ВАЖНО: функция делает РОВНО ТРИ вызова random(). От количества вызовов
 * зависит вся дальнейшая последовательность генератора, а значит — размеры
 * всех следующих магазинов и итоговая раскладка. Менять это число нельзя.
 *
 * @param {number} hex базовый цвет
 * @param {() => number} random
 * @returns {number} цвет в виде числа
 */
function jitterColor(hex, random) {
  const brightness = 0.9 + random() * 0.2; // 1) общая яркость
  const warmth = (random() - 0.5) * 0.16; // 2) сдвиг в тёплую/холодную сторону
  const accent = random(); // 3) выбор канала-акцента

  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;

  // Чуть сдвигаем цвет в сторону тепла...
  const channels = [r * brightness + warmth, g * brightness, b * brightness - warmth];

  // ...и подкрашиваем один из каналов, чтобы цвета не совпадали.
  const channel = accent < 0.33 ? 0 : accent < 0.66 ? 1 : 2;
  channels[channel] = Math.min(1, channels[channel] * 1.12);

  const to255 = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return (to255(channels[0]) << 16) | (to255(channels[1]) << 8) | to255(channels[2]);
}

/**
 * Создать список магазинов.
 *
 * @param {number} [count=100] сколько магазинов нужно
 * @param {object} [options]
 * @param {number} [options.seed=20260121] сид генератора (одинаковый seed = одинаковый магазин)
 * @param {number} [options.minSize=2] минимальный размер по ширине/глубине
 * @param {number} [options.maxSize=8] максимальный размер по ширине/глубине
 * @returns {Array<{id:string,name:string,width:number,depth:number,color:number,category:string,area:number}>}
 */
export function generateShopData(count = SHOP_COUNT, options = {}) {
  const {
    seed = 20260121,
    minSize = SHOP_MIN_SIZE,
    maxSize = SHOP_MAX_SIZE
  } = options;

  const total = Math.max(0, Math.floor(count));
  const random = createRandom(seed);
  const shops = [];

  if (total === 0) return shops;

  // 1. Первый магазин — фиксированный (пример из технического задания).
  shops.push({
    id: FLAGSHIP.id,
    name: FLAGSHIP.name,
    width: FLAGSHIP.width,
    depth: FLAGSHIP.depth,
    color: FLAGSHIP.color,
    category: FLAGSHIP.category,
    area: FLAGSHIP.width * FLAGSHIP.depth
  });

  // 2. Перемешиваем каталог, чтобы категории чередовались по всему ТЦ.
  const pool = shuffle(CATALOGUE.slice(), random);

  for (let i = 1; i < total; i++) {
    const entry = pool[(i - 1) % pool.length];
    // Если магазинов больше, чем брендов, добавляем номер к названию.
    const name = pool.length >= total ? entry[0] : `${entry[0]} ${Math.floor((i - 1) / pool.length) + 1}`;
    const width = randomInt(random, minSize, maxSize);
    const depth = randomInt(random, minSize, maxSize);
    const color = jitterColor(PALETTE[randomInt(random, 0, PALETTE.length - 1)], random);

    shops.push({
      id: `shop_${String(i + 1).padStart(3, '0')}`,
      name,
      width,
      depth,
      color,
      category: entry[1],
      area: width * depth
    });
  }

  return shops;
}

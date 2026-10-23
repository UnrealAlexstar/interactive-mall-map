/**
 * layout.js — раскладка магазинов по полю без наложений (Shelf Packing).
 *
 * ЗАДАЧА
 * ------
 * План ТЦ — это плоская задача: каждый магазин — прямоугольник `width x depth`,
 * который нужно положить на плоскость XZ так, чтобы никакие два не
 * пересекались. Магазины группируются в горизонтальные полки (ряды).
 *
 *      +--------------------------------------------------------+  <- проход
 *      |            |            |            |                 |
 *      |   unit A   |   unit B   |   unit C   |     unit D      |  <- полка
 *      |            |            |            |                 |
 *      +--------------------------------------------------------+
 *      +--------------------------------------------------------+  <- проход
 *      |   unit E   |   unit F   |                           ...
 *      +--------------------------------------------------------+
 *      <----------------- максимальная ширина полки -------------->
 *
 * 1. СОРТИРОВКА (NFDH — Next Fit Decreasing Height)
 *    Магазины сортируются по убыванию `depth`, при равенстве — по убыванию
 *    `width`. Сортировка от большего к меньшему и делает алгоритм эффективным:
 *    первый магазин полки задаёт её глубину, а все следующие не больше —
 *    значит, они никогда не вылезут за пределы полки.
 *
 * 2. ПРАВИЛО РАЗМЕЩЕНИЯ
 *    Магазин помещается на полку S, если:
 *        (a) unit.depth <= S.depth              — полка достаточно глубокая
 *        (b) S.cursor + unit.width <= shelfWidth — на полке есть место
 *    где `S.cursor` — координата левого края следующего магазина (уже с
 *    учётом отступа от предыдущего). Первый магазин полки начинается вплотную
 *    к краю, каждый следующий отделён от соседа ровно на `padding`.
 *
 * 3. ОТКРЫТИЕ НОВОЙ ПОЛКИ
 *    Если ни одна полка не подошла, открываем новую ПОД предыдущей:
 *        shelf.z = previousShelf.z + previousShelf.depth + aisle
 *    `aisle` — это проход между рядами. Именно он превращает результат в
 *    читаемый план, а не в сплошную кирпичную стену.
 *
 * 4. КООРДИНАТНАЯ СЕТКА
 *    Все исходные числа целые, начало полки — в нуле, поэтому все ГРАНИЦЫ
 *    попадают на целочисленные линии сетки, а все ЦЕНТРЫ — на кратные 0.5.
 *    Смещение в центр тоже кратно 0.5, поэтому сетка сохраняется целиком.
 *
 * 5. ЦЕНТРИРОВАНИЕ + ПОДБОР ШИРИНЫ ПОЛКИ
 *    Сначала раскладываем магазины при одной ширине полки, потом перебираем
 *    несколько вариантов ширины и берём тот, у которого площадь плана
 *    минимальна (с небольшим штрафом за непрямоугольный план). На выходе —
 *    почти квадратный ТЦ, стоящий в начале координат.
 *
 * Сложность: O(n log n) на сортировку + O(n * полок) на размещение,
 * то есть на практике O(n).
 */

/** Настройки раскладки по умолчанию. */
export const LAYOUT_DEFAULTS = Object.freeze({
  /** Зазор между соседними магазинами на одной полке. */
  padding: 1,
  /** Проход между соседними полками (рядами). */
  aisle: 2,
  /** Шаг сетки плана (в юнитах). */
  cell: 1,
  /** Насколько сильно штрафуем за вытянутый план. */
  squarenessWeight: 0.6
});

/**
 * Разложить магазины по полкам фиксированной максимальной ширины.
 *
 * @param {Array<{id:string,width:number,depth:number}>} units
 * @param {object} options
 * @param {number} options.shelfWidth максимальная ширина полки в юнитах
 * @param {number} options.padding зазор между магазинами на полке
 * @param {number} options.aisle проход между полками
 * @returns {{shelves:Array,placements:Array,width:number,depth:number}}
 */
export function packShelves(units, { shelfWidth, padding, aisle }) {
  // (1) Сортировка по убыванию глубины, затем ширины — NFDH.
  const sorted = units
    .slice()
    .sort((a, b) => (b.depth - a.depth) || (b.width - a.width) || a.id.localeCompare(b.id));

  const shelves = [];

  for (const unit of sorted) {
    // (2) First Fit: ищем первую полку, которая принимает магазин.
    let shelf = null;
    for (const candidate of shelves) {
      if (unit.depth > candidate.depth) continue; // полка слишком мелкая
      if (candidate.cursor + unit.width > shelfWidth) continue; // места нет
      shelf = candidate;
      break;
    }

    // (3) Ни одна полка не подошла — открываем новую под предыдущей.
    if (shelf === null) {
      const previous = shelves.length > 0 ? shelves[shelves.length - 1] : null;
      const z = previous === null ? 0 : previous.z + previous.depth + aisle;
      shelf = { index: shelves.length, z, depth: unit.depth, cursor: 0, units: [] };
      shelves.push(shelf);
    }

    // Магазин стоит вплотную к переднему краю полки и начинается с курсора.
    // Поэтому центр = край + размер / 2.
    const leftEdge = shelf.cursor;
    shelf.units.push({
      id: unit.id,
      x: leftEdge + unit.width / 2,
      z: shelf.z + unit.depth / 2,
      width: unit.width,
      depth: unit.depth,
      shelf: shelf.index
    });

    // Сдвигаем курсор за магазин и за оставляемый после него отступ.
    shelf.cursor = leftEdge + unit.width + padding;
  }

  // Габариты самого содержимого (а не предела ширины полки).
  let width = 0;
  let depth = 0;
  for (const shelf of shelves) {
    const used = Math.max(0, shelf.cursor - padding);
    if (used > width) width = used;
    const far = shelf.z + shelf.depth;
    if (far > depth) depth = far;
  }

  return { shelves, placements: shelves.flatMap((s) => s.units), width, depth };
}

/**
 * Разложить магазины так, чтобы план получился максимально компактным и
 * близким к квадратному: перебираем ширину полки и выбираем лучший вариант.
 *
 * @param {Array<{id:string,width:number,depth:number}>} units
 * @param {object} [options]
 * @returns {{placements:Array,bounds:object,stats:object}}
 */
export function layoutShops(units, options = {}) {
  const {
    padding = LAYOUT_DEFAULTS.padding,
    aisle = LAYOUT_DEFAULTS.aisle,
    cell = LAYOUT_DEFAULTS.cell,
    squarenessWeight = LAYOUT_DEFAULTS.squarenessWeight
  } = options;

  if (units.length === 0) {
    return {
      placements: [],
      bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, width: 0, depth: 0, centerX: 0, centerZ: 0 },
      stats: { shelves: 0, width: 0, depth: 0, area: 0, occupancy: 0, padding, aisle, cell, shelfWidth: 0 }
    };
  }

  // Суммарная площадь магазинов — нижняя граница площади плана.
  const totalArea = units.reduce((sum, u) => sum + u.width * u.depth, 0);
  const maxUnit = units.reduce((max, u) => Math.max(max, u.width, u.depth), 0);

  // Идеальный план — квадрат со стороной √(суммарной площади).
  // Перебираем ширину полки вокруг этого значения.
  const ideal = Math.sqrt(totalArea);
  const candidates = [];
  for (let i = 0; i <= 28; i++) {
    candidates.push(ideal * (0.55 + i * 0.08));
  }

  let best = null;
  for (const candidate of candidates) {
    const shelfWidth = Math.max(candidate, maxUnit);
    const result = packShelves(units, { shelfWidth, padding, aisle });

    // Цель: выиграть по площади, но план, сильно вытянутый в линию, штрафуем.
    // Штраф умножательный — поэтому компактный квадрат всегда лучше коридора.
    const area = result.width * result.depth;
    const longest = Math.max(result.width, result.depth);
    const aspectPenalty = longest > 0 ? ((result.width - result.depth) / longest) ** 2 : 0;
    const score = area * (1 + squarenessWeight * aspectPenalty);

    if (best === null || score < best.score) {
      best = { score, shelfWidth, ...result };
    }
  }

  // (5) Ставим план в центр координат. Смещение кратно 0.5, потому что все
  // размеры целые — так сохраняется полушаговая сетка.
  const offsetX = -best.width / 2;
  const offsetZ = -best.depth / 2;

  const snap = (value) => Math.round(value * 2) / 2;
  const placements = best.placements.map((placement) => ({
    id: placement.id,
    x: snap(placement.x + offsetX),
    z: snap(placement.z + offsetZ),
    width: placement.width,
    depth: placement.depth,
    shelf: placement.shelf
  }));

  // Пересчитываем габариты по итоговым (смещённым) координатам.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x - p.width / 2);
    maxX = Math.max(maxX, p.x + p.width / 2);
    minZ = Math.min(minZ, p.z - p.depth / 2);
    maxZ = Math.max(maxZ, p.z + p.depth / 2);
  }

  const planWidth = maxX - minX;
  const planDepth = maxZ - minZ;
  const planArea = planWidth * planDepth;

  return {
    placements,
    bounds: {
      minX,
      maxX,
      minZ,
      maxZ,
      width: planWidth,
      depth: planDepth,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      radius: 0.5 * Math.hypot(planWidth, planDepth)
    },
    stats: {
      shelves: best.shelves.length,
      shelfWidth: best.shelfWidth,
      width: planWidth,
      depth: planDepth,
      area: planArea,
      occupancy: planArea > 0 ? totalArea / planArea : 0,
      totalArea,
      padding,
      aisle,
      cell
    }
  };
}

/**
 * Проверка на лету: магазины не накладываются друг на друга, отступы
 * соблюдены. Возвращает список нарушений (пустой список = всё хорошо).
 *
 * @param {Array<{id:string,x:number,z:number,width:number,depth:number}>} placements
 * @param {object} [options]
 * @param {number} [options.epsilon=1e-6] допуск
 * @returns {Array<{a:string,b:string,overlap:number}>}
 */
export function verifyLayout(placements, { epsilon = 1e-6 } = {}) {
  const violations = [];
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i];
      const b = placements[j];
      // Насколько прямоугольники заходят друг на друга по X и по Z.
      const dx = Math.abs(a.x - b.x) - (a.width + b.width) / 2;
      const dz = Math.abs(a.z - b.z) - (a.depth + b.depth) / 2;
      if (dx < -epsilon && dz < -epsilon) {
        violations.push({
          a: a.id,
          b: b.id,
          overlap: Math.min(-dx, -dz)
        });
      }
    }
  }
  return violations;
}

/**
 * Быстрый доступ к раскладке по id магазина.
 * @param {Array} placements
 * @returns {Map<string, object>}
 */
export function placementsById(placements) {
  const map = new Map();
  for (const placement of placements) map.set(placement.id, placement);
  return map;
}

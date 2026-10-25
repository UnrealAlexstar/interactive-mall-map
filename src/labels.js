/**
 * labels.js — текстовые подписи магазинов внутри WebGL-сцены.
 *
 * ПОЧЕМУ НЕ CSS2DRenderer И НЕ ОТДЕЛЬНЫЙ CANVAS-СЛОЙ
 * -------------------------------------------------
 * CSS2DRenderer создаёт по DOM-узлу на подпись. Для ~100 подписей браузеру
 * на каждый кадр приходится пересчитывать стили, перекладывать слои и
 * композитить сотню элементов — при движении камеры это роняло FPS до ~30.
 *
 * Замена на один полноэкранный `<canvas>` убирает DOM, но оставляет другую
 * дорогую операцию: прозрачный слой размером с окно (при DPR 2 — 3200×2000)
 * приходится очищать, перерисовывать и заново композитить поверх WebGL каждый
 * кадр. На слабой/интегрированной графике именно это съедало больше всего
 * времени, а на неподвижной сцене подписи всё равно перерисовывались из-за
 * субпиксельного дрожания камеры — отсюда «мигание».
 *
 * Здесь подписи — это `THREE.Sprite` с заранее отрисованной `CanvasTexture`:
 *   - текст растрируется ОДИН раз (при изменении текста/размера/наведения),
 *     а не каждый кадр;
 *   - на кадре остаётся только сдвинуть/масштабировать 100 маленьких квадов;
 *   - нет полноэкранного прозрачного слоя и его композитинга;
 *   - подписи рисуются отдельным ортографическим проходом поверх сцены,
 *     поэтому попадание мышью считается по тем же экранным прямоугольникам.
 *
 * Поведение подписей сохранено: адаптивный масштаб, обрезка по фактической
 * ширине текста, LOD, плавный переход якоря 3D ⇄ 2D и наведение/выбор мышью.
 */

import * as THREE from 'three';

/** Максимальное число символов в подписи до обрезки. */
const MAX_NAME_LENGTH = 18;
/**
 * Размер (в пикселях) магазина на экране, при котором подпись имеет
 * обычный размер. Базовый шрифт 12px, поэтому с ограничениями ниже текст на
 * экране остаётся в пределах ~9px…15.6px — всегда читаемо.
 */
const TARGET_FOOTPRINT_PX = 30;
/** Нижняя и верхняя границы масштаба подписи. */
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.3;
/**
 * Шаг округления масштаба. Чем грубее шаг, тем реже меняется значение —
 * а значит, тем меньше работы при зуме.
 */
const SCALE_STEP = 0.05;
/**
 * Подписи магазинов, которые на экране уже меньше этого, скрываются
 * (уровень детализации). Порог намеренно низкий: подпись исчезает, только
 * когда магазин стал буквально несколькими пикселями шириной.
 */
const MIN_VISIBLE_PX = 9;
/**
 * Насколько шире магазина может быть подпись. 1.2 оставляет небольшой зазор
 * (между магазинами есть отступ в 1 юнит — это примерно 20% среднего
 * размера магазина).
 */
const LABEL_WIDTH_FACTOR = 1.2;

/** Геометрия подписи в базовых (немасштабированных) пикселях. */
const PADDING_X = 6;
const PADDING_TOP = 2;
const PADDING_BOTTOM = 3;
const BORDER = 1;
const LABEL_CHROME = PADDING_X * 2 + BORDER * 2; // 14
const NAME_LINE_HEIGHT = 15;
const META_LINE_HEIGHT = 11;
const LINE_GAP = 1;
const SIMPLE_HEIGHT = BORDER * 2 + PADDING_TOP + NAME_LINE_HEIGHT + PADDING_BOTTOM; // 22
const DETAILED_HEIGHT = SIMPLE_HEIGHT + LINE_GAP + META_LINE_HEIGHT; // 34
const DETAIL_SCALE = 1.02;
const CORNER_RADIUS = 6;

const NAME_FONT = '600 12px "Inter", "Segoe UI", system-ui, sans-serif';
const META_FONT = '9px "JetBrains Mono", "SF Mono", "Cascadia Mono", ui-monospace, monospace';

const COLOR_BG = 'rgba(9, 12, 18, 0.88)';
const COLOR_BG_HOVER = 'rgba(24, 32, 45, 0.94)';
const COLOR_BORDER = 'rgba(255, 255, 255, 0.13)';
const COLOR_BORDER_HOVER = 'rgba(255, 255, 255, 0.34)';
const COLOR_TEXT = '#f4f6f8';
const COLOR_META = 'rgba(154, 164, 178, 0.92)';

/**
 * Текстура рисуется в максимальном масштабе подписи, а на экран выводится
 * уменьшенной. Так при изменении масштаба не нужно растрировать текст заново.
 */
const TEXTURE_SCALE = MAX_SCALE;

/** Ограничение DPR для текстур: больше 2 не даёт заметного выигрыша. */
function texturePixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/**
 * Обрезать текст, оставив многоточие.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = MAX_NAME_LENGTH) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Кэш для измерения текста (создаётся один раз). */
let measureContext = null;
/** Кэш результатов измерения текста: text -> width */
const textWidthCache = new Map();

/**
 * Измерить ширину текста в пикселях с кэшированием.
 * @param {string} text
 * @returns {number}
 */
function measureText(text) {
  const cached = textWidthCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d');
    // Шрифт должен совпадать с NAME_FONT.
    measureContext.font = NAME_FONT;
  }
  const width = measureContext.measureText(text).width;
  textWidthCache.set(text, width);
  return width;
}

/**
 * Подобрать, сколько символов названия помещается в отведённую ширину.
 * Используем бинарный поиск вместо линейного цикла для меньшего числа измерений.
 * @param {string} name название магазина
 * @param {number} space доступная ширина текста в пикселях
 * @returns {{text:string, width:number}} обрезанный текст и его ширина
 */
function fitText(name, space) {
  if (space <= 0) {
    const text = '…';
    return { text, width: measureText(text) };
  }
  let left = 1;
  let right = Math.min(name.length, Math.max(1, Math.floor(space / 6)));
  let bestLen = 0;
  let bestText = '…';
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const candidate = truncate(name, mid);
    if (measureText(candidate) <= space + 0.5) {
      bestLen = mid;
      bestText = candidate;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  if (bestLen === 0) {
    const fallback = '…';
    return { text: fallback, width: measureText(fallback) };
  }
  return { text: bestText, width: measureText(bestText) };
}

/**
 * Нарисовать прямоугольник со скруглёнными углами.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 */
function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export class LabelManager {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container контейнер карты (нужен для координат мыши)
   * @param {Array} options.shops
   * @param {Map<string, object>} options.placements
   * @param {number} [options.height] высота магазина в юнитах
   */
  constructor({ container, shops, placements, height = 2 }) {
    this.container = container;
    this.height = height;
    this.visible = true;

    this.items = [];
    this.blend = -1; // -1 заставит выполнить первое обновление якорей
    this.centerY = 1;

    // Матрицы прошлого кадра — по ним определяем, двигалась ли камера.
    // Копии храним в Float64Array: элементы матриц three.js — обычные
    // double, и округление до float32 давало ложное «камера сдвинулась»
    // на каждом кадре (а с ним — лишнюю перерисовку и мерцание).
    this.lastWorld = new Float64Array(16);
    this.lastProjection = new Float64Array(16);

    this.width = 0;
    this.heightPx = 0;
    this.dpr = texturePixelRatio();

    this.hoveredId = null;
    this.dirty = true;
    this.needsProjection = true;

    this.viewProjection = new THREE.Matrix4();
    this._v = new THREE.Vector3();

    /**
     * Отдельная сцена и ортографическая камера в CSS-пикселях. Подписи
     * рисуются вторым проходом поверх основной сцены — с теми же размерами,
     * что и окно, поэтому экранные координаты совпадают с координатами мыши.
     */
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.position.z = 10;

    for (const shop of shops) {
      const placement = placements.get(shop.id);
      if (!placement) continue;

      const canvas = document.createElement('canvas');
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
        toneMapped: false
      });

      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = 1000 + this.items.length;
      this.scene.add(sprite);

      this.items.push({
        shop,
        placement,
        anchor: new THREE.Vector3(placement.x, height + 0.55, placement.z),
        // геометрия и состояние, пересчитываемые в update()
        scale: 1,
        budget: -1,
        text: truncate(shop.name),
        textWidth: measureText(truncate(shop.name)),
        detailed: false,
        screenVisible: false,
        screenX: 0,
        screenY: 0,
        boxWidth: 0,
        boxHeight: SIMPLE_HEIGHT,
        // кэш отрисованной подписи
        canvas,
        ctx: null,
        texture,
        cacheKey: '',
        sprite
      });
    }
  }

  /**
   * Подписи живут в собственной сцене и не требуют добавления в основную.
   * Метод оставлен для совместимости с прежним API.
   */
  attachTo() {
    // Ничего не делаем: подписи рисуются отдельным проходом.
  }

  /**
   * Подогнать «экран» подписей под окно.
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    const dpr = texturePixelRatio();
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));

    if (this.width === nextWidth && this.heightPx === nextHeight && this.dpr === dpr) return;

    this.width = nextWidth;
    this.heightPx = nextHeight;
    this.dpr = dpr;

    this.camera.left = -nextWidth / 2;
    this.camera.right = nextWidth / 2;
    this.camera.top = nextHeight / 2;
    this.camera.bottom = -nextHeight / 2;
    this.camera.updateProjectionMatrix();

    this.needsProjection = true;
    this.dirty = true;
  }

  /**
   * Показать или скрыть все подписи.
   * @param {boolean} visible
   */
  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.scene.visible = visible;
    this.dirty = true;
  }

  /**
   * Перевести якоря из положения «над коробкой» (3D) в положение «по центру
   * магазина» (2D). Значение blend задаёт анимация перехода камеры.
   * @param {number} blend 0 = 3D, 1 = 2D
   */
  setBlend(blend) {
    if (Math.abs(blend - this.blend) < 0.001) return;
    this.blend = blend;

    const yTop = this.height + 0.55; // над коробкой
    const yMiddle = this.height * 0.5; // по центру коробки
    this.centerY = THREE.MathUtils.lerp(1.0, 0.5, blend);

    for (const item of this.items) {
      item.anchor.y = THREE.MathUtils.lerp(yTop, yMiddle, blend);
    }

    this.needsProjection = true;
    this.dirty = true;
  }

  /**
   * Подсветить подпись наведённого магазина.
   * @param {string|null} id
   */
  setHover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.dirty = true;
  }

  /**
   * Проверить, двигалась ли камера с прошлого кадра.
   *
   * Сравниваем матрицу мира и матрицу проекции: они вместе описывают, что и
   * как именно видно. Если обе не изменились — картинка та же, значит и
   * подписи пересчитывать незачем.
   *
   * @param {THREE.Camera} camera
   * @returns {boolean}
   */
  cameraChanged(camera) {
    const world = camera.matrixWorld.elements;
    const projection = camera.projectionMatrix.elements;

    // Допуск: изменения меньше него не видны на экране (сотые доли
    // пикселя), поэтому не считаем их поводом перерисовывать кадр.
    // Без него шум вычислений матриц снова включал бы отрисовку вхолостую.
    const WORLD_EPSILON = 1e-5;
    const PROJECTION_EPSILON = 1e-7;

    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(world[i] - this.lastWorld[i]) > WORLD_EPSILON) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(projection[i] - this.lastProjection[i]) > PROJECTION_EPSILON) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      this.lastWorld.set(world);
      this.lastProjection.set(projection);
    }
    return changed;
  }

  /**
   * Пересчитать размеры, тексты и экранные позиции подписей, а также
   * подготовить текстуры, которые изменились.
   *
   * Вызывается каждый кадр, но если камера стоит на месте и ничего не
   * менялось, работа не делается вовсе.
   *
   * @param {THREE.Camera} camera камера, которой сейчас рисуем
   * @param {number} viewportHeight высота окна в CSS-пикселях
   * @returns {boolean} true, если кадр нужно перерисовать
   */
  update(camera, viewportHeight) {
    if (!this.visible || this.items.length === 0) return false;

    const cameraMoved = this.cameraChanged(camera);
    if (cameraMoved || this.needsProjection) {
      this.needsProjection = false;
      this._project(camera, viewportHeight);
    }

    this._syncTextures();
    return this.dirty;
  }

  /**
   * Пересчитать экранные прямоугольники и разложить спрайты.
   * @param {THREE.Camera} camera
   * @param {number} viewportHeight
   */
  _project(camera, viewportHeight) {
    const isOrtho = camera.isOrthographicCamera;
    const unitSpan = isOrtho
      ? (camera.top - camera.bottom) / camera.zoom
      : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);

    const viewProjection = this.viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    const width = this.width;
    const height = this.heightPx;
    const centerY = this.centerY;
    const vector = this._v;

    for (const item of this.items) {
      // Примерный размер магазина на экране в пикселях.
      const distance = camera.position.distanceTo(item.anchor);
      const unitsPerPixel = ((isOrtho ? unitSpan : unitSpan * distance)) / viewportHeight;
      const worldSize = (item.placement.width + item.placement.depth) / 2;
      const footprintPx = worldSize / Math.max(unitsPerPixel, 1e-6);

      // --- масштаб текста ------------------------------------------------
      // Чем крупнее магазин на экране, тем крупнее подпись.
      const rawScale = THREE.MathUtils.clamp(footprintPx / TARGET_FOOTPRINT_PX, MIN_SCALE, MAX_SCALE);
      const scale = Math.round(rawScale / SCALE_STEP) * SCALE_STEP;

      // --- сколько текста помещается ------------------------------------
      // Ширина подписи ограничена шириной её магазина на экране. Так как
      // масштаб применяется к готовому макету, ширину в макете делим на него.
      const available = (footprintPx * LABEL_WIDTH_FACTOR) / scale;
      // Округляем до 2 пикселей, чтобы текст не пересчитывался каждый кадр.
      const budget = Math.max(2, Math.floor((available - LABEL_CHROME) / 2) * 2);

      if (item.budget !== budget) {
        const fitted = fitText(item.shop.name, budget);
        item.budget = budget;
        item.text = fitted.text;
        item.textWidth = fitted.width;
      }

      const detailed = scale > DETAIL_SCALE;
      const objectVisible = footprintPx >= MIN_VISIBLE_PX;
      const boxWidth = item.textWidth + LABEL_CHROME;
      const boxHeight = detailed ? DETAILED_HEIGHT : SIMPLE_HEIGHT;

      // --- проекция мирового якоря в экранные координаты -----------------
      vector.copy(item.anchor).applyMatrix4(viewProjection);
      const inDepth = vector.z >= -1 && vector.z <= 1;
      const screenX = (vector.x * 0.5 + 0.5) * width;
      const screenY = (-vector.y * 0.5 + 0.5) * height;

      // Небольшой запас, чтобы подпись не «прыгала» на краю экрана.
      const marginX = boxWidth * scale + 24;
      const marginY = boxHeight * scale + 24;
      const onScreen =
        screenX > -marginX && screenX < width + marginX && screenY > -marginY && screenY < height + marginY;

      item.scale = scale;
      item.detailed = detailed;
      item.screenVisible = objectVisible && inDepth && onScreen;
      item.screenX = screenX;
      item.screenY = screenY;
      item.boxWidth = boxWidth;
      item.boxHeight = boxHeight;

      const sprite = item.sprite;
      sprite.visible = item.screenVisible;
      if (!item.screenVisible) continue;

      const drawWidth = boxWidth * scale;
      const drawHeight = boxHeight * scale;
      // Спрайт по умолчанию центрирован, а якорь задаёт точку centerY
      // (1 = низ подписи, 0.5 = середина).
      const centerScreenY = screenY + (0.5 - centerY) * drawHeight;

      sprite.position.set(screenX - width / 2, height / 2 - centerScreenY, 0);
      sprite.scale.set(drawWidth, drawHeight, 1);
    }

    this.dirty = true;
  }

  /**
   * Обновить текстуры у изменившихся подписей (текст, LOD, наведение).
   * В обычном кадре (камера едет, текст тот же) цикл только сравнивает ключи.
   */
  _syncTextures() {
    for (const item of this.items) {
      if (!item.screenVisible) continue;
      const hovered = this.hoveredId !== null && item.shop.id === this.hoveredId;
      const key = `${item.text}\u0000${item.detailed ? 1 : 0}\u0000${hovered ? 1 : 0}\u0000${this.dpr}`;
      if (item.cacheKey === key) continue;

      item.cacheKey = key;
      this._rasterize(item, hovered);
      this.dirty = true;
    }
  }

  /**
   * Отрисовать одну подпись в её собственную CanvasTexture.
   *
   * Текстура создаётся в максимальном масштабе (TEXTURE_SCALE), поэтому при
   * изменении scale её не нужно перерисовывать — спрайт просто рисуется
   * меньшего размера.
   *
   * @param {object} item
   * @param {boolean} hovered
   */
  _rasterize(item, hovered) {
    const canvas = item.canvas;
    const s = this.dpr * TEXTURE_SCALE;
    const width = item.boxWidth;
    const height = item.boxHeight;
    const canvasWidth = Math.max(1, Math.ceil(width * s));
    const canvasHeight = Math.max(1, Math.ceil(height * s));

    const resized = canvas.width !== canvasWidth || canvas.height !== canvasHeight;
    if (resized) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    const ctx = item.ctx ?? (item.ctx = canvas.getContext('2d'));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Локальные координаты подписи: x = 0 — центр, y = top — верх рамки.
    const top = -this.centerY * height;
    ctx.setTransform(s, 0, 0, s, canvasWidth / 2, this.centerY * height * s);

    roundRect(ctx, -width / 2, top, width, height, CORNER_RADIUS);
    ctx.fillStyle = hovered ? COLOR_BG_HOVER : COLOR_BG;
    ctx.fill();

    // Рамка рисуется внутри прямоугольника, чтобы её не срезал край текстуры.
    roundRect(
      ctx,
      -width / 2 + BORDER / 2,
      top + BORDER / 2,
      width - BORDER,
      height - BORDER,
      Math.max(0, CORNER_RADIUS - BORDER / 2)
    );
    ctx.lineWidth = BORDER;
    ctx.strokeStyle = hovered ? COLOR_BORDER_HOVER : COLOR_BORDER;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = NAME_FONT;
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(item.text, 0, top + PADDING_TOP + NAME_LINE_HEIGHT / 2);

    if (item.detailed) {
      ctx.font = META_FONT;
      ctx.fillStyle = COLOR_META;
      ctx.fillText(item.shop.id, 0, top + PADDING_TOP + NAME_LINE_HEIGHT + LINE_GAP + META_LINE_HEIGHT / 2);
    }

    if (resized) {
      // three.js выделяет память под текстуру один раз (texStorage2D), а
      // обновления загружает через texSubImage2D. Если размер canvas
      // изменился, новый кадр не помещается в старое хранилище — WebGL
      // ругается «Offset overflows texture dimensions». dispose() заставляет
      // three.js пересоздать текстуру и выделить память под новый размер.
      item.texture.dispose();
    }
    item.texture.needsUpdate = true;
  }

  /**
   * Нарисовать подписи поверх уже отрисованной основной сцены.
   *
   * Вызывается после `renderer.render(scene, camera)`: основной проход
   * очищает буфер, поэтому подписи нужно нарисовать заново в каждом кадре,
   * даже если их геометрия не менялась.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @returns {boolean} true, если подписи были нарисованы
   */
  render(renderer) {
    if (!this.visible || this.items.length === 0) {
      this.dirty = false;
      return false;
    }

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;

    this.dirty = false;
    return true;
  }

  /**
   * Найти подпись под курсором.
   *
   * Подписи — спрайты в отдельном проходе, а не DOM-элементы, поэтому
   * попадание считается по сохранённым экранным прямоугольникам.
   *
   * @param {number} clientX координата в CSS-пикселях относительно окна
   * @param {number} clientY
   * @returns {string|null} id магазина
   */
  pick(clientX, clientY) {
    if (!this.visible) return null;

    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // Обходим в обратном порядке: последняя нарисованная подпись — сверху.
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item.screenVisible) continue;

      const width = item.boxWidth * item.scale;
      const height = item.boxHeight * item.scale;
      const left = item.screenX - width / 2;
      const top = item.screenY - height * this.centerY;

      if (x >= left && x <= left + width && y >= top && y <= top + height) {
        return item.shop.id;
      }
    }

    return null;
  }

  /**
   * Освободить текстуры и материалы подписей.
   */
  dispose() {
    for (const item of this.items) {
      item.sprite.material.dispose();
      item.texture.dispose();
    }
    this.scene.clear();
  }
}

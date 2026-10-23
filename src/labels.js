/**
 * labels.js — текстовые подписи магазинов (CSS2DRenderer).
 *
 * УПРОЩЁННАЯ ВЕРСИЯ ДЛЯ ПРОИЗВОДИТЕЛЬНОСТИ
 * ---------------------------------------
 * - Кэширование измерений текста (избегаем повторных canvas.measureText)
 * - Бинарный поиск при подборе длины текста вместо линейного цикла
 * - Обновление только при реальном изменении камеры (матрицы)
 * - Минимум записей в DOM: масштаб округляется с шагом, ширина округляется
 * - Меньше операций в цикле обновления
 */

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

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
 * а значит, тем реже браузеру пересчитывать стили.
 */
const SCALE_STEP = 0.05;
/**
 * Подписи магазинов, которые на экране уже меньше этого, скрываются
 * (уровень детализации). Порог намеренно низкий: подпись исчезает, только
 * когда магазин стал буквально нескольким пикселям шириной.
 */
const MIN_VISIBLE_PX = 9;
/**
 * Насколько шире магазина может быть подпись. 1.2 оставляет небольшой зазор
 * (между магазинами есть отступ в 1 юнит — это примерно 20% среднего
 * размера магазина).
 */
const LABEL_WIDTH_FACTOR = 1.2;
/**
 * Сколько места внутри подписи занимают отступы и рамка
 * (padding 6+6 и border 1+1). Текст живёт внутри них, поэтому из доступной
 * ширины их нужно вычесть.
 */
const LABEL_CHROME = 14;

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
    // Шрифт должен совпадать с `.shop-label__name` из style.css.
    measureContext.font = '600 12px "Inter", "Segoe UI", system-ui, sans-serif';
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

export class LabelManager {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container элемент, в котором живёт слой подписей
   * @param {Array} options.shops
   * @param {Map<string, object>} options.placements
   * @param {number} [options.height] высота магазина в юнитах
   * @param {(id:string|null)=>void} [options.onHover]
   * @param {(id:string)=>void} [options.onSelect]
   */
  constructor({ container, shops, placements, height = 2, onHover, onSelect }) {
    this.container = container;
    this.height = height;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.visible = true;
    this.items = [];
    this.blend = -1; // -1 заставит выполнить первое обновление якорей
    this.lastCenterY = -1;

    // Последние применённые значения — чтобы не писать в DOM то же самое.
    this.lastScale = new Map();
    this.lastBudget = new Map();
    this.lastDetailed = new Map();
    this.lastVisible = new Map();

    // Матрицы прошлого кадра — по ним определяем, двигалась ли камера.
    this.lastWorld = new Float32Array(16);
    this.lastProjection = new Float32Array(16);

    this.renderer = new CSS2DRenderer();
    this.renderer.domElement.classList.add('label-layer');
    container.appendChild(this.renderer.domElement);

    this.group = new THREE.Group();
    this.group.name = 'labels';

    for (const shop of shops) {
      const placement = placements.get(shop.id);
      if (!placement) continue;

      // --- создаём DOM-элемент подписи ---
      const element = document.createElement('div');
      element.className = 'shop-label';
      element.dataset.shopId = shop.id;

      const inner = document.createElement('div');
      inner.className = 'shop-label__inner';

      const name = document.createElement('span');
      name.className = 'shop-label__name';
      name.textContent = truncate(shop.name);
      inner.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'shop-label__meta';
      meta.textContent = shop.id;
      inner.appendChild(meta);

      element.appendChild(inner);
      element.title = `${shop.name} — ${shop.id}`;

      // --- якорь в мировых координатах ---
      const object = new CSS2DObject(element);
      object.center.set(0.5, 1.0);
      object.position.set(placement.x, height + 0.55, placement.z);

      // --- события мыши ---
      // В 2D-режиме подпись лежит прямо поверх магазина, поэтому курсор
      // оказывается над подписью, а не над коробкой. События подписи
      // отправляем в тот же InteractionManager, что и события canvas.
      element.addEventListener('pointerenter', () => {
        if (this.onHover) this.onHover(shop.id);
      });
      element.addEventListener('pointerleave', () => {
        if (this.onHover) this.onHover(null);
      });
      element.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (this.onSelect) this.onSelect(shop.id);
      });

      this.group.add(object);
      this.items.push({
        object,
        element,
        inner,
        name,
        shop,
        placement,
        anchor: new THREE.Vector3(placement.x, height + 0.55, placement.z)
      });
    }
  }

  /**
   * Группа подписей должна находиться внутри сцены, иначе её не видно.
   * @param {THREE.Scene} scene
   */
  attachTo(scene) {
    scene.add(this.group);
  }

  /**
   * Подогнать размер слоя подписей под окно.
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    this.renderer.setSize(width, height);
  }

  /**
   * Показать или скрыть все подписи.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.visible = visible;
    for (const item of this.items) {
      item.object.visible = visible;
      item.element.classList.toggle('is-hidden', !visible);
    }
  }

  /**
   * Перевести якоря из положения «над коробкой» (3D) в положение «по центру
   * магазина» (2D). Значение blend задаёт анимация перехода камеры.
   * @param {number} blend 0 = 3D, 1 = 2D
   */
  setBlend(blend) {
    if (Math.abs(blend - this.blend) < 0.001) return;
    this.blend = blend;

    const yTop = this.height + 0.55;   // над коробкой
    const yMiddle = this.height * 0.5; // по центру коробки
    const centerY = THREE.MathUtils.lerp(1.0, 0.5, blend);
    const useCenterY = Math.abs(centerY - this.lastCenterY) > 0.0001;
    this.lastCenterY = centerY;

    for (const item of this.items) {
      const newY = THREE.MathUtils.lerp(yTop, yMiddle, blend);
      if (Math.abs(item.object.position.y - newY) > 0.0001) {
        item.object.position.y = newY;
      }
      if (useCenterY) {
        item.object.center.set(0.5, centerY);
      }
      item.anchor.copy(item.object.position);
    }
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

    for (let i = 0; i < 16; i++) {
      if (world[i] !== this.lastWorld[i]) {
        this.lastWorld.set(world);
        this.lastProjection.set(projection);
        return true;
      }
    }
    for (let i = 0; i < 16; i++) {
      if (projection[i] !== this.lastProjection[i]) {
        this.lastWorld.set(world);
        this.lastProjection.set(projection);
        return true;
      }
    }
    return false;
  }

  /**
   * Пересчитать размер подписей под текущий масштаб камеры.
   *
   * Вызывается каждый кадр, но внутри есть проверка: если камера стоит на
   * месте, работа не делается вовсе.
   *
   * ГЛАВНОЕ ПРАВИЛО: в DOM пишем только то, что действительно изменилось.
   * Любая запись в стиль заставляет браузер пересчитать стили, а изменение
   * ширины — ещё и пересобрать вёрстку. Поэтому:
   *   - масштаб округляем с шагом 0.05 (меняется редко);
   *   - доступную ширину текста округляем до 2 пикселей, и ширину с текстом
   *     обновляем только когда она реально изменилась.
   *
   * @param {THREE.Camera} camera камера, которой сейчас рисуем
   * @param {number} viewportHeight высота окна в CSS-пикселях
   */
  update(camera, viewportHeight) {
    if (!this.visible) return;
    if (!this.cameraChanged(camera)) return;

    const isOrtho = camera.isOrthographicCamera;

    // Сколько юнитов мира помещается в кадр на расстоянии 1 от камеры.
    const unitSpan = isOrtho
      ? (camera.top - camera.bottom) / camera.zoom
      : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);

    for (const item of this.items) {
      const distance = camera.position.distanceTo(item.anchor);
      const unitsPerPixel = ((isOrtho ? unitSpan : unitSpan * distance)) / viewportHeight;

      // Примерный размер магазина на экране в пикселях.
      const worldSize = (item.placement.width + item.placement.depth) / 2;
      const footprintPx = worldSize / Math.max(unitsPerPixel, 1e-6);

      // --- масштаб текста ------------------------------------------------
      // Чем крупнее магазин на экране, тем крупнее подпись.
      const rawScale = THREE.MathUtils.clamp(footprintPx / TARGET_FOOTPRINT_PX, MIN_SCALE, MAX_SCALE);
      const scale = Math.round(rawScale / SCALE_STEP) * SCALE_STEP;

      if (this.lastScale.get(item.shop.id) !== scale) {
        this.lastScale.set(item.shop.id, scale);
        item.inner.style.setProperty('--label-scale', scale.toFixed(3));
      }

      // --- сколько текста помещается ------------------------------------
      // Ширина подписи ограничена шириной её магазина на экране: подписи
      // встают рядом, а не закрывают соседей, а не влезшее имя обрезается
      // многоточием (полное имя остаётся в подсказке и в панели справа).
      //
      // Так как трансформация масштабирует результат, ширину в макете делим
      // на масштаб.
      const available = (footprintPx * LABEL_WIDTH_FACTOR) / scale;

      // Из доступной ширины вычитаем отступы и рамку — текст лежит внутри.
      // Округляем до 2 пикселей, чтобы значение менялось не каждый кадр.
      const space = Math.max(2, Math.floor((available - LABEL_CHROME) / 2) * 2);

      // Ширина и текст меняются реже, чем масштаб, обновляем только при изменении.
      if (this.lastBudget.get(item.shop.id) !== space) {
        this.lastBudget.set(item.shop.id, space);

        const fitted = fitText(item.shop.name, space);
        item.inner.style.setProperty('--label-width', `${(fitted.width + LABEL_CHROME).toFixed(1)}px`);
        if (item.name.textContent !== fitted.text) {
          item.name.textContent = fitted.text;
        }
      }

      // Подробная подпись (с id) — только когда её есть где показать.
      const detailed = scale > 1.02;
      if (this.lastDetailed.get(item.shop.id) !== detailed) {
        this.lastDetailed.set(item.shop.id, detailed);
        item.element.classList.toggle('is-detailed', detailed);
      }

      // Уровень детализации: прячем подписи нечитаемых магазинов.
      const visible = footprintPx >= MIN_VISIBLE_PX;
      if (this.lastVisible.get(item.shop.id) !== visible) {
        this.lastVisible.set(item.shop.id, visible);
        item.object.visible = visible;
      }
    }
  }

  /**
   * Отрисовать слой подписей.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  render(scene, camera) {
    this.renderer.render(scene, camera);
  }

  /**
   * Убрать подписи из DOM.
   */
  dispose() {
    for (const item of this.items) {
      if (item.element.parentNode) item.element.parentNode.removeChild(item.element);
    }
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}

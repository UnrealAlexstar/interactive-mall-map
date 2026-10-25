/**
 * main.js — точка входа: собирает все модули и запускает цикл отрисовки.
 *
 * Поток данных:
 *
 *   data.js        ->  100 описаний магазинов (id / имя / размеры / цвет)
 *   layout.js      ->  координаты (x, z) для каждого магазина без наложений
 *   scene.js       ->  рендерер, пол, свет, по коробке на магазин
 *   labels.js      ->  подписи-спрайты в отдельном проходе поверх сцены
 *   camera.js      ->  камера 3D, камера 2D и анимация перехода между ними
 *   interaction.js ->  наведение мышью и выделение по клику
 *
 * Цикл кадра (`requestAnimationFrame`) связывает всё вместе:
 *   1. продвигаем анимацию камеры;
 *   2. обновляем наведение мыши;
 *   3. обновляем подписи (только если камера двигалась);
 *   4. рисуем кадр — только когда что-то реально изменилось;
 *   5. при необходимости уменьшаем разрешение, чтобы удержать плавный FPS.
 */

import * as THREE from 'three';
import { generateShopData, SHOP_COUNT, SHOP_HEIGHT } from './data.js';
import { layoutShops, placementsById, verifyLayout } from './layout.js';
import { createRenderer, createScene, createLighting, createFloor, buildMall } from './scene.js';
import { CameraManager } from './camera.js';
import { LabelManager } from './labels.js';
import { InteractionManager } from './interaction.js';

/** Все элементы интерфейса, которые нам понадобятся. */
const dom = {
  app: document.getElementById('app'),
  modeToggle: document.getElementById('mode-toggle'),
  modeToggleLabel: document.querySelector('#mode-toggle .btn__label'),
  modeBadge: document.getElementById('mode-badge'),
  resetView: document.getElementById('reset-view'),
  toggleLabels: document.getElementById('toggle-labels'),
  infoPanel: document.getElementById('info-panel'),
  infoTitle: document.getElementById('info-title'),
  infoBody: document.getElementById('info-body'),
  statUnits: document.getElementById('stat-units'),
  statFootprint: document.getElementById('stat-footprint'),
  statShelves: document.getElementById('stat-shelves'),
  statFps: document.getElementById('stat-fps'),
  loading: document.getElementById('loading')
};

/**
 * Динамическое разрешение (dynamic resolution scaling).
 *
 * Если кадры идут медленно — например, на слабой видеокарте или в большом
 * окне на Retina-экране — мы рисуем сцену в меньшем разрешении. Как только
 * снова станет быстро, возвращаем исходное разрешение.
 *
 * Это единственный способ гарантированно удержать плавный FPS на любом
 * железе: остальные оптимизации (одна карта теней, дешёвые подписи) убирают
 * лишнюю работу, а здесь мы управляем количеством самих пикселей.
 */
class ResolutionScaler {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [options]
   * @param {number} [options.max] максимальная плотность пикселей
   * @param {number} [options.min] минимальная плотность пикселей
   * @param {number} [options.target] сколько FPS считаем хорошим
   * @param {number} [options.floor] ниже этого FPS уменьшаем разрешение
   */
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.max = options.max ?? Math.min(window.devicePixelRatio || 1, 2);
    this.min = options.min ?? 0.6;
    this.target = options.target ?? 55;
    this.floor = options.floor ?? 40;
    this.ratio = this.max;

    this.elapsed = 0;
    this.frames = 0;
  }

  /**
   * Вызывать один раз за кадр.
   * @param {number} dt сколько миллисекунд прошло с прошлого кадра
   * @returns {boolean} true, если разрешение изменилось и кадр надо перерисовать
   */
  update(dt) {
    this.elapsed += dt;
    this.frames++;

    // Решение принимаем раз в секунду, иначе разрешение «дёргалось» бы.
    if (this.elapsed < 1000) return false;

    const fps = (this.frames * 1000) / this.elapsed;
    this.elapsed = 0;
    this.frames = 0;

    let next = this.ratio;
    if (fps < this.floor) {
      next = Math.max(this.min, this.ratio - 0.25); // слишком медленно — рисуем мельче
    } else if (fps > this.target) {
      next = Math.min(this.max, this.ratio + 0.25); // есть запас — рисуем чётче
    }

    if (next === this.ratio) return false;

    this.ratio = next;
    this.renderer.setPixelRatio(next);
    console.info(`[MALL MAP] Render scale adjusted to ${next.toFixed(2)}x (${fps.toFixed(0)} fps)`);
    return true;
  }
}

/**
 * Запустить приложение.
 */
function init() {
  const container = dom.app;

  // Размер окна запоминаем: читать `clientHeight` каждый кадр нельзя —
  // это заставляет браузер пересчитывать вёрстку (и тормозит анимацию).
  let viewportWidth = container.clientWidth || window.innerWidth;
  let viewportHeight = container.clientHeight || window.innerHeight;

  // ------------------------------------------------------------ данные
  const shops = generateShopData(SHOP_COUNT);
  const layout = layoutShops(shops, { padding: 1, aisle: 2 });
  const placements = placementsById(layout.placements);

  // Быстрый доступ к магазину по id (O(1) вместо перебора массива).
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));

  // Проверка на лету: алгоритм раскладки не допускает наложений.
  const violations = verifyLayout(layout.placements);
  console.info(
    `%c[MALL MAP]%c Layout: ${shops.length} units · ${layout.stats.shelves} shelves · ` +
      `${layout.stats.width.toFixed(1)} x ${layout.stats.depth.toFixed(1)} units · ` +
      `occupancy ${(layout.stats.occupancy * 100).toFixed(1)}% · overlaps: ${violations.length}`,
    'background:#20c997;color:#0b0e14;padding:2px 6px;border-radius:3px;font-weight:700;',
    'color:#adb5bd;'
  );
  if (violations.length > 0) console.warn('[MALL MAP] Layout violations:', violations);

  // -------------------------------------------------------------- сцена
  const renderer = createRenderer(container);
  const scene = createScene();
  createLighting(scene, layout.bounds);
  createFloor(scene, layout.bounds);
  const { meshes } = buildMall(scene, shops, placements);

  // ------------------------------------------------------------- камера
  // Органы управления слушают события на КОНТЕЙНЕРЕ, а не на самом canvas:
  // контейнер занимает всё окно и остаётся стабильной целью, даже если canvas
  // пересоздадут или поверх него появятся другие элементы.
  const cameraManager = new CameraManager({
    domElement: container,
    bounds: layout.bounds,
    aspect: viewportWidth / viewportHeight
  });

  // -------------------------------------------------------------- подписи
  // Подписи создаются раньше InteractionManager: он использует `labels.pick()`
  // для наведения/клика по тексту, поэтому менеджер подписей уже должен быть
  // готов. Сами подписи от мыши не зависят — только от камеры и размера окна.
  const labels = new LabelManager({
    container,
    shops,
    placements,
    height: SHOP_HEIGHT
  });
  labels.setSize(viewportWidth, viewportHeight);

  // --------------------------------------------------------- взаимодействие
  // Текущее состояние: наведённый и выбранный магазин.
  let hovered = null;
  let selected = null;
  // Флаг «на экране есть изменения, которые видит только WebGL»: выбор,
  // подсветка, изменение разрешения, resize. Нужен, чтобы не рисовать кадры
  // вхолостую, но и не пропустить изменения материалов/рамок.
  let needsRender = true;

  const interaction = new InteractionManager({
    domElement: renderer.domElement,
    cameraManager,
    meshes,
    scene,
    onHover: (shop) => {
      hovered = shop;
      // Подсветка подписи должна совпадать с подсветкой коробки.
      labels.setHover(shop ? shop.id : null);
      needsRender = true;
      updateInfoPanel();
    },
    onSelect: (shop) => {
      selected = shop;
      needsRender = true;
      updateInfoPanel();
    },
    // Клик/наведение по тексту обрабатываются до рейкаста по коробкам.
    hitTestLabel: (clientX, clientY) => labels.pick(clientX, clientY)
  });

  // ----------------------------------------------------------------- UI
  dom.modeToggle.addEventListener('click', () => cameraManager.toggleMode());

  dom.resetView.addEventListener('click', () => {
    cameraManager.resetView();
    interaction.clearSelection();
    selected = null;
    needsRender = true;
    updateInfoPanel();
  });

  dom.toggleLabels.addEventListener('click', () => {
    const visible = !labels.visible;
    labels.setVisible(visible);
    // Скрыть подписи можно только перерисовав кадр без них.
    needsRender = true;
    dom.toggleLabels.classList.toggle('is-active', visible);
    dom.toggleLabels.setAttribute('aria-pressed', String(visible));
  });

  window.addEventListener('keydown', (event) => {
    // Не перехватываем клавиши, когда пользователь печатает в поле ввода.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

    switch (event.code) {
      case 'Space':
        event.preventDefault();
        cameraManager.toggleMode();
        break;
      case 'KeyR':
        cameraManager.resetView();
        break;
      case 'KeyL':
        dom.toggleLabels.click();
        break;
      case 'Escape':
        interaction.clearSelection();
        selected = null;
        updateInfoPanel();
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', onResize);

  function onResize() {
    viewportWidth = container.clientWidth || window.innerWidth;
    viewportHeight = container.clientHeight || window.innerHeight;
    renderer.setSize(viewportWidth, viewportHeight);
    cameraManager.resize(viewportWidth / viewportHeight);
    labels.setSize(viewportWidth, viewportHeight);
    needsRender = true;
  }

  // ------------------------------------------------------------- показатели
  dom.statUnits.textContent = String(shops.length);
  dom.statFootprint.textContent = `${layout.stats.width.toFixed(0)} × ${layout.stats.depth.toFixed(0)}`;
  dom.statShelves.textContent = String(layout.stats.shelves);

  /**
   * Обновить информационную панель (наведённый / выбранный магазин).
   */
  function updateInfoPanel() {
    const shop = selected ?? hovered;

    if (!shop) {
      if (dom.infoPanel.classList.contains('is-active')) {
        dom.infoPanel.classList.remove('is-active');
      }
      if (dom.infoTitle.textContent !== 'No selection') {
        dom.infoTitle.textContent = 'No selection';
      }
      const emptyHtml = '<p class="muted">Hover a unit to preview it, click to select it.</p>';
      if (dom.infoBody.innerHTML !== emptyHtml) {
        dom.infoBody.innerHTML = emptyHtml;
      }
      return;
    }

    const placement = placements.get(shop.id);
    const isSelected = selected !== null && selected.id === shop.id;
    const titleText = isSelected ? shop.name : `${shop.name} (hover)`;

    if (!dom.infoPanel.classList.contains('is-active')) {
      dom.infoPanel.classList.add('is-active');
    }
    if (dom.infoTitle.textContent !== titleText) {
      dom.infoTitle.textContent = titleText;
    }
    const html = `
      <dl>
        <dt>ID</dt><dd>${shop.id}</dd>
        <dt>Category</dt><dd>${shop.category}</dd>
        <dt>Footprint</dt><dd>${shop.width} × ${shop.depth}</dd>
        <dt>Area</dt><dd>${shop.area} u²</dd>
        <dt>Position</dt><dd>(${placement.x.toFixed(1)}, ${placement.z.toFixed(1)})</dd>
        <dt>Shelf</dt><dd>#${placement.shelf + 1}</dd>
      </dl>`;
    if (dom.infoBody.innerHTML !== html) {
      dom.infoBody.innerHTML = html;
    }
  }
  updateInfoPanel();

  // ------------------------------------------------------------- цикл кадра
  let lastMode = null;
  let lastTransitioning = false;
  let frames = 0;
  let fpsStamp = performance.now();
  let lastFrameStamp = fpsStamp;

  // Подстройка разрешения под реальную производительность машины.
  const resolutionScaler = new ResolutionScaler(renderer);

  /**
   * Обновить бейдж режима («3D VIEW» / «2D PLAN» / «TRANSITION»).
   */
  function updateModeUi() {
    const mode = cameraManager.mode;
    const transitioning = cameraManager.isTransitioning;
    // Отслеживаем и режим, и факт анимации: иначе после завершения перехода
    // бейдж навсегда оставался бы с надписью «TRANSITION».
    if (mode === lastMode && transitioning === lastTransitioning) return;

    lastMode = mode;
    lastTransitioning = transitioning;
    const badgeText = transitioning ? 'TRANSITION' : mode === '2d' ? '2D PLAN' : '3D VIEW';
    if (dom.modeBadge.textContent !== badgeText) {
      dom.modeBadge.textContent = badgeText;
    }
    dom.modeBadge.classList.toggle('is-2d', mode === '2d' && !transitioning);
    const toggleText = mode === '2d' ? 'Switch to 3D' : 'Switch to 2D';
    if (dom.modeToggleLabel.textContent !== toggleText) {
      dom.modeToggleLabel.textContent = toggleText;
    }
    dom.modeToggle.setAttribute('aria-label', mode === '2d' ? 'Switch to 3D view' : 'Switch to 2D plan view');
    document.body.classList.toggle('mode-2d', mode === '2d');
  }

  function animate(now) {
    requestAnimationFrame(animate);

    const delta = now - lastFrameStamp;
    lastFrameStamp = now;

    // 1. Камера (в т.ч. анимация перехода 2D ⇄ 3D). Возвращает true только
    //    при реальном изменении — субпиксельное дрожание OrbitControls
    //    откатывается внутри CameraManager.
    const cameraChanged = cameraManager.update(now);

    // 2. Наведение мышью — пересчёт не чаще раза за кадр.
    const hoverChanged = interaction.update();

    // 3. Подписи — сами проверяют, двигалась ли камера (см. labels.js).
    labels.setBlend(cameraManager.blend);
    const labelsChanged = labels.update(cameraManager.activeCamera, viewportHeight);

    // 4. Рисуем только когда на экране действительно что-то изменилось.
    //    На неподвижной сцене не тратятся ни CPU, ни GPU, а картинка не
    //    мерцает от бесконечной перерисовки.
    if (cameraChanged || hoverChanged || labelsChanged || needsRender) {
      const camera = cameraManager.activeCamera;
      renderer.render(scene, camera);
      // Подписи рисуются вторым проходом в тот же WebGL-буфер: основной
      // render() очищает цвет, поэтому слой нужно рисовать в каждом кадре.
      labels.render(renderer);
      needsRender = false;
    }

    // 5. Если кадры идут медленно — уменьшаем разрешение (см. ResolutionScaler).
    if (resolutionScaler.update(delta)) needsRender = true;

    updateModeUi();

    // Счётчик FPS: пересчитываем раз в полсекунды.
    frames++;
    if (now - fpsStamp >= 500) {
      dom.statFps.textContent = Math.round((frames * 1000) / (now - fpsStamp)).toString();
      frames = 0;
      fpsStamp = now;
    }
  }

  requestAnimationFrame(animate);

  // Прячем экран загрузки, как только первый кадр нарисован.
  requestAnimationFrame(() => {
    if (dom.loading) {
      dom.loading.classList.add('is-hidden');
      setTimeout(() => dom.loading.remove(), 600);
    }
  });

  // Объект для отладки из консоли браузера.
  window.mallMap = {
    renderer,
    scene,
    cameraManager,
    labels,
    interaction,
    resolutionScaler,
    shopById,
    placements,
    THREE
  };
}

try {
  init();
} catch (error) {
  console.error('[MALL MAP] Failed to initialise:', error);
  if (dom.loading) {
    dom.loading.classList.add('is-error');
    dom.loading.innerHTML = `<strong>Unable to start the 3D view.</strong><span>${error.message}</span>`;
  }
}

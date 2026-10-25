/**
 * interaction.js — работа с мышью: подсветка при наведении и выделение по клику.
 *
 * КАК УСТРОЕН РАЙКАСТ
 * -------------------
 * Событие `pointermove` только запоминает координаты курсора и ставит флаг
 * «нужно пересчитать». Сам пересечение луча с магазинами ищется не чаще
 * одного раза за кадр (в `update()`). Пока мышь не двигается — работы нет
 * вообще.
 *
 * ВИЗУАЛЬНЫЕ СОСТОЯНИЯ
 * --------------------
 *   нет       -> обычный цвет, без свечения
 *   наведение -> цвет светлеет + мягкое свечение
 *   выбрано   -> сильное свечение + белая рамка вокруг коробки
 *                + рамка на полу
 *
 * Рамка сделана «методом инвертированной оболочки»: рядом с коробкой рисуется
 * её чуть увеличенная копия обратной стороной (`BackSide`). Получается
 * аккуратная граница без пост-обработки (`OutlinePass`).
 */

import * as THREE from 'three';

const WHITE = new THREE.Color(0xffffff);

/** Насколько сильно подсвечивается магазин при наведении. */
const HOVER_BRIGHTEN = 0.34;
/** Сила свечения при наведении. */
const HOVER_EMISSIVE = 0.5;
/** Сила свечения у выбранного магазина. */
const SELECT_EMISSIVE = 0.85;

export class InteractionManager {
  /**
   * @param {object} options
   * @param {HTMLElement} options.domElement canvas
   * @param {import('./camera.js').CameraManager} options.cameraManager
   * @param {THREE.Mesh[]} options.meshes коробки магазинов
   * @param {THREE.Scene} options.scene
   * @param {(shop:object|null)=>void} [options.onHover]
   * @param {(shop:object|null)=>void} [options.onSelect]
   * @param {(clientX:number, clientY:number)=>string|null} [options.hitTestLabel]
   *   необязательный тест попадания по слою подписей. Подписи — это спрайты
   *   в WebGL, а не DOM-элементы, поэтому клик/наведение по ним определяется
   *   до рейкаста по мешам.
   */
  constructor({ domElement, cameraManager, meshes, scene, onHover, onSelect, hitTestLabel }) {
    this.domElement = domElement;
    this.cameraManager = cameraManager;
    this.meshes = meshes;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.hitTestLabel = hitTestLabel ?? null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-2, -2); // (-2, -2) = курсор вне окна
    this.clientX = -1;
    this.clientY = -1;
    this.pointerInside = false;
    this.needsRaycast = false;
    this.hoveredId = null;
    this.selectedId = null;

    // Быстрый доступ к коробке по id магазина.
    this.meshById = new Map();
    for (const mesh of meshes) this.meshById.set(mesh.userData.shopId, mesh);

    // --- рамка выделения (невидима, пока ничего не выбрано) -----------
    this.outline = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.BackSide, // рисуем только «изнанку» — получается рамка
        transparent: true,
        opacity: 0.9,
        depthWrite: false
      })
    );
    this.outline.name = 'selection-outline';
    this.outline.visible = false;
    this.outline.renderOrder = 10;
    scene.add(this.outline);

    // --- рамка на полу под выбранным магазином -------------------------
    this.footprint = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, 0.5),
        new THREE.Vector3(-0.5, 0, 0.5)
      ]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false })
    );
    this.footprint.name = 'selection-footprint';
    this.footprint.visible = false;
    this.footprint.renderOrder = 11;
    scene.add(this.footprint);

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);

    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerleave', this._onPointerLeave);
    domElement.addEventListener('pointerdown', this._onPointerDown);
  }

  /**
   * Перевести координаты мыши в координаты three.js (-1..1).
   * @param {PointerEvent} event
   */
  _updatePointer(event) {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.clientX = event.clientX;
    this.clientY = event.clientY;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerInside = true;
  }

  /** @param {PointerEvent} event */
  _onPointerMove(event) {
    this._updatePointer(event);
    this.needsRaycast = true;
  }

  /** @param {PointerEvent} event */
  _onPointerLeave() {
    this.pointerInside = false;
    this.pointer.set(-2, -2);
    this.needsRaycast = false;
    this.setHover(null);
  }

  /**
   * Выделение происходит по `pointerdown` — так отклик мгновенный.
   * Событие не останавливается, поэтому камера продолжает управляться мышью.
   * @param {PointerEvent} event
   */
  _onPointerDown(event) {
    this._updatePointer(event);
    const labelId = this.hitTestLabel ? this.hitTestLabel(this.clientX, this.clientY) : null;
    if (labelId) {
      this.select(labelId);
      return;
    }
    const hit = this.raycast();
    if (hit) this.select(hit.object.userData.shopId);
  }

  /**
   * Пустить луч из камеры через курсор и найти первый магазин.
   * @returns {THREE.Intersection|null}
   */
  raycast() {
    const camera = this.cameraManager.activeCamera;
    if (!camera) return null;
    this.raycaster.setFromCamera(this.pointer, camera);
    const intersections = this.raycaster.intersectObjects(this.meshes, false);
    return intersections.length > 0 ? intersections[0] : null;
  }

  /**
   * Обновление состояния наведения — один раз за кадр, и только если мышь
   * действительно двигалась.
   *
   * Сначала проверяется попадание по подписи (WebGL-спрайты), затем — рейкаст
   * по коробкам. Благодаря этому клик по тексту выбирает тот же магазин, что и
   * клик по его мешу.
   *
   * @returns {boolean} true, если состояние наведения изменилось
   */
  update() {
    if (!this.needsRaycast || !this.pointerInside) return false;
    this.needsRaycast = false;

    const labelId = this.hitTestLabel ? this.hitTestLabel(this.clientX, this.clientY) : null;
    if (labelId) {
      const changed = labelId !== this.hoveredId;
      this.setHover(labelId);
      return changed;
    }

    const hit = this.raycast();
    const nextId = hit ? hit.object.userData.shopId : null;

    if (nextId === this.hoveredId) return false;
    this.setHover(nextId);
    return true;
  }

  /**
   * Публичный способ задать наведённый магазин.
   *
   * Его же использует слой подписей: в 2D-режиме подпись лежит прямо на
   * магазине, поэтому курсор оказывается над подписью, а не над коробкой.
   * Через один и тот же метод подсветка и панель справа остаются
   * согласованными при любом положении курсора.
   *
   * @param {string|null} id
   */
  setHover(id) {
    if (id === this.hoveredId) return;

    // Сначала снимаем подсветку со старого магазина...
    const previousId = this.hoveredId;
    this.hoveredId = id;

    if (previousId !== null) this._refreshVisual(this.meshById.get(previousId));
    if (id !== null) this._refreshVisual(this.meshById.get(id));

    if (this.onHover) {
      this.onHover(id ? this.meshById.get(id).userData.shop : null);
    }
  }

  /**
   * Перерисовать коробку в зависимости от её состояния.
   * @param {THREE.Mesh} mesh
   */
  _refreshVisual(mesh) {
    if (!mesh) return;

    const base = mesh.userData.baseColor;
    const isSelected = mesh.userData.shopId === this.selectedId;
    const isHovered = mesh.userData.shopId === this.hoveredId;

    if (isSelected) {
      mesh.material.color.copy(base).lerp(WHITE, 0.55);
      mesh.material.emissive.copy(base).lerp(WHITE, 0.6);
      mesh.material.emissiveIntensity = SELECT_EMISSIVE;
    } else if (isHovered) {
      mesh.material.color.copy(base).lerp(WHITE, HOVER_BRIGHTEN);
      mesh.material.emissive.copy(base);
      mesh.material.emissiveIntensity = HOVER_EMISSIVE;
    } else {
      mesh.material.color.copy(base);
      mesh.material.emissiveIntensity = 0;
    }
  }

  /**
   * Выбрать магазин: обновить внешний вид и вывести данные в консоль.
   * @param {string} id
   */
  select(id) {
    if (this.selectedId === id) return;

    const previousId = this.selectedId;
    this.selectedId = id;

    if (previousId !== null) this._refreshVisual(this.meshById.get(previousId));

    const mesh = this.meshById.get(id);
    if (!mesh) return;
    this._refreshVisual(mesh);

    const shop = mesh.userData.shop;
    const position = mesh.getWorldPosition(new THREE.Vector3());

    // Рамка и след на полу переезжают к выбранному магазину.
    this.outline.visible = true;
    this.outline.position.copy(mesh.position);
    this.outline.scale.set(shop.width * 1.07, 2 * 1.12, shop.depth * 1.07);

    this.footprint.visible = true;
    this.footprint.position.set(mesh.position.x, 0.04, mesh.position.z);
    this.footprint.scale.set(shop.width + 0.35, 1, shop.depth + 0.35);

    // Вывод в консоль — это требование технического задания.
    console.log(
      `%c[MALL MAP]%c Shop selected  →  id: ${shop.id}  |  name: ${shop.name}  |  world position: (${position.x.toFixed(
        2
      )}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`,
      'background:#4dabf7;color:#0b0e14;padding:2px 6px;border-radius:3px;font-weight:700;',
      'color:#e9ecef;'
    );
    console.log({
      id: shop.id,
      name: shop.name,
      category: shop.category,
      width: shop.width,
      depth: shop.depth,
      position: { x: position.x, y: position.y, z: position.z }
    });

    if (this.onSelect) this.onSelect(shop, position);
  }

  /** Снять выделение. */
  clearSelection() {
    if (this.selectedId === null) return;

    const previousId = this.selectedId;
    this.selectedId = null;
    this._refreshVisual(this.meshById.get(previousId));

    this.outline.visible = false;
    this.footprint.visible = false;

    if (this.onSelect) this.onSelect(null, null);
  }

  /** Снять обработчики событий. */
  dispose() {
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.domElement.removeEventListener('pointerleave', this._onPointerLeave);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
  }
}

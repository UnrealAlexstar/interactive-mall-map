/**
 * scene.js — создание 3D-сцены: рендерер, пол, свет и коробки магазинов.
 *
 * Здесь нет ничего «умного» — только сборка сцены из простых кирпичиков:
 *
 *   createRenderer()  -> WebGL-рендерер, который рисует картинку
 *   createScene()     -> корневой объект сцены (фон, туман)
 *   createLighting()  -> свет: заполняющий + направленный (он же отбрасывает тени)
 *   createFloor()     -> пол магазина: плита + сетка + рамка
 *   buildMall()       -> по одной коробке на каждый магазин
 *
 * ВАЖНО ПРО ПРОИЗВОДИТЕЛЬНОСТЬ
 * ------------------------------
 * Сцена статична: коробки магазинов никогда не двигаются, двигается только
 * камера. Значит, карту теней тоже не нужно перерисовывать каждый кадр —
 * достаточно построить её один раз. Поэтому в createRenderer() выставляется
 *
 *     renderer.shadowMap.autoUpdate = false;
 *     renderer.shadowMap.needsUpdate = true;   // построить один раз
 *
 * Если этого не сделать, three будет рисовать все 100 коробок дважды в каждом
 * кадре (обычный проход + проход теней), и частота кадров упадёт примерно
 * вдвое. Подробнее — в README, раздел «Производительность».
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SHOP_HEIGHT } from './data.js';

/**
 * Создать WebGL-рендерер и добавить его в контейнер.
 * @param {HTMLElement} container
 * @returns {THREE.WebGLRenderer}
 */
export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false
  });

  // Ограничиваем плотность пикселей: на Retina-экранах devicePixelRatio = 2,
  // и без ограничения мы бы рисовали в 4 раза больше пикселей.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

  // --- тени -------------------------------------------------------------
  renderer.shadowMap.enabled = true;
  // `PCFSoftShadowMap` был удалён в three r18x, поэтому используем PCFShadowMap.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Сцена неподвижная => карту теней рисуем ОДИН раз, а не каждый кадр.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  // --- цвет -------------------------------------------------------------
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  renderer.domElement.classList.add('mall-canvas');
  container.appendChild(renderer.domElement);
  return renderer;
}

/**
 * Создать корневой объект сцены: тёмный фон и лёгкий туман.
 * @param {THREE.Scene} [scene]
 * @returns {THREE.Scene}
 */
export function createScene(scene = new THREE.Scene()) {
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.Fog(0x0b0e14, 320, 900);
  return scene;
}

/**
 * Настроить свет.
 *
 * Три источника:
 *   ambient    — равномерно подсвечивает всё, чтобы не было чёрных теней;
 *   hemisphere — небо/земля, даёт мягкий перепад цвета;
 *   key        — направленный свет, единственный, кто отбрасывает тени;
 *   rim        — холодная подсветка сзади, чтобы коробки «отделялись» от пола.
 *
 * @param {THREE.Scene} scene
 * @param {{radius:number}} bounds
 * @returns {{key:THREE.DirectionalLight}}
 */
export function createLighting(scene, bounds) {
  const radius = Math.max(bounds?.radius ?? 40, 20);

  scene.add(new THREE.AmbientLight(0xffffff, 0.38));
  scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x232936, 0.75));

  // --- главный направленный свет (отбрасывает тени) ---------------------
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(radius * 0.75, radius * 1.45, radius * 0.55);
  key.castShadow = true;

  // 1024x1024 — этого достаточно для мягких теней под коробками.
  // 2048x2048 стоил бы вчетверо дороже при рисовании карты теней.
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0006;      // убирает «полосы» (shadow acne) на поверхностях
  key.shadow.normalBias = 0.035; // сдвигает тень по нормали — тоже лечит acne
  key.shadow.radius = 2;

  // «Камера» источника света — просто большой куб, в который он всё видит.
  const shadowCamera = key.shadow.camera;
  shadowCamera.near = 1;
  shadowCamera.far = radius * 4.5;
  shadowCamera.left = -radius * 1.15;
  shadowCamera.right = radius * 1.15;
  shadowCamera.top = radius * 1.15;
  shadowCamera.bottom = -radius * 1.15;
  shadowCamera.updateProjectionMatrix();

  scene.add(key);
  scene.add(key.target);

  // --- контровой свет (без теней) --------------------------------------
  const rim = new THREE.DirectionalLight(0x8fb4ff, 0.55);
  rim.position.set(-radius * 0.8, radius * 0.7, -radius * 0.6);
  scene.add(rim);

  return { key };
}

/**
 * Нарисовать сетку линий на плоскости XZ.
 * @param {number} width
 * @param {number} depth
 * @param {number} cell размер клетки
 * @param {number} color
 * @param {number} opacity
 * @param {number} y высота над полом
 * @returns {THREE.LineSegments}
 */
function createGridLines(width, depth, cell, color, opacity, y) {
  const positions = [];
  const halfW = width / 2;
  const halfD = depth / 2;

  // Вертикальные линии (по X).
  for (let x = Math.ceil(-halfW / cell) * cell; x <= halfW + 1e-6; x += cell) {
    positions.push(x, 0, -halfD, x, 0, halfD);
  }
  // Горизонтальные линии (по Z).
  for (let z = Math.ceil(-halfD / cell) * cell; z <= halfD + 1e-6; z += cell) {
    positions.push(-halfW, 0, z, halfW, 0, z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  lines.position.y = y;
  lines.renderOrder = 1;
  return lines;
}

/**
 * Создать пол магазина: тёмная плита, мелкая и крупная сетки и рамка по краю.
 * @param {THREE.Scene} scene
 * @param {{width:number, depth:number}} bounds
 * @returns {THREE.Group}
 */
export function createFloor(scene, bounds) {
  const group = new THREE.Group();
  group.name = 'floor';

  const margin = 6; // запас вокруг здания магазина
  const width = bounds.width + margin * 2;
  const depth = bounds.depth + margin * 2;

  // Подложка «бесконечного пола». Тени она не принимает: она за пределами
  // теневой камеры, поэтому тратить на неё лишний шейдер незачем.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(width, depth) * 6, Math.max(width, depth) * 6),
    new THREE.MeshStandardMaterial({ color: 0x0a0d13, roughness: 1, metalness: 0 })
  );
  backdrop.rotation.x = -Math.PI / 2;
  backdrop.position.y = -0.06;
  group.add(backdrop);

  // Собственно плита пола магазина — вот она принимает тени от коробок.
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshStandardMaterial({ color: 0x141922, roughness: 0.92, metalness: 0.04 })
  );
  slab.rotation.x = -Math.PI / 2;
  slab.receiveShadow = true;
  group.add(slab);

  // Мелкая сетка (1 юнит) и крупная (10 юнитов).
  group.add(createGridLines(width, depth, 1, 0x2c3a4f, 0.5, 0.02));
  group.add(createGridLines(width, depth, 10, 0x4f6d99, 0.75, 0.03));

  // Рамка по периметру пола.
  const halfW = width / 2;
  const halfD = depth / 2;
  const frame = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfW, 0.05, -halfD),
      new THREE.Vector3(halfW, 0.05, -halfD),
      new THREE.Vector3(halfW, 0.05, halfD),
      new THREE.Vector3(-halfW, 0.05, halfD),
      new THREE.Vector3(-halfW, 0.05, -halfD)
    ]),
    new THREE.LineBasicMaterial({ color: 0x59a5ff, transparent: true, opacity: 0.55 })
  );
  frame.renderOrder = 2;
  group.add(frame);

  scene.add(group);
  return group;
}

/**
 * Создать коробку одного магазина.
 *
 * В `userData` кладём всё, что понадобится позже: id магазина, сам объект
 * данных и исходный цвет (из него мы считаем состояние «наведён / выбран»).
 *
 * @param {{id:string,name:string,width:number,depth:number,color:number}} shop
 * @param {{x:number,z:number}} placement
 * @returns {THREE.Mesh}
 */
export function createShopMesh(shop, placement) {
  const geometry = new THREE.BoxGeometry(shop.width, SHOP_HEIGHT, shop.depth);
  const baseColor = new THREE.Color(shop.color);

  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.45,
    metalness: 0.08,
    emissive: baseColor.clone(),
    emissiveIntensity: 0 // 0 = обычный вид, > 0 = подсветка при наведении
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Центр коробки ставим на высоту SHOP_HEIGHT / 2, чтобы она стояла на полу.
  mesh.position.set(placement.x, SHOP_HEIGHT / 2, placement.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = shop.id;
  mesh.userData = {
    shopId: shop.id,
    shop,
    baseColor: baseColor.clone()
  };
  return mesh;
}

/**
 * Построить весь ТЦ: коробки всех магазинов + общий контур.
 *
 * Контуры ( рёбра коробок ) сливаются в ОДИН объект `LineSegments`.
 * Иначе было бы 100 дополнительных вызовов отрисовки — по одному на магазин.
 *
 * @param {THREE.Scene} scene
 * @param {Array} shops
 * @param {Map<string, object>} placementMap
 * @returns {{group:THREE.Group, meshes:THREE.Mesh[], outlines:THREE.LineSegments}}
 */
export function buildMall(scene, shops, placementMap) {
  const group = new THREE.Group();
  group.name = 'mall';

  const meshes = [];
  const outlineGeometries = [];

  for (const shop of shops) {
    const placement = placementMap.get(shop.id);
    if (!placement) continue;

    const mesh = createShopMesh(shop, placement);
    group.add(mesh);
    meshes.push(mesh);

    // Рёбра коробки -> мировые координаты.
    const edges = new THREE.EdgesGeometry(mesh.geometry);
    edges.translate(placement.x, SHOP_HEIGHT / 2, placement.z);
    outlineGeometries.push(edges);
  }

  // Сливаем все контуры в один объект.
  let outlines = null;
  if (outlineGeometries.length > 0) {
    const merged = mergeGeometries(outlineGeometries, false);
    for (const geometry of outlineGeometries) geometry.dispose(); // освобождаем память
    outlines = new THREE.LineSegments(
      merged,
      new THREE.LineBasicMaterial({ color: 0x05070c, transparent: true, opacity: 0.55 })
    );
    outlines.name = 'mall-outlines';
    group.add(outlines);
  }

  scene.add(group);
  return { group, meshes, outlines };
}

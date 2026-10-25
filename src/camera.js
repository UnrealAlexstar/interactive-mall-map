/**
 * camera.js — камеры и переключение 2D ⇄ 3D.
 *
 * В приложении одновременно живут две камеры:
 *   - perspectiveCamera — режим 3D (изометрия). Её же используем как «тележку»
 *     для анимации перехода;
 *   - orthographicCamera — режим 2D (плоский план магазина сверху).
 *
 * ПОЧЕМУ ПЕРЕХОД ВЫГЛЯДИТ НЕРАЗРЫВНЫМ
 * -----------------------------------
 * Перспективную и ортографическую проекции нельзя получить друг из друга
 * поворотом или сдвигом камеры — это разные проекции. Поэтому переход сделан
 * так:
 *
 *   1. Состояние 2D мысленно описываем как ПЕРСПЕКТИВНУЮ позу: камера висит
 *      строго над планом на расстоянии D, при котором перспективный кадр
 *      закрывает ровно ту же высоту мира H, что и ортографический:
 *
 *          H = 2 * D * tan(fov / 2)
 *
 *      Ортографической камере задаём top = H/2, bottom = -H/2, zoom = 1 —
 *      и оба кадра получаются пиксель в пиксель одинаковыми.
 *
 *   2. Анимируем ориентацию камеры с помощью quaternion slerp (без проблем с
 *      гироскопом и без вырожденного «вверх» при взгляде строго вниз), а
 *      расстояние — обычным lerp:
 *
 *          dir(t) = slerp(qFrom, qTo, e) * (0, 0, 1)
 *          pos(t) = lerp(targetFrom, targetTo, e) + dir(t) * lerp(rFrom, rTo, e)
 *
 *      Формула точно воспроизводит начальную и конечную позы, поэтому в конце
 *      анимации смена проекции незаметна.
 *
 *   3. Вектор «вверх» меняется с +Y (3D) на -Z (2D), но мы НЕ интерполируем
 *      его в процессе анимации — он «зашит» в два кватерниона. Иначе в какой-то
 *      момент направление взгляда и вектор «вверх» стали бы параллельными, и
 *      lookAt() выродился бы.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Вертикальный угол обзора камеры в 3D. */
export const FOV_3D = 45;
/** Угол обзора «тележки» перехода — им же настроен 2D-кадр. */
export const FOV_2D = 30;
/** Длительность перехода 2D ⇄ 3D в миллисекундах. */
export const TRANSITION_DURATION = 900;

/** Угол изометрии: наклон от вертикали (полярный) и поворот вокруг оси Y. */
const POLAR_3D = THREE.MathUtils.degToRad(52);
const AZIMUTH_3D = THREE.MathUtils.degToRad(40);

/** Запас вокруг магазина, чтобы он не упирался в края кадра. */
const FIT_MARGIN = 1.08;

/**
 * Плавное ускорение/торможение (кубическая кривая).
 * @param {number} t 0..1
 * @returns {number} 0..1
 */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Кватернион ориентации камеры, которая смотрит из `eye` в `target`.
 * @param {THREE.Vector3} eye
 * @param {THREE.Vector3} target
 * @param {THREE.Vector3} up
 * @returns {THREE.Quaternion}
 */
function lookAtQuaternion(eye, target, up) {
  const matrix = new THREE.Matrix4().lookAt(eye, target, up);
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

export class CameraManager {
  /**
   * @param {object} options
   * @param {HTMLElement} options.domElement элемент, на котором работают мышь и колесо
   * @param {{width:number, depth:number, centerX:number, centerZ:number}} options.bounds
   * @param {number} [options.aspect] отношение ширины к высоте окна
   */
  constructor({ domElement, bounds, aspect = 1 }) {
    this.domElement = domElement;
    this.bounds = bounds;
    this.mode = '3d';
    this.blend = 0; // 0 = чистый 3D, 1 = чистый 2D
    this.transition = null;
    this.activeCamera = null;
    this.userInteracted = false; // пользователь уже трогал камеру?

    // Снимок камеры до вызова OrbitControls.update(). Нужен, чтобы откатить
    // субпиксельное дрожание, когда контролы уже «успокоились»: update()
    // возвращает false, но перед этим успевает пересчитать position/quaternion.
    this._savedPosition = new THREE.Vector3();
    this._savedQuaternion = new THREE.Quaternion();
    this._savedTarget = new THREE.Vector3();

    // --- камеры ---------------------------------------------------------
    this.perspectiveCamera = new THREE.PerspectiveCamera(FOV_3D, aspect, 0.5, 4000);
    this.perspectiveCamera.up.set(0, 1, 0);

    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
    // В 2D режиме «вверх» на экране — это -Z, чтобы план читался как
    // архитектурный чертёж (север сверху).
    this.orthographicCamera.up.set(0, 0, -1);

    // --- управление в 3D: вращение + панорамирование + зум -------------
    this.controls3D = new OrbitControls(this.perspectiveCamera, domElement);
    this.controls3D.enableDamping = true;
    this.controls3D.dampingFactor = 0.08;
    this.controls3D.minDistance = 6;
    this.controls3D.maxDistance = 1500;
    this.controls3D.maxPolarAngle = Math.PI * 0.495; // не даём уйти под пол
    this.controls3D.minPolarAngle = 0.05;
    this.controls3D.screenSpacePanning = true;
    this.controls3D.addEventListener('start', () => {
      this.userInteracted = true;
    });

    // --- управление в 2D: только панорамирование и зум ------------------
    this.controls2D = new OrbitControls(this.orthographicCamera, domElement);
    this.controls2D.enableDamping = true;
    this.controls2D.dampingFactor = 0.08;
    this.controls2D.enableRotate = false; // план нельзя крутить
    this.controls2D.screenSpacePanning = true;
    this.controls2D.minZoom = 0.4;
    this.controls2D.maxZoom = 14;
    this.controls2D.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls2D.touches.ONE = THREE.TOUCH.PAN;

    this.resize(aspect);

    const pose = this.poseFor('3d');
    this.applyPose(pose);
    this.activate('3d', pose);
  }

  /**
   * Пересчитать кадрирование под текущее соотношение сторон окна.
   * @param {number} aspect
   */
  resize(aspect) {
    this.aspect = aspect;

    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    // --- кадрирование 2D-плана -----------------------------------------
    // План должен целиком поместиться в кадр: по вертикали занимает всю
    // высоту, по горизонтали — темную ширину окна.
    const planHeight = Math.max(this.bounds.depth, this.bounds.width / aspect) * FIT_MARGIN;
    const half = planHeight / 2;
    this.planHeight = planHeight;

    this.orthographicCamera.left = -half * aspect;
    this.orthographicCamera.right = half * aspect;
    this.orthographicCamera.top = half;
    this.orthographicCamera.bottom = -half;
    this.orthographicCamera.updateProjectionMatrix();

    // Расстояние, на котором перспективная камера даёт ровно тот же кадр.
    this.planDistance = half / Math.tan(THREE.MathUtils.degToRad(FOV_2D) / 2);

    // --- кадрирование 3D ------------------------------------------------
    // Направление на камеру в изометрии.
    const dir = new THREE.Vector3(
      Math.sin(POLAR_3D) * Math.sin(AZIMUTH_3D),
      Math.cos(POLAR_3D),
      Math.sin(POLAR_3D) * Math.cos(AZIMUTH_3D)
    ).normalize();
    this.isometricDirection = dir;

    // Магазин вписываем в сферу радиуса `radius` — этого достаточно, чтобы
    // весь ТЦ гарантированно попал в кадр.
    this.isometricRadius = this.fitRadius(dir, FOV_3D, aspect);

    // Если пользователь ещё не трогал камеру — перекадрируем 3D-вид.
    if (!this.userInteracted && this.mode === '3d' && !this.transition) {
      const pose = this.poseFor('3d');
      this.applyPose(pose);
      this.controls3D.target.copy(pose.target);
      this.controls3D.update();
    }
  }

  /**
   * Расстояние до камеры, при котором сфера радиуса `radius` целиком влезает
   * в кадр. Сфера описана вокруг всего магазина, поэтому результат
   * гарантированно вмещает любую точку плана.
   *
   * @param {THREE.Vector3} dir направление от цели к камере
   * @param {number} fovDeg вертикальный угол обзора
   * @param {number} aspect
   * @returns {number} расстояние
   */
  fitRadius(dir, fovDeg, aspect) {
    // Половины углов обзора: по вертикали и по горизонтали.
    const vHalf = THREE.MathUtils.degToRad(fovDeg) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);

    // Берём более «узкий» угол — он и определяет, на каком расстоянии
    // сфера впишется в кадр.
    const limit = Math.min(vHalf, hHalf);
    return (this.bounds.radius * FIT_MARGIN) / Math.sin(limit);
  }

  /**
   * Собрать «эталонную» позу для режима: 3D (изометрия) или 2D (сверху).
   *
   * Поза — это набор чисел, который описывает положение камеры целиком:
   * позиция, ориентация, точка, на которую смотрим, расстояние и угол обзора.
   *
   * @param {'3d'|'2d'} mode
   * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion, target:THREE.Vector3, radius:number, fov:number}}
   */
  poseFor(mode) {
    const target = new THREE.Vector3(this.bounds.centerX ?? 0, 0, this.bounds.centerZ ?? 0);

    if (mode === '2d') {
      // Камера строго над планом.
      const radius = this.planDistance;
      const position = new THREE.Vector3(target.x, target.y + radius, target.z);
      return {
        position,
        quaternion: lookAtQuaternion(position, target, new THREE.Vector3(0, 0, -1)),
        target,
        radius,
        fov: FOV_2D
      };
    }

    // Изометрия: отходим от цели в сторону `isometricDirection`.
    const radius = this.isometricRadius;
    const position = target.clone().addScaledVector(this.isometricDirection, radius);
    return {
      position,
      quaternion: lookAtQuaternion(position, target, new THREE.Vector3(0, 1, 0)),
      target,
      radius,
      fov: FOV_3D
    };
  }

  /**
   * Снять текущее состояние камеры как позу, с которой можно интерполировать.
   * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion, target:THREE.Vector3, radius:number, fov:number}}
   */
  currentPose() {
    if (this.activeCamera === this.orthographicCamera) {
      // Текущий 2D-кадр (с учётом зума и панорамирования) переводим в
      // равносильную перспективную позу, чтобы переход начался ровно оттуда,
      // где видит пользователь.
      const visibleHeight =
        (this.orthographicCamera.top - this.orthographicCamera.bottom) / this.orthographicCamera.zoom;
      const distance = visibleHeight / 2 / Math.tan(THREE.MathUtils.degToRad(FOV_2D) / 2);
      const target = new THREE.Vector3(
        this.orthographicCamera.position.x,
        0,
        this.orthographicCamera.position.z
      );
      const position = new THREE.Vector3(target.x, target.y + distance, target.z);
      return {
        position,
        quaternion: lookAtQuaternion(position, target, new THREE.Vector3(0, 0, -1)),
        target,
        radius: distance,
        fov: FOV_2D
      };
    }

    const camera = this.perspectiveCamera;
    const target = this.controls3D.target.clone();
    return {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      target,
      radius: camera.position.distanceTo(target),
      fov: camera.fov
    };
  }

  /**
   * Применить позу к перспективной камере.
   * @param {object} pose
   */
  applyPose(pose) {
    this.perspectiveCamera.position.copy(pose.position);
    this.perspectiveCamera.quaternion.copy(pose.quaternion);
    this.perspectiveCamera.fov = pose.fov;
    this.perspectiveCamera.updateProjectionMatrix();
    this.perspectiveCamera.updateMatrixWorld(true);
  }

  /**
   * Включить режим БЕЗ анимации и синхронизировать нужные органы управления.
   * @param {'3d'|'2d'} mode
   * @param {object} pose
   */
  activate(mode, pose) {
    if (mode === '2d') {
      // Переносим перспективную 2D-позу на ортографическую камеру:
      // тот же кадр, но другая проекция.
      this.orthographicCamera.position.set(pose.target.x, pose.target.y + pose.radius, pose.target.z);
      this.orthographicCamera.up.set(0, 0, -1);
      this.orthographicCamera.zoom = 1;
      this.orthographicCamera.lookAt(pose.target);
      this.orthographicCamera.updateProjectionMatrix();
      this.orthographicCamera.updateMatrixWorld(true);
      this.controls2D.target.copy(pose.target);
      this.controls2D.enabled = true;
      this.controls3D.enabled = false;
      this.activeCamera = this.orthographicCamera;
    } else {
      this.controls3D.target.copy(pose.target);
      this.controls3D.enabled = true;
      this.controls2D.enabled = false;
      this.controls3D.update();
      this.activeCamera = this.perspectiveCamera;
    }
    this.mode = mode;
    this.blend = mode === '2d' ? 1 : 0;
  }

  /**
   * Переключить режим (с анимацией).
   * @param {'2d'|'3d'} mode
   * @param {object} [options]
   * @param {boolean} [options.immediate=false] пропустить анимацию
   * @returns {boolean} true, если переключение принято
   */
  setMode(mode, { immediate = false } = {}) {
    const next = mode === '2d' ? '2d' : '3d';
    if (this.transition) return false; // анимация уже идёт
    if (next === this.mode && !immediate) return false;

    const from = this.currentPose();
    const to = this.poseFor(next);

    if (immediate) {
      this.applyPose(to);
      this.activate(next, to);
      return true;
    }

    this.transition = {
      from,
      to,
      toMode: next,
      start: performance.now(),
      duration: TRANSITION_DURATION
    };
    this.mode = next; // режим, к которому мы движемся
    this.controls3D.enabled = false;
    this.controls2D.enabled = false;
    this.activeCamera = this.perspectiveCamera;
    return true;
  }

  /**
   * Переключить 2D ⇄ 3D.
   * @returns {boolean}
   */
  toggleMode() {
    return this.setMode(this.mode === '2d' ? '3d' : '2d');
  }

  /**
   * Вернуть стандартный изометрический вид.
   */
  resetView() {
    this.transition = null;
    this.userInteracted = false;
    const pose = this.poseFor('3d');
    this.applyPose(pose);
    this.activate('3d', pose);
  }

  /**
   * Продвинуть анимацию. Вызывается один раз за кадр.
   *
   * @param {number} now метка времени в миллисекундах
   * @returns {boolean} true, если камера действительно изменилась
   *   (идёт переход, работает инерция OrbitControls или пользователь тянет мышь).
   *   По этому флагу `main.js` решает, нужно ли вообще перерисовывать кадр:
   *   на неподвижной сцене не тратятся ни CPU, ни GPU, а картинка не мерцает.
   */
  update(now) {
    const transition = this.transition;

    if (transition) {
      const raw = Math.min(1, (now - transition.start) / transition.duration);
      const e = easeInOutCubic(raw);

      const target = transition.from.target.clone().lerp(transition.to.target, e);
      const quaternion = transition.from.quaternion.clone().slerp(transition.to.quaternion, e);
      const radius = transition.from.radius + (transition.to.radius - transition.from.radius) * e;
      const fov = transition.from.fov + (transition.to.fov - transition.from.fov) * e;

      // Локальная ось +Z камеры смотрит ОТ цели (соглашение three.js),
      // поэтому глаз = цель + направление * расстояние.
      const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
      this.perspectiveCamera.position.copy(target).addScaledVector(direction, radius);
      this.perspectiveCamera.quaternion.copy(quaternion);
      this.perspectiveCamera.fov = fov;
      this.perspectiveCamera.updateProjectionMatrix();
      this.perspectiveCamera.updateMatrixWorld(true);

      this.activeCamera = this.perspectiveCamera;
      this.blend = transition.toMode === '2d' ? e : 1 - e;

      if (raw >= 1) {
        this.transition = null;
        this.activate(transition.toMode, transition.to);
      }
      return true;
    }

    // Обычный кадр: камера едет по своим правилам.
    this.blend = this.mode === '2d' ? 1 : 0;

    const controls = this.mode === '2d' ? this.controls2D : this.controls3D;
    const camera = this.mode === '2d' ? this.orthographicCamera : this.perspectiveCamera;
    this.activeCamera = camera;

    // OrbitControls.update() пересчитывает позицию и lookAt КАЖДЫЙ вызов,
    // даже когда пользователь ничего не делает. Из-за ошибок округления это
    // даёт микроскопическое дрожание камеры — на неподвижной сцене оно
    // выглядит как мерцание/«шевеление» пикселей. Поэтому запоминаем позу и
    // откатываем её, если контролы сообщили, что реальных изменений нет.
    this._savedPosition.copy(camera.position);
    this._savedQuaternion.copy(camera.quaternion);
    this._savedTarget.copy(controls.target);

    const changed = controls.update();

    if (!changed) {
      camera.position.copy(this._savedPosition);
      camera.quaternion.copy(this._savedQuaternion);
      controls.target.copy(this._savedTarget);
      return false;
    }

    // OrbitControls меняет position/quaternion, но не world-матрицу. Подписи
    // проецируются в этом же кадре, до вызова renderer.render(), поэтому
    // матрицу нужно обновить здесь, иначе подписи отставали бы на кадр.
    camera.updateMatrixWorld(true);
    return true;
  }

  /** @returns {boolean} идёт ли сейчас анимация перехода */
  get isTransitioning() {
    return this.transition !== null;
  }
}

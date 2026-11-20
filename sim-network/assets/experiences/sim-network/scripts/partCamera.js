/**
 * Sim-network custom camera — grid-center home, cell-click focus, short press-freeze.
 * Player only. Keeps scene JSON orbit limits; panning stays off.
 * A place/cable press can freeze orbit for that gesture. A real drag releases it,
 * except a cable drag that starts on a device (that one stays frozen).
 */

import { getActiveLayout, getPlacementAtCell } from './layoutAssembler.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';
/** Match scene camera default target Y in cyber-c2.json. */
const HOME_TARGET_Y = 0.5;
/** Huge angular sensibility ≈ no drag-rotate (wheel zoom still works). */
const LOCKED_ANGULAR_SENSIBILITY = 1e12;
const DEFAULT_LERP_MS = 1000;
const BANNER_ID = 'sim-network-camera-locked-banner';
/** Layer-2 wall / structure — same rotation reference player drops use. */
const FOCUS_WALL_LAYER = 2;
/**
 * How far a press must move before it is a camera drag instead of a tool click.
 * Shared by the place tool and Cable-on-empty-cell. A shaky tap stays a click.
 */
export const TOOL_CAMERA_DRAG_SLOP_PX = 10;

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {import('@babylonjs/core').ArcRotateCamera | null} */
let boundCamera = null;
/** @type {{ x: number, y: number, z: number } | null} */
let homeTarget = null;
/** @type {number} */
let homeAlpha = 0;
/** @type {number} */
let homeBeta = 0;
/** @type {number} */
let homeRadius = 10;
/** Cell double-click focus radius from scene `camera.defaultFocusRadius`. */
/** @type {number} */
let focusRadius = 10;
/**
 * Extra radians when falling back to a device mesh yaw
 * (local +Z → alpha = π/2 − yaw). +π: kit GLBs face opposite that local +Z.
 */
const FOCUS_FACE_ALPHA_OFFSET = Math.PI;
/** Extra degrees when a layer-2 placement is mirrored (matches drop yaw). */
const MIRRORED_LAYER2_ROTATION_Y_EXTRA = 180;
/** @type {number} */
let lerpDurationMs = DEFAULT_LERP_MS;
/** @type {boolean} */
let locked = false;
/** @type {number | null} */
let savedAngularX = null;
/** @type {number | null} */
let savedAngularY = null;
/** @type {number} */
let lockedAlpha = 0;
/** @type {number} */
let lockedBeta = 0;
/** @type {import('@babylonjs/core').Vector3 | null} */
let lockedTarget = null;
/** @type {import('@babylonjs/core').Observer | null} */
let lockObserver = null;
/** @type {import('@babylonjs/core').Observer | null} */
let lerpObserver = null;
/** @type {HTMLElement | null} */
let bannerEl = null;
/** @type {((event: Event) => void) | null} */
let onPluginsSummary = null;
/** @type {((event: Event) => void) | null} */
let onReset3dView = null;

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (
        !host ||
        typeof host.Vector3 !== 'function' ||
        typeof host.layoutCellHalfOffset !== 'function' ||
        typeof host.getPlayerUiRoot !== 'function' ||
        !host.EVENTS ||
        typeof host.dispatchAppEvent !== 'function' ||
        !host.GLOBAL_DATA ||
        !host.PointerEventTypes
    ) {
        throw new Error(
            'Experience host API missing camera helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @param {import('@babylonjs/core').Camera | null | undefined} camera
 * @returns {camera is import('@babylonjs/core').ArcRotateCamera}
 */
function isOrbitCamera(camera) {
    return Boolean(
        camera &&
            typeof camera.alpha === 'number' &&
            typeof camera.beta === 'number' &&
            typeof camera.radius === 'number' &&
            camera.target
    );
}

/**
 * @param {object} layout
 * @returns {{ x: number, y: number, z: number }}
 */
function computeGridCenterTarget(layout) {
    const cellSize = layout?.cellSize ?? 1;
    const width = layout?.width ?? 0;
    const depth = layout?.depth ?? 0;
    return {
        x: (width * cellSize) / 2,
        y: HOME_TARGET_Y,
        z: (depth * cellSize) / 2,
    };
}

/**
 * @param {{ x: number, z: number }} cell
 * @param {object} layout
 * @returns {{ x: number, y: number, z: number }}
 */
function cellWorldCenter(cell, layout) {
    const host = getHost();
    const cellSize = layout?.cellSize ?? 1;
    const half = host.layoutCellHalfOffset(cellSize);
    return {
        x: cell.x * cellSize + half,
        y: HOME_TARGET_Y,
        z: cell.z * cellSize + half,
    };
}

function ensureBanner() {
    if (bannerEl) {
        return;
    }
    const host = getHost();
    const root = host.getPlayerUiRoot();
    bannerEl = document.createElement('div');
    bannerEl.id = BANNER_ID;
    bannerEl.className = 'sim-network-camera-locked-banner';
    bannerEl.hidden = true;
    bannerEl.setAttribute('role', 'status');
    bannerEl.setAttribute('aria-live', 'polite');

    const titleEl = document.createElement('div');
    titleEl.className = 'sim-network-camera-locked-banner__title';
    titleEl.textContent = 'Camera locked';
    bannerEl.appendChild(titleEl);

    root.appendChild(bannerEl);
}

function showBanner(visible) {
    if (!visible) {
        if (bannerEl) {
            bannerEl.hidden = true;
        }
        return;
    }
    ensureBanner();
    if (bannerEl) {
        bannerEl.hidden = false;
    }
}

function cancelTargetLerp() {
    if (boundScene && lerpObserver) {
        boundScene.onBeforeRenderObservable.remove(lerpObserver);
    }
    lerpObserver = null;
}

/**
 * Soft-freeze alpha/beta/target each frame while locked; radius (zoom) stays free.
 */
function attachLockObserver() {
    if (!boundScene || lockObserver) {
        return;
    }
    lockObserver = boundScene.onBeforeRenderObservable.add(() => {
        if (!locked || !boundCamera || !lockedTarget) {
            return;
        }
        boundCamera.alpha = lockedAlpha;
        boundCamera.beta = lockedBeta;
        boundCamera.target.copyFrom(lockedTarget);
        boundCamera.inertialAlphaOffset = 0;
        boundCamera.inertialBetaOffset = 0;
        boundCamera.inertialPanningX = 0;
        boundCamera.inertialPanningY = 0;
    });
}

function detachLockObserver() {
    if (boundScene && lockObserver) {
        boundScene.onBeforeRenderObservable.remove(lockObserver);
    }
    lockObserver = null;
}

/**
 * Tell the resetView plugin to use the grid-center home bookmark.
 */
function publishResetHome() {
    if (!homeTarget) {
        return;
    }
    const host = getHost();
    host.dispatchAppEvent(host.EVENTS.SET_RESET_VIEW_HOME, {
        alpha: homeAlpha,
        beta: homeBeta,
        radius: homeRadius,
        target: [homeTarget.x, homeTarget.y, homeTarget.z],
        durationMs: lerpDurationMs,
    });
}

function registerPluginHomeSync() {
    const host = getHost();
    onPluginsSummary = (event) => {
        const detail = /** @type {{ sceneId?: string, ok?: string[] }} */ (event?.detail);
        const sceneId = host.GLOBAL_DATA.getCurrentSceneId?.();
        if (detail?.sceneId && sceneId && detail.sceneId !== sceneId) {
            return;
        }
        if (Array.isArray(detail?.ok) && !detail.ok.includes('resetView')) {
            return;
        }
        publishResetHome();
    };
    window.addEventListener(host.EVENTS.PLUGINS_SUMMARY, onPluginsSummary);

    // Reset view while locked: unlock first so the freeze observer cannot snap
    // the camera back to the pre-home pose after the home lerp finishes.
    onReset3dView = () => {
        if (!locked) {
            return;
        }
        unlockSimNetworkCamera();
    };
    window.addEventListener(host.EVENTS.RESET_3D_VIEW, onReset3dView);
}

function unregisterPluginHomeSync() {
    const host = globalThis[HOST_KEY];
    if (host?.EVENTS && onPluginsSummary) {
        window.removeEventListener(host.EVENTS.PLUGINS_SUMMARY, onPluginsSummary);
    }
    if (host?.EVENTS && onReset3dView) {
        window.removeEventListener(host.EVENTS.RESET_3D_VIEW, onReset3dView);
    }
    onPluginsSummary = null;
    onReset3dView = null;
}

/**
 * @returns {boolean}
 */
export function isSimNetworkCameraLocked() {
    return locked;
}

/**
 * Freeze orbit (alpha/beta) and target; zoom (radius) still allowed within scene limits.
 * The banner stays hidden unless `showBanner` is true. A cable drag turns it on later.
 * @param {{ showBanner?: boolean }} [options]
 */
export function lockSimNetworkCamera(options = {}) {
    if (!boundCamera) {
        return;
    }
    const host = getHost();
    if (!locked) {
        savedAngularX = boundCamera.angularSensibilityX;
        savedAngularY = boundCamera.angularSensibilityY;
        if (!lockedTarget) {
            lockedTarget = new host.Vector3(0, HOME_TARGET_Y, 0);
        }
    }
    cancelTargetLerp();
    locked = true;
    lockedAlpha = boundCamera.alpha;
    lockedBeta = boundCamera.beta;
    lockedTarget.copyFrom(boundCamera.target);
    boundCamera.angularSensibilityX = LOCKED_ANGULAR_SENSIBILITY;
    boundCamera.angularSensibilityY = LOCKED_ANGULAR_SENSIBILITY;
    boundCamera.inertialAlphaOffset = 0;
    boundCamera.inertialBetaOffset = 0;
    boundCamera.inertialPanningX = 0;
    boundCamera.inertialPanningY = 0;
    attachLockObserver();
    showBanner(options.showBanner === true);
}

/**
 * Show or hide the Camera locked banner while orbit is frozen.
 * @param {boolean} visible
 */
export function setSimNetworkCameraLockBanner(visible) {
    if (!locked) {
        showBanner(false);
        return;
    }
    showBanner(visible === true);
}

/**
 * Restore orbit drag and hide the lock banner.
 */
export function unlockSimNetworkCamera() {
    if (!boundCamera) {
        locked = false;
        showBanner(false);
        return;
    }
    locked = false;
    detachLockObserver();
    if (savedAngularX != null) {
        boundCamera.angularSensibilityX = savedAngularX;
    }
    if (savedAngularY != null) {
        boundCamera.angularSensibilityY = savedAngularY;
    }
    savedAngularX = null;
    savedAngularY = null;
    showBanner(false);
}

/**
 * Fallback: orbit alpha from a device mesh yaw (local +Z as front).
 * @param {number} yawRadians
 * @returns {number}
 */
function faceAlphaFromYaw(yawRadians) {
    return Math.PI / 2 - yawRadians + FOCUS_FACE_ALPHA_OFFSET;
}

/**
 * Two face normals for a layer-2 wall/structure at `rotationY` degrees.
 * Even 90° steps (0/180): wall runs along Z → ±X. Odd (90/270): along X → ±Z.
 * @param {number} rotationYDeg
 * @returns {Array<{ x: number, z: number }>}
 */
function wallFaceNormals(rotationYDeg) {
    const quarter = ((Math.round(rotationYDeg / 90) % 4) + 4) % 4;
    if (quarter === 0 || quarter === 2) {
        return [
            { x: 1, z: 0 },
            { x: -1, z: 0 },
        ];
    }
    return [
        { x: 0, z: 1 },
        { x: 0, z: -1 },
    ];
}

/**
 * Into-the-room unit direction from layer-2 at the cell, picking the face
 * that points more toward the layout grid centre. Null if no layer-2 piece.
 * (Open-neighbour fallback is deferred until centre-aim fails in testing.)
 * @param {{ x: number, z: number }} cell
 * @param {object} layout
 * @returns {{ x: number, z: number } | null}
 */
function inwardDirFromWall(cell, layout) {
    const placement = getPlacementAtCell(cell.x, cell.z, FOCUS_WALL_LAYER);
    if (!placement) {
        return null;
    }
    let rotationY = typeof placement.rotationY === 'number' ? placement.rotationY : 0;
    if (placement.mirror === true) {
        rotationY += MIRRORED_LAYER2_ROTATION_Y_EXTRA;
    }
    const normals = wallFaceNormals(rotationY);
    const width = layout?.width ?? 0;
    const depth = layout?.depth ?? 0;
    const toCentreX = width / 2 - 0.5 - cell.x;
    const toCentreZ = depth / 2 - 0.5 - cell.z;
    let best = normals[0];
    let bestDot = -Infinity;
    for (const normal of normals) {
        const dot = normal.x * toCentreX + normal.z * toCentreZ;
        if (dot > bestDot) {
            bestDot = dot;
            best = normal;
        }
    }
    console.log(
        `[partCamera.js]: [N/A] - [inwardDirFromWall] - cell has a value of ${cell.x},${cell.z}, rotationY has a value of ${rotationY}, inward has a value of ${best.x},${best.z}, bestDot has a value of ${bestDot}.`
    ); //This is logged when face-on focus picks the room-side wall normal.
    return best;
}

/**
 * Lerp camera target to a cell’s world center and radius to `defaultFocusRadius`.
 * Spins alpha to look from into-the-room (layer-2 wall → grid centre), else
 * optional device yaw fallback. Beta (tilt) always stays put. No-op while locked.
 * @param {{ x: number, z: number }} cell
 * @param {{ faceYawRadians?: number | null }} [options]
 */
export function focusSimNetworkCell(cell, options = {}) {
    if (locked || !boundCamera || !boundScene || !cell) {
        return;
    }
    const activeLayout = getActiveLayout();
    if (!activeLayout) {
        console.warn(
            `[partCamera.js]: [N/A] - [focusSimNetworkCell] - layoutMissing has a value of true.`
        ); //This is logged when cell focus cannot resolve the active layout for world-center math.
        return;
    }

    const host = getHost();
    const goal = cellWorldCenter(cell, activeLayout);
    cancelTargetLerp();

    const start = boundCamera.target.clone();
    const goalVec = new host.Vector3(goal.x, goal.y, goal.z);
    const startRadius = boundCamera.radius;
    const goalRadius = focusRadius;
    const startAlpha = boundCamera.alpha;
    const fallbackYaw =
        typeof options?.faceYawRadians === 'number' && Number.isFinite(options.faceYawRadians)
            ? options.faceYawRadians
            : null;
    const inward = inwardDirFromWall(cell, activeLayout);
    /** @type {number | null} */
    let rawGoalAlpha = null;
    /** @type {string} */
    let faceSource = 'none';
    if (inward) {
        // Camera sits on the inward side: alpha from atan2(z, x) matches ArcRotate offset.
        rawGoalAlpha = Math.atan2(inward.z, inward.x);
        faceSource = 'wall-inward';
    } else if (fallbackYaw != null) {
        rawGoalAlpha = faceAlphaFromYaw(fallbackYaw);
        faceSource = 'device-yaw';
    }
    // Keep goal on the same continuous spin as startAlpha (never snap across a full turn).
    const alphaDelta = rawGoalAlpha != null ? shortestAngleDelta(startAlpha, rawGoalAlpha) : 0;
    const endAlpha = rawGoalAlpha != null ? startAlpha + alphaDelta : startAlpha;
    const spinAlpha = rawGoalAlpha != null;
    const startTime = performance.now();
    const duration = lerpDurationMs;

    boundCamera.inertialAlphaOffset = 0;
    boundCamera.inertialBetaOffset = 0;
    boundCamera.inertialRadiusOffset = 0;

    console.log(
        `[partCamera.js]: [N/A] - [focusSimNetworkCell] - cell has a value of ${cell.x},${cell.z}, faceSource has a value of ${faceSource}, startAlpha has a value of ${startAlpha}, rawGoalAlpha has a value of ${rawGoalAlpha ?? 'null'}, alphaDelta has a value of ${alphaDelta}, endAlpha has a value of ${endAlpha}.`
    ); //This is logged when cell focus starts, to verify shortest-turn alpha mapping.

    lerpObserver = boundScene.onBeforeRenderObservable.add(() => {
        if (!boundCamera) {
            cancelTargetLerp();
            return;
        }
        const t = Math.min(1, (performance.now() - startTime) / duration);
        const x = start.x + (goalVec.x - start.x) * t;
        const y = start.y + (goalVec.y - start.y) * t;
        const z = start.z + (goalVec.z - start.z) * t;
        // copyFrom components — do not use setTarget (would rewrite alpha/beta/radius).
        boundCamera.target.x = x;
        boundCamera.target.y = y;
        boundCamera.target.z = z;
        // Radius is distance-from-target on ArcRotateCamera; set directly so beta stays put.
        boundCamera.radius = startRadius + (goalRadius - startRadius) * t;
        if (spinAlpha) {
            boundCamera.alpha = startAlpha + alphaDelta * t;
        }
        if (t >= 1) {
            boundCamera.target.copyFrom(goalVec);
            boundCamera.radius = goalRadius;
            if (spinAlpha) {
                boundCamera.alpha = endAlpha;
            }
            cancelTargetLerp();
        }
    });
}

/**
 * Signed turn from `from` to `to` in (−π, π] — the short way around the circle.
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function shortestAngleDelta(from, to) {
    const tau = Math.PI * 2;
    let delta = (to - from) % tau;
    if (delta > Math.PI) {
        delta -= tau;
    } else if (delta < -Math.PI) {
        delta += tau;
    }
    return delta;
}

/**
 * Shortest turn from one orbit angle to another, so the camera does not spin the long way.
 * @param {number} from
 * @param {number} to
 * @param {number} t
 * @returns {number}
 */
function lerpAngle(from, to, t) {
    return from + shortestAngleDelta(from, to) * t;
}

/**
 * Move to a steep overhead view of the grid centre.
 * Uses the camera's own lowest up-down angle, the saved home distance, and the saved compass direction.
 * No-op while the camera is locked. Does not press Reset view.
 */
export function focusSimNetworkOverview() {
    if (locked || !boundCamera || !boundScene || !homeTarget) {
        return;
    }
    const host = getHost();
    const goalBeta =
        typeof boundCamera.lowerBetaLimit === 'number' ? boundCamera.lowerBetaLimit : homeBeta;
    cancelTargetLerp();
    const startTarget = boundCamera.target.clone();
    const goalTarget = new host.Vector3(homeTarget.x, homeTarget.y, homeTarget.z);
    const startAlpha = boundCamera.alpha;
    const startBeta = boundCamera.beta;
    const startRadius = boundCamera.radius;
    const goalRadius = homeRadius;
    const alphaDelta = shortestAngleDelta(startAlpha, homeAlpha);
    const endAlpha = startAlpha + alphaDelta;
    const startTime = performance.now();
    const duration = lerpDurationMs;
    boundCamera.inertialAlphaOffset = 0;
    boundCamera.inertialBetaOffset = 0;
    boundCamera.inertialRadiusOffset = 0;
    console.log(
        `[partCamera.js]: [N/A] - [focusSimNetworkOverview] - goalBeta has a value of ${goalBeta}, goalRadius has a value of ${goalRadius}, alphaDelta has a value of ${alphaDelta}.`
    ); //This is logged when the results HUD asks for the overhead camera home.
    lerpObserver = boundScene.onBeforeRenderObservable.add(() => {
        if (!boundCamera) {
            cancelTargetLerp();
            return;
        }
        const t = Math.min(1, (performance.now() - startTime) / duration);
        boundCamera.target.x = startTarget.x + (goalTarget.x - startTarget.x) * t;
        boundCamera.target.y = startTarget.y + (goalTarget.y - startTarget.y) * t;
        boundCamera.target.z = startTarget.z + (goalTarget.z - startTarget.z) * t;
        boundCamera.alpha = startAlpha + alphaDelta * t;
        boundCamera.beta = startBeta + (goalBeta - startBeta) * t;
        boundCamera.radius = startRadius + (goalRadius - startRadius) * t;
        if (t >= 1) {
            boundCamera.target.copyFrom(goalTarget);
            boundCamera.alpha = endAlpha;
            boundCamera.beta = goalBeta;
            boundCamera.radius = goalRadius;
            cancelTargetLerp();
        }
    });
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 * @param {object} layout
 */
/**
 * Home orbit radius (JSON camera.radius).
 * @returns {number}
 */
export function getSimNetworkHomeRadius() {
    return homeRadius;
}

/**
 * Current ArcRotateCamera radius, or home if the camera is not ready.
 * @returns {number}
 */
export function getSimNetworkCameraRadius() {
    if (boundCamera && typeof boundCamera.radius === 'number' && boundCamera.radius > 0) {
        return boundCamera.radius;
    }
    return homeRadius;
}

/**
 * Zoom as a fraction of home (1 = 100% / home distance).
 * Zooming out raises radius (fraction below 1); zooming in lowers it (fraction above 1).
 * @returns {number}
 */
export function getSimNetworkZoomFraction() {
    const radius = getSimNetworkCameraRadius();
    if (!homeRadius || homeRadius <= 0 || !radius || radius <= 0) {
        return 1;
    }
    return homeRadius / radius;
}

/**
 * Zoom fraction matching the zoom HUD (1 = closest / 100%, 0 = farthest / 0%).
 * Uses live ArcRotateCamera lowerRadiusLimit / upperRadiusLimit / radius.
 * @returns {number}
 */
export function getSimNetworkHudZoomFraction() {
    if (!boundCamera) {
        return 1;
    }
    const lower = boundCamera.lowerRadiusLimit;
    const upper = boundCamera.upperRadiusLimit;
    const radius = boundCamera.radius;
    if (
        typeof lower !== 'number' ||
        typeof upper !== 'number' ||
        upper <= lower ||
        typeof radius !== 'number' ||
        !(radius > 0)
    ) {
        return 1;
    }
    const clamped = Math.min(upper, Math.max(lower, radius));
    return (upper - clamped) / (upper - lower);
}

export function initializePartCamera(scene, layout) {
    disposePartCamera();

    const host = getHost();
    boundScene = scene;
    const camera = scene.activeCamera;
    if (!isOrbitCamera(camera)) {
        console.warn(
            `[partCamera.js]: [N/A] - [initializePartCamera] - orbitCameraMissing has a value of true.`
        ); //This is logged when sim-network camera helpers cannot bind because there is no ArcRotateCamera.
        return;
    }
    boundCamera = camera;

    const sceneId = host.GLOBAL_DATA.getCurrentSceneId?.();
    const sceneConfig = sceneId ? host.GLOBAL_DATA.getSceneDataSingle?.(sceneId) : null;
    const cameraConfig = sceneConfig?.camera || null;
    lerpDurationMs =
        typeof cameraConfig?.lerpDurationMs === 'number' && cameraConfig.lerpDurationMs > 0
            ? cameraConfig.lerpDurationMs
            : DEFAULT_LERP_MS;

    homeTarget = computeGridCenterTarget(layout);
    homeAlpha = typeof cameraConfig?.alpha === 'number' ? cameraConfig.alpha : camera.alpha;
    homeBeta = typeof cameraConfig?.beta === 'number' ? cameraConfig.beta : camera.beta;
    homeRadius = typeof cameraConfig?.radius === 'number' ? cameraConfig.radius : camera.radius;
    focusRadius =
        typeof cameraConfig?.defaultFocusRadius === 'number' &&
        cameraConfig.defaultFocusRadius > 0
            ? cameraConfig.defaultFocusRadius
            : homeRadius;

    // Apply center look-at now; keep JSON alpha/beta/radius / limits.
    camera.target.x = homeTarget.x;
    camera.target.y = homeTarget.y;
    camera.target.z = homeTarget.z;

    ensureBanner();
    registerPluginHomeSync();
    // Early publish; PLUGINS_SUMMARY will republish after resetView seeds from JSON.
    publishResetHome();

    console.log(
        `[partCamera.js]: [N/A] - [initializePartCamera] - homeTarget has a value of ${homeTarget.x},${homeTarget.y},${homeTarget.z}, width has a value of ${layout?.width}, depth has a value of ${layout?.depth}, lerpDurationMs has a value of ${lerpDurationMs}.`
    ); //This is logged when sim-network camera boots with grid-center home.
}

/**
 * Tear down lock, lerp, banner, and listeners.
 */
export function disposePartCamera() {
    cancelTargetLerp();
    unlockSimNetworkCamera();
    detachLockObserver();
    unregisterPluginHomeSync();

    bannerEl?.remove();
    bannerEl = null;
    boundScene = null;
    boundCamera = null;
    homeTarget = null;
    lockedTarget = null;
    locked = false;
}

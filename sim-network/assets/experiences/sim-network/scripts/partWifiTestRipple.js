/**
 * Stage 3.4 — disc ripple during Test Connection.
 * Cable packets stay as today; this module only adds timed orange ripples on online discs.
 */

import {
    isNetworkTestUiBusy,
    NETWORK_TEST_UI_CHANGED_EVENT,
} from './partCables.js';
import { getOnlineWifiDiscSnapshots } from './partWifiFx.js';
import {
    WIFI_DISC_TESSELLATION,
    WIFI_TEST_LOOP_S,
    WIFI_TEST_RIPPLE_END_T,
    WIFI_TEST_RIPPLE_FILL_ALPHA,
    WIFI_TEST_RIPPLE_FILL_COLOR_HEX,
    WIFI_TEST_RIPPLE_RING_ALPHA,
    WIFI_TEST_RIPPLE_RING_COLOR_HEX,
    WIFI_TEST_RIPPLE_RING_THICKNESS,
    WIFI_TEST_RIPPLE_STAGGER_T,
    WIFI_TEST_RIPPLE_START_T,
    WIFI_TEST_RIPPLE_Y,
} from './wifiConfig.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';

/**
 * @typedef {{
 *   stampId: string,
 *   range: number,
 *   root: import('@babylonjs/core').TransformNode,
 *   fill: import('@babylonjs/core').Mesh,
 *   ring: import('@babylonjs/core').Mesh,
 *   fillMat: import('@babylonjs/core').StandardMaterial,
 *   ringMat: import('@babylonjs/core').StandardMaterial,
 * }} RippleEntry
 */

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {((this: Window, ev: Event) => void) | null} */
let networkTestUiListener = null;
/** @type {import('@babylonjs/core').Observer | null} */
let renderObserver = null;
/** @type {RippleEntry[]} */
let rippleEntries = [];
/** Seconds into the shared test loop. */
let loopElapsedS = 0;
/** Signature of the last built snapshot set (stampId:range). */
let lastSnapshotKey = '';

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (
        !host ||
        typeof host.MeshBuilder !== 'object' ||
        typeof host.StandardMaterial !== 'function' ||
        typeof host.Color3 !== 'function' ||
        typeof host.TransformNode !== 'function'
    ) {
        throw new Error(
            'Experience host API missing WiFi test-ripple helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * Soft orange fill material for one ripple wash.
 * @param {string} name
 * @returns {import('@babylonjs/core').StandardMaterial}
 */
function makeFillMaterial(name) {
    const host = getHost();
    const mat = new host.StandardMaterial(name, boundScene);
    mat.disableLighting = true;
    mat.emissiveColor = host.Color3.FromHexString(WIFI_TEST_RIPPLE_FILL_COLOR_HEX);
    mat.diffuseColor = host.Color3.Black();
    mat.specularColor = host.Color3.Black();
    mat.alpha = 0;
    mat.transparencyMode = 2;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    return mat;
}

/**
 * Orange ring material for the expanding stroke.
 * @param {string} name
 * @returns {import('@babylonjs/core').StandardMaterial}
 */
function makeRingMaterial(name) {
    const host = getHost();
    const mat = new host.StandardMaterial(name, boundScene);
    mat.disableLighting = true;
    mat.emissiveColor = host.Color3.FromHexString(WIFI_TEST_RIPPLE_RING_COLOR_HEX);
    mat.diffuseColor = host.Color3.Black();
    mat.specularColor = host.Color3.Black();
    mat.alpha = 0;
    mat.transparencyMode = 2;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    return mat;
}

function disposeRippleEntries() {
    for (const entry of rippleEntries) {
        entry.fill.dispose();
        entry.ring.dispose();
        entry.root.dispose();
        entry.fillMat.dispose();
        entry.ringMat.dispose();
    }
    rippleEntries = [];
    lastSnapshotKey = '';
}

function stopRenderLoop() {
    if (boundScene && renderObserver) {
        boundScene.onBeforeRenderObservable.remove(renderObserver);
    }
    renderObserver = null;
}

function clearRipples() {
    stopRenderLoop();
    disposeRippleEntries();
    loopElapsedS = 0;
}

/**
 * @param {Array<{ stampId: string, range: number, x: number, y: number, z: number }>} snapshots
 */
function rebuildRippleEntries(snapshots) {
    disposeRippleEntries();
    if (!boundScene || snapshots.length === 0) {
        return;
    }
    const host = getHost();
    for (const snap of snapshots) {
        const range = Math.max(0.1, snap.range);
        const root = new host.TransformNode(`simnetWifiTestRippleRoot_${snap.stampId}`, boundScene);
        root.position.set(snap.x, WIFI_TEST_RIPPLE_Y, snap.z);

        const fillMat = makeFillMaterial(`simnetWifiTestRippleFillMat_${snap.stampId}`);
        // Unit disc; we scale XZ up to the source range as the ripple grows.
        const fill = host.MeshBuilder.CreateDisc(
            `simnetWifiTestRippleFill_${snap.stampId}`,
            { radius: 1, tessellation: WIFI_DISC_TESSELLATION },
            boundScene
        );
        fill.rotation.x = Math.PI / 2;
        fill.material = fillMat;
        fill.isPickable = false;
        fill.parent = root;
        fill.setEnabled(false);

        const ringMat = makeRingMaterial(`simnetWifiTestRippleRingMat_${snap.stampId}`);
        // Unit torus (diameter 2 → radius 1). Thickness is divided by range so full-size
        // world thickness ≈ WIFI_TEST_RIPPLE_RING_THICKNESS after scaling.
        const ring = host.MeshBuilder.CreateTorus(
            `simnetWifiTestRippleRing_${snap.stampId}`,
            {
                diameter: 2,
                thickness: WIFI_TEST_RIPPLE_RING_THICKNESS / range,
                tessellation: Math.max(24, Math.floor(WIFI_DISC_TESSELLATION / 2)),
            },
            boundScene
        );
        ring.material = ringMat;
        ring.isPickable = false;
        ring.parent = root;
        ring.setEnabled(false);

        rippleEntries.push({
            stampId: snap.stampId,
            range,
            root,
            fill,
            ring,
            fillMat,
            ringMat,
        });
    }
    lastSnapshotKey = snapshots.map((s) => `${s.stampId}:${s.range}`).join('|');
    console.log(
        `[partWifiTestRipple.js]: [N/A] - [rebuildRippleEntries] - rippleCount has a value of ${rippleEntries.length}, snapshotKey has a value of ${lastSnapshotKey}.`
    ); //This is logged when test ripples are built for the current online discs.
}

/**
 * Ease-out so the ripple expands quickly at first, then settles.
 * @param {number} t
 * @returns {number}
 */
function easeOutQuad(t) {
    const u = Math.max(0, Math.min(1, t));
    return 1 - (1 - u) * (1 - u);
}

/**
 * @param {RippleEntry} entry
 * @param {number} cycleT — 0..1 inside WIFI_TEST_LOOP_S
 * @param {number} index
 */
function paintRippleEntry(entry, cycleT, index) {
    const windowStart = WIFI_TEST_RIPPLE_START_T + index * WIFI_TEST_RIPPLE_STAGGER_T;
    const windowEnd = WIFI_TEST_RIPPLE_END_T;
    if (cycleT < windowStart || cycleT > windowEnd || windowEnd <= windowStart) {
        entry.fill.setEnabled(false);
        entry.ring.setEnabled(false);
        return;
    }
    const localT = (cycleT - windowStart) / (windowEnd - windowStart);
    const grow = easeOutQuad(localT);
    // Fade as it reaches full size so the ring reads as a passing wave.
    const fade = 1 - localT;
    const scale = Math.max(0.02, entry.range * grow);
    entry.fill.scaling.set(scale, scale, scale);
    entry.ring.scaling.set(scale, scale, scale);
    entry.fillMat.alpha = WIFI_TEST_RIPPLE_FILL_ALPHA * fade;
    entry.ringMat.alpha = WIFI_TEST_RIPPLE_RING_ALPHA * fade;
    entry.fill.setEnabled(true);
    entry.ring.setEnabled(true);
}

/**
 * @param {number} deltaS
 */
function tickRipples(deltaS) {
    if (!isNetworkTestUiBusy()) {
        clearRipples();
        return;
    }

    const snapshots = getOnlineWifiDiscSnapshots();
    const key = snapshots.map((s) => `${s.stampId}:${s.range}`).join('|');
    if (key !== lastSnapshotKey) {
        rebuildRippleEntries(snapshots);
    }
    if (rippleEntries.length === 0) {
        return;
    }

    loopElapsedS += Math.max(0, deltaS);
    if (loopElapsedS >= WIFI_TEST_LOOP_S) {
        loopElapsedS %= WIFI_TEST_LOOP_S;
    }
    const cycleT = loopElapsedS / WIFI_TEST_LOOP_S;
    for (let i = 0; i < rippleEntries.length; i += 1) {
        paintRippleEntry(rippleEntries[i], cycleT, i);
    }
}

function startRenderLoop() {
    if (!boundScene || renderObserver) {
        return;
    }
    renderObserver = boundScene.onBeforeRenderObservable.add(() => {
        const engine = boundScene?.getEngine?.();
        const deltaMs =
            typeof engine?.getDeltaTime === 'function' ? engine.getDeltaTime() : 16.67;
        tickRipples(deltaMs / 1000);
    });
}

function syncToNetworkTestUi() {
    if (!isNetworkTestUiBusy()) {
        if (rippleEntries.length > 0 || renderObserver) {
            clearRipples();
            console.log(
                `[partWifiTestRipple.js]: [N/A] - [syncToNetworkTestUi] - cleared has a value of true.`
            ); //This is logged when Test UI goes idle and disc ripples turn off.
        }
        return;
    }
    rebuildRippleEntries(getOnlineWifiDiscSnapshots());
    loopElapsedS = 0;
    startRenderLoop();
    console.log(
        `[partWifiTestRipple.js]: [N/A] - [syncToNetworkTestUi] - active has a value of true, rippleCount has a value of ${rippleEntries.length}.`
    ); //This is logged when Test Connection arms the online-disc ripple loop.
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializeWifiTestRipple(scene) {
    disposeWifiTestRipple();
    boundScene = scene;
    networkTestUiListener = () => {
        syncToNetworkTestUi();
    };
    window.addEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);
    console.log(
        `[partWifiTestRipple.js]: [N/A] - [initializeWifiTestRipple] - ready has a value of true.`
    ); //This is logged when Stage 3.4 disc ripples are armed for the active map.
}

export function disposeWifiTestRipple() {
    if (networkTestUiListener) {
        window.removeEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);
        networkTestUiListener = null;
    }
    clearRipples();
    boundScene = null;
}

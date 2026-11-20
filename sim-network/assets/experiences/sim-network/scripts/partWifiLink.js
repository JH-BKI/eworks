/**
 * Stage 3.3 — orange WiFi connection overlay + animated floor dashes.
 * Shown only while a Wireless-strip chip is selected (WIFI_CONNECTION_SELECTED_EVENT).
 */

import { getActiveLayout, getStampById } from './layoutAssembler.js';
import {
    isCableModeActive,
    isNetworkTestResultOverlayMesh,
    isNetworkTestUiBusy,
    NETWORK_TEST_UI_CHANGED_EVENT,
} from './partCables.js';
import { WIFI_CONNECTION_SELECTED_EVENT } from './partCellInspector.js';
import { isDroppableToolActive } from './partDrop.js';
import { refreshInteractableOverlays } from './partCellHighlight.js';
import { wifiLinkOverlayMeshes } from './wifiLinkOverlayState.js';
import {
    WIFI_LINK_COLOR_HEX,
    WIFI_LINK_DASH_HEIGHT,
    WIFI_LINK_DASH_LENGTH,
    WIFI_LINK_DASH_SPACING_M,
    WIFI_LINK_DASH_WIDTH,
    WIFI_LINK_DASHES_PER_LANE_MAX,
    WIFI_LINK_EDGE_COLOR_HEX,
    WIFI_LINK_GLOW_ALPHA,
    WIFI_LINK_GLOW_HEIGHT_MUL,
    WIFI_LINK_GLOW_LENGTH_MUL,
    WIFI_LINK_GLOW_WIDTH_MUL,
    WIFI_LINK_LANE_OFFSET_M,
    WIFI_LINK_RENDER_GROUP,
    WIFI_LINK_SPEED,
    WIFI_LINK_Y,
    WIFI_OVERLAY_ALPHA,
    WIFI_OVERLAY_RGB,
} from './wifiConfig.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {((this: Window, ev: Event) => void) | null} */
let wifiSelectionListener = null;
/** @type {((this: Window, ev: Event) => void) | null} */
let networkTestUiListener = null;
/** @type {import('@babylonjs/core').Observer | null} */
let renderObserver = null;
/** @type {{ sourceStampId: string, clientStampId: string } | null} */
let activeLink = null;
/** @type {import('@babylonjs/core').TransformNode | null} */
let linkRoot = null;
/** @type {import('@babylonjs/core').Mesh[]} */
let dashMeshes = [];
/** @type {import('@babylonjs/core').Mesh[]} */
let dashEdgeMeshes = [];
/** @type {import('@babylonjs/core').StandardMaterial | null} */
let dashMat = null;
/** @type {import('@babylonjs/core').StandardMaterial | null} */
let dashEdgeMat = null;
/** Metres along the path (cell-centre distance). */
let pathLengthM = 0;
/** @type {import('@babylonjs/core').Vector3 | null} */
let pathFrom = null;
/** @type {import('@babylonjs/core').Vector3 | null} */
let pathTo = null;
/** Shared clock for both duplex lanes (continuous conveyor). */
let pathElapsedS = 0;
/** Current dashes per lane (auto from path length / spacing). */
let dashesPerLane = 0;

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
        typeof host.Vector3 !== 'function' ||
        typeof host.TransformNode !== 'function' ||
        typeof host.layoutCellHalfOffset !== 'function'
    ) {
        throw new Error(
            'Experience host API missing WiFi link helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @returns {boolean}
 */
function toolsBlockWifiLink() {
    return isCableModeActive() || isDroppableToolActive() || isNetworkTestUiBusy();
}

function clearOrangeOverlay() {
    for (const mesh of wifiLinkOverlayMeshes) {
        try {
            if (mesh && !mesh.isDisposed?.() && !isNetworkTestResultOverlayMesh(mesh)) {
                mesh.renderOverlay = false;
            }
        } catch (error) {
            console.warn(
                `[partWifiLink.js]: [N/A] - [clearOrangeOverlay] - clearError has a value of ${error?.message || error}.`
            ); //This is logged when clearing a WiFi orange overlay fails on a disposed mesh.
        }
    }
    wifiLinkOverlayMeshes.clear();
}

/**
 * @param {string} stampId
 */
function paintStampOrange(stampId) {
    const stamp = getStampById(stampId);
    const meshes = stamp?.wrap?.getChildMeshes?.(false) || [];
    if (!meshes.length) {
        return;
    }
    const host = getHost();
    for (const mesh of meshes) {
        if (isNetworkTestResultOverlayMesh(mesh)) {
            continue;
        }
        mesh.renderOverlay = true;
        mesh.overlayColor = new host.Color3(
            WIFI_OVERLAY_RGB.r,
            WIFI_OVERLAY_RGB.g,
            WIFI_OVERLAY_RGB.b
        );
        mesh.overlayAlpha = WIFI_OVERLAY_ALPHA;
        wifiLinkOverlayMeshes.add(mesh);
    }
}

function disposeDashMeshes() {
    for (const mesh of dashMeshes) {
        mesh.dispose();
    }
    for (const mesh of dashEdgeMeshes) {
        mesh.dispose();
    }
    dashMeshes = [];
    dashEdgeMeshes = [];
    linkRoot?.dispose();
    linkRoot = null;
    dashMat?.dispose();
    dashEdgeMat?.dispose();
    dashMat = null;
    dashEdgeMat = null;
}

function stopRenderLoop() {
    if (boundScene && renderObserver) {
        boundScene.onBeforeRenderObservable.remove(renderObserver);
    }
    renderObserver = null;
}

function clearWifiLinkVisuals() {
    stopRenderLoop();
    clearOrangeOverlay();
    disposeDashMeshes();
    pathFrom = null;
    pathTo = null;
    pathLengthM = 0;
    pathElapsedS = 0;
    dashesPerLane = 0;
    refreshInteractableOverlays();
}

/**
 * World position at a cell centre, on the WiFi-link floor band.
 * @param {{ x: number, z: number }} cell
 * @returns {import('@babylonjs/core').Vector3}
 */
function cellCentreWorld(cell) {
    const host = getHost();
    const layout = getActiveLayout();
    const cellSize = layout?.cellSize ?? 1;
    const half = host.layoutCellHalfOffset(cellSize);
    return new host.Vector3(
        cell.x * cellSize + half,
        WIFI_LINK_Y,
        cell.z * cellSize + half
    );
}

function ensureDashMaterials() {
    if (dashMat && dashEdgeMat) {
        return;
    }
    const host = getHost();
    // Soft orange halo under each dash (low glow — larger, translucent).
    dashEdgeMat = new host.StandardMaterial('simnetWifiLinkGlowMat', boundScene);
    dashEdgeMat.disableLighting = true;
    dashEdgeMat.emissiveColor = host.Color3.FromHexString(WIFI_LINK_EDGE_COLOR_HEX);
    dashEdgeMat.diffuseColor = host.Color3.Black();
    dashEdgeMat.specularColor = host.Color3.Black();
    dashEdgeMat.alpha = WIFI_LINK_GLOW_ALPHA;
    dashEdgeMat.transparencyMode = 2;
    dashEdgeMat.backFaceCulling = false;
    dashEdgeMat.disableDepthWrite = true;

    dashMat = new host.StandardMaterial('simnetWifiLinkDashMat', boundScene);
    dashMat.disableLighting = true;
    dashMat.emissiveColor = host.Color3.FromHexString(WIFI_LINK_COLOR_HEX);
    dashMat.diffuseColor = host.Color3.Black();
    dashMat.specularColor = host.Color3.Black();
    dashMat.alpha = 1;
    dashMat.backFaceCulling = false;
    dashMat.disableDepthWrite = true;
}

/**
 * How many dashes each lane needs so the path stays evenly filled.
 * @param {number} lengthM
 * @returns {number}
 */
function computeDashesPerLane(lengthM) {
    if (lengthM < 0.001 || WIFI_LINK_DASH_SPACING_M <= 0) {
        return 1;
    }
    const needed = Math.ceil(lengthM / WIFI_LINK_DASH_SPACING_M);
    return Math.max(1, Math.min(WIFI_LINK_DASHES_PER_LANE_MAX, needed));
}

/**
 * Build (or rebuild) dash + glow meshes for both lanes.
 * @param {number} perLane
 */
function ensureDashMeshes(perLane) {
    const total = perLane * 2;
    if (dashMeshes.length === total && linkRoot && dashesPerLane === perLane) {
        return;
    }
    disposeDashMeshes();
    dashesPerLane = perLane;
    if (!boundScene || perLane < 1) {
        return;
    }
    const host = getHost();
    ensureDashMaterials();
    linkRoot = new host.TransformNode('simnetWifiLinkRoot', boundScene);
    for (let i = 0; i < total; i += 1) {
        // Soft orange glow halo (slightly larger than the solid dash).
        const edge = host.MeshBuilder.CreateBox(
            `simnetWifiLinkGlow_${i}`,
            {
                width: WIFI_LINK_DASH_WIDTH * WIFI_LINK_GLOW_WIDTH_MUL,
                height: WIFI_LINK_DASH_HEIGHT * WIFI_LINK_GLOW_HEIGHT_MUL,
                depth: WIFI_LINK_DASH_LENGTH * WIFI_LINK_GLOW_LENGTH_MUL,
            },
            boundScene
        );
        edge.material = dashEdgeMat;
        edge.isPickable = false;
        edge.parent = linkRoot;
        edge.renderingGroupId = WIFI_LINK_RENDER_GROUP;
        edge.setEnabled(false);
        dashEdgeMeshes.push(edge);

        const dash = host.MeshBuilder.CreateBox(
            `simnetWifiLinkDash_${i}`,
            {
                width: WIFI_LINK_DASH_WIDTH,
                height: WIFI_LINK_DASH_HEIGHT,
                depth: WIFI_LINK_DASH_LENGTH,
            },
            boundScene
        );
        dash.material = dashMat;
        dash.isPickable = false;
        dash.parent = linkRoot;
        dash.renderingGroupId = WIFI_LINK_RENDER_GROUP;
        dash.setEnabled(false);
        dashMeshes.push(dash);
    }
}

/**
 * Positive modulo so lane clocks can wrap cleanly (JS `%` keeps negatives negative).
 * @param {number} value
 * @param {number} period
 * @returns {number}
 */
function wrapUnitInterval(value, period) {
    if (period <= 0) {
        return 0;
    }
    return ((value % period) + period) % period;
}

/**
 * Point along a travel direction, shifted sideways in the fixed A→B left frame.
 * lateralSign +1 = left of centre (A→B lane), -1 = right of centre (B→A lane).
 * @param {import('@babylonjs/core').Vector3} from
 * @param {import('@babylonjs/core').Vector3} to
 * @param {number} alongM
 * @param {number} lateralSign
 * @param {number} abLeftX — unit left of pathFrom→pathTo
 * @param {number} abLeftZ
 * @returns {{ position: import('@babylonjs/core').Vector3, yaw: number } | null}
 */
function samplePath(from, to, alongM, lateralSign, abLeftX, abLeftZ) {
    const host = getHost();
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) {
        return null;
    }
    const t = Math.max(0, Math.min(1, alongM / len));
    const lateralM = lateralSign * WIFI_LINK_LANE_OFFSET_M;
    const position = new host.Vector3(
        from.x + dx * t + abLeftX * lateralM,
        WIFI_LINK_Y,
        from.z + dz * t + abLeftZ * lateralM
    );
    // Box length is local +Z. Yaw aims +Z along this lane's travel direction.
    const yaw = Math.atan2(dx, dz);
    return { position, yaw };
}

/**
 * Place one dash (and its soft glow) at a distance along the path.
 * @param {number} meshIndex
 * @param {number} alongM — metres along from→to (already wrapped into the path)
 * @param {import('@babylonjs/core').Vector3} from
 * @param {import('@babylonjs/core').Vector3} to
 * @param {number} lateralSign — +1 left of A→B centre, -1 right
 * @param {number} abLeftX
 * @param {number} abLeftZ
 */
function placeLaneDash(meshIndex, alongM, from, to, lateralSign, abLeftX, abLeftZ) {
    const dash = dashMeshes[meshIndex];
    const edge = dashEdgeMeshes[meshIndex];
    if (!dash || !edge) {
        return;
    }
    const sample = samplePath(from, to, alongM, lateralSign, abLeftX, abLeftZ);
    if (!sample) {
        dash.setEnabled(false);
        edge.setEnabled(false);
        return;
    }
    dash.setEnabled(true);
    edge.setEnabled(true);
    edge.position.copyFrom(sample.position);
    edge.position.y = WIFI_LINK_Y - 0.002;
    edge.rotation.y = sample.yaw;
    dash.position.copyFrom(sample.position);
    dash.rotation.y = sample.yaw;
}

/**
 * @param {number} deltaS
 */
function tickWifiLink(deltaS) {
    if (!activeLink || !pathFrom || !pathTo || pathLengthM < 0.001) {
        return;
    }

    // ui-spec: never show the link while building tools or the test are active.
    if (toolsBlockWifiLink()) {
        if (wifiLinkOverlayMeshes.size > 0) {
            clearOrangeOverlay();
            refreshInteractableOverlays();
        }
        for (const mesh of dashMeshes) {
            mesh.setEnabled(false);
        }
        for (const mesh of dashEdgeMeshes) {
            mesh.setEnabled(false);
        }
        return;
    }

    if (wifiLinkOverlayMeshes.size === 0) {
        paintStampOrange(activeLink.sourceStampId);
        paintStampOrange(activeLink.clientStampId);
    }

    // Continuous conveyor: always fill the path; B→A offset by half a step (zipper).
    const perLane = computeDashesPerLane(pathLengthM);
    ensureDashMeshes(perLane);
    pathElapsedS += Math.max(0, deltaS);
    const stepM = pathLengthM / perLane;
    const travelM = WIFI_LINK_SPEED * pathElapsedS;

    // Fixed left of A→B so +offset / -offset sit on opposite sides of the centre path.
    const abDx = pathTo.x - pathFrom.x;
    const abDz = pathTo.z - pathFrom.z;
    const abInv = 1 / pathLengthM;
    const abLeftX = abDz * abInv;
    const abLeftZ = -abDx * abInv;

    for (let i = 0; i < perLane; i += 1) {
        const alongOut = wrapUnitInterval(i * stepM + travelM, pathLengthM);
        const alongIn = wrapUnitInterval(i * stepM + travelM + stepM * 0.5, pathLengthM);
        placeLaneDash(i, alongOut, pathFrom, pathTo, 1, abLeftX, abLeftZ);
        placeLaneDash(perLane + i, alongIn, pathTo, pathFrom, -1, abLeftX, abLeftZ);
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
        tickWifiLink(deltaMs / 1000);
    });
}

/**
 * @param {{ sourceStampId: string, clientStampId: string } | null} detail
 */
function applyWifiConnectionSelection(detail) {
    if (!detail?.sourceStampId || !detail?.clientStampId || toolsBlockWifiLink()) {
        if (activeLink) {
            activeLink = null;
            clearWifiLinkVisuals();
            console.log(
                `[partWifiLink.js]: [N/A] - [applyWifiConnectionSelection] - cleared has a value of true.`
            ); //This is logged when the WiFi link/orange overlay turns off.
        }
        return;
    }

    const source = getStampById(detail.sourceStampId);
    const client = getStampById(detail.clientStampId);
    if (!source || !client) {
        activeLink = null;
        clearWifiLinkVisuals();
        return;
    }

    activeLink = {
        sourceStampId: detail.sourceStampId,
        clientStampId: detail.clientStampId,
    };
    clearOrangeOverlay();
    paintStampOrange(detail.sourceStampId);
    paintStampOrange(detail.clientStampId);

    pathFrom = cellCentreWorld(source);
    pathTo = cellCentreWorld(client);
    pathLengthM = Math.hypot(pathTo.x - pathFrom.x, pathTo.z - pathFrom.z);
    pathElapsedS = 0;
    ensureDashMeshes(computeDashesPerLane(pathLengthM));
    startRenderLoop();
    console.log(
        `[partWifiLink.js]: [N/A] - [applyWifiConnectionSelection] - sourceStampId has a value of ${detail.sourceStampId}, clientStampId has a value of ${detail.clientStampId}, pathLengthM has a value of ${pathLengthM.toFixed(2)}, dashesPerLane has a value of ${dashesPerLane}, overlayMeshCount has a value of ${wifiLinkOverlayMeshes.size}.`
    ); //This is logged when a Wireless chip turns on orange wash + the animated WiFi dashes.
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializeWifiLink(scene) {
    disposeWifiLink();
    boundScene = scene;
    // Clear depth before group 1 so dashes draw over furniture (same idea as cable x-ray).
    if (typeof scene.setRenderingAutoClearDepthStencil === 'function') {
        scene.setRenderingAutoClearDepthStencil(WIFI_LINK_RENDER_GROUP, true, true, true);
    }
    wifiSelectionListener = (event) => {
        const detail = /** @type {CustomEvent} */ (event).detail;
        applyWifiConnectionSelection(
            detail && detail.sourceStampId && detail.clientStampId ? detail : null
        );
    };
    window.addEventListener(WIFI_CONNECTION_SELECTED_EVENT, wifiSelectionListener);
    networkTestUiListener = () => {
        if (isNetworkTestUiBusy() && activeLink) {
            activeLink = null;
            clearWifiLinkVisuals();
            console.log(
                `[partWifiLink.js]: [N/A] - [networkTestUiListener] - clearedForTest has a value of true.`
            ); //This is logged when Test Connection hides the WiFi link (ui-spec: never during test).
        }
    };
    window.addEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);
    console.log(
        `[partWifiLink.js]: [N/A] - [initializeWifiLink] - ready has a value of true.`
    ); //This is logged when Stage 3.3 WiFi link + orange overlay is armed.
}

export function disposeWifiLink() {
    if (wifiSelectionListener) {
        window.removeEventListener(WIFI_CONNECTION_SELECTED_EVENT, wifiSelectionListener);
        wifiSelectionListener = null;
    }
    if (networkTestUiListener) {
        window.removeEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);
        networkTestUiListener = null;
    }
    activeLink = null;
    clearWifiLinkVisuals();
    boundScene = null;
}

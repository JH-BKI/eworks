/**
 * HTML Unplug pill — DaisyUI btn at the selected cable's screen midpoint (ui-spec board 16).
 * Mounts in #uiContainer (player frame). Not SpatialLabel / Babylon GUI.
 */

import {
    getCableById,
    getCableWorldPathPoints,
    removeCableById,
} from './partCables.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {HTMLButtonElement | null} */
let pillEl = null;
/** @type {string | null} */
let activeCableId = null;
/** @type {import('@babylonjs/core').Observer | null} */
let renderObserver = null;

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (!host || typeof host.getPlayerUiRoot !== 'function') {
        throw new Error(
            'Experience host API missing Unplug-pill helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @returns {HTMLElement | null}
 */
function getPlayerFrame() {
    const root = getHost().getPlayerUiRoot();
    if (!root || root.id !== 'uiContainer') {
        return null;
    }
    return root;
}

function playSfx(clipId) {
    const host = getHost();
    if (typeof host.dispatchAppEvent !== 'function' || !host.EVENTS?.AUDIO_CONTROL) {
        return;
    }
    host.dispatchAppEvent(host.EVENTS.AUDIO_CONTROL, {
        action: 'play',
        clipId,
    });
}

/**
 * Midpoint of the cable's world path, or null.
 * @param {string} cableId
 * @returns {import('@babylonjs/core').Vector3 | null}
 */
function getCableMidpointWorld(cableId) {
    const cable = getCableById(cableId);
    if (!cable) {
        return null;
    }
    const points = getCableWorldPathPoints(cable);
    if (!points.length) {
        return null;
    }
    const midIndex = Math.floor(points.length / 2);
    return points[midIndex].clone();
}

/**
 * Project a world point into #uiContainer local CSS pixels.
 * @param {import('@babylonjs/core').Vector3} worldPos
 * @returns {{ x: number, y: number, visible: boolean } | null}
 */
function projectToPlayerFrame(worldPos) {
    if (!boundScene) {
        return null;
    }
    const host = getHost();
    const engine = boundScene.getEngine?.();
    const camera = boundScene.activeCamera;
    const frame = getPlayerFrame();
    const canvas = engine?.getRenderingCanvas?.();
    if (!engine || !camera || !frame || !canvas || typeof host.Vector3?.Project !== 'function') {
        return null;
    }

    const renderWidth = engine.getRenderWidth();
    const renderHeight = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(renderWidth, renderHeight);
    if (typeof host.Matrix?.Identity !== 'function' || typeof host.Vector3?.Project !== 'function') {
        return null;
    }

    // World position is already in world space, so the world matrix is identity
    // (same pattern as hotspotManager / helperFunctions screen projection).
    const screen = host.Vector3.Project(
        worldPos,
        host.Matrix.Identity(),
        boundScene.getTransformMatrix(),
        viewport
    );

    const canvasRect = canvas.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    if (!(canvasRect.width > 0) || !(canvasRect.height > 0)) {
        return null;
    }

    const pageX = canvasRect.left + (screen.x / renderWidth) * canvasRect.width;
    const pageY = canvasRect.top + (screen.y / renderHeight) * canvasRect.height;
    const localX = pageX - frameRect.left;
    const localY = pageY - frameRect.top;
    const visible =
        screen.z >= 0 &&
        screen.z <= 1 &&
        localX >= 0 &&
        localY >= 0 &&
        localX <= frameRect.width &&
        localY <= frameRect.height;

    return { x: localX, y: localY, visible };
}

function ensurePillEl() {
    if (pillEl) {
        return pillEl;
    }
    const frame = getPlayerFrame();
    const host = getHost();
    if (!frame) {
        return null;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sim-network-unplug-pill';
    // DaisyUI: btn + error colour + soft size; position via CSS absolute in player frame.
    btn.className =
        'btn btn-error btn-sm sim-network-unplug-pill hidden gap-1.5 shadow-lg border-2 border-base-100';
    btn.hidden = true;
    btn.setAttribute('aria-label', 'Unplug cable');

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = 'inline-flex';
    icon.innerHTML = host.getIcon('icon_cable_unplug', 'h-4 w-4 stroke-current');

    const label = document.createElement('span');
    label.textContent = 'Unplug';

    btn.append(icon, label);
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!activeCableId) {
            return;
        }
        const linkId = activeCableId;
        playSfx('remove-component');
        setUnplugCableTarget(null);
        removeCableById(linkId);
        console.log(
            `[partUnplugPill.js]: [N/A] - [click] - unpluggedLinkId has a value of ${linkId}.`
        ); //This is logged when the player taps the HTML Unplug pill on the cable midpoint.
    });

    frame.appendChild(btn);
    pillEl = btn;
    return pillEl;
}

function hidePill() {
    if (!pillEl) {
        return;
    }
    pillEl.classList.add('hidden');
    pillEl.hidden = true;
}

function updatePillPosition() {
    if (!activeCableId || !pillEl) {
        hidePill();
        return;
    }
    const mid = getCableMidpointWorld(activeCableId);
    if (!mid) {
        hidePill();
        return;
    }
    const projected = projectToPlayerFrame(mid);
    if (!projected || !projected.visible) {
        hidePill();
        return;
    }
    pillEl.style.left = `${projected.x}px`;
    pillEl.style.top = `${projected.y}px`;
    pillEl.classList.remove('hidden');
    pillEl.hidden = false;
}

/**
 * Show or hide the Unplug pill for a cable link id.
 * @param {string | null} cableId
 */
export function setUnplugCableTarget(cableId) {
    activeCableId = cableId || null;
    if (!activeCableId) {
        hidePill();
        return;
    }
    ensurePillEl();
    updatePillPosition();
    console.log(
        `[partUnplugPill.js]: [N/A] - [setUnplugCableTarget] - cableId has a value of ${activeCableId}.`
    ); //This is logged when the Unplug pill is aimed at a selected cable.
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializeUnplugPill(scene) {
    disposeUnplugPill();
    boundScene = scene;
    ensurePillEl();
    hidePill();
    renderObserver = scene.onBeforeRenderObservable.add(() => {
        if (activeCableId) {
            updatePillPosition();
        }
    });
    console.log(
        `[partUnplugPill.js]: [N/A] - [initializeUnplugPill] - ready has a value of true.`
    ); //This is logged when the HTML Unplug pill system starts for a map.
}

export function disposeUnplugPill() {
    if (boundScene && renderObserver) {
        boundScene.onBeforeRenderObservable.remove(renderObserver);
    }
    renderObserver = null;
    activeCableId = null;
    pillEl?.remove();
    pillEl = null;
    boundScene = null;
}

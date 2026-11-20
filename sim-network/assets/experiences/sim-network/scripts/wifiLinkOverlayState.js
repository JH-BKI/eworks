/**
 * Shared set of meshes wearing the selected Wireless-chip orange wash.
 * Kept in its own file so explore hover (partCellHighlight) can protect them
 * without a circular import with partWifiLink.
 */

import { WIFI_OVERLAY_ALPHA, WIFI_OVERLAY_RGB } from './wifiConfig.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';

/** @type {Set<import('@babylonjs/core').AbstractMesh>} */
export const wifiLinkOverlayMeshes = new Set();

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (!host || typeof host.Color3 !== 'function') {
        throw new Error(
            'Experience host API missing WiFi overlay helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @param {import('@babylonjs/core').AbstractMesh | null | undefined} mesh
 * @returns {boolean}
 */
export function isWifiLinkOverlayMesh(mesh) {
    return Boolean(mesh && wifiLinkOverlayMeshes.has(mesh));
}

/**
 * Re-apply the selected WiFi orange wash after explore hover tried to clear it.
 * @param {import('@babylonjs/core').AbstractMesh | null | undefined} mesh
 * @returns {boolean}
 */
export function restoreWifiLinkOverlay(mesh) {
    if (!mesh || mesh.isDisposed?.() || !wifiLinkOverlayMeshes.has(mesh)) {
        return false;
    }
    const host = getHost();
    mesh.renderOverlay = true;
    mesh.overlayColor = new host.Color3(
        WIFI_OVERLAY_RGB.r,
        WIFI_OVERLAY_RGB.g,
        WIFI_OVERLAY_RGB.b
    );
    mesh.overlayAlpha = WIFI_OVERLAY_ALPHA;
    return true;
}

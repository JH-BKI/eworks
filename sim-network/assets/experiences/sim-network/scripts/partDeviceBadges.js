/**
 * Sim-network scene device badges — dark SpatialLabel pills beside floating status GLBs.
 * Builds universal SpatialLabel segments (icon data URLs + text); no SpatialLabel domain logic here.
 */

import {
    getActiveLayout,
    getAllStamps,
    getPartDef,
    getStampById,
} from './layoutAssembler.js';
import {
    CABLES_CHANGED_EVENT,
    countCablesOnStamp,
    getCableOnlineIds,
} from './partCables.js';
import { getSimNetworkHudZoomFraction } from './partCamera.js';
import { shouldShowConnectionStatus } from './partConnectionStatus.js';
import {
    computeWifiNetwork,
    isWifiClientPart,
    isWifiSourcePart,
} from './partWifi.js';
import {
    DEVICE_BADGE_BG_HEX,
    DEVICE_BADGE_CORNER_RADIUS_PX,
    DEVICE_BADGE_FONT_SIZE_PX,
    DEVICE_BADGE_ICON_COLOR,
    DEVICE_BADGE_ICON_SIZE_PX,
    DEVICE_BADGE_OFFSET_X,
    DEVICE_BADGE_PADDING_H_PX,
    DEVICE_BADGE_PADDING_V_PX,
    DEVICE_BADGE_PLANE_HEIGHT_M,
    DEVICE_BADGE_SEGMENT_GAP_PX,
    DEVICE_BADGE_TEXT_HEX,
    DEVICE_BADGE_Y,
    DEVICE_BADGE_ZOOM_SCALE_MAX,
    DEVICE_BADGE_ZOOM_SCALE_MIN,
} from './wifiConfig.js';

/** Draw after status meshes in the transparent queue; stay in group 0 for wall occlusion. */
const DEVICE_BADGE_ALPHA_INDEX = 1000;

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {Map<string, { setContent: Function, setLocalPosition: Function, setScreenScaleFactor?: Function, dispose: Function, faces: object[] }>} */
const badgeByStampId = new Map();
/** @type {((ev: Event) => void) | null} */
let cablesChangedListener = null;
/** @type {import('@babylonjs/core').Observer | null} */
let zoomScaleObserver = null;
/** Last applied zoom scale — skip work when unchanged. */
let lastBadgeZoomScale = 1;

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (
        !host ||
        typeof host.SpatialLabel !== 'function' ||
        typeof host.getIconDataUrl !== 'function' ||
        typeof host.layoutCellHalfOffset !== 'function'
    ) {
        throw new Error(
            'Experience host API missing device-badge helpers (SpatialLabel / getIconDataUrl).'
        );
    }
    return host;
}

/**
 * @param {object | null | undefined} partDef
 * @returns {boolean}
 */
function canShowCableHalf(partDef) {
    const maxCables = partDef?.maxCables;
    if (typeof maxCables === 'number') {
        return maxCables > 0;
    }
    return partDef?.linkType !== 'wifi';
}

/**
 * @param {string} iconName
 * @returns {string}
 */
function iconSource(iconName) {
    return getHost().getIconDataUrl(iconName, DEVICE_BADGE_ICON_COLOR);
}

/**
 * Build SpatialLabel segments for one stamp from cable + WiFi state.
 * @param {object} stamp
 * @param {ReturnType<typeof computeWifiNetwork>} wifi
 * @returns {Array<{ type: string, text?: string, source?: string }>}
 */
function buildBadgeSegments(stamp, wifi) {
    const partDef = getPartDef(stamp.partId);
    const cableCount = countCablesOnStamp(stamp.stampId);
    const wifiCount = wifi.clientCountBySourceId.get(stamp.stampId) || 0;

    if (isWifiClientPart(partDef)) {
        if (wifi.sourceByClientId.has(stamp.stampId)) {
            return [
                { type: 'icon', source: iconSource('icon_wifi') },
                { type: 'text', text: '1' },
            ];
        }
        return [{ type: 'icon', source: iconSource('icon_wifi_off') }];
    }

    if (isWifiSourcePart(partDef) && !canShowCableHalf(partDef)) {
        // Repeater (WiFi-only source): count or crossed-out WiFi when offline.
        if (wifi.parentBySourceId.has(stamp.stampId)) {
            return [
                { type: 'icon', source: iconSource('icon_wifi') },
                { type: 'text', text: String(wifiCount) },
            ];
        }
        return [{ type: 'icon', source: iconSource('icon_wifi_off') }];
    }

    /** @type {Array<{ type: string, text?: string, source?: string }>} */
    const segments = [];
    const showCable = canShowCableHalf(partDef);
    const showWifi = isWifiSourcePart(partDef);

    if (showCable) {
        if (cableCount > 0) {
            segments.push(
                { type: 'icon', source: iconSource('icon_cable') },
                { type: 'text', text: String(cableCount) }
            );
        } else if (!showWifi || wifiCount === 0) {
            // Broken link when not cabled (and no WiFi half to show alone).
            segments.push({ type: 'icon', source: iconSource('icon_cable_unplug') });
        }
    }

    if (showWifi && wifiCount > 0) {
        if (segments.length > 0) {
            segments.push({ type: 'text', text: ' |' });
        }
        segments.push(
            { type: 'icon', source: iconSource('icon_wifi') },
            { type: 'text', text: String(wifiCount) }
        );
    }

    if (segments.length === 0) {
        segments.push({ type: 'icon', source: iconSource('icon_cable_unplug') });
    }

    return segments;
}

/**
 * @param {object} stamp
 * @param {Array<{ type: string, text?: string, source?: string }>} segments
 */
function positionBadge(stamp, label) {
    const host = getHost();
    const layout = getActiveLayout();
    const cellSize = layout?.cellSize ?? 1;
    const half = host.layoutCellHalfOffset(cellSize);
    label.setLocalPosition([
        stamp.x * cellSize + half + DEVICE_BADGE_OFFSET_X,
        DEVICE_BADGE_Y,
        stamp.z * cellSize + half,
    ]);
}

/**
 * Map zoom HUD % to pill scale (closest = 100% → 1×, farthest = 0% → 2×).
 * scale = ((1 − hudZoom) × 1) + 1 — smooth every frame.
 * @returns {number}
 */
function computeBadgeZoomScale() {
    const hudZoom = getSimNetworkHudZoomFraction();
    const scale = (1 - hudZoom) * 1 + 1;
    return Math.max(
        DEVICE_BADGE_ZOOM_SCALE_MIN,
        Math.min(DEVICE_BADGE_ZOOM_SCALE_MAX, scale)
    );
}

/**
 * @param {number} scale
 */
function applyZoomScaleToAllBadges(scale) {
    for (const label of badgeByStampId.values()) {
        if (typeof label.setScreenScaleFactor === 'function') {
            label.setScreenScaleFactor(scale);
        }
    }
}

function syncBadgeZoomScale() {
    const scale = computeBadgeZoomScale();
    if (Math.abs(scale - lastBadgeZoomScale) < 0.001) {
        return;
    }
    lastBadgeZoomScale = scale;
    applyZoomScaleToAllBadges(scale);
}

/**
 * @param {object} stamp
 * @param {ReturnType<typeof computeWifiNetwork>} wifi
 */
function upsertBadgeForStamp(stamp, wifi) {
    if (!boundScene || !stamp?.stampId) {
        return;
    }
    const partDef = getPartDef(stamp.partId);
    // Same gate as floating status GLBs — interactable devices only (not floor/furniture).
    if (!shouldShowConnectionStatus(partDef)) {
        detachDeviceBadgeForStamp(stamp.stampId);
        return;
    }

    const host = getHost();
    const segments = buildBadgeSegments(stamp, wifi);
    let label = badgeByStampId.get(stamp.stampId);

    if (!label) {
        label = new host.SpatialLabel(boundScene, `simnetDeviceBadge_${stamp.stampId}`, '', {
            billboard: true,
            planeHeightM: DEVICE_BADGE_PLANE_HEIGHT_M,
            content: segments,
            style: {
                frameBackgroundHex: DEVICE_BADGE_BG_HEX,
                frameBorderHex: DEVICE_BADGE_BG_HEX,
                textColorHex: DEVICE_BADGE_TEXT_HEX,
                fontSizePx: DEVICE_BADGE_FONT_SIZE_PX,
                iconSizePx: DEVICE_BADGE_ICON_SIZE_PX,
                segmentGapPx: DEVICE_BADGE_SEGMENT_GAP_PX,
                cornerRadiusPx: DEVICE_BADGE_CORNER_RADIUS_PX,
                paddingHorizontalPx: DEVICE_BADGE_PADDING_H_PX,
                paddingVerticalPx: DEVICE_BADGE_PADDING_V_PX,
                borderThicknessPx: 0,
            },
        });
        label.faces.forEach((face) => {
            face.frame.alpha = 1;
            // Group 0: normal scene depth so walls/furniture hide the pill.
            face.plane.renderingGroupId = 0;
            face.plane.isPickable = false;
            face.plane.alphaIndex = DEVICE_BADGE_ALPHA_INDEX;
            if (face.plane.material) {
                // Depth-test against walls; write depth so status beams can't cut through the pill.
                face.plane.material.disableDepthWrite = false;
                if ('forceDepthWrite' in face.plane.material) {
                    face.plane.material.forceDepthWrite = true;
                }
            }
        });
        badgeByStampId.set(stamp.stampId, label);
    } else {
        label.setContent(segments);
        label.faces.forEach((face) => {
            face.frame.alpha = 1;
        });
    }

    positionBadge(stamp, label);
    if (typeof label.setScreenScaleFactor === 'function') {
        label.setScreenScaleFactor(lastBadgeZoomScale);
    }
}

/**
 * @param {string} stampId
 */
export function detachDeviceBadgeForStamp(stampId) {
    const label = badgeByStampId.get(stampId);
    if (!label) {
        return;
    }
    label.dispose();
    badgeByStampId.delete(stampId);
}

/**
 * Recompute every placed device badge from current cable + WiFi state.
 */
export function refreshAllDeviceBadges() {
    if (!boundScene) {
        return;
    }
    const stamps = getAllStamps();
    const wifi = computeWifiNetwork({
        stamps,
        getPartDef,
        cableOnlineIds: getCableOnlineIds(),
    });
    const live = new Set();
    for (const stamp of stamps) {
        const partDef = getPartDef(stamp.partId);
        if (!shouldShowConnectionStatus(partDef)) {
            continue;
        }
        live.add(stamp.stampId);
        upsertBadgeForStamp(stamp, wifi);
    }
    for (const stampId of [...badgeByStampId.keys()]) {
        if (!live.has(stampId)) {
            detachDeviceBadgeForStamp(stampId);
        }
    }
    console.log(
        `[partDeviceBadges.js]: [N/A] - [refreshAllDeviceBadges] - badgeCount has a value of ${badgeByStampId.size}, stampCount has a value of ${stamps.length}.`
    ); //This is logged when scene device pills are rebuilt from cable + WiFi counts.
}

/**
 * @param {string} stampId
 */
export function refreshDeviceBadgeForStamp(stampId) {
    if (!boundScene || !stampId) {
        return;
    }
    const stamp = getStampById(stampId);
    if (!stamp) {
        detachDeviceBadgeForStamp(stampId);
        return;
    }
    const wifi = computeWifiNetwork({
        stamps: getAllStamps(),
        getPartDef,
        cableOnlineIds: getCableOnlineIds(),
    });
    upsertBadgeForStamp(stamp, wifi);
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializeDeviceBadges(scene) {
    disposeDeviceBadges();
    boundScene = scene;
    cablesChangedListener = () => refreshAllDeviceBadges();
    window.addEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);
    refreshAllDeviceBadges();
    lastBadgeZoomScale = computeBadgeZoomScale();
    applyZoomScaleToAllBadges(lastBadgeZoomScale);
    zoomScaleObserver = scene.onBeforeRenderObservable.add(() => {
        syncBadgeZoomScale();
    });
    console.log(
        `[partDeviceBadges.js]: [N/A] - [initializeDeviceBadges] - ready has a value of true, badgeCount has a value of ${badgeByStampId.size}, zoomScale has a value of ${lastBadgeZoomScale}.`
    ); //This is logged when scene device badge system starts for a map.
}

export function disposeDeviceBadges() {
    if (cablesChangedListener) {
        window.removeEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);
    }
    cablesChangedListener = null;
    if (boundScene && zoomScaleObserver) {
        boundScene.onBeforeRenderObservable.remove(zoomScaleObserver);
    }
    zoomScaleObserver = null;
    lastBadgeZoomScale = 1;
    for (const stampId of [...badgeByStampId.keys()]) {
        detachDeviceBadgeForStamp(stampId);
    }
    badgeByStampId.clear();
    boundScene = null;
}

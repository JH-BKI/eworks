/**
 * Sim-network WiFi scene visuals — coverage discs and edge rings on the floor.
 * Only online sources draw a disc (orange fill + faint white dashed edge).
 * Offline / uncabled / out-of-range sources draw nothing until they get a valid link.
 * The placement ghost is checked as a "what if" stamp so a repeater in range previews orange.
 */

import { getActiveLayout, getAllStamps, getPartDef } from './layoutAssembler.js';
import {
    CABLES_CHANGED_EVENT,
    CABLE_MODE_CHANGED_EVENT,
    getCableOnlineIds,
    isCableModeActive,
} from './partCables.js';
import { computeWifiNetwork, isWifiSourcePart } from './partWifi.js';
import { refreshAllDeviceBadges } from './partDeviceBadges.js';
import { refreshAllConnectionStatuses } from './partConnectionStatus.js';
import {
    WIFI_DISC_ALPHA_BASE,
    WIFI_DISC_ALPHA_SELECTED,
    WIFI_DISC_COLOR_HEX,
    WIFI_DISC_TESSELLATION,
    WIFI_DISC_Y,
    WIFI_RING_ALPHA,
    WIFI_RING_COLOR_HEX,
    WIFI_RING_DASHES,
    WIFI_RING_Y,
} from './wifiConfig.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';
const GHOST_STAMP_ID = '__wifiGhost__';
/** Same event partDrop / partCables use to set the sticky green selected cell. */
const EXPLORE_SELECTION_EVENT = 'sim-network-explore-selection';

/**
 * @typedef {{
 *   range: number,
 *   disc: import('@babylonjs/core').Mesh,
 *   ring: import('@babylonjs/core').LinesMesh
 * }} DiscEntry
 */

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {Map<string, DiscEntry>} */
const discByStampId = new Map();
/** @type {import('@babylonjs/core').StandardMaterial | null} */
let discMatBase = null;
/** @type {import('@babylonjs/core').StandardMaterial | null} */
let discMatSelected = null;
/** @type {{ partId: string, x: number, z: number } | null} */
let ghostStamp = null;
/** @type {{ x: number, z: number } | null} */
let selectedCell = null;
/** @type {(() => void) | null} */
let cablesChangedListener = null;
/** @type {((event: Event) => void) | null} */
let exploreSelectionListener = null;
/** @type {(() => void) | null} */
let cableModeChangedListener = null;
/** Last refresh log signature — only log when counts / ghost / selection change. */
let lastRefreshLogKey = '';

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
        typeof host.layoutCellHalfOffset !== 'function'
    ) {
        throw new Error(
            'Experience host API missing WiFi FX helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @param {number} alpha
 * @param {string} name
 * @returns {import('@babylonjs/core').StandardMaterial}
 */
function makeDiscMaterial(alpha, name) {
    const host = getHost();
    const mat = new host.StandardMaterial(name, boundScene);
    mat.disableLighting = true;
    mat.emissiveColor = host.Color3.FromHexString(WIFI_DISC_COLOR_HEX);
    mat.diffuseColor = host.Color3.Black();
    mat.specularColor = host.Color3.Black();
    mat.alpha = alpha;
    mat.transparencyMode = 2;
    mat.backFaceCulling = false;
    // Never hide what draws after it, so overlapping discs simply stack.
    mat.disableDepthWrite = true;
    return mat;
}

/**
 * White dashed edge around an online disc.
 * Built as short line arcs (CreateLineSystem) — avoids CreateDashedLines empty-array warnings.
 * @param {string} name
 * @param {number} radius
 * @returns {import('@babylonjs/core').LinesMesh}
 */
function makeDashedRing(name, radius) {
    const host = getHost();
    const dashCount = WIFI_RING_DASHES;
    const dashArc = (Math.PI * 2) / dashCount;
    const dashFraction = 0.55;
    const stepsPerDash = 3;
    /** @type {import('@babylonjs/core').Vector3[][]} */
    const lines = [];
    for (let d = 0; d < dashCount; d += 1) {
        const start = d * dashArc;
        const end = start + dashArc * dashFraction;
        /** @type {import('@babylonjs/core').Vector3[]} */
        const segment = [];
        for (let s = 0; s <= stepsPerDash; s += 1) {
            const t = start + (end - start) * (s / stepsPerDash);
            segment.push(new host.Vector3(Math.cos(t) * radius, 0, Math.sin(t) * radius));
        }
        lines.push(segment);
    }
    const ring = host.MeshBuilder.CreateLineSystem(name, { lines }, boundScene);
    ring.color = host.Color3.FromHexString(WIFI_RING_COLOR_HEX);
    ring.alpha = WIFI_RING_ALPHA;
    ring.isPickable = false;
    return ring;
}

/**
 * @param {string} key
 * @param {number} range
 * @returns {DiscEntry}
 */
function createDiscEntry(key, range) {
    const host = getHost();
    const disc = host.MeshBuilder.CreateDisc(
        `simnetWifiDisc_${key}`,
        { radius: range, tessellation: WIFI_DISC_TESSELLATION },
        boundScene
    );
    // CreateDisc stands in the XY plane; lay it flat on the floor.
    disc.rotation.x = Math.PI / 2;
    disc.material = discMatBase;
    disc.isPickable = false;
    const ring = makeDashedRing(`simnetWifiRing_${key}`, range);
    return { range, disc, ring };
}

/**
 * @param {DiscEntry} entry
 */
function disposeDiscEntry(entry) {
    entry.disc.dispose();
    entry.ring.dispose();
}

/**
 * @param {string} key
 * @param {number} range
 * @returns {DiscEntry}
 */
function ensureDiscEntry(key, range) {
    const existing = discByStampId.get(key);
    if (existing && existing.range === range) {
        return existing;
    }
    if (existing) {
        disposeDiscEntry(existing);
    }
    const entry = createDiscEntry(key, range);
    discByStampId.set(key, entry);
    return entry;
}

/**
 * Position + selected fill for an online disc (caller only paints online sources).
 * @param {DiscEntry} entry
 * @param {{ x: number, z: number }} stamp
 * @param {boolean} selected
 */
function paintDiscEntry(entry, stamp, selected) {
    const host = getHost();
    const layout = getActiveLayout();
    const cellSize = layout?.cellSize ?? 1;
    const half = host.layoutCellHalfOffset(cellSize);
    const cx = stamp.x * cellSize + half;
    const cz = stamp.z * cellSize + half;
    entry.disc.position.set(cx, WIFI_DISC_Y, cz);
    entry.ring.position.set(cx, WIFI_RING_Y, cz);
    entry.disc.material = selected ? discMatSelected : discMatBase;
    entry.disc.setEnabled(true);
    entry.ring.setEnabled(true);
}

/**
 * Every placed stamp plus the placement ghost (if any).
 * @returns {Array<{ stampId: string, partId: string, x: number, z: number }>}
 */
function collectStampsWithGhost() {
    const stamps = getAllStamps().map((stamp) => ({
        stampId: stamp.stampId,
        partId: stamp.partId,
        x: stamp.x,
        z: stamp.z,
    }));
    if (ghostStamp) {
        stamps.push({ stampId: GHOST_STAMP_ID, ...ghostStamp });
    }
    return stamps;
}

/**
 * Redraw every disc from the live WiFi network (cables, placed parts, ghost, selection).
 * Offline sources get no disc at all.
 */
export function refreshWifiVisuals() {
    if (!boundScene || !discMatBase) {
        return;
    }
    const stamps = collectStampsWithGhost();
    const wifi = computeWifiNetwork({
        stamps,
        getPartDef,
        cableOnlineIds: getCableOnlineIds(),
    });
    const liveKeys = new Set();
    let onlineCount = 0;
    let selectedOnline = false;
    for (const stamp of stamps) {
        const def = getPartDef(stamp.partId);
        if (!isWifiSourcePart(def)) {
            continue;
        }
        const online = wifi.parentBySourceId.has(stamp.stampId);
        if (!online) {
            continue;
        }
        liveKeys.add(stamp.stampId);
        onlineCount += 1;
        // Selected fill only in free play — Cable tool hides the green wash but keeps
        // sticky memory; do not show 0.4 while the tool is still armed.
        const selected = stamp.stampId !== GHOST_STAMP_ID
            && !isCableModeActive()
            && selectedCell?.x === stamp.x
            && selectedCell?.z === stamp.z;
        if (selected) {
            selectedOnline = true;
        }
        const entry = ensureDiscEntry(stamp.stampId, def.wifiRange);
        paintDiscEntry(entry, stamp, selected);
    }
    for (const [key, entry] of discByStampId) {
        if (!liveKeys.has(key)) {
            disposeDiscEntry(entry);
            discByStampId.delete(key);
        }
    }
    const logKey = [
        liveKeys.size,
        onlineCount,
        ghostStamp?.partId || 'none',
        selectedCell ? `${selectedCell.x},${selectedCell.z}` : 'none',
        selectedOnline ? '1' : '0',
    ].join('|');
    if (logKey !== lastRefreshLogKey) {
        lastRefreshLogKey = logKey;
        console.log(
            `[partWifiFx.js]: [N/A] - [refreshWifiVisuals] - sourceCount has a value of ${liveKeys.size}, onlineCount has a value of ${onlineCount}, ghostPartId has a value of ${ghostStamp?.partId || 'none'}, selectedCell has a value of ${selectedCell ? `${selectedCell.x},${selectedCell.z}` : 'none'}, selectedOnline has a value of ${selectedOnline}.`
        ); //This is logged when WiFi disc state changes (counts, ghost, or selection), to confirm online-only discs and selected fill.
    }
    // Discs, floating GLBs, and scene pills all follow the same WiFi + cable truth.
    refreshAllConnectionStatuses();
    refreshAllDeviceBadges();
}

/**
 * Placement ghost position (or null when the ghost is hidden). Refreshes only on a real change.
 * @param {{ partId: string, x: number, z: number } | null} ghost
 */
export function setWifiGhost(ghost) {
    const next = ghost && isWifiSourcePart(getPartDef(ghost.partId))
        ? { partId: ghost.partId, x: ghost.x, z: ghost.z }
        : null;
    const same = next === ghostStamp
        || (next && ghostStamp
            && next.partId === ghostStamp.partId
            && next.x === ghostStamp.x
            && next.z === ghostStamp.z);
    if (same) {
        return;
    }
    ghostStamp = next;
    refreshWifiVisuals();
}

/**
 * Cell of the device open in the inspector (or null). Its source disc uses the selected fill.
 * @param {{ x: number, z: number } | null} cell
 */
export function setWifiSelectedCell(cell) {
    const next = cell ? { x: cell.x, z: cell.z } : null;
    if (next?.x === selectedCell?.x && next?.z === selectedCell?.z) {
        return;
    }
    selectedCell = next;
    refreshWifiVisuals();
}

/**
 * Live online coverage discs for the test ripple (excludes placement ghost).
 * @returns {Array<{ stampId: string, range: number, x: number, y: number, z: number }>}
 */
export function getOnlineWifiDiscSnapshots() {
    /** @type {Array<{ stampId: string, range: number, x: number, y: number, z: number }>} */
    const out = [];
    for (const [stampId, entry] of discByStampId) {
        if (stampId === GHOST_STAMP_ID) {
            continue;
        }
        if (!entry?.disc || entry.disc.isDisposed?.() || !entry.disc.isEnabled()) {
            continue;
        }
        out.push({
            stampId,
            range: entry.range,
            x: entry.disc.position.x,
            y: entry.disc.position.y,
            z: entry.disc.position.z,
        });
    }
    return out;
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializeWifiFx(scene) {
    disposeWifiFx();
    boundScene = scene;
    discMatBase = makeDiscMaterial(WIFI_DISC_ALPHA_BASE, 'simnetWifiDiscMatBase');
    discMatSelected = makeDiscMaterial(WIFI_DISC_ALPHA_SELECTED, 'simnetWifiDiscMatSelected');
    cablesChangedListener = () => refreshWifiVisuals();
    window.addEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);
    cableModeChangedListener = () => refreshWifiVisuals();
    window.addEventListener(CABLE_MODE_CHANGED_EVENT, cableModeChangedListener);
    exploreSelectionListener = (event) => {
        const cell = /** @type {CustomEvent} */ (event).detail?.cell;
        setWifiSelectedCell(cell && typeof cell.x === 'number' ? cell : null);
    };
    window.addEventListener(EXPLORE_SELECTION_EVENT, exploreSelectionListener);
    refreshWifiVisuals();
    console.log(
        `[partWifiFx.js]: [N/A] - [initializeWifiFx] - ready has a value of true.`
    ); //This is logged when WiFi coverage discs are armed for the active map.
}

export function disposeWifiFx() {
    if (cablesChangedListener) {
        window.removeEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);
        cablesChangedListener = null;
    }
    if (cableModeChangedListener) {
        window.removeEventListener(CABLE_MODE_CHANGED_EVENT, cableModeChangedListener);
        cableModeChangedListener = null;
    }
    if (exploreSelectionListener) {
        window.removeEventListener(EXPLORE_SELECTION_EVENT, exploreSelectionListener);
        exploreSelectionListener = null;
    }
    for (const entry of discByStampId.values()) {
        disposeDiscEntry(entry);
    }
    discByStampId.clear();
    discMatBase?.dispose();
    discMatSelected?.dispose();
    discMatBase = null;
    discMatSelected = null;
    ghostStamp = null;
    selectedCell = null;
    lastRefreshLogKey = '';
    boundScene = null;
}

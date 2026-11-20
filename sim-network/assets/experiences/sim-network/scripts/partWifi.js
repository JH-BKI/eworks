/**
 * Sim-network WiFi rules — pure logic, no scene or host access.
 * Callers pass plain stamps ({ stampId, partId, x, z }) and a part lookup.
 */

import { WIFI_RANGE_M } from './wifiConfig.js';

/** Failure reasons shown as results-HUD link tips. */
export const WIFI_REASON_OUT_OF_RANGE = 'Out of range';
export const WIFI_REASON_SOURCE_OFFLINE = 'Source not connected';

/**
 * @param {object | null | undefined} partDef
 * @returns {boolean}
 */
export function isWifiSourcePart(partDef) {
    return typeof partDef?.wifiRange === 'number' && partDef.wifiRange > 0;
}

/**
 * @param {object | null | undefined} partDef
 * @returns {boolean}
 */
export function isWifiClientPart(partDef) {
    return partDef?.linkType === 'wifi' && !isWifiSourcePart(partDef);
}

/**
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 * @returns {number}
 */
function cellDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The one coverage check: straight-line distance between cell centres, edge counts as inside.
 * @param {{ x: number, z: number, range?: number }} source
 * @param {{ x: number, z: number }} cell
 * @returns {boolean}
 */
export function inRange(source, cell) {
    const range = typeof source?.range === 'number' ? source.range : WIFI_RANGE_M;
    return cellDistance(source, cell) <= range;
}

/**
 * Nearest source in `candidates` covering `cell`; exact ties keep the first found.
 * @param {Array<{ stampId: string, x: number, z: number, range: number }>} candidates
 * @param {{ x: number, z: number }} cell
 * @param {string} [excludeId]
 * @returns {{ stampId: string, x: number, z: number, range: number } | null}
 */
function nearestCovering(candidates, cell, excludeId) {
    let best = null;
    let bestDist = Infinity;
    for (const source of candidates) {
        if (source.stampId === excludeId || !inRange(source, cell)) {
            continue;
        }
        const dist = cellDistance(source, cell);
        if (dist < bestDist) {
            best = source;
            bestDist = dist;
        }
    }
    return best;
}

/**
 * Nearest source in `candidates` regardless of range (for out-of-range HUD paths).
 * @param {Array<{ stampId: string, x: number, z: number }>} candidates
 * @param {{ x: number, z: number }} cell
 * @param {string} [excludeId]
 * @returns {{ stampId: string } | null}
 */
function nearestAny(candidates, cell, excludeId) {
    let best = null;
    let bestDist = Infinity;
    for (const source of candidates) {
        if (source.stampId === excludeId) {
            continue;
        }
        const dist = cellDistance(source, cell);
        if (dist < bestDist) {
            best = source;
            bestDist = dist;
        }
    }
    return best;
}

/**
 * Bring repeaters online pass by pass: a repeater joins the nearest source that was
 * online at the start of the pass. Stops when a pass changes nothing.
 * @param {Array<object>} sources
 * @param {Map<string, string | null>} parentBySourceId
 */
function bringRepeatersOnline(sources, parentBySourceId) {
    let changed = true;
    while (changed) {
        changed = false;
        const onlineNow = sources.filter((source) => parentBySourceId.has(source.stampId));
        for (const source of sources) {
            if (source.backhaul !== 'wifi' || parentBySourceId.has(source.stampId)) {
                continue;
            }
            const parent = nearestCovering(onlineNow, source, source.stampId);
            if (parent) {
                parentBySourceId.set(source.stampId, parent.stampId);
                changed = true;
            }
        }
    }
}

/**
 * Why a WiFi stamp is not connected, plus the source its HUD path should run through.
 * @param {object} stamp
 * @param {Array<object>} sources
 * @param {Array<object>} onlineSources
 * @returns {{ reason: string, viaSourceId: string | null }}
 */
function explainOffline(stamp, sources, onlineSources) {
    const offlineSources = sources.filter((source) => !onlineSources.includes(source));
    const coveringOffline = nearestCovering(offlineSources, stamp, stamp.stampId);
    if (coveringOffline) {
        // An offline repeater is itself out of range; an offline cabled source has no internet.
        const reason = coveringOffline.backhaul === 'wifi'
            ? WIFI_REASON_OUT_OF_RANGE
            : WIFI_REASON_SOURCE_OFFLINE;
        return { reason, viaSourceId: coveringOffline.stampId };
    }
    const via = nearestAny(onlineSources, stamp, stamp.stampId)
        || nearestAny(sources, stamp, stamp.stampId);
    return { reason: WIFI_REASON_OUT_OF_RANGE, viaSourceId: via ? via.stampId : null };
}

/**
 * Work out the whole wireless network.
 * @param {{
 *   stamps: Array<{ stampId: string, partId: string, x: number, z: number }>,
 *   getPartDef: (partId: string) => object | null | undefined,
 *   cableOnlineIds: Set<string>
 * }} input
 * @returns {{
 *   parentBySourceId: Map<string, string | null>,
 *   sourceByClientId: Map<string, string>,
 *   clientCountBySourceId: Map<string, number>,
 *   offlineById: Map<string, { reason: string, viaSourceId: string | null }>
 * }}
 */
export function computeWifiNetwork(input) {
    const { stamps, getPartDef, cableOnlineIds } = input;
    const sources = [];
    const clients = [];
    for (const stamp of stamps) {
        const def = getPartDef(stamp.partId);
        if (isWifiSourcePart(def)) {
            sources.push({
                stampId: stamp.stampId,
                x: stamp.x,
                z: stamp.z,
                range: def.wifiRange,
                backhaul: def.linkType === 'wifi' ? 'wifi' : 'cable',
            });
        } else if (isWifiClientPart(def)) {
            clients.push(stamp);
        }
    }

    /** Online sources → parent source id (null = online by cable). */
    /** @type {Map<string, string | null>} */
    const parentBySourceId = new Map();
    for (const source of sources) {
        if (source.backhaul === 'cable' && cableOnlineIds.has(source.stampId)) {
            parentBySourceId.set(source.stampId, null);
        }
    }
    bringRepeatersOnline(sources, parentBySourceId);
    const onlineSources = sources.filter((source) => parentBySourceId.has(source.stampId));

    /** @type {Map<string, string>} */
    const sourceByClientId = new Map();
    /** @type {Map<string, number>} */
    const clientCountBySourceId = new Map(onlineSources.map((source) => [source.stampId, 0]));
    /** @type {Map<string, { reason: string, viaSourceId: string | null }>} */
    const offlineById = new Map();

    for (const client of clients) {
        const source = nearestCovering(onlineSources, client);
        if (source) {
            sourceByClientId.set(client.stampId, source.stampId);
            clientCountBySourceId.set(source.stampId, clientCountBySourceId.get(source.stampId) + 1);
        } else {
            offlineById.set(client.stampId, explainOffline(client, sources, onlineSources));
        }
    }
    for (const source of sources) {
        const parentId = parentBySourceId.get(source.stampId);
        if (source.backhaul !== 'wifi') {
            continue;
        }
        if (parentId) {
            // A repeater counts its uplink as well as its clients.
            clientCountBySourceId.set(source.stampId, clientCountBySourceId.get(source.stampId) + 1);
            clientCountBySourceId.set(parentId, clientCountBySourceId.get(parentId) + 1);
        } else {
            offlineById.set(source.stampId, explainOffline(source, sources, onlineSources));
        }
    }

    return { parentBySourceId, sourceByClientId, clientCountBySourceId, offlineById };
}

/**
 * Sim-network cell inspector — one-row header + Connections tray
 * (Wired + Wireless strips). Cable Unplug lives on the HTML midpoint pill.
 * Layout: board 31 / plans/wifi-mode/inspector-31/spec.md
 */

import {
    getAllStamps,
    getPartDef,
    getStampById,
    getStampsAtCell,
    getStampLabel,
    removeStampById,
} from './layoutAssembler.js';
import {
    getAllCableLinks,
    getCableOnlineIds,
    getNetworkHudPartIcon,
    removeCablesForStamp,
    isCableModeActive,
    NETWORK_TEST_UI_CHANGED_EVENT,
    isNetworkTestUiBusy,
    areNetworkEditsLocked,
    maxCablesForPart,
    highlightCableLink,
    clearCableHighlight,
} from './partCables.js';
import {
    isDroppableToolActive,
    pickCellAtPointer,
    refreshStockButtons,
} from './partDrop.js';
import { unbindInteractableRoot } from './partInteraction.js';
import { detachConnectionStatusForStamp } from './partConnectionStatus.js';
import { detachDeviceBadgeForStamp } from './partDeviceBadges.js';
import {
    focusSimNetworkCell,
    isSimNetworkCameraLocked,
} from './partCamera.js';
import { refreshWifiVisuals } from './partWifiFx.js';
import {
    computeWifiNetwork,
    isWifiClientPart,
    isWifiSourcePart,
} from './partWifi.js';
import { setUnplugCableTarget } from './partUnplugPill.js';
import { notifyTutorialAction } from './sim-network-tutorial-coach.js';

const HOST_KEY = '__XRS_EXPERIENCE_HOST__';
const SELECT_CLICK_SLOP_PX = 5;
/** Same-cell second click within this window focuses the camera (ms). */
const FOCUS_DOUBLE_CLICK_MS = 450;
const CABLES_CHANGED_EVENT = 'sim-network-cables-changed';
const FOLD_LAYOUT_QUERY = '(max-width: 767px), (max-height: 500px)';
const PHONE_WIDTH_QUERY = '(max-width: 767px)';

/** Stage 3 listens for this — WiFi link / orange overlay. */
export const WIFI_CONNECTION_SELECTED_EVENT = 'sim-network-wifi-connection-selected';

/** @type {((this: Window, ev: Event) => void) | null} */
let networkEditsLockListener = null;
/** @type {((this: Window, ev: Event) => void) | null} */
let cablesChangedListener = null;
/** @type {((this: Window, ev: Event) => void) | null} */
let networkTestUiListener = null;
/** @type {((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null} */
let foldLayoutListener = null;
/** @type {MediaQueryList | null} */
let foldLayoutQuery = null;

/** @type {import('@babylonjs/core').Scene | null} */
let boundScene = null;
/** @type {HTMLElement | null} */
let stackEl = null;
/** @type {HTMLElement | null} */
let panelEl = null;
/** @type {HTMLElement | null} */
let deviceEl = null;
/** @type {HTMLElement | null} */
let tileEl = null;
/** @type {HTMLElement | null} */
let nameEl = null;
/** @type {HTMLElement | null} */
let statusBadgeEl = null;
/** @type {HTMLElement | null} */
let countEl = null;
/** @type {HTMLElement | null} */
let connectionsDividerEl = null;
/** @type {HTMLElement | null} */
let connectionsMetaEl = null;
/** @type {HTMLElement | null} */
let connectionsLabelEl = null;
/** @type {HTMLButtonElement | null} */
let connectionsToggleBtn = null;
/** @type {HTMLElement | null} */
let trayEl = null;
/** @type {HTMLElement | null} */
let wiredStripEl = null;
/** @type {HTMLElement | null} */
let wirelessStripEl = null;
/** @type {import('@babylonjs/core').Observer | null} */
let pointerObserver = null;
/** @type {{ x: number, y: number, toolActiveAtDown: boolean } | null} */
let pointerDownInfo = null;
/** @type {{ x: number, z: number } | null} */
let inspectedCell = null;
/** @type {string | null} */
let selectedLinkId = null;
/**
 * Active WiFi connection from a Wireless-strip chip, or null.
 * @type {{ sourceStampId: string, clientStampId: string } | null}
 */
let selectedWifi = null;
/**
 * null until the first open. Then true = tray closed, false = tray open.
 * @type {boolean | null}
 */
let foldPreference = null;
/** First click of a pending same-cell double-click for camera focus. */
/** @type {{ x: number, z: number, atMs: number } | null} */
let pendingFocusClick = null;

/**
 * @returns {object}
 */
function getHost() {
    const host = globalThis[HOST_KEY];
    if (!host || !host.PointerEventTypes) {
        throw new Error(
            'Experience host API missing pointer helpers. Is installExperienceHostApi() running?'
        );
    }
    return host;
}

/**
 * @returns {HTMLElement | null}
 */
function getPlayerFrame() {
    const host = getHost();
    const root = typeof host.getPlayerUiRoot === 'function' ? host.getPlayerUiRoot() : null;
    if (!root || root.id !== 'uiContainer') {
        return null;
    }
    return root;
}

/**
 * @param {string} clipId
 */
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
 * @param {number} x
 * @param {number} z
 * @returns {object[]}
 */
function getInteractableStampsAtCell(x, z) {
    return getStampsAtCell(x, z).filter((stamp) => {
        return getPartDef(stamp.partId)?.interactable === true;
    });
}

/**
 * @param {string} stampId
 * @returns {Array<{ id: string, fromStampId: string, toStampId: string }>}
 */
function linksOnStamp(stampId) {
    return getAllCableLinks().filter((link) => {
        return link.fromStampId === stampId || link.toStampId === stampId;
    });
}

/**
 * @param {{ id: string, fromStampId: string, toStampId: string }} link
 * @param {string} stampId
 * @returns {{ partId: string, label: string }}
 */
function otherEnd(link, stampId) {
    const otherId = link.fromStampId === stampId ? link.toStampId : link.fromStampId;
    const stamp = getStampById(otherId);
    return {
        partId: stamp?.partId || '',
        label: getStampLabel(stamp),
    };
}

/**
 * @returns {ReturnType<typeof computeWifiNetwork>}
 */
function getWifiSnapshot() {
    return computeWifiNetwork({
        stamps: getAllStamps(),
        getPartDef,
        cableOnlineIds: getCableOnlineIds(),
    });
}

/**
 * Wireless-strip rows for one device (other end + connection pair for the event).
 * @param {object} stamp
 * @param {ReturnType<typeof computeWifiNetwork>} wifi
 * @returns {Array<{ otherStampId: string, sourceStampId: string, clientStampId: string }>}
 */
function wirelessEntriesForStamp(stamp, wifi) {
    const partDef = getPartDef(stamp.partId);
    /** @type {Array<{ otherStampId: string, sourceStampId: string, clientStampId: string }>} */
    const entries = [];
    const seen = new Set();

    /**
     * @param {string} otherStampId
     * @param {string} sourceStampId
     * @param {string} clientStampId
     */
    const pushEntry = (otherStampId, sourceStampId, clientStampId) => {
        if (!otherStampId || seen.has(otherStampId)) {
            return;
        }
        seen.add(otherStampId);
        entries.push({ otherStampId, sourceStampId, clientStampId });
    };

    // Live links only — offline viaSourceId is for the results HUD path, not Connections.
    if (isWifiClientPart(partDef)) {
        const sourceId = wifi.sourceByClientId.get(stamp.stampId) || null;
        if (sourceId) {
            pushEntry(sourceId, sourceId, stamp.stampId);
        }
        return entries;
    }

    if (!isWifiSourcePart(partDef)) {
        return entries;
    }

    // Repeater uplink first (design: Wireless strip starts with the source it repeats).
    if (partDef?.linkType === 'wifi' && wifi.parentBySourceId.has(stamp.stampId)) {
        const parentId = wifi.parentBySourceId.get(stamp.stampId);
        if (parentId) {
            pushEntry(parentId, parentId, stamp.stampId);
        }
    }

    for (const [clientId, sourceId] of wifi.sourceByClientId) {
        if (sourceId === stamp.stampId) {
            pushEntry(clientId, stamp.stampId, clientId);
        }
    }
    for (const [childId, parentId] of wifi.parentBySourceId) {
        if (parentId === stamp.stampId) {
            pushEntry(childId, stamp.stampId, childId);
        }
    }
    return entries;
}

/**
 * Connections tray closed when the player folded it (phone starts folded).
 * @returns {boolean}
 */
function trayIsClosed() {
    return foldPreference === true;
}

function ensureFoldPreference() {
    if (foldPreference !== null) {
        return;
    }
    foldPreference = window.matchMedia(PHONE_WIDTH_QUERY).matches;
    console.log(
        `[partCellInspector.js]: [N/A] - [ensureFoldPreference] - foldPreference has a value of ${foldPreference}.`
    ); //This is logged when the inspector picks its first tray open/closed state.
}

/**
 * @param {{ sourceStampId: string, clientStampId: string } | null} next
 */
function setWifiSelection(next) {
    const same =
        selectedWifi &&
        next &&
        selectedWifi.sourceStampId === next.sourceStampId &&
        selectedWifi.clientStampId === next.clientStampId;
    if (same) {
        return;
    }
    if (!selectedWifi && !next) {
        return;
    }
    selectedWifi = next;
    window.dispatchEvent(
        new CustomEvent(WIFI_CONNECTION_SELECTED_EVENT, {
            detail: selectedWifi
                ? {
                      sourceStampId: selectedWifi.sourceStampId,
                      clientStampId: selectedWifi.clientStampId,
                  }
                : null,
        })
    );
    console.log(
        `[partCellInspector.js]: [N/A] - [setWifiSelection] - sourceStampId has a value of ${selectedWifi?.sourceStampId ?? 'null'}, clientStampId has a value of ${selectedWifi?.clientStampId ?? 'null'}.`
    ); //This is logged when a Wireless-strip chip selects or clears a WiFi connection.
}

function clearConnectionSelections() {
    selectedLinkId = null;
    clearCableHighlight();
    setUnplugCableTarget(null);
    setWifiSelection(null);
}

/**
 * @param {{ id: string, className: string, iconName: string, label: string, ariaLabel: string, tooltip?: string, onClick: () => void }} options
 * @returns {HTMLButtonElement}
 */
function createInspectorButton(options) {
    const host = getHost();
    const wrap = host.button(
        options.id,
        'neutral',
        { iconName: options.iconName, iconOnly: options.label.length === 0, iconPosition: 'before' },
        { text: options.ariaLabel, tooltipPosition: 'top' },
        null
    );
    const buttonEl = wrap.querySelector('button');
    if (!(buttonEl instanceof HTMLButtonElement)) {
        wrap.remove();
        throw new Error(`Inspector button factory did not return a button for ${options.id}.`);
    }
    buttonEl.type = 'button';
    buttonEl.remove();
    wrap.remove();
    buttonEl.className = options.className;
    buttonEl.setAttribute('aria-label', options.ariaLabel);
    if (options.tooltip) {
        buttonEl.classList.add('tooltip', 'tooltip-top');
        buttonEl.setAttribute('data-tip', options.tooltip);
    } else {
        buttonEl.removeAttribute('data-tip');
    }
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = host.getIcon(options.iconName, 'h-5 w-5 fill-current');
    if (options.label) {
        const labelEl = document.createElement('span');
        labelEl.className = 'sim-network-inspector__label';
        labelEl.textContent = options.label;
        buttonEl.replaceChildren(icon, labelEl);
    } else {
        buttonEl.replaceChildren(icon);
    }
    buttonEl.addEventListener('click', () => {
        options.onClick();
    });
    return buttonEl;
}

/**
 * @param {boolean} hidden
 */
function setStackHidden(hidden) {
    if (!stackEl) {
        return;
    }
    stackEl.classList.toggle('hidden', hidden);
    stackEl.hidden = hidden;
}

function hidePanel() {
    const wasOpen = Boolean(stackEl && !stackEl.hidden);
    clearConnectionSelections();
    setStackHidden(true);
    inspectedCell = null;
    if (wasOpen) {
        console.log(
            `[partCellInspector.js]: [N/A] - [hidePanel] - panelHidden has a value of true.`
        ); //This is logged when the cell inspector card closes.
    }
}

/**
 * @param {string} iconName
 */
function paintTile(iconName) {
    if (!tileEl) {
        return;
    }
    const host = getHost();
    tileEl.innerHTML = host.getIcon(iconName, 'h-5 w-5 fill-current');
}

/**
 * Count line: ports for wired gear, Connected/Repeating/Out of range for WiFi.
 * @param {object} stamp
 * @param {Array<{ id: string }>} links
 * @param {number} maxCables
 * @param {ReturnType<typeof computeWifiNetwork>} wifi
 */
function paintCountLine(stamp, links, maxCables, wifi) {
    if (!countEl) {
        return;
    }
    const partDef = getPartDef(stamp.partId);

    if (isWifiClientPart(partDef)) {
        const sourceId = wifi.sourceByClientId.get(stamp.stampId);
        if (sourceId) {
            countEl.textContent = `Connected to ${getStampLabel(getStampById(sourceId))}`;
        } else {
            countEl.textContent = 'Out of range';
        }
        return;
    }

    if (isWifiSourcePart(partDef) && partDef?.linkType === 'wifi') {
        if (wifi.parentBySourceId.has(stamp.stampId)) {
            const parentId = wifi.parentBySourceId.get(stamp.stampId);
            const parentLabel = parentId
                ? getStampLabel(getStampById(parentId))
                : '';
            countEl.textContent = parentLabel
                ? `Repeating ${parentLabel}`
                : 'Online';
        } else {
            countEl.textContent = 'Out of range';
        }
        return;
    }

    const strong = document.createElement('b');
    strong.textContent = `${links.length}/${maxCables}`;
    const word = maxCables === 1 ? ' port' : ' ports';
    countEl.replaceChildren(strong, document.createTextNode(word));
}

/**
 * @param {object} stamp
 */
function paintRemoveSlot(stamp) {
    if (!deviceEl) {
        return;
    }
    deviceEl.querySelector('.sim-network-inspector__remove')?.remove();
    deviceEl.querySelector('.sim-network-inspector__fixed')?.remove();
    if (stamp.playerDrop !== true) {
        return;
    }
    const removeBtn = createInspectorButton({
        id: 'sim-network-inspector-remove',
        className: 'btn btn-square btn-error btn-sm sim-network-inspector__remove',
        iconName: 'icon_trash',
        label: '',
        ariaLabel: 'Remove device',
        tooltip: 'Remove device',
        onClick: () => {
            playSfx('remove-component');
            const stampId = stamp.stampId;
            const removedCables = removeCablesForStamp(stampId);
            unbindInteractableRoot(stamp.wrap);
            detachConnectionStatusForStamp(stampId);
            detachDeviceBadgeForStamp(stampId);
            removeStampById(stampId);
            refreshStockButtons();
            refreshWifiVisuals();
            console.log(
                `[partCellInspector.js]: [N/A] - [paintRemoveSlot] - removedDroppableStampId has a value of ${stampId}, removedCableCount has a value of ${removedCables}.`
            ); //This is logged when the player removes a device from the cell inspector.
            if (inspectedCell) {
                renderPanel(inspectedCell);
            }
        },
    });
    deviceEl.appendChild(removeBtn);
}

/**
 * One half of a link/wifi count pair (icon + number), matching board 04.
 * @param {string} iconName
 * @param {number} count
 * @param {string} ariaLabel
 * @returns {HTMLElement}
 */
function buildConnCountHalf(iconName, count, ariaLabel) {
    const host = getHost();
    const half = document.createElement('span');
    half.className = 'sim-network-inspector__conn-half';
    half.setAttribute('aria-label', ariaLabel);
    const icon = document.createElement('span');
    icon.className = 'sim-network-inspector__conn-half-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = host.getIcon(iconName, 'h-3.5 w-3.5 stroke-current');
    const num = document.createElement('span');
    num.className = 'sim-network-inspector__conn-half-num';
    num.textContent = String(count);
    half.append(icon, num);
    return half;
}

/**
 * Dark connection-count pill: link N | WiFi N, zero halves hidden.
 * Sits under the CONNECTIONS label in the header.
 * @param {number} linkCount
 * @param {number} wifiCount
 */
function paintStatusBadge(linkCount, wifiCount) {
    if (!statusBadgeEl) {
        return;
    }
    statusBadgeEl.replaceChildren();
    const showLink = linkCount > 0;
    const showWifi = wifiCount > 0;
    if (!showLink && !showWifi) {
        statusBadgeEl.hidden = true;
        statusBadgeEl.classList.add('hidden');
        return;
    }
    statusBadgeEl.hidden = false;
    statusBadgeEl.classList.remove('hidden');
    const bits = [];
    if (showLink) {
        bits.push(buildConnCountHalf('icon_cable', linkCount, `${linkCount} cable connections`));
    }
    if (showLink && showWifi) {
        const sep = document.createElement('span');
        sep.className = 'sim-network-inspector__conn-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '|';
        bits.push(sep);
    }
    if (showWifi) {
        bits.push(buildConnCountHalf('icon_wifi', wifiCount, `${wifiCount} WiFi clients`));
    }
    statusBadgeEl.append(...bits);
    statusBadgeEl.setAttribute(
        'aria-label',
        [
            showLink ? `${linkCount} cables` : '',
            showWifi ? `${wifiCount} WiFi clients` : '',
        ]
            .filter(Boolean)
            .join(', ')
    );
}

/**
 * Header Connections block: divider + CONNECTIONS label + count pill + square chevron.
 * Hidden entirely when there are no links and no WiFi (no tray toggle).
 * @param {number} linkCount
 * @param {number} wifiCount
 */
function paintConnectionsFooter(linkCount, wifiCount) {
    if (!panelEl || !connectionsToggleBtn) {
        return;
    }
    const hasAny = linkCount > 0 || wifiCount > 0;
    const hideConn = !hasAny;
    connectionsDividerEl?.classList.toggle('hidden', hideConn);
    if (connectionsDividerEl) {
        connectionsDividerEl.hidden = hideConn;
    }
    connectionsMetaEl?.classList.toggle('hidden', hideConn);
    if (connectionsMetaEl) {
        connectionsMetaEl.hidden = hideConn;
    }
    connectionsToggleBtn.hidden = hideConn;
    connectionsToggleBtn.classList.toggle('hidden', hideConn);

    if (!hasAny) {
        if (trayEl) {
            trayEl.hidden = true;
            trayEl.classList.add('hidden');
        }
        panelEl.classList.remove('has-connections');
        return;
    }

    panelEl.classList.add('has-connections');
    if (connectionsMetaEl && statusBadgeEl && statusBadgeEl.parentElement !== connectionsMetaEl) {
        connectionsMetaEl.append(statusBadgeEl);
    }

    const closed = trayIsClosed();
    const host = getHost();
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = host.getIcon(
        closed ? 'icon_chevron_down' : 'icon_chevron_up',
        'h-4 w-4 stroke-current'
    );
    connectionsToggleBtn.replaceChildren(icon);

    const summary = [
        linkCount > 0 ? `link ${linkCount}` : '',
        wifiCount > 0 ? `WiFi ${wifiCount}` : '',
    ]
        .filter(Boolean)
        .join(' | ');
    connectionsToggleBtn.setAttribute('aria-expanded', closed ? 'false' : 'true');
    connectionsToggleBtn.setAttribute(
        'aria-label',
        closed ? `Show connections: ${summary}` : `Hide connections: ${summary}`
    );
}

/**
 * @param {object} stamp
 * @param {Array<{ id: string, fromStampId: string, toStampId: string }>} links
 * @param {number} maxCables
 */
function paintWiredStrip(stamp, links, maxCables) {
    if (!wiredStripEl) {
        return;
    }
    wiredStripEl.replaceChildren();
    if (maxCables <= 0 && links.length === 0) {
        wiredStripEl.hidden = true;
        wiredStripEl.classList.add('hidden');
        return;
    }
    wiredStripEl.hidden = false;
    wiredStripEl.classList.remove('hidden');

    const label = document.createElement('span');
    label.className = 'sim-network-inspector__strip-label';
    label.textContent = 'Wired';
    const chips = document.createElement('div');
    chips.className = 'sim-network-inspector__ports';

    links.forEach((link, index) => {
        const portNumber = index + 1;
        const other = otherEnd(link, stamp.stampId);
        const selected = selectedLinkId === link.id;
        const portBtn = createInspectorButton({
            id: `sim-network-inspector-port-${link.id}`,
            className: selected
                ? 'btn btn-square sim-network-inspector__port is-selected'
                : 'btn btn-square sim-network-inspector__port',
            iconName: getNetworkHudPartIcon(other.partId),
            label: '',
            ariaLabel: `Port ${portNumber}: connection to ${other.label}`,
            onClick: () => {
                if (selectedLinkId === link.id) {
                    clearConnectionSelections();
                    console.log(
                        `[partCellInspector.js]: [N/A] - [paintWiredStrip] - clearedLinkId has a value of ${link.id}.`
                    ); //This is logged when the player taps the selected Wired port again.
                } else {
                    setWifiSelection(null);
                    selectedLinkId = link.id;
                    highlightCableLink(link.id, stamp.stampId);
                    setUnplugCableTarget(link.id);
                    console.log(
                        `[partCellInspector.js]: [N/A] - [paintWiredStrip] - selectedLinkId has a value of ${link.id}.`
                    ); //This is logged when the player selects a Wired port to highlight its cable.
                }
                if (inspectedCell) {
                    renderPanel(inspectedCell);
                }
            },
        });
        portBtn.dataset.cableId = link.id;
        portBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        chips.appendChild(portBtn);
    });
    for (let portNumber = links.length + 1; portNumber <= maxCables; portNumber += 1) {
        const slot = document.createElement('span');
        slot.className = 'sim-network-inspector__port sim-network-inspector__port--empty';
        slot.setAttribute('role', 'img');
        slot.setAttribute('aria-label', `Port ${portNumber}: empty`);
        slot.textContent = String(portNumber);
        chips.appendChild(slot);
    }

    wiredStripEl.append(label, chips);
}

/**
 * @param {object} stamp
 * @param {Array<{ otherStampId: string, sourceStampId: string, clientStampId: string }>} entries
 */
function paintWirelessStrip(stamp, entries) {
    if (!wirelessStripEl) {
        return;
    }
    wirelessStripEl.replaceChildren();
    if (entries.length === 0) {
        wirelessStripEl.hidden = true;
        wirelessStripEl.classList.add('hidden');
        return;
    }
    wirelessStripEl.hidden = false;
    wirelessStripEl.classList.remove('hidden');

    const label = document.createElement('span');
    label.className = 'sim-network-inspector__strip-label';
    label.textContent = 'Wireless';
    const chips = document.createElement('div');
    chips.className = 'sim-network-inspector__wifi-chips';

    entries.forEach((entry) => {
        const other = getStampById(entry.otherStampId);
        const otherLabel = getStampLabel(other);
        const selected =
            selectedWifi &&
            selectedWifi.sourceStampId === entry.sourceStampId &&
            selectedWifi.clientStampId === entry.clientStampId;
        const chipBtn = createInspectorButton({
            id: `sim-network-inspector-wifi-${entry.otherStampId}`,
            className: selected
                ? 'btn btn-square sim-network-inspector__wifi-chip is-selected'
                : 'btn btn-square sim-network-inspector__wifi-chip',
            iconName: getNetworkHudPartIcon(other?.partId || ''),
            label: '',
            ariaLabel: `Wireless connection with ${otherLabel}`,
            onClick: () => {
                if (selected) {
                    clearConnectionSelections();
                    console.log(
                        `[partCellInspector.js]: [N/A] - [paintWirelessStrip] - clearedWifiClientStampId has a value of ${entry.clientStampId}.`
                    ); //This is logged when the player deselects a Wireless chip.
                } else {
                    selectedLinkId = null;
                    clearCableHighlight();
                    setUnplugCableTarget(null);
                    setWifiSelection({
                        sourceStampId: entry.sourceStampId,
                        clientStampId: entry.clientStampId,
                    });
                    console.log(
                        `[partCellInspector.js]: [N/A] - [paintWirelessStrip] - selectedWifiClientStampId has a value of ${entry.clientStampId}, sourceStampId has a value of ${entry.sourceStampId}.`
                    ); //This is logged when the player selects a Wireless chip for Stage 3 link/orange.
                }
                if (inspectedCell) {
                    renderPanel(inspectedCell);
                }
            },
        });
        chipBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        chips.appendChild(chipBtn);
    });

    wirelessStripEl.append(label, chips);
}

/**
 * @param {{ x: number, z: number }} cell
 */
function renderPanel(cell) {
    if (!stackEl || !panelEl || !nameEl) {
        return;
    }
    const stamps = getInteractableStampsAtCell(cell.x, cell.z);
    if (stamps.length === 0) {
        hidePanel();
        return;
    }
    if (isNetworkTestUiBusy() || areNetworkEditsLocked()) {
        hidePanel();
        return;
    }
    const stamp = stamps[0];
    if (stamps.length > 1) {
        console.log(
            `[partCellInspector.js]: [N/A] - [renderPanel] - extraStampCount has a value of ${stamps.length - 1}.`
        ); //This is logged when a cell has more than one device and the card shows the first.
    }
    ensureFoldPreference();
    inspectedCell = { x: cell.x, z: cell.z };

    const links = linksOnStamp(stamp.stampId);
    if (selectedLinkId && !links.some((link) => link.id === selectedLinkId)) {
        selectedLinkId = null;
        clearCableHighlight();
        setUnplugCableTarget(null);
    }

    const wifi = getWifiSnapshot();
    const wifiEntries = wirelessEntriesForStamp(stamp, wifi);
    if (
        selectedWifi &&
        !wifiEntries.some(
            (entry) =>
                entry.sourceStampId === selectedWifi.sourceStampId &&
                entry.clientStampId === selectedWifi.clientStampId
        )
    ) {
        setWifiSelection(null);
    }

    const deviceName = getStampLabel(stamp);
    const partDef = getPartDef(stamp.partId);
    const maxCables = maxCablesForPart(partDef);
    nameEl.textContent = deviceName;
    paintTile(getNetworkHudPartIcon(stamp.partId));
    paintCountLine(stamp, links, maxCables, wifi);
    paintStatusBadge(links.length, wifiEntries.length);
    paintRemoveSlot(stamp);
    paintConnectionsFooter(links.length, wifiEntries.length);
    paintWiredStrip(stamp, links, maxCables);
    paintWirelessStrip(stamp, wifiEntries);

    const closed = trayIsClosed();
    const showTray = (links.length > 0 || wifiEntries.length > 0) && !closed;
    if (trayEl) {
        trayEl.hidden = !showTray;
        trayEl.classList.toggle('hidden', !showTray);
    }
    stackEl.classList.toggle('is-folded', closed);
    stackEl.classList.toggle('has-selection', Boolean(selectedLinkId || selectedWifi));
    stackEl.classList.toggle('is-empty', links.length === 0 && wifiEntries.length === 0);
    panelEl.setAttribute('aria-label', `${deviceName} connections`);
    setStackHidden(false);

    if (selectedLinkId) {
        setUnplugCableTarget(selectedLinkId);
    } else {
        setUnplugCableTarget(null);
    }

    console.log(
        `[partCellInspector.js]: [N/A] - [renderPanel] - cell has a value of ${cell.x},${cell.z}, stampId has a value of ${stamp.stampId}, linkCount has a value of ${links.length}, wifiCount has a value of ${wifiEntries.length}, maxCables has a value of ${maxCables}.`
    ); //This is logged when the cell inspector card is shown or refreshed.
}

function buildPanelShell() {
    const frame = getPlayerFrame();
    if (!frame) {
        console.warn(
            `[partCellInspector.js]: [N/A] - [buildPanelShell] - playerFrameMissing has a value of true.`
        ); //This is logged when #uiContainer is missing so the inspector cannot mount.
        return;
    }

    stackEl = document.createElement('div');
    stackEl.className = 'sim-network-inspector-stack hidden';
    stackEl.hidden = true;

    panelEl = document.createElement('section');
    panelEl.className =
        'sim-network-inspector rounded-box border border-base-content/10 shadow-lg text-base-content';
    panelEl.setAttribute('role', 'region');
    panelEl.setAttribute('aria-label', 'Device connections');

    deviceEl = document.createElement('div');
    deviceEl.className = 'sim-network-inspector__device';
    deviceEl.setAttribute('role', 'group');
    deviceEl.setAttribute('aria-label', 'Device');

    tileEl = document.createElement('span');
    tileEl.className = 'sim-network-inspector__tile bg-base-200';
    tileEl.setAttribute('aria-hidden', 'true');

    const identity = document.createElement('div');
    identity.className = 'sim-network-inspector__identity';
    const nameRow = document.createElement('span');
    nameRow.className = 'sim-network-inspector__name-row';
    nameEl = document.createElement('span');
    nameEl.className = 'sim-network-inspector__name';
    nameRow.append(nameEl);
    countEl = document.createElement('span');
    countEl.className = 'sim-network-inspector__count';
    identity.append(nameRow, countEl);
    deviceEl.append(tileEl, identity);

    connectionsDividerEl = document.createElement('div');
    connectionsDividerEl.className = 'sim-network-inspector__header-divider hidden';
    connectionsDividerEl.hidden = true;
    connectionsDividerEl.setAttribute('aria-hidden', 'true');

    connectionsMetaEl = document.createElement('div');
    connectionsMetaEl.className = 'sim-network-inspector__connections-meta hidden';
    connectionsMetaEl.hidden = true;
    connectionsLabelEl = document.createElement('span');
    connectionsLabelEl.className = 'sim-network-inspector__connections-label';
    connectionsLabelEl.textContent = 'Connections';
    statusBadgeEl = document.createElement('span');
    statusBadgeEl.className =
        'badge badge-neutral badge-sm sim-network-inspector__status-badge hidden';
    statusBadgeEl.hidden = true;
    statusBadgeEl.setAttribute('role', 'img');
    connectionsMetaEl.append(connectionsLabelEl, statusBadgeEl);

    connectionsToggleBtn = document.createElement('button');
    connectionsToggleBtn.type = 'button';
    connectionsToggleBtn.id = 'sim-network-inspector-connections';
    connectionsToggleBtn.className =
        'btn btn-square btn-sm sim-network-inspector__connections-toggle hidden';
    connectionsToggleBtn.hidden = true;
    connectionsToggleBtn.setAttribute('aria-controls', 'sim-network-inspector-tray');
    connectionsToggleBtn.addEventListener('click', () => {
        ensureFoldPreference();
        foldPreference = foldPreference !== true;
        clearConnectionSelections();
        console.log(
            `[partCellInspector.js]: [N/A] - [connectionsToggle] - foldPreference has a value of ${foldPreference}.`
        ); //This is logged when the player opens or closes the Connections tray.
        if (inspectedCell) {
            renderPanel(inspectedCell);
        }
    });

    panelEl.append(
        deviceEl,
        connectionsDividerEl,
        connectionsMetaEl,
        connectionsToggleBtn
    );

    trayEl = document.createElement('section');
    trayEl.id = 'sim-network-inspector-tray';
    trayEl.className =
        'sim-network-inspector-tray hidden rounded-box border border-base-content/10 shadow-lg text-base-content';
    trayEl.hidden = true;
    trayEl.setAttribute('role', 'region');
    trayEl.setAttribute('aria-label', 'Connection strips');

    wiredStripEl = document.createElement('div');
    wiredStripEl.className = 'sim-network-inspector__strip sim-network-inspector__strip--wired';
    wirelessStripEl = document.createElement('div');
    wirelessStripEl.className = 'sim-network-inspector__strip sim-network-inspector__strip--wireless';
    trayEl.append(wiredStripEl, wirelessStripEl);

    stackEl.append(panelEl, trayEl);
    frame.appendChild(stackEl);
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
function attachPointerObserver(scene) {
    const host = getHost();
    pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
        const type = pointerInfo.type;

        if (type === host.PointerEventTypes.POINTERDOWN) {
            pointerDownInfo = {
                x: scene.pointerX,
                y: scene.pointerY,
                toolActiveAtDown: isDroppableToolActive() || isCableModeActive(),
            };
            return;
        }

        if (type !== host.PointerEventTypes.POINTERUP || !pointerDownInfo) {
            return;
        }

        const dx = scene.pointerX - pointerDownInfo.x;
        const dy = scene.pointerY - pointerDownInfo.y;
        const toolActiveAtDown = pointerDownInfo.toolActiveAtDown;
        pointerDownInfo = null;
        if (Math.hypot(dx, dy) > SELECT_CLICK_SLOP_PX) {
            return;
        }
        if (isDroppableToolActive()) {
            return;
        }

        const cell = pickCellAtPointer(scene.pointerX, scene.pointerY);
        if (!cell) {
            return;
        }

        const toolsOff =
            !toolActiveAtDown &&
            !isDroppableToolActive() &&
            !isCableModeActive();
        if (toolsOff && !isSimNetworkCameraLocked()) {
            const nowMs = performance.now();
            const isDoubleClick =
                pendingFocusClick &&
                pendingFocusClick.x === cell.x &&
                pendingFocusClick.z === cell.z &&
                nowMs - pendingFocusClick.atMs <= FOCUS_DOUBLE_CLICK_MS;
            if (isDoubleClick) {
                pendingFocusClick = null;
                const focusStamp = getInteractableStampsAtCell(cell.x, cell.z)[0] || null;
                // Device yaw is fallback only; partCamera prefers layer-2 wall → into-room.
                const faceYawRadians =
                    typeof focusStamp?.wrap?.rotation?.y === 'number'
                        ? focusStamp.wrap.rotation.y
                        : null;
                focusSimNetworkCell(cell, { faceYawRadians });
                notifyTutorialAction({
                    type: 'cellDoubleClick',
                    x: cell.x,
                    z: cell.z,
                });
                console.log(
                    `[partCellInspector.js]: [N/A] - [attachPointerObserver] - doubleClickFocusCell has a value of ${cell.x},${cell.z}, fallbackFaceYawRadians has a value of ${faceYawRadians ?? 'null'}, partId has a value of ${focusStamp?.partId ?? 'none'}.`
                ); //This is logged when a same-cell double-click moves the camera look-at.
            } else {
                pendingFocusClick = { x: cell.x, z: cell.z, atMs: nowMs };
            }
        } else {
            pendingFocusClick = null;
        }

        const interactableStamps = getInteractableStampsAtCell(cell.x, cell.z);
        if (interactableStamps.length === 0) {
            if (inspectedCell) {
                hidePanel();
            }
            return;
        }
        if (isNetworkTestUiBusy() || areNetworkEditsLocked()) {
            if (inspectedCell) {
                hidePanel();
            }
            console.log(
                `[partCellInspector.js]: [N/A] - [attachPointerObserver] - openBlocked has a value of true, testBusy has a value of ${isNetworkTestUiBusy()}, editsLocked has a value of ${areNetworkEditsLocked()}.`
            ); //This is logged when a device click is ignored because the results HUD is up or editing is locked.
            return;
        }
        if (
            stackEl &&
            !stackEl.hidden &&
            inspectedCell &&
            inspectedCell.x === cell.x &&
            inspectedCell.z === cell.z
        ) {
            console.log(
                `[partCellInspector.js]: [N/A] - [attachPointerObserver] - skippedRebuildForCell has a value of ${cell.x},${cell.z}.`
            ); //This is logged when the player re-clicks a cell that is already open in the inspector.
            return;
        }

        clearConnectionSelections();
        renderPanel(cell);
    });
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export function initializePartCellInspector(scene) {
    disposePartCellInspector();
    boundScene = scene;
    buildPanelShell();
    if (!stackEl) {
        return;
    }

    networkEditsLockListener = () => {
        if (areNetworkEditsLocked()) {
            hidePanel();
        }
    };
    window.addEventListener('sim-network-network-edits-lock', networkEditsLockListener);

    cablesChangedListener = () => {
        if (inspectedCell && stackEl && !stackEl.hidden) {
            renderPanel(inspectedCell);
        }
    };
    window.addEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);

    networkTestUiListener = () => {
        if (isNetworkTestUiBusy()) {
            hidePanel();
        }
    };
    window.addEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);

    foldLayoutQuery = window.matchMedia(FOLD_LAYOUT_QUERY);
    foldLayoutListener = () => {
        if (inspectedCell && stackEl && !stackEl.hidden) {
            renderPanel(inspectedCell);
        }
    };
    foldLayoutQuery.addEventListener('change', foldLayoutListener);

    attachPointerObserver(scene);
    console.log(
        `[partCellInspector.js]: [N/A] - [initializePartCellInspector] - panelMounted has a value of true.`
    ); //This is logged when the cell inspector card is ready.
}

/**
 * Tear down inspector UI and pointer observer.
 */
export function disposePartCellInspector() {
    if (networkEditsLockListener) {
        window.removeEventListener('sim-network-network-edits-lock', networkEditsLockListener);
        networkEditsLockListener = null;
    }
    if (cablesChangedListener) {
        window.removeEventListener(CABLES_CHANGED_EVENT, cablesChangedListener);
        cablesChangedListener = null;
    }
    if (networkTestUiListener) {
        window.removeEventListener(NETWORK_TEST_UI_CHANGED_EVENT, networkTestUiListener);
        networkTestUiListener = null;
    }
    if (foldLayoutQuery && foldLayoutListener) {
        foldLayoutQuery.removeEventListener('change', foldLayoutListener);
    }
    foldLayoutQuery = null;
    foldLayoutListener = null;
    clearConnectionSelections();
    if (boundScene && pointerObserver) {
        boundScene.onPointerObservable.remove(pointerObserver);
    }
    pointerObserver = null;
    pointerDownInfo = null;
    pendingFocusClick = null;
    inspectedCell = null;
    selectedLinkId = null;
    selectedWifi = null;
    foldPreference = null;
    stackEl?.remove();
    stackEl = null;
    panelEl = null;
    deviceEl = null;
    tileEl = null;
    nameEl = null;
    statusBadgeEl = null;
    countEl = null;
    connectionsDividerEl = null;
    connectionsMetaEl = null;
    connectionsLabelEl = null;
    connectionsToggleBtn = null;
    trayEl = null;
    wiredStripEl = null;
    wirelessStripEl = null;
    boundScene = null;
}

/**
 * Sim-network WiFi tunables — one place for every WiFi number (design.md / ui-spec.md tokens).
 */

/** Default disc radius in metres (= cells). Parts may override with kit `wifiRange`. */
export const WIFI_RANGE_M = 5;
/** Disc fill when its source is not selected. */
export const WIFI_DISC_ALPHA_BASE = 0.1;
/** Disc fill when its source is selected (stronger than base so selection reads in isometric view). */
export const WIFI_DISC_ALPHA_SELECTED = 0.2;
/**
 * Safety cap for dashes per lane (count is auto: ceil(pathLength / spacing)).
 * Prevents a huge mesh pool on an unusually long link.
 */
export const WIFI_LINK_DASHES_PER_LANE_MAX = 48;
/** WiFi link dash speed, in cells per second (was 1.40625; −50% → 0.703125). */
export const WIFI_LINK_SPEED = 0.703125;
/**
 * Target metres between successive dash centres along the path.
 * Per-lane count = ceil(pathLength / this); actual step = pathLength / count (≤ this).
 * Halved again so dash count roughly doubles once more.
 */
export const WIFI_LINK_DASH_SPACING_M = 0.333984375;
/**
 * Sideways offset from the centre path for each duplex lane (metres).
 * ±0.05 m either side — lanes closer together than the prior ±0.1 m.
 */
export const WIFI_LINK_LANE_OFFSET_M = 0.05;
/** Test animation loop length, in seconds. */
export const WIFI_TEST_LOOP_S = 3;
/**
 * Disc ripple phase inside each test loop (0–1 of WIFI_TEST_LOOP_S).
 * Board 30: cables first, then ripples expand across online discs.
 */
export const WIFI_TEST_RIPPLE_START_T = 0.45;
export const WIFI_TEST_RIPPLE_END_T = 0.9;
/** Stagger between online discs as a fraction of the ripple window. */
export const WIFI_TEST_RIPPLE_STAGGER_T = 0.08;
/** Soft fill wash during the ripple (orange disc expand). */
export const WIFI_TEST_RIPPLE_FILL_COLOR_HEX = '#fb923c';
export const WIFI_TEST_RIPPLE_FILL_ALPHA = 0.18;
/** Expanding ring stroke (board 30 orange). */
export const WIFI_TEST_RIPPLE_RING_COLOR_HEX = '#f97316';
export const WIFI_TEST_RIPPLE_RING_ALPHA = 0.7;
/** Ring tube thickness in metres (world), before scale. */
export const WIFI_TEST_RIPPLE_RING_THICKNESS = 0.05;
/** Ripple meshes sit just above the static coverage discs. */
export const WIFI_TEST_RIPPLE_Y = 0.008;
/** Floor height for the animated WiFi link (above discs, below devices). */
export const WIFI_LINK_Y = 0.02;
/** Draw WiFi dashes after furniture (same idea as selected-cable x-ray). */
export const WIFI_LINK_RENDER_GROUP = 1;
/** Lighter orange for WiFi link dashes + glow (was `#f97316`). */
export const WIFI_LINK_COLOR_HEX = '#fdba74';
/** Soft orange under-glow (same lighter orange as the dash body). */
export const WIFI_LINK_EDGE_COLOR_HEX = '#fdba74';
/** Soft glow halo alpha under each dash (was 0.38; −50% → 0.19). */
export const WIFI_LINK_GLOW_ALPHA = 0.19;
/** Glow halo size vs dash body (width / height / length multipliers). */
export const WIFI_LINK_GLOW_WIDTH_MUL = 4.2;
export const WIFI_LINK_GLOW_HEIGHT_MUL = 0.85;
export const WIFI_LINK_GLOW_LENGTH_MUL = 1.7;
/** Dash body size (metres); −50% from prior length/width/height. */
export const WIFI_LINK_DASH_LENGTH = 0.1125;
export const WIFI_LINK_DASH_WIDTH = 0.00984375;
export const WIFI_LINK_DASH_HEIGHT = 0.009;
/** Device mesh overlay when a Wireless chip is selected (`#fcb98a`). */
export const WIFI_OVERLAY_RGB = { r: 0.988, g: 0.725, b: 0.541 };
export const WIFI_OVERLAY_ALPHA = 0.4;

/** Disc fill colour (orange #fb923c). */
export const WIFI_DISC_COLOR_HEX = '#fb923c';
/** Online source edge ring (white, faint). */
export const WIFI_RING_COLOR_HEX = '#ffffff';
export const WIFI_RING_ALPHA = 0.45;
/** Offline source ring (no internet, or repeater out of range); no fill. */
export const WIFI_OFFLINE_RING_COLOR_HEX = '#e2e8f0';
export const WIFI_OFFLINE_RING_ALPHA = 0.95;
/** Disc height: above the floor (0), under cell outlines (0.01) and cables (0.05). */
export const WIFI_DISC_Y = 0.006;
/** Ring sits a hair above its disc. */
export const WIFI_RING_Y = 0.007;
/** Disc / ring smoothness (number of sides). */
export const WIFI_DISC_TESSELLATION = 96;
/** Dashes around one edge ring. */
export const WIFI_RING_DASHES = 60;

/** Scene device badge (dark pill beside floating status GLB) — ui-spec tokens. */
export const DEVICE_BADGE_BG_HEX = '#111827d9';
export const DEVICE_BADGE_TEXT_HEX = '#ffffff';
export const DEVICE_BADGE_ICON_COLOR = '#ffffff';
/** World Y for the pill (same band as status icons). */
export const DEVICE_BADGE_Y = 1.5;
/**
 * Pill scale vs zoom HUD % (closest = 100%, farthest = 0%).
 * scale = ((1 − hudZoom) × 1) + 1 (100% → 1×, 50% → 1.5×, 0% → 2×). Smooth, no step.
 */
export const DEVICE_BADGE_ZOOM_SCALE_MIN = 1.0;
export const DEVICE_BADGE_ZOOM_SCALE_MAX = 2.0;
/** Horizontal offset from cell centre (0 = centred under the floating status GLB). */
export const DEVICE_BADGE_OFFSET_X = 0;
export const DEVICE_BADGE_PLANE_HEIGHT_M = 0.28;
export const DEVICE_BADGE_FONT_SIZE_PX = 72;
export const DEVICE_BADGE_ICON_SIZE_PX = 80;
export const DEVICE_BADGE_SEGMENT_GAP_PX = 10;
export const DEVICE_BADGE_PADDING_H_PX = 28;
/** Extra vertical pad so icon slots (with inset) breathe inside the dark pill. */
export const DEVICE_BADGE_PADDING_V_PX = 24;
export const DEVICE_BADGE_CORNER_RADIUS_PX = 48;

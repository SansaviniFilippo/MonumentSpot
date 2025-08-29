// Centralized DOM element references
export const appEl = document.getElementById('app');
export const videoEl = document.getElementById('camera');
export const canvasEl = document.getElementById('overlay');
export const hudEl = document.getElementById('hud');
export const startBtn = document.getElementById('startBtn');
export const statusEl = document.getElementById('status');
export const infoEl = document.getElementById('info');
export const hintEl = document.getElementById('hint');
export const hotspotsEl = document.getElementById('hotspots');
export const detailEl = document.getElementById('detail');
export const detailTitleEl = document.getElementById('detailTitle');
// Legacy meta element (no longer used but kept for compatibility)
export const detailMetaEl = document.getElementById('detailMeta');
export const detailBodyEl = document.getElementById('detailBody');
// New structured detail fields
export const detailArtistEl = document.getElementById('detailArtist');
export const detailYearEl = document.getElementById('detailYear');
export const detailMuseumEl = document.getElementById('detailMuseum');
export const detailLocationEl = document.getElementById('detailLocation');
export const closeDetailBtn = document.getElementById('closeDetailBtn');
// Legacy back button (removed in new UI)
export const backBtn = document.getElementById('backBtn');

export function get2DContext() {
  return canvasEl.getContext('2d');
}

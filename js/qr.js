// =====================================================================
//  QR-Code als SVG (lokal erzeugt, Bibliothek: qrcode-generator, MIT)
// =====================================================================

import qrcode from './vendor/qrcode.js';

const SVG = 'http://www.w3.org/2000/svg';

// Liefert ein <svg>-Element. Weißer Rand ("quiet zone") von 4 Modulen,
// damit Handy-Kameras den Code auch auf dunklem Hintergrund erkennen.
export function createQrSvg(text, { label = 'QR-Code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;

  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('qr');

  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

// Spieler-URL aus der aktuellen Adresse ableiten – funktioniert unter
// https://USER.github.io/operation-lan-party/host.html genauso wie lokal.
export function playerUrl(code) {
  const url = new URL('./', window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('game', code);
  return url.toString();
}

export function isLocalhost() {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
}

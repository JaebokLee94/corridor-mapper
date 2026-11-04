import { LATEX_ASSETS } from './latex-assets.mjs';

const cache = new Map();
const MAX_IMAGES = 256;
let repaintPending = false;
const formula = tex => {
  const asset = LATEX_ASSETS[tex];
  if (!asset) throw new RangeError(`Uncompiled LaTeX expression: ${tex}. Run npm run build:latex.`);
  return asset;
};
/** CSS-pixel metrics from the TeX em box; depth is the distance below the alphabetic baseline. */
export function measureTex(tex, size = 14) {
  const asset = formula(tex);
  return { width: asset.width * size, height: asset.height * size, depth: asset.depth * size };
}
/** Fill authored inline labels only. Inputs, option values and computation never pass through this renderer. */
export function renderMath(root = document) {
  const elements = [...(root.matches?.('[data-tex]') ? [root] : []), ...root.querySelectorAll('[data-tex]')];
  for (const node of elements) {
    const tex = node.dataset.tex;
    if (node.dataset.renderedTex === tex) continue;
    const asset = formula(tex);
    const label = node.getAttribute('aria-label') || node.textContent.trim() || tex;
    node.innerHTML = asset.svg;
    node.setAttribute('role', 'img'); node.setAttribute('aria-label', label);
    node.dataset.renderedTex = tex;
    const svg = node.firstElementChild;
    svg.style.width = `${asset.width}em`; svg.style.height = `${asset.height}em`;
    svg.style.verticalAlign = `${-asset.depth}em`;
    svg.style.overflow = 'visible';
  }
}
function scheduleRepaint() {
  if (repaintPending || typeof window === 'undefined' || !window.dispatchEvent) return;
  repaintPending = true;
  const target = window;
  setTimeout(() => { repaintPending = false; target.dispatchEvent(new Event('resize')); }, 0);
}
function canvasImage(tex, color) {
  const asset = formula(tex), key = `${color}\n${tex}`;
  let entry = cache.get(key);
  if (entry) return entry;
  // Node numerical/renderer tests do not provide a browser Image implementation.
  if (typeof Image === 'undefined') return null;
  if (cache.size >= MAX_IMAGES) {
    const oldest = [...cache].find(([, value]) => value.ready)?.[0] ?? cache.keys().next().value;
    cache.delete(oldest);
  }
  const image = new Image();
  entry = { image, ready: false, error: null, promise: null };
  entry.promise = new Promise((resolve, reject) => {
    image.onload = () => { entry.ready = true; resolve(); scheduleRepaint(); };
    image.onerror = () => { entry.error = new Error(`Could not load LaTeX SVG: ${tex}`); reject(entry.error); };
  });
  // Keep first-frame asynchronous failures observable without an unhandled rejection.
  entry.promise.catch(error => console.error(error));
  cache.set(key, entry);
  const safeColor = String(color).replace(/[<>"&]/g, '');
  const svg = asset.svg.replace('<svg ', `<svg width="${asset.width * 64}" height="${asset.height * 64}" color="${safeColor}" `);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return entry;
}
/** Draw the same TeX SVG used in DOM labels; x/y and size are CSS pixels, y is the baseline.
 * O(1) per cached expression. At most 256 colour/formula images are retained across theme switches.
 */
export function drawTex(ctx, tex, x, y, { size = 14, align = 'left', color } = {}) {
  const metrics = measureTex(tex, size), image = canvasImage(tex, color || ctx.fillStyle || '#000000');
  if (image?.error) throw image.error;
  if (image?.ready) {
    const left = align === 'center' ? x - metrics.width / 2 : align === 'right' ? x - metrics.width : x;
    ctx.drawImage(image.image, left, y - metrics.height + metrics.depth, metrics.width, metrics.height);
  }
  return metrics.width;
}
/** Warm the two text colours before PNG export, then wait for all queued SVGs.
 * Preloading formulas prevents an export-only title from missing on its first draw.
 */
export async function prepareCanvasMath(colors) {
  if (typeof Image === 'undefined') return;
  if (!colors) {
    const css = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement) : null;
    colors = ['--color-ink', '--color-ink-muted'].map(name => css?.getPropertyValue(name).trim() || '#000000');
  }
  for (const color of new Set(colors)) for (const tex of Object.keys(LATEX_ASSETS)) canvasImage(tex, color);
  await Promise.all([...cache.values()].map(entry => entry.promise));
}

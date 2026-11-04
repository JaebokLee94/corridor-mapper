import { renderMath } from './latex.mjs';

// Static TeX fragments used alongside changing measured values. The numbers remain
// plain text so hover updates do not invoke a TeX engine or alter numerical data.
export const DOM_TEX = [String.raw`D`, String.raw`A`, String.raw`Q`, String.raw`\bar{D}`,
  String.raw`\hat{\beta}`, String.raw`\mathrm{m}^{-2}`, String.raw`n`, String.raw`\pm`];

export function setMathText(element, parts) {
  element.replaceChildren(...parts.map(part => {
    if (typeof part === 'string') return document.createTextNode(part);
    const span = document.createElement('span');
    span.dataset.tex = part.tex;
    return span;
  }));
  renderMath(element);
}

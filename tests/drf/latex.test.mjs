import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileTex } from '../../build-latex.mjs';
import { LATEX_ASSETS } from '../../drf/latex-assets.mjs';
import { measureTex, drawTex, prepareCanvasMath } from '../../drf/latex.mjs';

const raw = String.raw;
test('LaTeX fractions, accents and scripts compile to self-contained vector glyphs', () => {
  const fraction = compileTex(raw`\frac{D}{\max(Q,1)}`);
  assert.match(fraction.svg, /data-mml-node="mfrac"/);
  assert.match(fraction.svg, /<rect[^>]*width="[1-9][^"]*"[^>]*height="[1-9][^"]*"/,
    'The fraction rule retains the MathJax rectangle dimensions');
  const plain = compileTex('D'), accented = compileTex(raw`\bar{D}`), scripted = compileTex(raw`Q_t`);
  assert.ok(accented.height > plain.height, 'The accent must have actual space above the base glyph');
  assert.ok(scripted.depth > 0, 'A subscript extends below the baseline');
  assert.match(scripted.svg, /data-mml-node="msub"/);
  assert.throws(() => compileTex(raw`\notAnAuthoredCommand{D}`), /Undefined control sequence/);
  for (const asset of [fraction, ...Object.values(LATEX_ASSETS)]) {
    assert.match(asset.svg, /<path\b/);
    assert.doesNotMatch(asset.svg, /<(?:text|image|use)\b|(?:href|src)=/,
      'Formulas must not depend on system fonts, another formula, or a network URL');
    assert.ok(asset.width > 0 && asset.height > 0 && asset.depth >= 0);
  }
});

test('the compiled formula inventory matches authored HTML and renderer registries', async () => {
  const html = await readFile(new URL('../../drf.html', import.meta.url), 'utf8');
  const authored = [...html.matchAll(/data-tex="([^"]*)"/g)].map(match => match[1]);
  for (const tex of authored) assert.ok(LATEX_ASSETS[tex], tex);
  const { CANVAS_TEX } = await import('../../drf/render-math.mjs');
  const { DOM_TEX } = await import('../../drf/dom-math.mjs');
  for (const tex of [...CANVAS_TEX, ...DOM_TEX]) assert.ok(LATEX_ASSETS[tex], tex);
  for (const [tex, asset] of Object.entries(LATEX_ASSETS)) assert.deepEqual(compileTex(tex), asset,
    `Recompilation must reproduce the committed paths and bounds: ${tex}`);
  assert.throws(() => measureTex(raw`\uncompiled`), /Uncompiled LaTeX expression/);
});

test('canvas uses loaded SVGs at the requested baseline and preserves export colour', async () => {
  const previousImage = globalThis.Image, sources = [], calls = [];
  globalThis.Image = class {
    set src(value) { sources.push(value); queueMicrotask(() => this.onload()); }
  };
  try {
    const tex = raw`Q_t`, ctx = { fillStyle: '#123456', drawImage: (...args) => calls.push(args) };
    const box = measureTex(tex, 20);
    drawTex(ctx, tex, 80, 40, { size: 20, align: 'center' });
    assert.equal(calls.length, 0, 'An unloaded image must not be drawn');
    await prepareCanvasMath(['#123456']);
    drawTex(ctx, tex, 80, 40, { size: 20, align: 'center' });
    assert.deepEqual(calls[0].slice(1), [80 - box.width / 2, 40 - box.height + box.depth, box.width, box.height]);
    const svg = decodeURIComponent(sources[0].split(',')[1]);
    assert.match(svg, /color="#123456"/);
    assert.equal((svg.match(/^<svg[^>]*\bwidth=/g) ?? []).length, 1);
    assert.doesNotMatch(svg, /<rect[^>]*fill="white"/, 'Math images preserve transparency');
  } finally { globalThis.Image = previousImage; }
});

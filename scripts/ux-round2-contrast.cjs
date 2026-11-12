"use strict";

// Rendered contrast for the UX round 2 Chromium leg (B6, PWA-08).
// Colours come from the computed style; backgrounds come from rendered pixels.
// The page is screenshotted once with text and focus rings made transparent,
// so every sampled pixel shows what lies behind the text or the ring.

const TEXT_RATIO = 4.5;
const FOCUS_RING_RATIO = 3;
const HIDE_FOREGROUND = `*, *::before, *::after {
  color: transparent !important; -webkit-text-fill-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; outline-color: transparent !important;
}`;

// Runs in the page. The page's CSP refuses inline style elements, so the
// rule is adopted as a constructed stylesheet, which CSP does not govern.
function hideForeground(rule) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(rule);
  window.uxRound2ContrastSheet = sheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function showForeground() {
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== window.uxRound2ContrastSheet);
}

// Runs in the page. Lists visible text and focusable controls that a hit test
// at their centre reaches, with the colours to check and the boxes to sample.
// A text box is the box of its own glyph lines, not of the whole element.
// A control that is visually hidden, like the auto-start checkbox, shows its
// focus on the next sibling, so that sibling is measured instead.
function collectTargets() {
  const describe = (element) => element.id ? `#${element.id}`
    : `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${element.textContent.trim().slice(0, 24)}"`;
  const reached = (element) => {
    const box = element?.getBoundingClientRect();
    if (!box || box.width < 1 || box.height < 1 || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit && (element.contains(hit) || hit.contains(element)) ? box : null;
  };
  const inactive = (element) => element.closest(":disabled, [aria-disabled='true'], [inert]") !== null;
  const plain = (box) => ({ left: box.left, top: box.top, width: box.width, height: box.height });
  const glyphBox = (nodes) => {
    const range = document.createRange();
    const lines = nodes.flatMap((node) => { range.selectNodeContents(node); return [...range.getClientRects()]; });
    const left = Math.min(...lines.map((line) => line.left));
    const top = Math.min(...lines.map((line) => line.top));
    return { left, top, width: Math.max(...lines.map((line) => line.right)) - left,
      height: Math.max(...lines.map((line) => line.bottom)) - top };
  };
  const texts = [];
  for (const element of document.body.querySelectorAll("*")) {
    const nodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (nodes.length === 0 || inactive(element) || !reached(element)) continue;
    texts.push({ target: describe(element), color: getComputedStyle(element).color, box: glyphBox(nodes) });
  }
  const rings = [];
  for (const element of document.body.querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")) {
    if (inactive(element)) continue;
    element.focus({ preventScroll: true });
    // The reduced-motion rule gives every property a short transition, so
    // the focused style is read only after the transitions are finished.
    for (const animation of document.getAnimations()) animation.finish();
    const indicator = reached(element) ? element : element.nextElementSibling;
    const box = reached(indicator);
    if (!box) { element.blur(); continue; }
    const style = getComputedStyle(indicator);
    rings.push({ target: describe(element), visible: element.matches(":focus-visible"), style: style.outlineStyle,
      color: style.outlineColor, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
      insetRings: style.boxShadow.split(/,(?![^(]*\))/).filter((shadow) => /\binset\b/.test(shadow))
        .map((shadow) => shadow.match(/rgba?\([^)]*\)/)?.[0]).filter(Boolean),
      box: plain(box) });
    element.blur();
  }
  return { texts, rings };
}

// Runs in the page. Decodes the screenshot and returns, for each box, the most
// common rendered colour. A ring box is the band the outline paints.
async function sampleBackgrounds({ image, boxes }) {
  const picture = new Image();
  picture.src = `data:image/png;base64,${image}`;
  await picture.decode();
  const canvas = new OffscreenCanvas(picture.width, picture.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(picture, 0, 0);
  const scale = picture.width / window.innerWidth;
  return boxes.map(({ outer, inner }) => {
    const left = Math.max(0, Math.floor(outer.left * scale));
    const top = Math.max(0, Math.floor(outer.top * scale));
    const width = Math.min(picture.width - left, Math.ceil(outer.width * scale));
    const height = Math.min(picture.height - top, Math.ceil(outer.height * scale));
    if (width < 1 || height < 1) return null;
    const pixels = context.getImageData(left, top, width, height).data;
    const counts = new Map();
    for (let index = 0; index < pixels.length; index += 4) {
      const x = left + (index / 4) % width;
      const y = top + Math.floor(index / 4 / width);
      if (inner && x >= inner.left * scale && x < (inner.left + inner.width) * scale
        && y >= inner.top * scale && y < (inner.top + inner.height) * scale) continue;
      const key = (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const [key] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || [];
    return key === undefined ? null : [(key >> 16) & 255, (key >> 8) & 255, key & 255];
  });
}

function parseColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const [red, green, blue, alpha = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { rgb: [red, green, blue], alpha };
}

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// A translucent foreground is composited over the rendered background first.
function contrastRatio(foreground, background) {
  const shown = foreground.rgb.map((channel, index) =>
    channel * foreground.alpha + background[index] * (1 - foreground.alpha));
  const [high, low] = [luminance(shown), luminance(background)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

function hex(rgb) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function grow(box, by) {
  return { left: box.left - by, top: box.top - by, width: box.width + 2 * by, height: box.height + 2 * by };
}

// An outline is checked against the band it paints. A control that draws its
// focus as inset rings instead (R50-S02, clipped timer actions) is checked
// against its own fill, inside the rings.
function ringBand(ring) {
  if (outlineShown(ring)) return { outer: grow(ring.box, ring.offset + ring.width), inner: grow(ring.box, ring.offset) };
  return { outer: grow(ring.box, -8), inner: null };
}

function outlineShown(ring) {
  const color = parseColor(ring.color);
  return ring.style !== "none" && ring.width > 0 && color !== null && color.alpha > 0;
}

function textFinding(text, background) {
  const color = parseColor(text.color);
  if (!color || color.alpha === 0 || !background) return null;
  const ratio = contrastRatio(color, background);
  return ratio >= TEXT_RATIO ? null
    : `text ${text.target}: ${hex(color.rgb)} on ${hex(background)} is ${ratio.toFixed(2)}:1, needs ${TEXT_RATIO}:1`;
}

// Of two inset rings, the one that stands out from the fill is the indicator.
function ringFinding(ring, background) {
  if (!ring.visible) return null;
  const colors = (outlineShown(ring) ? [ring.color] : ring.insetRings).map(parseColor).filter((color) => color?.alpha > 0);
  if (colors.length === 0) return `focus ${ring.target}: no visible focus ring`;
  if (!background) return null;
  const [best, ratio] = colors.map((color) => [color, contrastRatio(color, background)])
    .sort((left, right) => right[1] - left[1])[0];
  return ratio >= FOCUS_RING_RATIO ? null
    : `focus ${ring.target}: ${hex(best.rgb)} on ${hex(background)} is ${ratio.toFixed(2)}:1, needs ${FOCUS_RING_RATIO}:1`;
}

// Makes the whole page one viewport tall, so every box measured in the page
// is a box in the screenshot, then lists every contrast shortfall.
async function contrastFindings(page) {
  const size = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height });
  // The dock and the layout observers answer the new size on later frames.
  await page.evaluate(() => new Promise((resolve) => {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)));
  }));
  await page.keyboard.press("Shift");
  const { texts, rings } = await page.evaluate(collectTargets);
  await page.evaluate(hideForeground, HIDE_FOREGROUND);
  const image = (await page.screenshot({ animations: "disabled" })).toString("base64");
  await page.evaluate(showForeground);
  const boxes = [...texts.map((text) => ({ outer: text.box, inner: null })), ...rings.map(ringBand)];
  const backgrounds = await page.evaluate(sampleBackgrounds, { image, boxes });
  await page.setViewportSize(size);
  return [
    ...texts.map((text, index) => textFinding(text, backgrounds[index])),
    ...rings.map((ring, index) => ringFinding(ring, backgrounds[texts.length + index])),
  ].filter(Boolean);
}

module.exports = { contrastFindings, contrastRatio, parseColor, TEXT_RATIO, FOCUS_RING_RATIO };

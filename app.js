/* ─────────────────────────────────────────────────────────────
   FoamCut — app.js
   Pipeline:
     1. Load image → OpenCV Mat (with corrections applied)
     2. Detect 5mm backlit grid → pixels-per-mm calibration
     3. Otsu / manual threshold → contours
     4. Filter by area — process ALL valid contours (no overlap skip)
     5. approxPolyDP smoothing
     6. Clipper.js outward offset
     7. SVG generation (2 paths per tool: exact + offset)
     8. Layered debug viewer (original + overlay, independently togglable)
   ───────────────────────────────────────────────────────────── */

'use strict';

// ── State ──────────────────────────────────────────────────────
const state = {
  file: null,
  svgBlob: null,
  loadedImg: null,
  corrections: {
    brightness: 0,   // -100 to +100
    contrast:   0,   // -100 to +100
    rotation:   0,   // degrees
    threshold:  0,   // 0 = Otsu auto, 1-255 = manual
  },
};

// ── DOM refs ───────────────────────────────────────────────────
const dropZone        = document.getElementById('drop-zone');
const fileInput       = document.getElementById('file-input');
const browseBtn       = document.getElementById('browse-btn');
const changeBtn       = document.getElementById('change-btn');
const dropInner       = document.getElementById('drop-inner');
const previewInner    = document.getElementById('preview-inner');
const previewImg      = document.getElementById('preview-img');
const processSection  = document.getElementById('process-section');
const processBtn      = document.getElementById('process-btn');
const btnLabel        = document.getElementById('btn-label');
const btnSpinner      = document.getElementById('btn-spinner');
const resultsSection  = document.getElementById('results-section');
const toolCountLabel  = document.getElementById('tool-count-label');
const downloadSvgBtn  = document.getElementById('download-svg-btn');
const downloadDebugBtn= document.getElementById('download-debug-btn');
const widthInput      = document.getElementById('width-in');
const heightInput     = document.getElementById('height-in');
const offsetInput     = document.getElementById('offset-mm');
const cvCanvas        = document.getElementById('cv-canvas');

// Corrections
const corrBrightness  = document.getElementById('corr-brightness');
const corrContrast    = document.getElementById('corr-contrast');
const corrRotation    = document.getElementById('corr-rotation');
const corrThreshold   = document.getElementById('corr-threshold');
const valBrightness   = document.getElementById('val-brightness');
const valContrast     = document.getElementById('val-contrast');
const valRotation     = document.getElementById('val-rotation');
const valThreshold    = document.getElementById('val-threshold');
const resetCorrections= document.getElementById('reset-corrections');
const correctionCanvas= document.getElementById('correction-canvas');

// Debug viewer
const debugViewer     = document.getElementById('debug-viewer');
const canvasOriginal  = document.getElementById('canvas-original');
const canvasOverlay   = document.getElementById('canvas-overlay');
const toggleOriginal  = document.getElementById('toggle-original');
const toggleOverlay   = document.getElementById('toggle-overlay');

// ── File handling ──────────────────────────────────────────────
function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  state.file = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;

  const img = new Image();
  img.onload = () => {
    state.loadedImg = img;
    renderCorrectionPreview();
  };
  img.src = url;

  dropInner.classList.add('hidden');
  previewInner.classList.remove('hidden');
  processSection.classList.remove('hidden');   // show step 3 with corrections
  updateProcessBtn();
}

browseBtn.addEventListener('click', () => fileInput.click());
changeBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

dropZone.addEventListener('click', (e) => {
  if (e.target === dropZone || e.target.closest('#drop-inner')) fileInput.click();
});
dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  setFile(e.dataTransfer.files[0]);
});

// ── Process button state ───────────────────────────────────────
function updateProcessBtn() {
  processBtn.disabled = !(state.file && processBtn.dataset.cvReady === 'true');
}
window.updateProcessBtn = updateProcessBtn;

// ── Image Corrections ──────────────────────────────────────────
function renderCorrectionPreview() {
  if (!state.loadedImg) return;
  applyCorrectionsToCanvas(state.loadedImg, correctionCanvas, state.corrections);
}

function applyCorrectionsToCanvas(img, dest, corr) {
  const { brightness, contrast, rotation } = corr;
  const rad  = (rotation * Math.PI) / 180;
  const sin  = Math.abs(Math.sin(rad));
  const cos  = Math.abs(Math.cos(rad));
  const rotW = Math.ceil(img.naturalWidth * cos + img.naturalHeight * sin);
  const rotH = Math.ceil(img.naturalWidth * sin + img.naturalHeight * cos);

  const off = document.createElement('canvas');
  off.width  = rotW;
  off.height = rotH;
  const ctx = off.getContext('2d');
  ctx.translate(rotW / 2, rotH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const brightnessVal = 1 + (brightness / 100);
  const contrastVal   = 1 + (contrast   / 100);

  dest.width  = rotW;
  dest.height = rotH;
  const dctx = dest.getContext('2d');
  dctx.filter = `brightness(${brightnessVal}) contrast(${contrastVal})`;
  dctx.drawImage(off, 0, 0);
  dctx.filter = 'none';
}

function bindSlider(input, valEl, fmt, key) {
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    state.corrections[key] = v;
    valEl.textContent = fmt(v);
    renderCorrectionPreview();
  });
}

bindSlider(corrBrightness, valBrightness, v => (v >= 0 ? `+${v}` : `${v}`), 'brightness');
bindSlider(corrContrast,   valContrast,   v => (v >= 0 ? `+${v}` : `${v}`), 'contrast');
bindSlider(corrRotation,   valRotation,   v => `${v}°`,                       'rotation');
bindSlider(corrThreshold,  valThreshold,  v => (v === 0 ? 'Auto' : `${v}`),  'threshold');

resetCorrections.addEventListener('click', () => {
  corrBrightness.value  = 0;
  corrContrast.value    = 0;
  corrRotation.value    = 0;
  corrThreshold.value   = 0;
  valBrightness.textContent = '0';
  valContrast.textContent   = '0';
  valRotation.textContent   = '0°';
  valThreshold.textContent  = 'Auto';
  state.corrections = { brightness: 0, contrast: 0, rotation: 0, threshold: 0 };
  renderCorrectionPreview();
});

// ── Layer toggles ──────────────────────────────────────────────
function setLayerVisible(canvas, btn, visible) {
  canvas.style.opacity = visible ? '1' : '0';
  btn.classList.toggle('active', visible);
}

toggleOriginal.addEventListener('click', () => {
  setLayerVisible(canvasOriginal, toggleOriginal, !toggleOriginal.classList.contains('active'));
});
toggleOverlay.addEventListener('click', () => {
  setLayerVisible(canvasOverlay, toggleOverlay, !toggleOverlay.classList.contains('active'));
});

downloadDebugBtn.addEventListener('click', () => {
  const comp = document.createElement('canvas');
  comp.width  = canvasOriginal.width;
  comp.height = canvasOriginal.height;
  const ctx = comp.getContext('2d');
  if (parseFloat(canvasOriginal.style.opacity || 1) > 0) ctx.drawImage(canvasOriginal, 0, 0);
  if (parseFloat(canvasOverlay.style.opacity  || 1) > 0) ctx.drawImage(canvasOverlay,  0, 0);
  comp.toBlob(blob => downloadBlob(blob, 'foamcut-debug.png'), 'image/png');
});

// ── Main process ───────────────────────────────────────────────
processBtn.addEventListener('click', runPipeline);

async function runPipeline() {
  if (!state.file) return;

  resultsSection.classList.add('hidden');
  debugViewer.classList.add('hidden');
  state.svgBlob = null;

  btnLabel.textContent = 'Processing…';
  btnSpinner.classList.remove('hidden');
  processBtn.disabled = true;

  try {
    await runPipelineInner();
  } catch (err) {
    console.error(err);
    alert(`Processing failed: ${err.message}`);
  } finally {
    btnLabel.textContent = 'Process Image';
    btnSpinner.classList.add('hidden');
    processBtn.disabled = false;
  }
}

async function runPipelineInner() {
  const widthIn  = parseFloat(widthInput.value)  || 20;
  const heightIn = parseFloat(heightInput.value) || 14;
  const offsetMm = parseFloat(offsetInput.value) ?? 2;

  // ── Load image with corrections baked in ──────────────────
  const img = await loadImage(state.file);
  applyCorrectionsToCanvas(img, cvCanvas, state.corrections);
  const src = cv.imread(cvCanvas);

  // ── Grid calibration ───────────────────────────────────────
  const pixPerMm = detectGridScale(src);
  const mmWidth  = widthIn  * 25.4;
  const mmHeight = heightIn * 25.4;
  const pxPerMm  = pixPerMm ?? Math.min(src.cols / mmWidth, src.rows / mmHeight);

  // ── Segmentation ───────────────────────────────────────────
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

  const binary = new cv.Mat();
  const manualThresh = state.corrections.threshold;
  if (manualThresh > 0) {
    cv.threshold(blurred, binary, manualThresh, 255, cv.THRESH_BINARY_INV);
  } else {
    cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  }

  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // Keep all contours in a reasonable size range — no overlap skipping
  const minAreaPx = 100 * pxPerMm * pxPerMm;
  const maxAreaPx = src.cols * src.rows * 0.95;

  const validContours = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minAreaPx && area <= maxAreaPx) {
      validContours.push(c);
    } else {
      c.delete();
    }
  }

  // ── Smooth & build SVG — ALL valid contours processed ─────
  const smoothed = validContours.map(c => smoothContour(c, pxPerMm));

  const svgString = buildSVG({
    tools: smoothed,
    pxPerMm,
    drawerWidthMm:  mmWidth,
    drawerHeightMm: mmHeight,
    offsetMm,
    imgWidth:  src.cols,
    imgHeight: src.rows,
  });
  state.svgBlob = new Blob([svgString], { type: 'image/svg+xml' });

  // ── Debug layers ───────────────────────────────────────────
  renderOriginalLayer(img, canvasOriginal);
  renderOverlayLayer({ src, smoothed, canvas: canvasOverlay });

  // ── Cleanup ────────────────────────────────────────────────
  src.delete(); gray.delete(); blurred.delete(); binary.delete();
  kernel.delete(); closed.delete(); contours.delete(); hierarchy.delete();

  // ── Show results ───────────────────────────────────────────
  const calibNote = pixPerMm
    ? `Grid: ${pixPerMm.toFixed(1)} px/mm`
    : 'Scale: estimated from dimensions';
  toolCountLabel.textContent =
    `${smoothed.length} tool${smoothed.length !== 1 ? 's' : ''} detected · ${calibNote}`;

  setLayerVisible(canvasOriginal, toggleOriginal, true);
  setLayerVisible(canvasOverlay,  toggleOverlay,  true);

  debugViewer.classList.remove('hidden');
  downloadDebugBtn.classList.remove('hidden');
  resultsSection.classList.remove('hidden');

  // Refresh correction preview to reflect what was actually processed
  renderCorrectionPreview();
}

// ── Layer renderers ────────────────────────────────────────────
function renderOriginalLayer(img, canvas) {
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
}

function renderOverlayLayer({ src, smoothed, canvas }) {
  const overlay = new cv.Mat(src.rows, src.cols, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));

  const vec = new cv.MatVector();
  smoothed.forEach(c => vec.push_back(c));
  if (vec.size() > 0) {
    cv.drawContours(overlay, vec, -1, new cv.Scalar(52, 211, 153, 255), 3);
  }

  canvas.width  = src.cols;
  canvas.height = src.rows;
  cv.imshow(canvas, overlay);

  overlay.delete();
  vec.delete();
}

// ── Grid Scale Detection ───────────────────────────────────────
function detectGridScale(src) {
  try {
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const bright = new cv.Mat();
    cv.threshold(gray, bright, 200, 255, cv.THRESH_BINARY);

    const rows = bright.rows, cols = bright.cols;
    const rowSums = [];
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let c = 0; c < cols; c++) s += bright.ucharPtr(r, c)[0];
      rowSums.push(s / 255);
    }
    const colSums = [];
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let r = 0; r < rows; r++) s += bright.ucharPtr(r, c)[0];
      colSums.push(s / 255);
    }
    gray.delete(); bright.delete();

    const h = findDominantSpacing(rowSums, cols * 0.5);
    const v = findDominantSpacing(colSums, rows * 0.5);
    const spacings = [h, v].filter(s => s !== null && s > 5);
    if (!spacings.length) return null;
    return spacings.reduce((a, b) => a + b, 0) / spacings.length / 5;
  } catch { return null; }
}

function findDominantSpacing(sums, threshold) {
  const peaks = [];
  for (let i = 1; i < sums.length - 1; i++) {
    if (sums[i] > threshold && sums[i] >= sums[i-1] && sums[i] >= sums[i+1]) peaks.push(i);
  }
  if (peaks.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < peaks.length; i++) diffs.push(peaks[i] - peaks[i-1]);
  diffs.sort((a, b) => a - b);
  const m = diffs[Math.floor(diffs.length / 2)];
  return m > 3 ? m : null;
}

// ── Contour Smoothing ──────────────────────────────────────────
function smoothContour(contour, pxPerMm) {
  const out = new cv.Mat();
  cv.approxPolyDP(contour, out, 0.8 * pxPerMm, true);
  return out;
}

// ── SVG Generation ─────────────────────────────────────────────
function buildSVG({ tools, pxPerMm, drawerWidthMm, drawerHeightMm, offsetMm, imgWidth, imgHeight }) {
  const scaleX = drawerWidthMm  / imgWidth;
  const scaleY = drawerHeightMm / imgHeight;

  const svgTools = tools.map((contour, idx) => {
    const pts = [];
    for (let i = 0; i < contour.rows; i++) {
      pts.push([contour.data32S[i*2] * scaleX, contour.data32S[i*2+1] * scaleY]);
    }
    return `
  <g id="tool-${idx+1}" class="tool">
    <path class="exact"  d="${pointsToPath(pts)}"                    fill="none" stroke="#1a1a2e" stroke-width="0.3"/>
    <path class="offset" d="${pointsToPath(offsetPolygon(pts, offsetMm))}" fill="none" stroke="#4f7cff" stroke-width="0.3" stroke-dasharray="1 0.5"/>
  </g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- FoamCut SVG — ${new Date().toISOString()} | ${tools.length} tools | offset ${offsetMm}mm -->
<svg xmlns="http://www.w3.org/2000/svg"
     width="${drawerWidthMm.toFixed(2)}mm" height="${drawerHeightMm.toFixed(2)}mm"
     viewBox="0 0 ${drawerWidthMm.toFixed(4)} ${drawerHeightMm.toFixed(4)}">
  <style>.exact{stroke:#1a1a2e}.offset{stroke:#4f7cff}</style>
  <rect x="0" y="0" width="${drawerWidthMm.toFixed(4)}" height="${drawerHeightMm.toFixed(4)}"
        fill="none" stroke="#888" stroke-width="0.5"/>
${svgTools}
</svg>`;
}

function pointsToPath(pts) {
  if (!pts.length) return '';
  return pts.map(([x,y], i) => `${i===0?'M':'L'}${x.toFixed(3)},${y.toFixed(3)}`).join(' ') + ' Z';
}

// ── Polygon Offset (Clipper.js) ────────────────────────────────
function offsetPolygon(points, offsetMm) {
  if (!window.ClipperLib) return points;
  const S = 1000;
  const path = points.map(([x,y]) => ({ X: Math.round(x*S), Y: Math.round(y*S) }));
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, offsetMm * S);
  if (!sol || !sol.length) return points;
  const largest = sol.reduce((a,b) => b.length > a.length ? b : a, sol[0]);
  return largest.map(p => [p.X/S, p.Y/S]);
}

// ── Downloads ──────────────────────────────────────────────────
downloadSvgBtn.addEventListener('click', () => {
  if (state.svgBlob) downloadBlob(state.svgBlob, 'foamcut.svg');
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ────────────────────────────────────────────────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

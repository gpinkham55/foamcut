/* ─────────────────────────────────────────────────────────────
   FoamCut — app.js
   Pipeline:
     1. Load image → OpenCV Mat
     2. Detect 5mm backlit grid → pixels-per-mm calibration
     3. Otsu threshold → contours
     4. Filter noise, flag/skip touching groups
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
  loadedImg: null,        // HTMLImageElement of the uploaded photo
  corrections: {
    brightness: 0,        // -100 to +100
    contrast:   0,        // -100 to +100
    rotation:   0,        // degrees
    threshold:  0,        // 0 = auto (Otsu), 1-255 = manual
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
const processBtn      = document.getElementById('process-btn');
const btnLabel        = document.getElementById('btn-label');
const btnSpinner      = document.getElementById('btn-spinner');
const resultsSection  = document.getElementById('results-section');
const toolCountLabel  = document.getElementById('tool-count-label');
const downloadSvgBtn  = document.getElementById('download-svg-btn');
const downloadDebugBtn= document.getElementById('download-debug-btn');
const warningsArea    = document.getElementById('warnings-area');
const widthInput      = document.getElementById('width-in');
const heightInput     = document.getElementById('height-in');
const offsetInput     = document.getElementById('offset-mm');
const cvCanvas        = document.getElementById('cv-canvas');

// Corrections
const correctionsSection  = document.getElementById('corrections-section');
const corrBrightness      = document.getElementById('corr-brightness');
const corrContrast        = document.getElementById('corr-contrast');
const corrRotation        = document.getElementById('corr-rotation');
const corrThreshold       = document.getElementById('corr-threshold');
const valBrightness       = document.getElementById('val-brightness');
const valContrast         = document.getElementById('val-contrast');
const valRotation         = document.getElementById('val-rotation');
const valThreshold        = document.getElementById('val-threshold');
const resetCorrections    = document.getElementById('reset-corrections');
const correctionCanvas    = document.getElementById('correction-canvas');

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
  correctionsSection.classList.remove('hidden');
  updateProcessBtn();
}

browseBtn.addEventListener('click', () => fileInput.click());
changeBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

dropZone.addEventListener('click', (e) => {
  if (e.target === dropZone || e.target.closest('#drop-inner')) fileInput.click();
});
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  setFile(e.dataTransfer.files[0]);
});

// ── Process button state ───────────────────────────────────────
function updateProcessBtn() {
  const ready = state.file && processBtn.dataset.cvReady === 'true';
  processBtn.disabled = !ready;
}
window.updateProcessBtn = updateProcessBtn;

// ── Layer toggles ──────────────────────────────────────────────
function setLayerVisible(canvas, btn, visible) {
  canvas.style.opacity = visible ? '1' : '0';
  btn.classList.toggle('active', visible);
}

toggleOriginal.addEventListener('click', () => {
  const isActive = toggleOriginal.classList.contains('active');
  setLayerVisible(canvasOriginal, toggleOriginal, !isActive);
});

toggleOverlay.addEventListener('click', () => {
  const isActive = toggleOverlay.classList.contains('active');
  setLayerVisible(canvasOverlay, toggleOverlay, !isActive);
});

// Download PNG — composites both visible layers
downloadDebugBtn.addEventListener('click', () => {
  const composite = document.createElement('canvas');
  composite.width  = canvasOriginal.width;
  composite.height = canvasOriginal.height;
  const ctx = composite.getContext('2d');

  if (parseFloat(canvasOriginal.style.opacity || 1) > 0) {
    ctx.drawImage(canvasOriginal, 0, 0);
  }
  if (parseFloat(canvasOverlay.style.opacity || 1) > 0) {
    ctx.drawImage(canvasOverlay, 0, 0);
  }
  composite.toBlob(blob => downloadBlob(blob, 'foamcut-debug.png'), 'image/png');
});

// ── Image Corrections ──────────────────────────────────────────

function renderCorrectionPreview() {
  if (!state.loadedImg) return;
  applyCorrectionsToCanvas(state.loadedImg, correctionCanvas, state.corrections);
}

// Apply brightness / contrast / rotation to a source image and draw to dest canvas
function applyCorrectionsToCanvas(img, destCanvas, corr) {
  const { brightness, contrast, rotation } = corr;

  // Work on an offscreen canvas so rotation doesn't clip
  const rad    = (rotation * Math.PI) / 180;
  const sin    = Math.abs(Math.sin(rad));
  const cos    = Math.abs(Math.cos(rad));
  const rotW   = Math.ceil(img.naturalWidth * cos + img.naturalHeight * sin);
  const rotH   = Math.ceil(img.naturalWidth * sin + img.naturalHeight * cos);

  const off = document.createElement('canvas');
  off.width  = rotW;
  off.height = rotH;
  const ctx = off.getContext('2d');

  // Rotate around center
  ctx.translate(rotW / 2, rotH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Brightness / contrast via CSS filter on the final canvas
  // contrast(x): x = 1 is normal; map -100..+100 → 0..2
  const contrastVal   = 1 + (contrast / 100);
  // brightness(x): x = 1 is normal; map -100..+100 → 0..2
  const brightnessVal = 1 + (brightness / 100);

  destCanvas.width  = rotW;
  destCanvas.height = rotH;
  const dctx = destCanvas.getContext('2d');
  dctx.filter = `brightness(${brightnessVal}) contrast(${contrastVal})`;
  dctx.drawImage(off, 0, 0);
  dctx.filter = 'none';
}

// Slider wiring
function bindSlider(input, valEl, transform, key) {
  input.addEventListener('input', () => {
    const raw = parseFloat(input.value);
    state.corrections[key] = key === 'threshold' ? raw : raw;
    valEl.textContent = transform(raw);
    renderCorrectionPreview();
  });
}

bindSlider(corrBrightness, valBrightness, v => (v >= 0 ? `+${v}` : `${v}`),  'brightness');
bindSlider(corrContrast,   valContrast,   v => (v >= 0 ? `+${v}` : `${v}`),  'contrast');
bindSlider(corrRotation,   valRotation,   v => `${v}°`,                        'rotation');
bindSlider(corrThreshold,  valThreshold,  v => (v === 0 ? 'Auto' : `${v}`),   'threshold');

resetCorrections.addEventListener('click', () => {
  corrBrightness.value = 0;
  corrContrast.value   = 0;
  corrRotation.value   = 0;
  corrThreshold.value  = 0;
  valBrightness.textContent = '0';
  valContrast.textContent   = '0';
  valRotation.textContent   = '0°';
  valThreshold.textContent  = 'Auto';
  state.corrections = { brightness: 0, contrast: 0, rotation: 0, threshold: 0 };
  renderCorrectionPreview();
});

// ── Main process ───────────────────────────────────────────────
processBtn.addEventListener('click', runPipeline);

async function runPipeline() {
  if (!state.file) return;

  // Reset UI
  resultsSection.classList.add('hidden');
  warningsArea.classList.add('hidden');
  warningsArea.innerHTML = '';
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

  // ── Load image into OpenCV (with corrections applied) ─────
  const img = await loadImage(state.file);
  applyCorrectionsToCanvas(img, cvCanvas, state.corrections);
  const src = cv.imread(cvCanvas);

  // ── Grid calibration ───────────────────────────────────────
  const pixPerMm = detectGridScale(src);

  const mmWidth  = widthIn  * 25.4;
  const mmHeight = heightIn * 25.4;
  const fallbackPxPerMm = Math.min(src.cols / mmWidth, src.rows / mmHeight);
  const pxPerMm = pixPerMm ?? fallbackPxPerMm;

  // ── Segmentation ───────────────────────────────────────────
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

  // Threshold — manual override if set, otherwise Otsu auto
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

  // ── Detect touching / overlapping groups ───────────────────
  const { isolated, touchingGroups } = separateContours(validContours);
  const warnings = touchingGroups.map(group =>
    `Group of ${group.length} overlapping/touching tools skipped — re-photograph with spacing`
  );

  // ── Smooth contours ────────────────────────────────────────
  const smoothed = isolated.map(c => smoothContour(c, pxPerMm));

  // ── Build SVG ─────────────────────────────────────────────
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

  // ── Render debug layers ────────────────────────────────────
  renderOriginalLayer(img, canvasOriginal);
  renderOverlayLayer({
    src,
    isolated,
    touchingContours: touchingGroups.flat(),
    smoothed,
    canvas: canvasOverlay,
  });

  // ── Cleanup ────────────────────────────────────────────────
  src.delete(); gray.delete(); blurred.delete(); binary.delete();
  kernel.delete(); closed.delete(); contours.delete(); hierarchy.delete();

  // ── Show results ───────────────────────────────────────────
  const calibNote = pixPerMm
    ? `Grid: ${pixPerMm.toFixed(1)} px/mm`
    : 'Scale: estimated from dimensions';
  toolCountLabel.textContent =
    `${isolated.length} tool${isolated.length !== 1 ? 's' : ''} detected · ${calibNote}`;

  // Reset layer visibility to active
  setLayerVisible(canvasOriginal, toggleOriginal, true);
  setLayerVisible(canvasOverlay,  toggleOverlay,  true);

  debugViewer.classList.remove('hidden');
  downloadDebugBtn.classList.remove('hidden');
  resultsSection.classList.remove('hidden');

  if (warnings.length > 0) {
    warningsArea.innerHTML = warnings.map(w => `<p>⚠ ${w}</p>`).join('');
    warningsArea.classList.remove('hidden');
  }
}

// ── Layer renderers ────────────────────────────────────────────

// Draw the original photo onto its canvas
function renderOriginalLayer(img, canvas) {
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
}

// Draw only the contour outlines (transparent background) onto overlay canvas
function renderOverlayLayer({ src, isolated, touchingContours, smoothed, canvas }) {
  // Create a transparent RGBA Mat
  const overlay = new cv.Mat(src.rows, src.cols, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));

  // Skipped (touching) — red
  const skippedVec = new cv.MatVector();
  touchingContours.forEach(c => skippedVec.push_back(c));
  if (skippedVec.size() > 0) {
    cv.drawContours(overlay, skippedVec, -1, new cv.Scalar(248, 113, 113, 255), 4);
  }

  // Detected (smoothed) — green
  const smoothedVec = new cv.MatVector();
  smoothed.forEach(c => smoothedVec.push_back(c));
  if (smoothedVec.size() > 0) {
    cv.drawContours(overlay, smoothedVec, -1, new cv.Scalar(52, 211, 153, 255), 3);
  }

  canvas.width  = src.cols;
  canvas.height = src.rows;
  cv.imshow(canvas, overlay);

  overlay.delete();
  skippedVec.delete();
  smoothedVec.delete();
}

// ── Grid Scale Detection ───────────────────────────────────────
function detectGridScale(src) {
  try {
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const bright = new cv.Mat();
    cv.threshold(gray, bright, 200, 255, cv.THRESH_BINARY);

    const rows = bright.rows;
    const cols = bright.cols;

    const rowSums = [];
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let c = 0; c < cols; c++) sum += bright.ucharPtr(r, c)[0];
      rowSums.push(sum / 255);
    }

    const colSums = [];
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let r = 0; r < rows; r++) sum += bright.ucharPtr(r, c)[0];
      colSums.push(sum / 255);
    }

    gray.delete(); bright.delete();

    const hSpacing = findDominantSpacing(rowSums, cols * 0.5);
    const vSpacing = findDominantSpacing(colSums, rows * 0.5);
    const spacings = [hSpacing, vSpacing].filter(s => s !== null && s > 5);
    if (spacings.length === 0) return null;
    const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    return avg / 5;
  } catch {
    return null;
  }
}

function findDominantSpacing(sums, threshold) {
  const peaks = [];
  for (let i = 1; i < sums.length - 1; i++) {
    if (sums[i] > threshold && sums[i] >= sums[i - 1] && sums[i] >= sums[i + 1]) peaks.push(i);
  }
  if (peaks.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < peaks.length; i++) diffs.push(peaks[i] - peaks[i - 1]);
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  return median > 3 ? median : null;
}

// ── Contour Separation ─────────────────────────────────────────
function separateContours(contours) {
  const rects  = contours.map(c => cv.boundingRect(c));
  const parent = contours.map((_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a, b) { parent[find(a)] = find(b); }

  const pad = 4;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], pad)) union(i, j);
    }
  }

  const groups = {};
  contours.forEach((_, i) => {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(i);
  });

  const isolated = [];
  const touchingGroups = [];
  Object.values(groups).forEach(idxs => {
    if (idxs.length === 1) isolated.push(contours[idxs[0]]);
    else touchingGroups.push(idxs.map(i => contours[i]));
  });

  return { isolated, touchingGroups };
}

function rectsOverlap(a, b, pad) {
  return !(a.x + a.width  + pad < b.x ||
           b.x + b.width  + pad < a.x ||
           a.y + a.height + pad < b.y ||
           b.y + b.height + pad < a.y);
}

// ── Contour Smoothing ──────────────────────────────────────────
function smoothContour(contour, pxPerMm) {
  const smoothed = new cv.Mat();
  cv.approxPolyDP(contour, smoothed, 0.8 * pxPerMm, true);
  return smoothed;
}

// ── SVG Generation ─────────────────────────────────────────────
function buildSVG({ tools, pxPerMm, drawerWidthMm, drawerHeightMm, offsetMm, imgWidth, imgHeight }) {
  const scaleX = drawerWidthMm  / imgWidth;
  const scaleY = drawerHeightMm / imgHeight;

  const svgTools = tools.map((contour, idx) => {
    const points = [];
    for (let i = 0; i < contour.rows; i++) {
      points.push([
        contour.data32S[i * 2]     * scaleX,
        contour.data32S[i * 2 + 1] * scaleY,
      ]);
    }
    const exactPath  = pointsToPath(points);
    const offsetPath = pointsToPath(offsetPolygon(points, offsetMm));

    return `
  <g id="tool-${idx + 1}" class="tool">
    <path class="exact"  d="${exactPath}"  fill="none" stroke="#1a1a2e" stroke-width="0.3"/>
    <path class="offset" d="${offsetPath}" fill="none" stroke="#4f7cff" stroke-width="0.3" stroke-dasharray="1 0.5"/>
  </g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- FoamCut SVG — generated ${new Date().toISOString()} -->
<!-- Canvas: ${drawerWidthMm.toFixed(1)}mm × ${drawerHeightMm.toFixed(1)}mm -->
<!-- Tools: ${tools.length} | Offset: ${offsetMm}mm -->
<!-- Layers: "exact" = tool silhouette, "offset" = foam pocket cut line -->
<svg xmlns="http://www.w3.org/2000/svg"
     width="${drawerWidthMm.toFixed(2)}mm"
     height="${drawerHeightMm.toFixed(2)}mm"
     viewBox="0 0 ${drawerWidthMm.toFixed(4)} ${drawerHeightMm.toFixed(4)}">
  <style>
    .exact  { stroke: #1a1a2e; }
    .offset { stroke: #4f7cff; }
  </style>
  <rect x="0" y="0" width="${drawerWidthMm.toFixed(4)}" height="${drawerHeightMm.toFixed(4)}"
        fill="none" stroke="#888" stroke-width="0.5"/>
${svgTools}
</svg>`;
}

function pointsToPath(pts) {
  if (!pts.length) return '';
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(3)},${y.toFixed(3)}`).join(' ') + ' Z';
}

// ── Polygon Offset (Clipper.js) ────────────────────────────────
function offsetPolygon(points, offsetMm) {
  if (!window.ClipperLib) return points;
  const SCALE = 1000;
  const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, offsetMm * SCALE);
  if (!solution || !solution.length) return points;
  const largest = solution.reduce((a, b) => (b.length > a.length ? b : a), solution[0]);
  return largest.map(pt => [pt.X / SCALE, pt.Y / SCALE]);
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

function drawToCanvas(canvas, img) {
  canvas.width  = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
}

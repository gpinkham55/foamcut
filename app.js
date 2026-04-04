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
     8. Optional debug PNG overlay
   ───────────────────────────────────────────────────────────── */

'use strict';

// ── State ──────────────────────────────────────────────────────
const state = {
  file: null,
  svgBlob: null,
  debugBlob: null,
  cvReady: false,
};

// ── DOM refs ───────────────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const browseBtn      = document.getElementById('browse-btn');
const changeBtn      = document.getElementById('change-btn');
const dropInner      = document.getElementById('drop-inner');
const previewInner   = document.getElementById('preview-inner');
const previewImg     = document.getElementById('preview-img');
const processBtn     = document.getElementById('process-btn');
const btnLabel       = document.getElementById('btn-label');
const btnSpinner     = document.getElementById('btn-spinner');
const statusArea     = document.getElementById('status-area');
const statusLog      = document.getElementById('status-log');
const resultsSection = document.getElementById('results-section');
const toolCountLabel = document.getElementById('tool-count-label');
const downloadSvgBtn = document.getElementById('download-svg-btn');
const debugResult    = document.getElementById('debug-result');
const debugCanvas    = document.getElementById('debug-canvas');
const downloadDebug  = document.getElementById('download-debug-btn');
const warningsArea   = document.getElementById('warnings-area');
const widthInput     = document.getElementById('width-in');
const heightInput    = document.getElementById('height-in');
const offsetInput    = document.getElementById('offset-mm');
const debugToggle    = document.getElementById('debug-toggle');
const cvCanvas       = document.getElementById('cv-canvas');

// ── Logging ────────────────────────────────────────────────────
function log(msg, type = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ` ${type}` : '');
  line.textContent = `› ${msg}`;
  statusLog.appendChild(line);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// ── File handling ──────────────────────────────────────────────
function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  state.file = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  dropInner.classList.add('hidden');
  previewInner.classList.remove('hidden');
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

// ── Main process ───────────────────────────────────────────────
processBtn.addEventListener('click', runPipeline);

async function runPipeline() {
  if (!state.file) return;

  // Reset UI
  statusArea.classList.remove('hidden');
  statusLog.innerHTML = '';
  resultsSection.classList.add('hidden');
  warningsArea.classList.add('hidden');
  warningsArea.innerHTML = '';
  state.svgBlob = null;
  state.debugBlob = null;

  btnLabel.textContent = 'Processing…';
  btnSpinner.classList.remove('hidden');
  processBtn.disabled = true;

  try {
    await runPipelineInner();
  } catch (err) {
    log(`Error: ${err.message}`, 'err');
    console.error(err);
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
  const doDebug  = debugToggle.checked;

  // ── Load image into OpenCV ─────────────────────────────────
  log('Loading image…');
  const img = await loadImage(state.file);
  drawToCanvas(cvCanvas, img);
  const src = cv.imread(cvCanvas);
  log(`Image: ${src.cols}×${src.rows}px`, 'ok');

  // ── Grid calibration ───────────────────────────────────────
  log('Detecting 5mm grid for scale calibration…');
  const pixPerMm = detectGridScale(src);
  if (pixPerMm === null) {
    log('Grid not detected — falling back to drawer-dimension scale', 'warn');
  } else {
    log(`Grid calibration: ${pixPerMm.toFixed(2)} px/mm`, 'ok');
  }

  // Fallback: derive scale from drawer dimensions vs image size
  const mmWidth  = widthIn  * 25.4;
  const mmHeight = heightIn * 25.4;
  const fallbackPxPerMm = Math.min(src.cols / mmWidth, src.rows / mmHeight);
  const pxPerMm = pixPerMm ?? fallbackPxPerMm;

  // ── Segmentation ───────────────────────────────────────────
  log('Segmenting tools…');
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Blur to reduce grid noise
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

  // Otsu threshold — tools are dark on bright backlit background
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  // Morphological close to fill gaps in tool bodies
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

  // Find contours
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // Minimum area in pixels² (tools must be at least 1cm² = 100mm²)
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
  log(`Found ${validContours.length} candidate tool(s)`, 'ok');

  // ── Detect touching / overlapping groups ───────────────────
  const { isolated, touchingGroups } = separateContours(validContours, src);
  const warnings = [];
  if (touchingGroups.length > 0) {
    touchingGroups.forEach((group, i) => {
      const msg = `Group of ${group.length} overlapping/touching tools skipped — re-photograph with spacing`;
      warnings.push(msg);
      log(msg, 'warn');
    });
  }
  log(`Processing ${isolated.length} isolated tool(s)…`);

  // ── Smooth each contour ────────────────────────────────────
  const smoothed = isolated.map(c => smoothContour(c, pxPerMm));

  // ── Build SVG ─────────────────────────────────────────────
  log('Building SVG…');
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

  // ── Debug overlay ──────────────────────────────────────────
  if (doDebug) {
    log('Rendering debug overlay…');
    renderDebug({
      src,
      isolated,
      touchingGroups: touchingGroups.flat(),
      smoothed,
      canvas: debugCanvas,
    });
    state.debugBlob = canvasToBlob(debugCanvas);
    debugResult.classList.remove('hidden');
  } else {
    debugResult.classList.add('hidden');
  }

  // ── Cleanup OpenCV Mats ────────────────────────────────────
  src.delete(); gray.delete(); blurred.delete(); binary.delete();
  kernel.delete(); closed.delete(); contours.delete(); hierarchy.delete();

  // ── Show results ───────────────────────────────────────────
  toolCountLabel.textContent = `${isolated.length} tool(s) detected — SVG ready`;
  resultsSection.classList.remove('hidden');

  if (warnings.length > 0) {
    warningsArea.innerHTML = warnings.map(w => `<p>⚠ ${w}</p>`).join('');
    warningsArea.classList.remove('hidden');
  }

  log('Done!', 'ok');
}

// ── Grid Scale Detection ───────────────────────────────────────
function detectGridScale(src) {
  try {
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Look for bright grid lines via adaptive threshold inversion
    const bright = new cv.Mat();
    cv.threshold(gray, bright, 200, 255, cv.THRESH_BINARY);

    // Horizontal projection — sum each row
    const rows = bright.rows;
    const cols = bright.cols;
    const rowSums = [];
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let c = 0; c < cols; c++) {
        sum += bright.ucharPtr(r, c)[0];
      }
      rowSums.push(sum / 255);
    }

    const colSums = [];
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let r = 0; r < rows; r++) {
        sum += bright.ucharPtr(r, c)[0];
      }
      colSums.push(sum / 255);
    }

    gray.delete(); bright.delete();

    // Find peaks (grid lines) — threshold at 50% of max sum
    const hSpacing = findDominantSpacing(rowSums, cols * 0.5);
    const vSpacing = findDominantSpacing(colSums, rows * 0.5);

    // Average the two axes; each spacing represents 5mm
    const spacings = [hSpacing, vSpacing].filter(s => s !== null && s > 5);
    if (spacings.length === 0) return null;
    const avgSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    return avgSpacing / 5; // px per mm
  } catch (e) {
    return null;
  }
}

function findDominantSpacing(sums, threshold) {
  const peaks = [];
  for (let i = 1; i < sums.length - 1; i++) {
    if (sums[i] > threshold && sums[i] >= sums[i - 1] && sums[i] >= sums[i + 1]) {
      peaks.push(i);
    }
  }
  if (peaks.length < 2) return null;

  // Collect inter-peak distances
  const diffs = [];
  for (let i = 1; i < peaks.length; i++) diffs.push(peaks[i] - peaks[i - 1]);

  // Median spacing
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  return median > 3 ? median : null;
}

// ── Contour Separation ─────────────────────────────────────────
function separateContours(contours, src) {
  // Build bounding rects and check for overlap
  const rects = contours.map(c => cv.boundingRect(c));

  // Union-find to group touching/overlapping contours
  const parent = contours.map((_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a, b) { parent[find(a)] = find(b); }

  const padding = 4; // px — contours within 4px considered touching
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], padding)) union(i, j);
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
    if (idxs.length === 1) {
      isolated.push(contours[idxs[0]]);
    } else {
      touchingGroups.push(idxs.map(i => contours[i]));
    }
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
  // Epsilon ~ 0.8mm in pixels — tight enough to preserve shape, removes sub-mm noise
  const epsilon = 0.8 * pxPerMm;
  cv.approxPolyDP(contour, smoothed, epsilon, true);
  return smoothed;
}

// ── SVG Generation ─────────────────────────────────────────────
function buildSVG({ tools, pxPerMm, drawerWidthMm, drawerHeightMm, offsetMm, imgWidth, imgHeight }) {
  const toMm = (px) => px / pxPerMm;

  // Scale factor: map image pixel space → drawer mm space
  const scaleX = drawerWidthMm  / imgWidth;
  const scaleY = drawerHeightMm / imgHeight;

  const svgTools = tools.map((contour, idx) => {
    const points = [];
    for (let i = 0; i < contour.rows; i++) {
      const x = contour.data32S[i * 2]     * scaleX;
      const y = contour.data32S[i * 2 + 1] * scaleY;
      points.push([x, y]);
    }

    const exactPath  = pointsToPath(points);
    const offsetPts  = offsetPolygon(points, offsetMm);
    const offsetPath = pointsToPath(offsetPts);

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

  <!-- Drawer outline -->
  <rect x="0" y="0"
        width="${drawerWidthMm.toFixed(4)}"
        height="${drawerHeightMm.toFixed(4)}"
        fill="none" stroke="#888" stroke-width="0.5"/>
${svgTools}
</svg>`;
}

function pointsToPath(pts) {
  if (pts.length === 0) return '';
  const d = pts.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${x.toFixed(3)},${y.toFixed(3)}`
  ).join(' ');
  return d + ' Z';
}

// ── Polygon Offset (Clipper.js) ────────────────────────────────
function offsetPolygon(points, offsetMm) {
  if (!window.ClipperLib) return points; // fallback: no offset

  const SCALE = 1000; // Clipper uses integers

  const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);

  const solution = new ClipperLib.Paths();
  co.Execute(solution, offsetMm * SCALE);

  if (!solution || solution.length === 0) return points;

  // Take the largest result polygon
  const largest = solution.reduce((a, b) => (b.length > a.length ? b : a), solution[0]);
  return largest.map(pt => [pt.X / SCALE, pt.Y / SCALE]);
}

// ── Debug Overlay ──────────────────────────────────────────────
function renderDebug({ src, isolated, touchingGroups, smoothed, canvas }) {
  const display = src.clone();

  // Draw skipped (touching) contours in red
  const skippedVec = new cv.MatVector();
  touchingGroups.forEach(c => skippedVec.push_back(c));
  if (skippedVec.size() > 0) {
    cv.drawContours(display, skippedVec, -1, new cv.Scalar(248, 113, 113, 255), 3);
  }

  // Draw smoothed contours in green
  const smoothedVec = new cv.MatVector();
  smoothed.forEach(c => smoothedVec.push_back(c));
  if (smoothedVec.size() > 0) {
    cv.drawContours(display, smoothedVec, -1, new cv.Scalar(52, 211, 153, 255), 2);
  }

  cv.imshow(canvas, display);
  display.delete();
  skippedVec.delete();
  smoothedVec.delete();
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// ── Downloads ──────────────────────────────────────────────────
downloadSvgBtn.addEventListener('click', () => {
  if (!state.svgBlob) return;
  downloadBlob(state.svgBlob, 'foamcut.svg');
});

downloadDebug.addEventListener('click', async () => {
  const blob = await canvasToBlob(debugCanvas);
  downloadBlob(blob, 'foamcut-debug.png');
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Image loader helper ────────────────────────────────────────
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

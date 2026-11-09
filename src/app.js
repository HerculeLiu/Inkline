const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  fileInput: $("#fileInput"), dropZone: $("#dropZone"), emptyUploadButton: $("#emptyUploadButton"),
  autoMode: $("#autoMode"), autoModeLabel: $("#autoModeLabel"), modeDescription: $("#modeDescription"),
  processButton: $("#processButton"), resetButton: $("#resetButton"), downloadButton: $("#downloadButton"),
  validationMessage: $("#validationMessage"), outlineColorText: $("#outlineColorText"),
  emptyState: $("#emptyState"), canvasWrap: $("#canvasWrap"), canvasViewport: $("#canvasViewport"),
  baseCanvas: $("#baseCanvas"), resultCanvas: $("#resultCanvas"), compareDivider: $("#compareDivider"), compareMode: $("#compareMode"),
  zoomValue: $("#zoomValue"), progressBar: $("#progressBar"), progressValue: $("#progressValue"), statusIcon: $("#statusIcon"), statusTitle: $("#statusTitle"), statusDetail: $("#statusDetail"),
  fileName: $("#fileName"), fileMeta: $("#fileMeta"), thumbnail: $("#thumbnail"), resultState: $("#resultState"),
  initialRegions: $("#initialRegions"), finalRegions: $("#finalRegions"), mergedRegions: $("#mergedRegions"), boundaryPixels: $("#boundaryPixels"), elapsedTime: $("#elapsedTime"),
  effectiveList: $("#effectiveList"), warningsList: $("#warningsList"), warningCount: $("#warningCount"), integrityState: $("#integrityState"),
  controlsPanel: $("#controlsPanel")
};

const paramIds = ["segmentationMethod", "localThreshold", "globalThreshold", "minRegionArea", "minInnerAreaRatio", "outlineWidth", "outlineColor", "preSmoothLevel", "connectivity"];
const autoManagedIds = new Set(paramIds.filter((id) => id !== "segmentationMethod"));
const state = {
  image: null,
  file: null,
  result: null,
  requestId: 0,
  worker: null,
  processing: false,
  activeView: "original",
  comparePosition: 50,
  zoom: 1,
  fitScale: 1,
  dirty: false
};

function createWorker() {
  state.worker?.terminate();
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker.onmessage = handleWorkerMessage;
  state.worker.onerror = (event) => showError(event.message || "Worker 运行失败。");
}

function setStatus(title, detail, percent = 0, kind = "") {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressValue.textContent = `${Math.round(percent)}%`;
  elements.statusIcon.className = `status-icon ${kind}`.trim();
}

function setResultState(text, kind = "") {
  elements.resultState.textContent = text;
  elements.resultState.className = `result-state ${kind}`.trim();
}

function showError(message) {
  state.processing = false;
  elements.processButton.disabled = !state.image;
  elements.processButton.querySelector("span").textContent = "重新处理";
  setStatus("处理未完成", message, 0, "error");
  elements.validationMessage.textContent = message;
  setResultState("ERROR", "dirty");
}

function readParams() {
  const hex = $("#outlineColor").value;
  const params = {
    autoMode: elements.autoMode.checked,
    segmentationMethod: $("#segmentationMethod").value,
    localThreshold: Number($("#localThreshold").value) / 100,
    globalThreshold: Number($("#globalThreshold").value) / 100,
    minRegionArea: Number($("#minRegionArea").value),
    minInnerAreaRatio: Number($("#minInnerAreaRatio").value) / 100,
    outlineWidth: Number($("#outlineWidth").value),
    outlineColor: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)],
    preSmoothLevel: Number($("#preSmoothLevel").value),
    connectivity: Number($("#connectivity").value)
  };
  const errors = [];
  if (!Number.isFinite(params.localThreshold) || params.localThreshold < 0 || params.localThreshold > 1) errors.push("局部色差需在 0–100 之间。");
  if (!Number.isFinite(params.globalThreshold) || params.globalThreshold < params.localThreshold) errors.push("全局色差必须大于或等于局部色差。");
  if (!Number.isInteger(params.minRegionArea) || params.minRegionArea < 1) errors.push("最小色块必须是大于 0 的整数。");
  if (params.minInnerAreaRatio < 0 || params.minInnerAreaRatio > 1) errors.push("剩余面积比例需在 0–100% 之间。");
  if (!Number.isInteger(params.outlineWidth) || params.outlineWidth < 1 || params.outlineWidth > 8) errors.push("描边宽度需为 1–8 的整数。");
  if (!Number.isInteger(params.preSmoothLevel) || params.preSmoothLevel < 0 || params.preSmoothLevel > 5) errors.push("平滑强度需为 0–5 的整数。");
  elements.validationMessage.textContent = errors[0] || "";
  elements.processButton.disabled = !state.image || state.processing || errors.length > 0;
  return { params, errors };
}

function writeParams(params) {
  if (!params) return;
  if (params.segmentationMethod) $("#segmentationMethod").value = params.segmentationMethod;
  $("#localThreshold").value = (params.localThreshold * 100).toFixed(1);
  $("#globalThreshold").value = (params.globalThreshold * 100).toFixed(1);
  $("#minRegionArea").value = Math.round(params.minRegionArea);
  $("#minInnerAreaRatio").value = Math.round(params.minInnerAreaRatio * 100);
  $("#outlineWidth").value = Math.round(params.outlineWidth);
  $("#preSmoothLevel").value = Math.round(params.preSmoothLevel);
  $("#connectivity").value = String(params.connectivity);
  if (params.outlineColor) {
    const hex = `#${params.outlineColor.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    $("#outlineColor").value = hex;
    elements.outlineColorText.textContent = hex.toUpperCase();
  }
  readParams();
}

function updateMode() {
  const auto = elements.autoMode.checked;
  elements.autoModeLabel.textContent = auto ? "自动估计" : "手动参数";
  elements.modeDescription.textContent = auto
    ? "从图片的相邻色差与噪声分布估计实际参数。"
    : "当前数值可编辑；全局阈值不能低于局部阈值。";
  for (const id of autoManagedIds) {
    const input = $(`#${id}`);
    input.disabled = auto;
    input.closest(".parameter-row")?.classList.toggle("disabled", auto);
  }
  $$('[data-step="outlineWidth"]').forEach((button) => button.disabled = auto);
  readParams();
}

function copyImageForWorker() {
  return { width: state.image.width, height: state.image.height, data: new Uint8ClampedArray(state.image.data) };
}

function analyzeCurrentImage() {
  if (!state.image) return;
  createWorker();
  const requestId = ++state.requestId;
  const image = copyImageForWorker();
  setStatus("正在分析图片", "采样相邻像素的 OKLab 色差", 7, "working");
  state.worker.postMessage({ type: "ANALYZE", requestId, image }, [image.data.buffer]);
}

function processCurrentImage() {
  if (!state.image || state.processing) return;
  const { params, errors } = readParams();
  if (errors.length) return;
  createWorker();
  const requestId = ++state.requestId;
  const image = copyImageForWorker();
  state.processing = true;
  state.dirty = false;
  elements.processButton.disabled = true;
  elements.downloadButton.disabled = true;
  elements.processButton.querySelector("span").textContent = "处理中…";
  elements.validationMessage.textContent = "";
  setResultState("PROCESSING");
  setStatus("准备处理", "RGBA 与透明像素归一化", 2, "working");
  state.worker.postMessage({ type: "PROCESS", requestId, image, params }, [image.data.buffer]);
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (message.requestId !== state.requestId) return;
  if (message.type === "PROGRESS") {
    setStatus(message.stage, "处理运行在独立 Worker，不会阻塞界面", message.percent, "working");
    return;
  }
  if (message.type === "ANALYZED") {
    if (elements.autoMode.checked) {
      const current = readParams().params;
      writeParams({ ...message.analysis.params, segmentationMethod: current.segmentationMethod, outlineColor: current.outlineColor });
    }
    const metric = message.analysis.metrics;
    setStatus("参数估计完成", `${metric.reason} · 采样 ${metric.sampledEdges.toLocaleString()} 条相邻边`, 0, "done");
    setResultState("INPUT READY");
    renderEffectiveParams({ ...message.analysis.params, segmentationMethod: $("#segmentationMethod").value }, true);
    renderWarnings(message.analysis.warnings);
    elements.processButton.disabled = false;
    return;
  }
  if (message.type === "DONE") {
    state.processing = false;
    state.result = message.output;
    state.dirty = false;
    elements.processButton.disabled = false;
    elements.processButton.querySelector("span").textContent = "再次处理";
    elements.downloadButton.disabled = false;
    setStatus("处理完成", `${message.output.stats.finalRegionCount.toLocaleString()} 个最终区域 · 导出保持 ${message.output.width} × ${message.output.height}`, 100, "done");
    setResultState("VERIFIED", "ready");
    renderResult(message.output);
    if (state.activeView === "original") setActiveView("final");
    return;
  }
  if (message.type === "ERROR") showError(message.message);
}

async function decodeFile(file) {
  if (!file.type.match(/^image\/(png|jpeg|webp)$/)) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  const bitmap = await createImageBitmap(file);
  if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error("图片边长超过 4096 像素，请先裁剪后重试。");
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return image;
}

async function loadFile(file) {
  try {
    setStatus("正在读取图片", file.name, 2, "working");
    const image = await decodeFile(file);
    loadImage(image, { name: file.name, type: file.type.split("/")[1].toUpperCase(), size: file.size });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function loadImage(image, fileInfo) {
  state.requestId++;
  state.worker?.terminate();
  state.image = image;
  state.file = fileInfo;
  state.result = null;
  state.dirty = false;
  state.processing = false;
  state.zoom = 1;
  elements.emptyState.hidden = true;
  elements.canvasWrap.hidden = false;
  elements.downloadButton.disabled = true;
  elements.processButton.querySelector("span").textContent = "开始处理";
  elements.fileName.textContent = fileInfo.name;
  const alpha = hasTransparency(image) ? "透明" : "不透明";
  elements.fileMeta.textContent = `${image.width} × ${image.height} · ${fileInfo.type} · ${alpha}`;
  setResultState("ANALYZING");
  resetStats();
  drawOriginal();
  drawThumbnail();
  fitCanvas();
  setActiveView("original");
  updateCompare();
  analyzeCurrentImage();
}

function hasTransparency(image) {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 255) return true;
  return false;
}

function drawOriginal() {
  const canvas = elements.baseCanvas;
  canvas.width = state.image.width; canvas.height = state.image.height;
  canvas.getContext("2d").putImageData(state.image, 0, 0);
  elements.resultCanvas.width = state.image.width;
  elements.resultCanvas.height = state.image.height;
}

function drawThumbnail() {
  elements.thumbnail.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.width = 86; canvas.height = 86;
  const ctx = canvas.getContext("2d");
  const source = document.createElement("canvas");
  source.width = state.image.width; source.height = state.image.height;
  source.getContext("2d").putImageData(state.image, 0, 0);
  const scale = Math.max(86 / source.width, 86 / source.height);
  const width = source.width * scale; const height = source.height * scale;
  ctx.drawImage(source, (86 - width) / 2, (86 - height) / 2, width, height);
  elements.thumbnail.append(canvas);
}

function fitCanvas() {
  if (!state.image) return;
  const bounds = elements.canvasViewport.getBoundingClientRect();
  state.fitScale = Math.min((bounds.width - 60) / state.image.width, (bounds.height - 60) / state.image.height, 1);
  state.zoom = 1;
  updateCanvasSize();
}

function updateCanvasSize() {
  if (!state.image) return;
  const scale = state.fitScale * state.zoom;
  elements.canvasWrap.style.width = `${Math.max(1, Math.round(state.image.width * scale))}px`;
  elements.canvasWrap.style.height = `${Math.max(1, Math.round(state.image.height * scale))}px`;
  elements.baseCanvas.style.width = elements.resultCanvas.style.width = "100%";
  elements.baseCanvas.style.height = elements.resultCanvas.style.height = "100%";
  elements.zoomValue.value = `${Math.round(state.zoom * 100)}%`;
}

function setActiveView(view) {
  state.activeView = view;
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  elements.compareMode.disabled = view === "original" || !state.result;
  drawActiveResult();
}

function drawActiveResult() {
  if (!state.image) return;
  if (state.activeView === "original" || !state.result) {
    elements.resultCanvas.style.display = "none";
    elements.compareDivider.style.display = "none";
    return;
  }
  const { width, height } = state.result;
  let rgba;
  if (state.activeView === "flat") rgba = state.result.flatRGBA;
  if (state.activeView === "final") rgba = state.result.outlinedRGBA;
  if (state.activeView === "boundary") {
    rgba = new Uint8ClampedArray(width * height * 4);
    const outline = state.result.stats.effectiveParams.outlineColor;
    for (let i = 0; i < width * height; i++) {
      const offset = i * 4;
      if (state.image.data[offset + 3] === 0) continue;
      if (state.result.boundaryMask[i]) {
        rgba[offset] = outline[0]; rgba[offset + 1] = outline[1]; rgba[offset + 2] = outline[2];
      } else {
        rgba[offset] = 250; rgba[offset + 1] = 249; rgba[offset + 2] = 244;
      }
      rgba[offset + 3] = 255;
    }
  }
  elements.resultCanvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  elements.resultCanvas.style.display = "block";
  updateCompare();
}

function updateCompare() {
  const enabled = elements.compareMode.checked && state.activeView !== "original" && state.result;
  elements.resultCanvas.style.clipPath = enabled ? `inset(0 ${100 - state.comparePosition}% 0 0)` : "none";
  elements.compareDivider.style.display = enabled ? "block" : "none";
  elements.compareDivider.style.left = `${state.comparePosition}%`;
}

function renderResult(output) {
  const stats = output.stats;
  elements.initialRegions.textContent = stats.initialRegionCount.toLocaleString();
  elements.finalRegions.textContent = stats.finalRegionCount.toLocaleString();
  elements.mergedRegions.textContent = stats.mergedSmallRegionCount.toLocaleString();
  elements.boundaryPixels.textContent = stats.boundaryPixelCount.toLocaleString();
  elements.elapsedTime.textContent = stats.elapsedMs < 1000 ? `${stats.elapsedMs} ms` : `${(stats.elapsedMs / 1000).toFixed(2)} s`;
  elements.integrityState.textContent = stats.validation.passed ? "PASS" : "FAIL";
  elements.integrityState.closest(".integrity-card").style.background = stats.validation.passed ? "var(--acid)" : "#ff8b77";
  renderEffectiveParams(stats.effectiveParams, false);
  renderWarnings(stats.warnings);
  drawActiveResult();
}

function renderEffectiveParams(params, estimated) {
  if (!params) return;
  const methodLabel = {
    existing: "现有方法 · STABLE",
    "fh-rag": "FH + RAG · EXPERIMENTAL",
    "hierarchical-fusion": "多尺度融合 · EXPERIMENTAL"
  }[params.segmentationMethod] || params.segmentationMethod;
  elements.effectiveList.innerHTML = `
    <div><dt>分割方法</dt><dd>${escapeHtml(methodLabel)}</dd></div>
    <div><dt>局部 / 全局色差</dt><dd>${(params.localThreshold * 100).toFixed(1)} / ${(params.globalThreshold * 100).toFixed(1)} ΔOK×100</dd></div>
    <div><dt>最小色块 / 剩余比例</dt><dd>${Math.round(params.minRegionArea)} px / ${Math.round(params.minInnerAreaRatio * 100)}%</dd></div>
    <div><dt>线宽 / 平滑 / 邻接</dt><dd>${params.outlineWidth} px / L${params.preSmoothLevel} / ${params.connectivity}-N</dd></div>
    ${estimated ? "<div><dt>状态</dt><dd>AUTO ESTIMATE</dd></div>" : ""}
  `;
}

function renderWarnings(warnings = []) {
  elements.warningCount.textContent = String(warnings.length);
  elements.warningsList.innerHTML = warnings.length
    ? warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")
    : '<li class="muted">未发现额外风险。</li>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));
}

function resetStats() {
  for (const element of [elements.initialRegions, elements.finalRegions, elements.mergedRegions, elements.boundaryPixels, elements.elapsedTime]) element.textContent = "—";
  elements.integrityState.textContent = "—";
  renderWarnings([]);
}

function markDirty() {
  const { errors } = readParams();
  elements.outlineColorText.textContent = $("#outlineColor").value.toUpperCase();
  if (state.result) {
    state.dirty = true;
    setResultState("PARAMS CHANGED", "dirty");
    setStatus("参数已修改", "再次处理后才会更新预览与下载文件", 0, "");
  }
  elements.processButton.disabled = !state.image || state.processing || errors.length > 0;
}

function resetParams() {
  writeParams({
    segmentationMethod: "existing",
    localThreshold: 0.024, globalThreshold: 0.06, minRegionArea: 9, minInnerAreaRatio: 0.8,
    outlineWidth: 2, outlineColor: [21, 21, 21], preSmoothLevel: 0, connectivity: 4
  });
  if (elements.autoMode.checked && state.image) analyzeCurrentImage();
  else markDirty();
}

function downloadResult() {
  if (!state.result || state.dirty) {
    elements.validationMessage.textContent = state.dirty ? "参数已变化，请重新处理后再下载。" : "请先完成处理。";
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = state.result.width; canvas.height = state.result.height;
  canvas.getContext("2d").putImageData(new ImageData(state.result.outlinedRGBA, state.result.width, state.result.height), 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return showError("PNG 编码失败。");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = (state.file?.name || "image").replace(/\.[^.]+$/, "");
    const methodSuffix = {
      existing: "existing",
      "fh-rag": "fh-rag",
      "hierarchical-fusion": "multiscale-fusion"
    }[state.result.stats.segmentationMethod] || "outlined";
    link.href = url; link.download = `${baseName}-${methodSuffix}-outlined.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}

function generateSample(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 720; canvas.height = 480;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (kind === "landscape") {
    ctx.fillStyle = "#9ed8ee"; ctx.fillRect(0, 0, 720, 480);
    ctx.fillStyle = "#ffd95c"; ctx.beginPath(); ctx.arc(585, 92, 54, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff8df";
    for (const [x, y, r] of [[130,92,42],[175,86,55],[220,101,38]]) { ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
    ctx.fillStyle = "#7bbb72"; ctx.beginPath(); ctx.moveTo(0,330); ctx.quadraticCurveTo(160,185,330,338); ctx.quadraticCurveTo(520,210,720,325); ctx.lineTo(720,480); ctx.lineTo(0,480); ctx.fill();
    ctx.fillStyle = "#326e57"; ctx.beginPath(); ctx.moveTo(0,390); ctx.quadraticCurveTo(190,260,385,400); ctx.quadraticCurveTo(555,300,720,375); ctx.lineTo(720,480); ctx.lineTo(0,480); ctx.fill();
    ctx.fillStyle = "#e9875d"; ctx.beginPath(); ctx.moveTo(270,480); ctx.lineTo(355,325); ctx.lineTo(430,480); ctx.fill();
  } else if (kind === "portrait") {
    ctx.fillStyle = "#f0c95e"; ctx.fillRect(0, 0, 720, 480);
    ctx.fillStyle = "#5877ff"; ctx.fillRect(68, 74, 584, 348);
    ctx.fillStyle = "#f4b18c"; ctx.beginPath(); ctx.arc(360,210,112,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "#2c2428"; ctx.beginPath(); ctx.arc(360,170,125,Math.PI,Math.PI*2); ctx.lineTo(480,270); ctx.quadraticCurveTo(430,230,410,172); ctx.quadraticCurveTo(350,205,240,177); ctx.lineTo(240,270); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff9e9"; ctx.beginPath(); ctx.ellipse(320,218,25,15,0,0,Math.PI*2); ctx.ellipse(405,218,25,15,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "#1a1b18"; ctx.beginPath(); ctx.arc(322,219,7,0,Math.PI*2); ctx.arc(407,219,7,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "#c9ff54"; ctx.beginPath(); ctx.moveTo(210,480); ctx.quadraticCurveTo(235,330,360,332); ctx.quadraticCurveTo(500,332,520,480); ctx.fill();
    ctx.fillStyle = "#e35f52"; ctx.fillRect(341,278,45,10);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 720, 0);
    gradient.addColorStop(0, "#3544b1"); gradient.addColorStop(.45, "#b95d94"); gradient.addColorStop(1, "#f3c063");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 720, 480);
    ctx.fillStyle = "#101510"; ctx.fillRect(92, 104, 144, 272);
    ctx.fillStyle = "#f6efe2"; ctx.beginPath(); ctx.arc(494,240,105,0,Math.PI*2); ctx.fill();
  }
  const image = ctx.getImageData(0, 0, 720, 480);
  if (kind !== "gradient") {
    const random = seededRandom(kind === "landscape" ? 42 : 73);
    for (let i = 0; i < image.data.length; i += 4) {
      const noise = Math.round((random() - .5) * 7);
      image.data[i] = Math.max(0, Math.min(255, image.data[i] + noise));
      image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + noise));
      image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + noise));
    }
  }
  return image;
}

elements.fileInput.addEventListener("change", () => { const file = elements.fileInput.files?.[0]; if (file) loadFile(file); elements.fileInput.value = ""; });
elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.emptyUploadButton.addEventListener("click", () => elements.fileInput.click());
for (const type of ["dragenter", "dragover"]) elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.add("dragging"); });
for (const type of ["dragleave", "drop"]) elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.remove("dragging"); });
elements.dropZone.addEventListener("drop", (event) => { const file = event.dataTransfer.files?.[0]; if (file) loadFile(file); });
$$('[data-sample]').forEach((button) => button.addEventListener("click", () => {
  const names = { landscape: "山谷与太阳.png", portrait: "蓝底角色.png", gradient: "跨度渐变.png" };
  loadImage(generateSample(button.dataset.sample), { name: names[button.dataset.sample], type: "SYNTHETIC", size: 0 });
}));

elements.autoMode.addEventListener("change", () => {
  updateMode();
  if (elements.autoMode.checked && state.image) analyzeCurrentImage();
  else markDirty();
});
paramIds.forEach((id) => $(`#${id}`).addEventListener("input", markDirty));
$$('[data-step]').forEach((button) => button.addEventListener("click", () => {
  const input = $(`#${button.dataset.step}`); input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + Number(button.dataset.delta)))); markDirty();
}));
elements.processButton.addEventListener("click", processCurrentImage);
elements.resetButton.addEventListener("click", resetParams);
elements.downloadButton.addEventListener("click", downloadResult);
$$('[data-view]').forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
elements.compareMode.addEventListener("change", updateCompare);
$("#zoomIn").addEventListener("click", () => { state.zoom = Math.min(5, state.zoom * 1.25); updateCanvasSize(); });
$("#zoomOut").addEventListener("click", () => { state.zoom = Math.max(.25, state.zoom / 1.25); updateCanvasSize(); });
$("#zoomFit").addEventListener("click", fitCanvas);
elements.compareDivider.addEventListener("pointerdown", (event) => {
  elements.compareDivider.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const rect = elements.canvasWrap.getBoundingClientRect();
    state.comparePosition = Math.max(3, Math.min(97, ((moveEvent.clientX - rect.left) / rect.width) * 100)); updateCompare();
  };
  move(event);
  elements.compareDivider.addEventListener("pointermove", move);
  elements.compareDivider.addEventListener("pointerup", () => elements.compareDivider.removeEventListener("pointermove", move), { once: true });
});
$("#mobileSettings").addEventListener("click", () => elements.controlsPanel.classList.add("open"));
$("#closeSettings").addEventListener("click", () => elements.controlsPanel.classList.remove("open"));
window.addEventListener("resize", () => { if (state.image && state.zoom === 1) fitCanvas(); });

updateMode();
setStatus("等待图片", "所有处理都在当前设备完成", 0, "");

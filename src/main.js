const {entrypoints, versions, shell} = require("uxp");

// Keep the panel controls usable even if Photoshop rejects a host API while
// loading the adapter. The adapter is loaded only when an operation needs it.
let photoshopAdapter = null;
function photoshop() {
  if (!photoshopAdapter) photoshopAdapter = require("./photoshop.js");
  return photoshopAdapter;
}

const DEFAULT_TONE_CURVE = [1.18, 1, 0.72];
const DEFAULT_STRUCTURE = 0.65;
const DEFAULT_ASPECT = 1;
const state = {
  target: null,
  previewId: null,
  toneCurve: DEFAULT_TONE_CURVE.slice(),
  structure: DEFAULT_STRUCTURE,
  aspect: DEFAULT_ASPECT,
  busy: false,
  pendingRender: false,
  renderTimer: null,
  awaitingManualSelection: false,
  wired: false
};

function byId(id) { return document.getElementById(id); }

function setStatus(message, isError = false) {
  const status = byId("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function updateAvailability() {
  byId("analyze").disabled = state.busy || state.awaitingManualSelection;
  byId("manualAnalyze").disabled = state.busy || state.awaitingManualSelection;
}

function setBusy(busy) {
  state.busy = busy;
  updateAvailability();
}

function settings() {
  return {
    amount: Number(byId("amount").value),
    size: Number(byId("size").value),
    chroma: Number(byId("chroma").value),
    seed: Number(byId("seed").value),
    toneCurve: state.toneCurve,
    structure: state.structure,
    aspect: state.aspect
  };
}

function updateOutputs() {
  byId("amountValue").textContent = Number(byId("amount").value).toFixed(1) + "%";
  byId("sizeValue").textContent = Number(byId("size").value).toFixed(1) + " px";
  byId("chromaValue").textContent = Math.round(Number(byId("chroma").value)) + "%";
  byId("seedValue").textContent = String(Math.round(Number(byId("seed").value)));
}

function explainError(error) {
  console.error(error);
  setStatus(error && error.message ? error.message : String(error), true);
}

function setManualSelectionStage(awaiting) {
  state.awaitingManualSelection = awaiting;
  byId("manualAnalyze").textContent = awaiting ? "采集中…" : "手动采集样本";
  byId("analysisHint").textContent = awaiting
    ? "请在画面中框选干净背景；松开鼠标后会立即分析并生成。"
    : "自动匹配周边背景并立即生成；也可手动框选样本。";
  updateAvailability();
}

function onBackgroundSelectionChanged() {
  if (!state.awaitingManualSelection || state.busy || !state.target) return;
  try {
    if (!photoshop().hasBackgroundSelection(state.target.documentId)) return;
    setManualSelectionStage(false);
    analyze(true);
  } catch (error) {
    setManualSelectionStage(false);
    explainError(error);
  }
}

async function ensureTarget() {
  const ps = photoshop();
  const active = ps.getActiveLayerIdentity();
  let targetIsUsable = false;
  if (state.target && active.documentId === state.target.documentId &&
      (active.layerId === state.target.layerId || active.layerId === state.previewId)) {
    try {
      ps.resolveTarget(state.target);
      targetIsUsable = true;
    } catch (error) {
      console.warn("MeiNoise target is no longer available; retargeting.", error);
    }
  }
  if (targetIsUsable) return;

  // A generated grain layer is already final. Preserve it when changing target.
  state.previewId = null;
  state.target = null;
  state.toneCurve = DEFAULT_TONE_CURVE.slice();
  state.structure = DEFAULT_STRUCTURE;
  state.aspect = DEFAULT_ASPECT;
  setManualSelectionStage(false);
  byId("analysisResult").classList.add("hidden");
  state.target = ps.captureTarget();
  updateAvailability();
}

async function beginManualSelection() {
  if (state.busy || state.awaitingManualSelection) return;
  setBusy(true);
  setStatus("正在准备手动背景选区……");
  try {
    await ensureTarget();
    await photoshop().listenForBackgroundSelection(onBackgroundSelectionChanged);
    await photoshop().activateBackgroundSelectionTool();
    setManualSelectionStage(true);
    setStatus("请框选干净背景；松开鼠标后会自动生成噪点。");
  } catch (error) {
    setManualSelectionStage(false);
    explainError(error);
  } finally {
    setBusy(false);
  }
}

function requestRender(delay = 260) {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    render();
  }, delay);
}

async function analyze(useSelection = false) {
  if (state.busy) return;
  setBusy(true);
  setStatus(useSelection ? "正在分析手动背景样本……" : "正在自动匹配并生成噪点……");
  let succeeded = false;
  let previewWasHidden = false;
  try {
    const ps = photoshop();
    await ensureTarget();
    if (state.previewId && state.target) {
      await ps.setPreviewVisibility(state.target, state.previewId, false);
      previewWasHidden = true;
    }
    const result = useSelection ? await ps.analyzeSelection() : await ps.analyzeAroundTarget(state.target);
    byId("amount").value = result.amount.toFixed(1);
    byId("size").value = result.size.toFixed(1);
    byId("chroma").value = Math.round(result.chroma);
    state.toneCurve = result.toneCurve;
    state.structure = result.structure;
    state.aspect = result.aspect || 1;
    updateOutputs();
    const confidence = result.confidence >= 0.7 ? "高" : result.confidence >= 0.4 ? "中" : "低";
    const completeTone = result.tonalCoverage >= 3;
    const resultNode = byId("analysisResult");
    const source = useSelection ? "选区" : `${result.patchCount || 1} 个周边样本`;
    const textureNote = result.textureScore >= 0.35 ? " · 已抑制纹理干扰" : "";
    resultNode.textContent = completeTone
      ? `已从${source}匹配颗粒 · 明暗响应完整${textureNote} · 置信度${confidence}`
      : `已从${source}匹配颗粒 · 明暗响应部分使用默认值${textureNote} · 置信度${confidence}`;
    resultNode.classList.remove("hidden");
    setStatus("噪点已匹配，正在生成图层……");
    succeeded = true;
  } catch (error) {
    explainError(error);
  } finally {
    if (previewWasHidden) {
      try {
        await photoshop().setPreviewVisibility(state.target, state.previewId, true);
      } catch (error) {
        explainError(error);
      }
    }
    setBusy(false);
  }
  if (succeeded) requestRender(0);
}

async function render() {
  if (state.busy) {
    state.pendingRender = true;
    return;
  }
  setBusy(true);
  setStatus("正在更新预览……");
  try {
    await ensureTarget();
    state.previewId = await photoshop().renderPreview(state.target, settings(), state.previewId);
    setStatus("预览已更新。");
  } catch (error) {
    explainError(error);
  } finally {
    setBusy(false);
    if (state.pendingRender) {
      state.pendingRender = false;
      requestRender(0);
    }
  }
}

function onControlInput() {
  updateOutputs();
  requestRender();
}

function togglePopover(event, buttonId, popoverId) {
  event.stopPropagation();
  const popover = byId(popoverId);
  const willShow = popover.classList.contains("hidden");
  for (const id of ["infoPopover", "copyrightPopover"]) {
    byId(id).classList.add("hidden");
  }
  popover.classList.toggle("hidden", !willShow);
  byId("infoButton").setAttribute("aria-expanded", "false");
  byId("copyrightButton").setAttribute("aria-expanded", "false");
  byId(buttonId).setAttribute("aria-expanded", String(willShow));
}

function closeInfo(event) {
  if (event && (byId("infoPopover").contains(event.target) || byId("copyrightPopover").contains(event.target))) return;
  byId("infoPopover").classList.add("hidden");
  byId("copyrightPopover").classList.add("hidden");
  byId("infoButton").setAttribute("aria-expanded", "false");
  byId("copyrightButton").setAttribute("aria-expanded", "false");
}

async function openCopyrightSite(event) {
  event.preventDefault();
  event.stopPropagation();
  try {
    await shell.openExternal("https://www.kicity.com");
  } catch (error) {
    explainError(error);
  }
}

function wirePanel() {
  if (state.wired) return;
  state.wired = true;
  byId("analyze").addEventListener("click", () => analyze(false));
  byId("manualAnalyze").addEventListener("click", beginManualSelection);
  byId("infoButton").addEventListener("click", (event) => togglePopover(event, "infoButton", "infoPopover"));
  byId("copyrightButton").addEventListener("click", (event) => togglePopover(event, "copyrightButton", "copyrightPopover"));
  byId("copyrightLink").addEventListener("click", openCopyrightSite);
  document.addEventListener("click", closeInfo);
  for (const id of ["amount", "size", "chroma", "seed"]) {
    byId(id).addEventListener("input", onControlInput);
    byId(id).addEventListener("change", onControlInput);
  }

  updateOutputs();
  updateAvailability();
  byId("pluginVersion").textContent = "v" + versions.plugin;
  const bootError = byId("bootError");
  if (bootError) bootError.classList.add("hidden");
}

wirePanel();
entrypoints.setup({panels: {meinoisePanel: {show() { wirePanel(); }}}});

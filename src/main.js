const {entrypoints} = require("uxp");

// Keep the panel controls usable even if Photoshop rejects a host API while
// loading the adapter. The adapter is loaded only when an operation needs it.
let photoshopAdapter = null;
function photoshop() {
  if (!photoshopAdapter) photoshopAdapter = require("./photoshop.js");
  return photoshopAdapter;
}

const DEFAULT_TONE_CURVE = [1.18, 1, 0.72];
const state = {
  target: null,
  previewId: null,
  toneCurve: DEFAULT_TONE_CURVE.slice(),
  busy: false,
  pendingRender: false,
  renderTimer: null,
  awaitingBackgroundSelection: false,
  wired: false
};

function byId(id) { return document.getElementById(id); }

function setStatus(message, isError = false) {
  const status = byId("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function updateAvailability() {
  byId("analyze").disabled = state.busy;
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
    toneCurve: state.toneCurve
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

function setBackgroundSelectionStage(awaiting) {
  state.awaitingBackgroundSelection = awaiting;
  byId("analyze").textContent = awaiting ? "分析所选背景" : "选择背景样本";
  byId("analysisHint").textContent = awaiting
    ? "请在画面中框选背景，然后再次点击上方按钮。"
    : "用于匹配非均质明暗响应；不分析也可直接调节。";
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
  setBackgroundSelectionStage(false);
  byId("analysisResult").classList.add("hidden");
  state.target = ps.captureTarget();
  updateAvailability();
}

async function beginBackgroundSelection() {
  if (state.busy) return;
  setBusy(true);
  setStatus("正在准备背景选区……");
  try {
    await ensureTarget();
    await photoshop().activateBackgroundSelectionTool();
    setBackgroundSelectionStage(true);
    setStatus("请框选靠近目标的干净背景，然后点击“分析所选背景”。");
  } catch (error) {
    explainError(error);
  } finally {
    setBusy(false);
  }
}

function handleAnalyze() {
  if (state.awaitingBackgroundSelection) analyze();
  else beginBackgroundSelection();
}

function requestRender(delay = 260) {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    render();
  }, delay);
}

async function analyze() {
  if (state.busy) return;
  setBusy(true);
  setStatus("正在分析背景颗粒……");
  let succeeded = false;
  let previewWasHidden = false;
  try {
    const ps = photoshop();
    // Locks the currently selected layer before the background selection is read.
    await ensureTarget();
    if (state.previewId && state.target) {
      await ps.setPreviewVisibility(state.target, state.previewId, false);
      previewWasHidden = true;
    }
    const result = await ps.analyzeSelection();
    byId("amount").value = result.amount.toFixed(1);
    byId("size").value = result.size.toFixed(1);
    byId("chroma").value = Math.round(result.chroma);
    state.toneCurve = result.toneCurve;
    updateOutputs();
    const confidence = result.confidence >= 0.7 ? "高" : result.confidence >= 0.4 ? "中" : "低";
    const completeTone = result.tonalCoverage >= 3;
    const resultNode = byId("analysisResult");
    resultNode.textContent = completeTone
      ? `已匹配背景颗粒 · 明暗响应完整 · 置信度${confidence}`
      : `已匹配背景颗粒 · 明暗响应部分使用默认值 · 置信度${confidence}`;
    resultNode.classList.remove("hidden");
    setBackgroundSelectionStage(false);
    setStatus("分析结果已写入参数，正在更新预览……");
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

function toggleInfo(event) {
  event.stopPropagation();
  const popover = byId("infoPopover");
  const willShow = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !willShow);
  byId("infoButton").setAttribute("aria-expanded", String(willShow));
}

function closeInfo(event) {
  if (event && byId("infoPopover").contains(event.target)) return;
  byId("infoPopover").classList.add("hidden");
  byId("infoButton").setAttribute("aria-expanded", "false");
}

function wirePanel() {
  if (state.wired) return;
  state.wired = true;
  byId("analyze").addEventListener("click", handleAnalyze);
  byId("infoButton").addEventListener("click", toggleInfo);
  document.addEventListener("click", closeInfo);
  for (const id of ["amount", "size", "chroma", "seed"]) {
    byId(id).addEventListener("input", onControlInput);
    byId(id).addEventListener("change", onControlInput);
  }

  updateOutputs();
  updateAvailability();
  const bootError = byId("bootError");
  if (bootError) bootError.classList.add("hidden");
}

wirePanel();
entrypoints.setup({panels: {meinoisePanel: {show() { wirePanel(); }}}});

const {entrypoints, versions, shell, host} = require("uxp");
const {setLocale, getLanguage, t} = require("./i18n.js");

setLocale((host && (host.uiLocale || host.locale)) ||
  (typeof navigator !== "undefined" && navigator.language) || "en");

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
const CONTROL_SPECS = {
  amount: {inputId: "amountInput", decimals: 1, integer: false},
  size: {inputId: "sizeInput", decimals: 1, integer: false},
  chroma: {inputId: "chromaInput", decimals: 0, integer: true},
  seed: {inputId: "seedInput", decimals: 0, integer: true}
};
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

function applyLocale() {
  document.documentElement.lang = getLanguage() === "zh" ? "zh-CN" : "en";
  const text = {
    subtitle: "subtitle",
    bootError: "bootError",
    analyze: "analyze",
    manual: "manualAnalyze",
    hint: "analysisHint",
    manualGuideTitle: "manualGuideTitle",
    manualGuide1: "manualGuide1",
    manualGuide2: "manualGuide2",
    manualGuide3: "manualGuide3",
    manualGuide4: "manualGuide4",
    manualGuide5: "manualGuide5",
    ready: "status"
  };
  for (const [key, id] of Object.entries(text)) byId(id).textContent = t(key);
  byId("copyrightButton").setAttribute("aria-label", t("copyrightLabel"));
  byId("manualAnalyze").setAttribute("title", t("manualTitle"));
  byId("infoButton").setAttribute("aria-label", t("infoLabel"));
  for (const id of Object.keys(CONTROL_SPECS)) {
    byId(id).setAttribute("aria-label", t("numericValue", {name: id[0].toUpperCase() + id.slice(1)}));
    byId(CONTROL_SPECS[id].inputId).setAttribute("aria-label",
      t("numericValue", {name: id[0].toUpperCase() + id.slice(1)}));
  }
}

function setStatus(message, isError = false) {
  const status = byId("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function updateAvailability() {
  byId("analyze").disabled = state.busy || state.awaitingManualSelection;
  // Keep the manual button available while waiting so the user can cancel a
  // sampling operation without having to draw a throwaway selection.
  byId("manualAnalyze").disabled = state.busy;
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

function clampControlValue(value, control) {
  const minimum = Number(control.min);
  const maximum = Number(control.max);
  return Math.max(minimum, Math.min(maximum, value));
}

function formatControlValue(id, value) {
  const spec = CONTROL_SPECS[id];
  const normalized = spec.integer ? Math.round(value) : value;
  return normalized.toFixed(spec.decimals);
}

function syncNumberFromSlider(id) {
  const value = Number(byId(id).value);
  byId(CONTROL_SPECS[id].inputId).value = formatControlValue(id, value);
}

function updateOutputs() {
  for (const id of Object.keys(CONTROL_SPECS)) syncNumberFromSlider(id);
}

function explainError(error) {
  console.error(error);
  setStatus(error && error.message ? error.message : String(error), true);
}

function setManualSelectionStage(awaiting) {
  state.awaitingManualSelection = awaiting;
  byId("manualAnalyze").textContent = awaiting ? t("manualCancel") : t("manual");
  byId("analysisHint").textContent = awaiting
    ? t("manualPrompt")
    : t("hint");
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
  if (state.busy) return;
  if (state.awaitingManualSelection) {
    setManualSelectionStage(false);
    setStatus(t("manualCancelled"));
    return;
  }
  setBusy(true);
  setStatus(t("preparingManual"));
  try {
    await ensureTarget();
    await photoshop().listenForBackgroundSelection(onBackgroundSelectionChanged);
    await photoshop().activateBackgroundSelectionTool();
    setManualSelectionStage(true);
    setStatus(t("manualStatus"));
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

function cancelScheduledRender() {
  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }
  state.pendingRender = false;
}

async function analyze(useSelection = false) {
  if (state.busy) return;
  // Analysis produces a fresh parameter set and schedules its own render.
  // Discard a stale slider render so it cannot run again afterwards.
  cancelScheduledRender();
  setBusy(true);
  setStatus(useSelection ? t("analyzingManual") : t("analyzingAuto"));
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
    const confidence = result.confidence >= 0.7 ? t("confidenceHigh") :
      result.confidence >= 0.4 ? t("confidenceMedium") : t("confidenceLow");
    const completeTone = result.tonalCoverage >= 3;
    const resultNode = byId("analysisResult");
    const source = useSelection ? t("selectionSource") :
      t("surroundingSource", {count: result.patchCount || 1});
    const textureNote = result.textureScore >= 0.35 ? t("textureSuppressed") : "";
    resultNode.textContent = completeTone
      ? t("resultComplete", {source, texture: textureNote, confidence})
      : t("resultPartial", {source, texture: textureNote, confidence});
    resultNode.classList.remove("hidden");
    setStatus(t("generatingLayer"));
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
  setStatus(t("updatingPreview"));
  try {
    await ensureTarget();
    state.previewId = await photoshop().renderPreview(state.target, settings(), state.previewId);
    setStatus(t("previewUpdated"));
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

function onNumberInput(id) {
  const spec = CONTROL_SPECS[id];
  const editor = byId(spec.inputId);
  const value = Number(editor.value);
  if (editor.value === "" || !Number.isFinite(value)) return;
  const slider = byId(id);
  if (value < Number(slider.min) || value > Number(slider.max)) return;
  slider.value = spec.integer ? Math.round(value) : value;
  requestRender();
}

function commitNumberInput(id) {
  const spec = CONTROL_SPECS[id];
  const editor = byId(spec.inputId);
  const slider = byId(id);
  let value = Number(editor.value);
  if (editor.value === "" || !Number.isFinite(value)) value = Number(slider.value);
  value = clampControlValue(value, slider);
  if (spec.integer) value = Math.round(value);
  slider.value = value;
  editor.value = formatControlValue(id, Number(slider.value));
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
  applyLocale();
  byId("analyze").addEventListener("click", () => analyze(false));
  byId("manualAnalyze").addEventListener("click", beginManualSelection);
  byId("infoButton").addEventListener("click", (event) => togglePopover(event, "infoButton", "infoPopover"));
  byId("copyrightButton").addEventListener("click", (event) => togglePopover(event, "copyrightButton", "copyrightPopover"));
  byId("copyrightLink").addEventListener("click", openCopyrightSite);
  document.addEventListener("click", closeInfo);
  for (const id of ["amount", "size", "chroma", "seed"]) {
    byId(id).addEventListener("input", onControlInput);
    byId(id).addEventListener("change", onControlInput);
    const editor = byId(CONTROL_SPECS[id].inputId);
    editor.addEventListener("input", () => onNumberInput(id));
    editor.addEventListener("change", () => commitNumberInput(id));
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        commitNumberInput(id);
        editor.blur();
      }
    });
  }

  updateOutputs();
  updateAvailability();
  byId("pluginVersion").textContent = "v" + versions.plugin;
  const bootError = byId("bootError");
  if (bootError) bootError.classList.add("hidden");
}

wirePanel();
entrypoints.setup({panels: {meinoisePanel: {show() { wirePanel(); }}}});

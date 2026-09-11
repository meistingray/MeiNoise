const {entrypoints} = require("uxp");
const photoshop = require("./photoshop.js");

const state = {
  target: null,
  previewId: null,
  toneCurve: [1.18, 1, 0.72],
  seed: 1376312589,
  busy: false,
  renderTimer: null,
  renderSerial: 0,
  wired: false
};

function byId(id) { return document.getElementById(id); }

function setStatus(message, isError = false) {
  const status = byId("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["setTarget", "analyze", "preview", "randomize", "apply", "cancel"]) {
    byId(id).disabled = busy;
  }
}

function settings() {
  return {
    amount: Number(byId("amount").value),
    size: Number(byId("size").value),
    chroma: Number(byId("chroma").value),
    toneCurve: state.toneCurve,
    seed: state.seed
  };
}

function updateOutputs() {
  byId("amountValue").textContent = Number(byId("amount").value).toFixed(1) + "%";
  byId("sizeValue").textContent = Number(byId("size").value).toFixed(1) + " px";
  byId("chromaValue").textContent = Math.round(Number(byId("chroma").value)) + "%";
}

function explainError(error) {
  console.error(error);
  setStatus(error && error.message ? error.message : String(error), true);
}

async function setTarget() {
  if (state.busy) return;
  try {
    if (state.previewId && state.target) await photoshop.cancelPreview(state.target, state.previewId);
    state.previewId = null;
    state.target = photoshop.captureTarget();
    byId("targetName").textContent = state.target.name;
    setStatus("目标已设置。现在在干净背景上创建选区并点击“分析选区”。");
  } catch (error) { explainError(error); }
}

async function analyze() {
  if (state.busy) return;
  if (!state.target) return setStatus("请先设置目标图层。", true);
  setBusy(true);
  setStatus("正在分析背景颗粒……");
  let shouldRender = false;
  try {
    const result = await photoshop.analyzeSelection();
    byId("amount").value = result.amount.toFixed(1);
    byId("size").value = result.size.toFixed(1);
    byId("chroma").value = Math.round(result.chroma);
    state.toneCurve = result.toneCurve;
    updateOutputs();
    const confidence = result.confidence >= 0.7 ? "高" : result.confidence >= 0.4 ? "中" : "低";
    const coverage = result.tonalCoverage >= 3 ? "完整明暗响应" : "部分明暗响应";
    const resultNode = byId("analysisResult");
    resultNode.textContent = `样本 ${result.sampleCount.toLocaleString()} px · 置信度${confidence} · ${coverage}`;
    resultNode.classList.remove("hidden");
    setStatus("分析完成。可微调参数，然后在画布中检查匹配效果。");
    shouldRender = byId("autoPreview").checked;
  } catch (error) { explainError(error); }
  finally { setBusy(false); }
  if (shouldRender) await render();
}

async function render() {
  if (state.busy) return;
  if (!state.target) return setStatus("请先设置目标图层。", true);
  const serial = ++state.renderSerial;
  const oldPreview = state.previewId;
  setBusy(true);
  setStatus("正在生成画布预览……");
  try {
    const newId = await photoshop.renderPreview(state.target, settings(), oldPreview);
    if (serial === state.renderSerial) state.previewId = newId;
    setStatus("预览已更新。颗粒层已剪贴到目标图层，背景保持可见。");
  } catch (error) {
    // A failed render rolls Photoshop history back, restoring the old preview.
    state.previewId = oldPreview;
    explainError(error);
  } finally { setBusy(false); }
}

function scheduleRender() {
  updateOutputs();
  if (!byId("autoPreview").checked || !state.target) return;
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    render();
  }, 450);
}

async function randomize() {
  state.seed = (Math.random() * 0x7fffffff) | 0;
  setStatus("Seed 已更换。");
  if (byId("autoPreview").checked) await render();
}

async function cancel() {
  if (state.busy || !state.previewId) return;
  setBusy(true);
  try {
    await photoshop.cancelPreview(state.target, state.previewId);
    state.previewId = null;
    setStatus("预览已删除，目标图层没有被修改。");
  } catch (error) { explainError(error); }
  finally { setBusy(false); }
}

async function apply() {
  if (state.busy) return;
  setBusy(true);
  try {
    await photoshop.applyPreview(state.target, state.previewId);
    state.previewId = null;
    setStatus("已应用为独立的 MeiNoise Grain 剪贴图层。");
  } catch (error) { explainError(error); }
  finally { setBusy(false); }
}

function wirePanel() {
  if (state.wired) return;
  state.wired = true;
  byId("setTarget").addEventListener("click", setTarget);
  byId("analyze").addEventListener("click", analyze);
  byId("preview").addEventListener("click", render);
  byId("randomize").addEventListener("click", randomize);
  byId("cancel").addEventListener("click", cancel);
  byId("apply").addEventListener("click", apply);
  for (const id of ["amount", "size", "chroma"]) {
    byId(id).addEventListener("input", updateOutputs);
    byId(id).addEventListener("change", scheduleRender);
  }
  updateOutputs();
}

entrypoints.setup({
  panels: {
    meinoisePanel: {
      show() { wirePanel(); }
    }
  }
});

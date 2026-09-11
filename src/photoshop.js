const {app, core, imaging, constants, action} = require("photoshop");
const {analyzeGrain, combineGrainAnalyses, generateGrainBand, clamp} = require("./math.js");

const GRAIN_PREFIX = "MeiNoise - ";
const MAX_ANALYSIS_EDGE = 512;
const BAND_HEIGHT = 192;
let backgroundSelectionHandler = null;
let backgroundSelectionListenerInstalled = false;

function numberValue(value) {
  return value && typeof value === "object" && "value" in value ? value.value : Number(value);
}

function normalizeBounds(bounds, document) {
  return {
    left: Math.max(0, Math.floor(numberValue(bounds.left))),
    top: Math.max(0, Math.floor(numberValue(bounds.top))),
    right: Math.min(Math.floor(numberValue(document.width)), Math.ceil(numberValue(bounds.right))),
    bottom: Math.min(Math.floor(numberValue(document.height)), Math.ceil(numberValue(bounds.bottom)))
  };
}

function findLayer(layers, id) {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    if (layer.layers) {
      const child = findLayer(layer.layers, id);
      if (child) return child;
    }
  }
  return null;
}

function activeDocument() {
  if (!app.documents.length) throw new Error("请先打开一个 Photoshop 文档。");
  return app.activeDocument;
}

function documentById(documentId) {
  for (const document of app.documents) {
    if (document.id === documentId) return document;
  }
  return null;
}

function validateDocument(document) {
  const documentModes = constants.DocumentMode || {};
  const mode = document.mode;
  const isRgb = mode === undefined || mode === null ||
    mode === documentModes.RGB || String(mode).toLowerCase().includes("rgb");
  if (!isRgb) throw new Error("MeiNoise 目前只支持 RGB 文档。");

  // UXP returns a BitsPerChannelType enum (for example "bitDepth8"), not
  // the numeric value shown in Photoshop's document tab.
  const depthTypes = constants.BitsPerChannelType || {};
  const depth = document.bitsPerChannel === undefined
    ? (document.depth === undefined ? 8 : document.depth)
    : document.bitsPerChannel;
  const normalizedDepth = String(depth).toLowerCase();
  const isEight = depth === depthTypes.EIGHT || depth === 8 ||
    normalizedDepth === "8" || normalizedDepth === "bitdepth8";
  const isSixteen = depth === depthTypes.SIXTEEN || depth === 16 ||
    normalizedDepth === "16" || normalizedDepth === "bitdepth16";
  if (!isEight && !isSixteen) throw new Error("MeiNoise 目前只支持 8 位和 16 位文档。");
}

function captureTarget() {
  const document = activeDocument();
  validateDocument(document);
  const layer = document.activeLayers && document.activeLayers[0];
  if (!layer) throw new Error("请选择一个目标图层。");
  if (layer.name.startsWith(GRAIN_PREFIX)) throw new Error("请选择需要匹配颗粒的原图层，而不是 MeiNoise 颗粒层。");
  const bounds = normalizeBounds(layer.boundsNoEffects || layer.bounds, document);
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) throw new Error("目标图层没有可处理的像素范围。");
  return {documentId: document.id, layerId: layer.id, name: layer.name, bounds};
}

async function activateBackgroundSelectionTool() {
  await core.executeAsModal(async () => {
    const document = activeDocument();
    if (document.selection && document.selection.bounds) {
      await document.selection.deselect();
    }
    const result = await action.batchPlay([{
      _obj: "select",
      _target: [{_ref: "marqueeRectTool"}],
      _options: {dialogOptions: "dontDisplay"}
    }], {});
    if (result && result[0] && result[0]._obj === "error") {
      throw new Error(result[0].message || "无法切换到矩形选框工具。");
    }
  }, {commandName: "Select MeiNoise background sample"});
}

function hasBackgroundSelection(documentId) {
  const document = documentById(documentId);
  return Boolean(document && document.selection && document.selection.bounds);
}

async function listenForBackgroundSelection(handler) {
  backgroundSelectionHandler = handler;
  if (backgroundSelectionListenerInstalled) return;
  await action.addNotificationListener(["set"], (eventName, descriptor) => {
    if (!backgroundSelectionHandler) return;
    const description = JSON.stringify(descriptor || {}).toLowerCase();
    if (description.includes("selection")) backgroundSelectionHandler();
  });
  backgroundSelectionListenerInstalled = true;
}

function getActiveLayerIdentity() {
  const document = activeDocument();
  const layer = document.activeLayers && document.activeLayers[0];
  if (!layer) throw new Error("请选择要添加颗粒的图层。");
  return {documentId: document.id, layerId: layer.id, name: layer.name};
}

function resolveTarget(target) {
  const document = activeDocument();
  if (!target || document.id !== target.documentId) throw new Error("目标文档已改变，请重新设置目标图层。");
  validateDocument(document);
  const layer = findLayer(document.layers, target.layerId);
  if (!layer) throw new Error("目标图层已不存在，请重新设置。");
  return {document, layer, bounds: normalizeBounds(layer.boundsNoEffects || layer.bounds, document)};
}

function autoSampleBounds(targetBounds, document) {
  const documentWidth = Math.floor(numberValue(document.width));
  const documentHeight = Math.floor(numberValue(document.height));
  const width = targetBounds.right - targetBounds.left;
  const height = targetBounds.bottom - targetBounds.top;
  const shortEdge = Math.max(1, Math.min(width, height));
  const patch = Math.round(clamp(shortEdge * 0.18, 24, 128));
  const gaps = shortEdge < 64 ? [2, Math.max(6, Math.round(shortEdge * 0.18))] :
    [Math.round(clamp(shortEdge * 0.025, 3, 18))];
  const positions = [0.18, 0.5, 0.82];
  const result = [];
  const seen = new Set();

  function add(left, top, right, bottom) {
    const bounds = {
      left: Math.max(0, Math.round(left)),
      top: Math.max(0, Math.round(top)),
      right: Math.min(documentWidth, Math.round(right)),
      bottom: Math.min(documentHeight, Math.round(bottom))
    };
    if (bounds.right - bounds.left < 8 || bounds.bottom - bounds.top < 8) return;
    const key = `${bounds.left}:${bounds.top}:${bounds.right}:${bounds.bottom}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(bounds);
    }
  }

  for (const gap of gaps) {
    for (const position of positions) {
      const centerX = targetBounds.left + width * position;
      const centerY = targetBounds.top + height * position;
      add(centerX - patch / 2, targetBounds.top - gap - patch, centerX + patch / 2, targetBounds.top - gap);
      add(centerX - patch / 2, targetBounds.bottom + gap, centerX + patch / 2, targetBounds.bottom + gap + patch);
      add(targetBounds.left - gap - patch, centerY - patch / 2, targetBounds.left - gap, centerY + patch / 2);
      add(targetBounds.right + gap, centerY - patch / 2, targetBounds.right + gap + patch, centerY + patch / 2);
    }
  }
  return result.slice(0, 24);
}

async function analyzeAroundTarget(target) {
  const resolved = resolveTarget(target);
  const candidates = autoSampleBounds(resolved.bounds, resolved.document);
  if (!candidates.length) {
    throw new Error("目标图层周围没有可采样区域。请点击“手动”框选背景样本。");
  }
  return core.executeAsModal(async () => {
    const analyses = [];
    for (const bounds of candidates) {
      let pixels;
      try {
        // No layerID: sample the visible document composite surrounding the
        // target. Patches stay at native resolution so fine grain is preserved.
        pixels = await imaging.getPixels({
          documentID: resolved.document.id,
          sourceBounds: bounds,
          componentSize: 8,
          colorSpace: "RGB",
          applyAlpha: true
        });
        const data = await pixels.imageData.getData({chunky: true});
        try {
          analyses.push(analyzeGrain({
            data,
            width: pixels.imageData.width,
            height: pixels.imageData.height,
            components: pixels.imageData.components,
            componentSize: pixels.imageData.componentSize
          }));
        } catch (error) {
          // Edges and detailed patches are expected; other patches can carry
          // the estimate. Only fail after all candidates have been considered.
          if (!error || !String(error.message || error).includes("有效样本不足")) throw error;
        }
      } finally {
        if (pixels && pixels.imageData) pixels.imageData.dispose();
      }
    }
    return combineGrainAnalyses(analyses);
  }, {commandName: "Analyze MeiNoise surrounding background"});
}

async function analyzeSelection() {
  return core.executeAsModal(async () => {
    const document = activeDocument();
    validateDocument(document);
    const selectionBounds = document.selection && document.selection.bounds;
    if (!selectionBounds) throw new Error("请先在干净背景上创建一个选区。");
    const bounds = normalizeBounds(selectionBounds, document);
    const sourceWidth = bounds.right - bounds.left;
    const sourceHeight = bounds.bottom - bounds.top;
    if (sourceWidth < 8 || sourceHeight < 8) throw new Error("背景选区太小。");
    const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(sourceWidth, sourceHeight));
    const targetSize = scale < 1 ? {
      width: Math.max(8, Math.round(sourceWidth * scale)),
      height: Math.max(8, Math.round(sourceHeight * scale))
    } : undefined;

    const pixelOptions = {
      documentID: document.id,
      sourceBounds: bounds,
      componentSize: 8,
      colorSpace: "RGB",
      applyAlpha: true
    };
    if (targetSize) pixelOptions.targetSize = targetSize;
    const selectionOptions = {documentID: document.id, sourceBounds: bounds, componentSize: 8};
    if (targetSize) selectionOptions.targetSize = targetSize;

    let pixels;
    let selection;
    try {
      pixels = await imaging.getPixels(pixelOptions);
      selection = await imaging.getSelection(selectionOptions);
      const data = await pixels.imageData.getData({chunky: true});
      const mask = await selection.imageData.getData({chunky: true});
      return analyzeGrain({
        data,
        mask,
        width: pixels.imageData.width,
        height: pixels.imageData.height,
        components: pixels.imageData.components,
        componentSize: pixels.imageData.componentSize,
        documentScale: sourceWidth / pixels.imageData.width
      });
    } finally {
      if (pixels && pixels.imageData) pixels.imageData.dispose();
      if (selection && selection.imageData) selection.imageData.dispose();
    }
  }, {commandName: "Analyze MeiNoise background selection"});
}

async function deleteLayerById(document, layerId) {
  if (!layerId) return;
  const layer = findLayer(document.layers, layerId);
  if (layer) await layer.delete();
}

async function renderPreview(target, settings, previousPreviewId, onProgress) {
  const resolved = resolveTarget(target);
  const {document, layer: targetLayer, bounds} = resolved;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0) throw new Error("目标图层没有可处理的像素范围。");

  return core.executeAsModal(async (executionContext) => {
    const suspension = await executionContext.hostControl.suspendHistory({
      documentID: document.id,
      name: "Update MeiNoise preview"
    });
    try {
      if (previousPreviewId) await deleteLayerById(document, previousPreviewId);
      const preview = await document.createLayer({
        name: GRAIN_PREFIX + target.name,
        blendMode: constants.BlendMode.LINEARLIGHT,
        fillNeutral: false,
        opacity: 100
      });
      preview.move(targetLayer, constants.ElementPlacement.PLACEBEFORE);
      preview.isClippingMask = true;

      for (let offsetY = 0; offsetY < height; offsetY += BAND_HEIGHT) {
        if (executionContext.isCancelled) throw new Error("预览已取消。");
        const bandHeight = Math.min(BAND_HEIGHT, height - offsetY);
        let source;
        let outputImage;
        try {
          source = await imaging.getPixels({
            documentID: document.id,
            layerID: targetLayer.id,
            sourceBounds: {
              left: bounds.left,
              top: bounds.top + offsetY,
              right: bounds.right,
              bottom: bounds.top + offsetY + bandHeight
            },
            componentSize: -1,
            colorSpace: "RGB"
          });
          if (source.imageData.componentSize !== 8 && source.imageData.componentSize !== 16) {
            throw new Error("MeiNoise 目前只支持 8 位和 16 位文档。");
          }
          const sourceData = await source.imageData.getData({chunky: true, fullRange: true});
          const actual = source.sourceBounds;
          const actualLeft = Math.round(numberValue(actual.left));
          const actualTop = Math.round(numberValue(actual.top));
          const actualWidth = source.imageData.width;
          const actualHeight = source.imageData.height;
          const grain = generateGrainBand({
            targetData: sourceData,
            width: actualWidth,
            height: actualHeight,
            components: source.imageData.components,
            componentSize: source.imageData.componentSize,
            originX: actualLeft,
            originY: actualTop,
            amount: clamp(settings.amount, 0, 12),
            size: clamp(settings.size, 0.5, 6),
            structure: clamp(settings.structure === undefined ? 0.65 : settings.structure, 0, 1),
            chroma: clamp(settings.chroma, 0, 100),
            seed: settings.seed | 0,
            toneCurve: settings.toneCurve
          });
          outputImage = await imaging.createImageDataFromBuffer(grain, {
            width: actualWidth,
            height: actualHeight,
            components: 3,
            chunky: true,
            colorSpace: "RGB",
            colorProfile: source.imageData.colorProfile || document.colorProfileName || "",
            fullRange: source.imageData.componentSize === 16
          });
          await imaging.putPixels({
            documentID: document.id,
            layerID: preview.id,
            imageData: outputImage,
            replace: offsetY === 0,
            targetBounds: {left: actualLeft, top: actualTop},
            commandName: "Render MeiNoise preview"
          });
        } finally {
          if (source && source.imageData) source.imageData.dispose();
          if (outputImage) outputImage.dispose();
        }
        const progress = Math.min(1, (offsetY + bandHeight) / height);
        executionContext.reportProgress({value: progress, commandName: "生成 MeiNoise 预览"});
        if (onProgress) onProgress(progress);
      }
      await executionContext.hostControl.resumeHistory(suspension, true);
      return preview.id;
    } catch (error) {
      await executionContext.hostControl.resumeHistory(suspension, false);
      throw error;
    }
  }, {commandName: "Update MeiNoise preview"});
}

async function cancelPreview(target, previewId) {
  if (!previewId) return;
  // Cleanup must not depend on the original target still existing. This lets a
  // deleted target be replaced by a newly selected layer without trapping the UI.
  const document = target && documentById(target.documentId);
  if (!document) return;
  await core.executeAsModal(async () => deleteLayerById(document, previewId), {commandName: "Cancel MeiNoise"});
}

async function applyPreview(target, previewId) {
  if (!previewId) throw new Error("请先生成预览。");
  const resolved = resolveTarget(target);
  await core.executeAsModal(async () => {
    const layer = findLayer(resolved.document.layers, previewId);
    if (!layer) throw new Error("预览图层已不存在，请重新生成。");
    layer.name = GRAIN_PREFIX + target.name;
  }, {commandName: "Apply MeiNoise"});
}

async function setPreviewVisibility(target, previewId, visible) {
  if (!previewId) return;
  const resolved = resolveTarget(target);
  await core.executeAsModal(async () => {
    const layer = findLayer(resolved.document.layers, previewId);
    if (layer) layer.visible = visible;
  }, {commandName: visible ? "Show MeiNoise preview" : "Hide MeiNoise preview"});
}

module.exports = {
  captureTarget,
  getActiveLayerIdentity,
  activateBackgroundSelectionTool,
  hasBackgroundSelection,
  listenForBackgroundSelection,
  autoSampleBounds,
  analyzeAroundTarget,
  analyzeSelection,
  renderPreview,
  cancelPreview,
  applyPreview,
  setPreviewVisibility,
  resolveTarget
};

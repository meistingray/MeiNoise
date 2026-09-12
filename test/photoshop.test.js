const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function imageData(data, width, height, components, componentSize = 8) {
  return {
    width,
    height,
    components,
    componentSize,
    colorProfile: "sRGB IEC61966-2.1",
    async getData() { return data; },
    dispose() { this.disposed = true; }
  };
}

function createFixture() {
  const calls = {putPixels: [], history: [], progress: [], modalDepth: 0};
  const target = {
    id: 10,
    name: "Pasted subject",
    boundsNoEffects: {left: 40, top: 30, right: 88, bottom: 78},
    layers: null
  };
  const document = {
    id: 1,
    width: 128,
    height: 112,
    mode: "RGBColorMode",
    bitsPerChannel: "bitDepth8",
    colorProfileName: "sRGB IEC61966-2.1",
    activeLayers: [target],
    layers: [target],
    selection: {
      bounds: {left: 0, top: 0, right: 20, bottom: 20},
      async deselect() { this.bounds = null; }
    },
    async createLayer(options) {
      const layer = {
        id: 99,
        name: options.name,
        blendMode: options.blendMode,
        layers: null,
        move(relative, placement) { this.moved = {relative, placement}; },
        delete() { this.deleted = true; }
      };
      this.layers.unshift(layer);
      return layer;
    }
  };

  const photoshopMock = {
    app: {documents: [document], activeDocument: document},
    constants: {
      BitsPerChannelType: {EIGHT: "bitDepth8", SIXTEEN: "bitDepth16", THIRTYTWO: "bitDepth32"},
      DocumentMode: {RGB: "RGBColorMode", CMYK: "CMYKColorMode"},
      BlendMode: {LINEARLIGHT: "linearLight"},
      ElementPlacement: {PLACEBEFORE: "placeBefore"}
    },
    action: {
      async addNotificationListener(events, callback) {
        calls.notificationEvents = events;
        calls.notificationCallback = callback;
      },
      async batchPlay(descriptors) {
        calls.batchPlay = descriptors;
        return [{}];
      }
    },
    core: {
      async executeAsModal(callback) {
        calls.modalDepth++;
        try {
          return await callback({
            isCancelled: false,
            reportProgress(value) { calls.progress.push(value); },
            hostControl: {
              async suspendHistory(value) { calls.history.push(["suspend", value]); return {id: 7}; },
              async resumeHistory(value, commit) { calls.history.push(["resume", value, commit]); }
            }
          });
        } finally {
          calls.modalDepth--;
        }
      }
    },
    imaging: {
      async getPixels(options) {
        if (calls.modalDepth < 1) throw new Error("imaging.getPixels called outside modal scope");
        const bounds = options.sourceBounds;
        const width = Math.round(bounds.right - bounds.left);
        const height = Math.round(bounds.bottom - bounds.top);
        if (options.layerID) {
          const data = new Uint8Array(width * height * 4).fill(128);
          for (let i = 3; i < data.length; i += 4) data[i] = 255;
          return {imageData: imageData(data, width, height, 4), sourceBounds: bounds};
        }
        const data = new Uint8Array(width * height * 3).fill(128);
        return {imageData: imageData(data, width, height, 3), sourceBounds: bounds};
      },
      async getSelection(options) {
        if (calls.modalDepth < 1) throw new Error("imaging.getSelection called outside modal scope");
        const bounds = options.sourceBounds;
        const width = Math.round(bounds.right - bounds.left);
        const height = Math.round(bounds.bottom - bounds.top);
        return {imageData: imageData(new Uint8Array(width * height).fill(255), width, height, 1)};
      },
      async createImageDataFromBuffer(data, options) {
        return imageData(data, options.width, options.height, options.components, data instanceof Uint16Array ? 16 : 8);
      },
      async putPixels(options) { calls.putPixels.push(options); }
    }
  };
  return {photoshopMock, document, target, calls};
}

test("Photoshop adapter captures, analyzes, and renders a clipped preview", async () => {
  const fixture = createFixture();
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "photoshop") return fixture.photoshopMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  let adapter;
  try {
    adapter = require("../src/photoshop.js");
  } finally {
    Module._load = originalLoad;
  }

  const captured = adapter.captureTarget();
  assert.equal(captured.layerId, fixture.target.id);
  assert.equal(adapter.getActiveLayerIdentity().layerId, fixture.target.id);
  let selectionNotificationCount = 0;
  await adapter.listenForBackgroundSelection(() => selectionNotificationCount++);
  assert.deepEqual(fixture.calls.notificationEvents, ["set"]);
  fixture.calls.notificationCallback("set", {_target: [{_ref: "channel", _property: "selection"}]});
  assert.equal(selectionNotificationCount, 1);
  await adapter.activateBackgroundSelectionTool();
  assert.equal(fixture.calls.batchPlay[0]._target[0]._ref, "marqueeRectTool");
  assert.equal(adapter.hasBackgroundSelection(fixture.document.id), false);
  fixture.document.selection.bounds = {left: 0, top: 0, right: 20, bottom: 20};
  assert.equal(adapter.hasBackgroundSelection(fixture.document.id), true);
  const analysis = await adapter.analyzeSelection();
  assert.ok(analysis.sampleCount >= 128);
  const automatic = await adapter.analyzeAroundTarget(captured);
  assert.ok(automatic.patchCount >= 1);
  assert.ok(automatic.candidateCount >= automatic.patchCount);
  assert.equal(fixture.calls.modalDepth, 0);

  const previewId = await adapter.renderPreview(captured, {
    amount: 2,
    size: 1,
    chroma: 15,
    seed: 42,
    toneCurve: [1, 1, 1]
  });
  assert.equal(previewId, 99);
  const preview = fixture.document.layers[0];
  assert.equal(preview.name, "MeiNoise - Pasted subject");
  assert.equal(preview.blendMode, "linearLight");
  assert.equal(preview.isClippingMask, true);
  assert.deepEqual(preview.moved, {relative: fixture.target, placement: "placeBefore"});
  assert.equal(fixture.calls.putPixels.length, 1);
  assert.equal(fixture.calls.history[0][0], "suspend");
  assert.deepEqual(fixture.calls.history.at(-1).slice(0, 1), ["resume"]);
  assert.equal(fixture.calls.history.at(-1)[2], true);

  await adapter.setPreviewVisibility(captured, previewId, false);
  assert.equal(preview.visible, false);
  await adapter.setPreviewVisibility(captured, previewId, true);
  assert.equal(preview.visible, true);

  fixture.document.layers = [preview];
  await assert.doesNotReject(() => adapter.cancelPreview(captured, previewId));
  assert.equal(preview.deleted, true);
});

test("automatic sample planning stays native-sized and bounded", () => {
  const fixture = createFixture();
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "photoshop") return fixture.photoshopMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let adapter;
  try {
    delete require.cache[require.resolve("../src/photoshop.js")];
    adapter = require("../src/photoshop.js");
  } finally {
    Module._load = originalLoad;
  }
  const bounds = adapter.autoSampleBounds({left: 3000, top: 2000, right: 9000, bottom: 7000}, {width: 12000, height: 9000});
  assert.ok(bounds.length > 0 && bounds.length <= 24);
  for (const patch of bounds) {
    assert.ok(patch.right - patch.left <= 128);
    assert.ok(patch.bottom - patch.top <= 128);
    assert.ok(patch.left >= 0 && patch.top >= 0 && patch.right <= 12000 && patch.bottom <= 9000);
  }

  const small = adapter.autoSampleBounds({left: 90, top: 90, right: 110, bottom: 110}, {width: 200, height: 200});
  assert.ok(small.length > 12, "small targets should search both near and farther rings");
  assert.deepEqual(adapter.autoSampleBounds({left: 0, top: 0, right: 200, bottom: 200}, {width: 200, height: 200}), []);
});

test("manual sample planning keeps large selections at native resolution", () => {
  const fixture = createFixture();
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "photoshop") return fixture.photoshopMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let adapter;
  try {
    delete require.cache[require.resolve("../src/photoshop.js")];
    adapter = require("../src/photoshop.js");
  } finally {
    Module._load = originalLoad;
  }
  const patches = adapter.manualSampleBounds({left: 20, top: 30, right: 2020, bottom: 1030});
  assert.equal(patches.length, 16);
  for (const patch of patches) {
    assert.equal(patch.right - patch.left, 128);
    assert.equal(patch.bottom - patch.top, 128);
  }
  assert.deepEqual(adapter.manualSampleBounds({left: 2, top: 3, right: 62, bottom: 43}), [
    {left: 2, top: 3, right: 62, bottom: 43}
  ]);
});

test("Photoshop adapter accepts UXP 8-bit and 16-bit enum values", () => {
  for (const depth of ["bitDepth8", "bitDepth16"]) {
    const fixture = createFixture();
    fixture.document.bitsPerChannel = depth;
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "photoshop") return fixture.photoshopMock;
      return originalLoad.call(this, request, parent, isMain);
    };

    let adapter;
    try {
      delete require.cache[require.resolve("../src/photoshop.js")];
      adapter = require("../src/photoshop.js");
    } finally {
      Module._load = originalLoad;
    }
    assert.doesNotThrow(() => adapter.captureTarget());
  }
});

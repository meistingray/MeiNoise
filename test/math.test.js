const test = require("node:test");
const assert = require("node:assert/strict");
const {robustSigma, combineGrainAnalyses, hash2D, toneGain, generateGrainBand, analyzeGrain, correlationKernel} = require("../src/math.js");

test("robustSigma ignores a large outlier", () => {
  const data = [-1, -1, -0.8, -0.5, 0, 0.4, 0.8, 1, 100];
  assert.ok(robustSigma(data) < 2);
});

test("hash is deterministic and coordinate dependent", () => {
  assert.equal(hash2D(12, 34, 56), hash2D(12, 34, 56));
  assert.notEqual(hash2D(12, 34, 56), hash2D(13, 34, 56));
});

test("tone curve interpolates its three anchors", () => {
  assert.equal(toneGain(0, [2, 1, 0.5]), 2);
  assert.equal(toneGain(0.5, [2, 1, 0.5]), 1);
  assert.equal(toneGain(1, [2, 1, 0.5]), 0.5);
});

test("grain output is deterministic and centered around neutral gray", () => {
  const width = 128;
  const height = 128;
  const targetData = new Uint8Array(width * height * 4).fill(128);
  for (let i = 3; i < targetData.length; i += 4) targetData[i] = 255;
  const options = {targetData, width, height, components: 4, componentSize: 8, originX: 0, originY: 0, amount: 3, size: 1.2, chroma: 0, seed: 42, toneCurve: [1, 1, 1]};
  const first = generateGrainBand(options);
  const second = generateGrainBand(options);
  assert.deepEqual(first, second);
  const mean = first.reduce((sum, value) => sum + value, 0) / first.length;
  assert.ok(Math.abs(mean - 127.5) < 1.5, `mean was ${mean}`);
  for (let i = 0; i < first.length; i += 3) {
    assert.equal(first[i], first[i + 1]);
    assert.equal(first[i], first[i + 2]);
  }
});

test("clipped grain does not apply target alpha a second time", () => {
  const opaque = new Uint8Array([128, 128, 128, 255]);
  const translucent = new Uint8Array([128, 128, 128, 64]);
  const options = {width: 1, height: 1, components: 4, componentSize: 8, originX: 3, originY: 4, amount: 8, size: 1, chroma: 0, seed: 42, toneCurve: [1, 1, 1]};
  assert.deepEqual(
    generateGrainBand({...options, targetData: translucent}),
    generateGrainBand({...options, targetData: opaque})
  );
});

test("correlated noise is seamless across Photoshop render bands", () => {
  const width = 72;
  const bandHeight = 40;
  const fullHeight = bandHeight * 2;
  const makeTarget = (height) => {
    const target = new Uint8Array(width * height * 4).fill(112);
    for (let index = 3; index < target.length; index += 4) target[index] = 255;
    return target;
  };
  const base = {
    width, components: 4, componentSize: 8, originX: 17,
    amount: 3, size: 4, structure: 0.8, chroma: 20,
    seed: 91, toneCurve: [1, 1, 1]
  };
  const full = generateGrainBand({...base, targetData: makeTarget(fullHeight), height: fullHeight, originY: 23});
  const top = generateGrainBand({...base, targetData: makeTarget(bandHeight), height: bandHeight, originY: 23});
  const bottom = generateGrainBand({...base, targetData: makeTarget(bandHeight), height: bandHeight, originY: 23 + bandHeight});
  assert.deepEqual(full, new Uint8Array([...top, ...bottom]));
});

test("automatic patch aggregation resists a highly textured outlier", () => {
  const base = (amount, size = 1) => ({amount, size, structure: 0.65, chroma: 12, toneCurve: [1.1, 1, 0.8], sampleCount: 2000, confidence: 0.9, tonalCoverage: 3});
  const result = combineGrainAnalyses([base(2), base(2.1), base(1.9), base(8, 4)]);
  assert.ok(result.amount < 2.2, `amount was ${result.amount}`);
  assert.equal(result.patchCount, 3);
  assert.equal(result.candidateCount, 4);
});

test("aggregation enables direction only when several patches agree", () => {
  const directional = (aspectCandidate) => ({
    amount: 2, size: 4, structure: 0.7, aspectCandidate,
    anisotropicAmount: 2.1, anisotropicSize: 4.5, anisotropicStructure: 0.75,
    anisotropyGain: 0.25, chroma: 12, toneCurve: [1, 1, 1],
    sampleCount: 2000, confidence: 0.9, tonalCoverage: 3
  });
  const agreed = combineGrainAnalyses([directional(0.8), directional(0.82), directional(0.78)]);
  assert.ok(agreed.aspect < 0.85, `aspect was ${agreed.aspect}`);
  assert.ok(agreed.size > 4.4, `size was ${agreed.size}`);

  const disputed = combineGrainAnalyses([directional(0.8), directional(1.25), directional(1)]);
  assert.equal(disputed.aspect, 1);
  assert.equal(disputed.size, 4);
});

test("normalized coarse branch makes Size increase spatial persistence", () => {
  function neighborCorrelation(size, aspect = 1, direction = "x") {
    const model = correlationKernel(size, 0.65, aspect);
    const kernelAt = (x, y) => {
      if (Math.abs(x) > model.radiusX || Math.abs(y) > model.radiusY) return 0;
      const gaussian = model.weightsX[x + model.radiusX] * model.weightsY[y + model.radiusY] /
        model.gaussianNormalization;
      return (model.fineWeight * (x === 0 && y === 0 ? 1 : 0) + model.coarseWeight * gaussian) /
        model.normalization;
    };
    let variance = 0;
    let covariance = 0;
    for (let y = -model.radiusY; y <= model.radiusY; y++) {
      for (let x = -model.radiusX; x <= model.radiusX; x++) {
        const value = kernelAt(x, y);
        variance += value * value;
        covariance += value * kernelAt(x + (direction === "x" ? 1 : 0), y + (direction === "y" ? 1 : 0));
      }
    }
    return covariance / variance;
  }
  const measured = [1.5, 3, 5].map((size) => neighborCorrelation(size));
  assert.ok(measured[0] < measured[1] && measured[1] < measured[2], measured.join(", "));
  assert.ok(neighborCorrelation(4, 0.8, "y") > neighborCorrelation(4, 0.8, "x"));
});

test("analysis returns bounded controls for a noisy flat patch", () => {
  const width = 96;
  const height = 96;
  const data = new Uint8Array(width * height * 3);
  const mask = new Uint8Array(width * height).fill(255);
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < data.length; i++) data[i] = Math.round(128 + (random() - 0.5) * 18);
  const result = analyzeGrain({data, mask, width, height, components: 3, componentSize: 8});
  assert.ok(result.amount >= 0.1 && result.amount <= 12);
  assert.ok(result.size >= 0.5 && result.size <= 6);
  assert.ok(result.structure >= 0 && result.structure <= 1);
  assert.ok(result.chroma >= 0 && result.chroma <= 100);
  assert.equal(result.toneCurve.length, 3);
  assert.ok(result.chroma > 70, `independent RGB noise gave Chroma ${result.chroma}`);
});

test("correlated generator keeps Amount stable and Size analysis monotonic", () => {
  const width = 192;
  const height = 192;
  const pixels = width * height;
  const targetData = new Uint8Array(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel++) {
    targetData[pixel * 4] = 96;
    targetData[pixel * 4 + 1] = 96;
    targetData[pixel * 4 + 2] = 96;
    targetData[pixel * 4 + 3] = 255;
  }

  const measuredSizes = [];
  for (const size of [1.5, 3, 5]) {
    const grain = generateGrainBand({
      targetData, width, height, components: 4, componentSize: 8,
      originX: 0, originY: 0, amount: 3, size, structure: 0.65,
      chroma: 15, seed: 37, toneCurve: [1, 1, 1]
    });
    const composite = new Uint8Array(pixels * 3);
    for (let index = 0; index < composite.length; index++) {
      composite[index] = Math.max(0, Math.min(255, 96 + 2 * grain[index] - 255));
    }
    const result = analyzeGrain({data: composite, width, height, components: 3, componentSize: 8});
    assert.ok(Math.abs(result.amount - 3) < 0.35, `Size ${size} returned Amount ${result.amount}`);
    assert.ok(Math.abs(result.size - size) < 1.1, `Size ${size} returned Size ${result.size}`);
    assert.ok(Math.abs(result.chroma - 15) < 4, `Chroma was ${result.chroma}`);
    measuredSizes.push(result.size);
  }
  assert.ok(measuredSizes[0] < measuredSizes[1] && measuredSizes[1] < measuredSizes[2], measuredSizes.join(", "));
});

test("analysis recognizes common-channel noise as low Chroma", () => {
  const width = 96;
  const height = 96;
  const data = new Uint8Array(width * height * 3);
  const mask = new Uint8Array(width * height).fill(255);
  let state = 9876;
  for (let pixel = 0; pixel < width * height; pixel++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = Math.round(128 + (state / 4294967296 - 0.5) * 18);
    data[pixel * 3] = value;
    data[pixel * 3 + 1] = value;
    data[pixel * 3 + 2] = value;
  }
  const result = analyzeGrain({data, mask, width, height, components: 3, componentSize: 8});
  assert.ok(result.chroma < 5, `common RGB noise gave Chroma ${result.chroma}`);
});

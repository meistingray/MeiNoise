/* Pure image math. Kept independent from UXP so it can be tested with Node. */

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustSigma(values) {
  if (values.length < 8) return 0;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

function weightedMean(items, readValue) {
  let sum = 0;
  let weightSum = 0;
  for (const item of items) {
    const weight = Math.max(1, item.sampleCount || 0) * (0.35 + 0.65 * clamp(item.confidence || 0, 0, 1));
    sum += readValue(item) * weight;
    weightSum += weight;
  }
  return weightSum ? sum / weightSum : 0;
}

/*
 * Texture tends to inflate a grain estimate, so the automatic sampler anchors
 * itself below the median and only combines patches near that anchor. This is
 * deliberately conservative: adding slightly too little grain is easier to
 * correct than baking scene detail into the noise model.
 */
function combineGrainAnalyses(analyses) {
  if (!analyses || !analyses.length) {
    throw new Error("图层周围没有足够的可用背景。可扩大画布，或点击“手动”框选背景样本。");
  }
  const sorted = analyses.slice().sort((a, b) => a.amount - b.amount);
  const anchor = sorted[Math.floor((sorted.length - 1) * 0.35)].amount;
  const tolerance = Math.max(0.45, anchor * 0.75);
  let selected = sorted.filter((item) => Math.abs(item.amount - anchor) <= tolerance);
  const minimum = Math.min(3, sorted.length);
  if (selected.length < minimum) {
    selected = sorted
      .slice()
      .sort((a, b) => Math.abs(a.amount - anchor) - Math.abs(b.amount - anchor))
      .slice(0, minimum);
  }
  const toneCurve = [0, 1, 2].map((index) => clamp(
    weightedMean(selected, (item) => item.toneCurve[index]), 0.45, 2.2
  ));
  const averageConfidence = weightedMean(selected, (item) => item.confidence);
  return {
    amount: clamp(weightedMean(selected, (item) => item.amount), 0.1, 12),
    size: clamp(weightedMean(selected, (item) => item.size), 0.5, 6),
    structure: clamp(weightedMean(selected, (item) => item.structure === undefined ? 0.65 : item.structure), 0, 1),
    chroma: clamp(weightedMean(selected, (item) => item.chroma), 0, 100),
    toneCurve,
    sampleCount: selected.reduce((sum, item) => sum + item.sampleCount, 0),
    confidence: clamp(averageConfidence * Math.min(1, selected.length / 4), 0, 1),
    tonalCoverage: Math.max(...selected.map((item) => item.tonalCoverage)),
    patchCount: selected.length,
    candidateCount: analyses.length
  };
}

function pixelAt(data, width, components, x, y, component, maxValue) {
  return data[(y * width + x) * components + Math.min(component, components - 1)] / maxValue;
}

function buildChannelIntegrals(data, width, height, components, maxValue) {
  const integralWidth = width + 1;
  const integrals = [
    new Float64Array(integralWidth * (height + 1)),
    new Float64Array(integralWidth * (height + 1)),
    new Float64Array(integralWidth * (height + 1))
  ];
  for (let y = 1; y <= height; y++) {
    const rowSum = [0, 0, 0];
    for (let x = 1; x <= width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        rowSum[channel] += pixelAt(data, width, components, x - 1, y - 1, channel, maxValue);
        integrals[channel][y * integralWidth + x] =
          integrals[channel][(y - 1) * integralWidth + x] + rowSum[channel];
      }
    }
  }
  return {integrals, integralWidth};
}

function boxMean(integral, integralWidth, left, top, right, bottom) {
  const sum = integral[bottom * integralWidth + right] -
    integral[top * integralWidth + right] -
    integral[bottom * integralWidth + left] +
    integral[top * integralWidth + left];
  return sum / Math.max(1, (right - left) * (bottom - top));
}

function gaussianKernel1D(size) {
  const sigma = Math.max(0.18, size * 0.5);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const value = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    weights[offset + radius] = value;
    sum += value;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return {weights, radius};
}

function correlationKernel(size, structure) {
  const {weights, radius} = gaussianKernel1D(size);
  const mix = clamp(structure, 0, 1);
  const centerGaussian = weights[radius] * weights[radius];
  let oneDimEnergy = 0;
  for (const weight of weights) oneDimEnergy += weight * weight;
  const energy = (1 - mix) ** 2 +
    2 * (1 - mix) * mix * centerGaussian +
    mix * mix * oneDimEnergy * oneDimEnergy;
  return {weights, radius, mix, normalization: Math.sqrt(Math.max(energy, 1e-12))};
}

const modelCache = new Map();

function modeledResidualSignature(size, structure, detrendRadius) {
  const model = correlationKernel(size, structure);
  const extent = model.radius + detrendRadius;
  const side = extent * 2 + 1;
  const effective = new Float64Array(side * side);
  const boxSide = detrendRadius * 2 + 1;
  const boxArea = boxSide * boxSide;

  function kernelAt(x, y) {
    if (Math.abs(x) > model.radius || Math.abs(y) > model.radius) return 0;
    const gaussian = model.weights[x + model.radius] * model.weights[y + model.radius];
    const impulse = x === 0 && y === 0 ? 1 : 0;
    return ((1 - model.mix) * impulse + model.mix * gaussian) / model.normalization;
  }

  for (let y = -extent; y <= extent; y++) {
    for (let x = -extent; x <= extent; x++) {
      let localMean = 0;
      for (let by = -detrendRadius; by <= detrendRadius; by++) {
        for (let bx = -detrendRadius; bx <= detrendRadius; bx++) {
          localMean += kernelAt(x - bx, y - by);
        }
      }
      effective[(y + extent) * side + x + extent] = kernelAt(x, y) - localMean / boxArea;
    }
  }

  let variance = 0;
  for (const value of effective) variance += value * value;
  const correlations = [];
  for (let lag = 1; lag <= 6; lag++) {
    let covariance = 0;
    let count = 0;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x + lag < side; x++) {
        covariance += effective[y * side + x] * effective[y * side + x + lag];
        covariance += effective[x * side + y] * effective[(x + lag) * side + y];
        count += 2;
      }
    }
    correlations.push(covariance / Math.max(2 * variance, 1e-12));
  }
  return {correlations, residualStd: Math.sqrt(Math.max(variance, 1e-12))};
}

function correlationModels(detrendRadius) {
  if (modelCache.has(detrendRadius)) return modelCache.get(detrendRadius);
  const models = [];
  for (let size = 0.5; size <= 6.001; size += 0.25) {
    for (let structure = 0; structure <= 1.001; structure += 0.1) {
      const signature = modeledResidualSignature(size, structure, detrendRadius);
      models.push({size, structure, ...signature});
    }
  }
  modelCache.set(detrendRadius, models);
  return models;
}

function fitCorrelationModel(observed, detrendRadius) {
  const weights = [1, 0.8, 0.65, 0.5, 0.38, 0.28];
  let best = null;
  for (const candidate of correlationModels(detrendRadius)) {
    let error = 0;
    for (let i = 0; i < observed.length; i++) {
      error += weights[i] * (observed[i] - candidate.correlations[i]) ** 2;
    }
    // When the fitted field is effectively white, Size is mathematically
    // unidentifiable. A tiny regularizer keeps that case at the compact end
    // instead of overfitting sample noise with a huge, almost-zero mix kernel.
    error += 0.00002 * (candidate.size - 0.5) ** 2 + 0.00001 * candidate.structure ** 2;
    if (!best || error < best.error) best = {...candidate, error};
  }
  return best;
}

function analyzeGrain(options) {
  const {data, width, height, components, componentSize, mask, documentScale = 1} = options;
  if (width < 8 || height < 8 || components < 3) {
    throw new Error("样本太小，请选择至少 8×8 像素的背景区域。");
  }
  const maxValue = componentSize === 16 ? 65535 : 255;
  const lumaResiduals = [];
  const samples = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 180000)));
  const detrendRadius = Math.max(2, Math.min(8, Math.floor((Math.min(width, height) - 3) / 2), Math.floor(Math.min(width, height) / 6)));
  const {integrals, integralWidth} = buildChannelIntegrals(data, width, height, components, maxValue);

  for (let y = detrendRadius; y < height - detrendRadius; y += stride) {
    for (let x = detrendRadius; x < width - detrendRadius; x += stride) {
      const maskIndex = y * width + x;
      if (mask && mask[maskIndex] < 192) continue;
      const r = pixelAt(data, width, components, x, y, 0, maxValue);
      const g = pixelAt(data, width, components, x, y, 1, maxValue);
      const b = pixelAt(data, width, components, x, y, 2, maxValue);
      const left = x - detrendRadius;
      const top = y - detrendRadius;
      const right = x + detrendRadius + 1;
      const bottom = y + detrendRadius + 1;
      const rr = r - boxMean(integrals[0], integralWidth, left, top, right, bottom);
      const rg = g - boxMean(integrals[1], integralWidth, left, top, right, bottom);
      const rb = b - boxMean(integrals[2], integralWidth, left, top, right, bottom);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const residual = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
      const chroma = Math.sqrt(((rr - rg) ** 2 + (rb - rg) ** 2) / 2);

      if (Math.abs(residual) > 0.24 || chroma > 0.34) continue;
      lumaResiduals.push(residual);
      samples.push({x, y, value: residual, channels: [rr, rg, rb]});
    }
  }

  if (lumaResiduals.length < 128) {
    throw new Error("有效样本不足。请扩大选区，并避开明显边缘或纹理。");
  }

  // A second robust pass rejects textured outliers.
  const sigma0 = Math.max(robustSigma(lumaResiduals), 1 / maxValue);
  const threshold = Math.max(4.5 * sigma0, 2 / maxValue);
  const cleanLuma = [];
  const cleanSamples = [];
  const toneBins = [[], [], []];
  const grid = new Map();
  for (const sample of samples) {
    if (Math.abs(sample.value) <= threshold) {
      cleanLuma.push(sample.value);
      cleanSamples.push(sample);
      const r = pixelAt(data, width, components, sample.x, sample.y, 0, maxValue);
      const g = pixelAt(data, width, components, sample.x, sample.y, 1, maxValue);
      const b = pixelAt(data, width, components, sample.x, sample.y, 2, maxValue);
      const luma = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      toneBins[Math.min(2, Math.floor(luma * 3))].push(sample.value);
      grid.set(sample.y * width + sample.x, sample.value);
    }
  }
  const residualSigma = robustSigma(cleanLuma);
  const mean = cleanLuma.reduce((sum, value) => sum + value, 0) / Math.max(1, cleanLuma.length);
  let variance = 0;
  const channelVariance = [0, 0, 0];
  const channelCovariance = [0, 0, 0]; // RG, RB, GB
  const channelMeans = [0, 0, 0];
  for (const sample of cleanSamples) {
    variance += (sample.value - mean) ** 2;
    const [rr, rg, rb] = sample.channels;
    channelMeans[0] += rr;
    channelMeans[1] += rg;
    channelMeans[2] += rb;
  }
  variance /= Math.max(1, cleanLuma.length);
  for (let i = 0; i < 3; i++) channelMeans[i] /= Math.max(1, cleanSamples.length);
  for (const sample of cleanSamples) {
    const values = sample.channels.map((value, index) => value - channelMeans[index]);
    channelVariance[0] += values[0] ** 2;
    channelVariance[1] += values[1] ** 2;
    channelVariance[2] += values[2] ** 2;
    channelCovariance[0] += values[0] * values[1];
    channelCovariance[1] += values[0] * values[2];
    channelCovariance[2] += values[1] * values[2];
  }

  const correlations = [];
  for (let lag = 1; lag <= 6; lag++) {
    let covariance = 0;
    let correlationCount = 0;
    const distance = lag * stride;
    for (const sample of cleanSamples) {
      const right = grid.get(sample.y * width + sample.x + distance);
      const below = grid.get((sample.y + distance) * width + sample.x);
      if (right !== undefined) {
        covariance += (sample.value - mean) * (right - mean);
        correlationCount++;
      }
      if (below !== undefined) {
        covariance += (sample.value - mean) * (below - mean);
        correlationCount++;
      }
    }
    correlations.push(variance > 0 ? covariance / Math.max(1, correlationCount) / variance : 0);
  }
  const fitted = fitCorrelationModel(correlations, detrendRadius);

  const pairCorrelation = [
    channelCovariance[0] / Math.sqrt(Math.max(1e-12, channelVariance[0] * channelVariance[1])),
    channelCovariance[1] / Math.sqrt(Math.max(1e-12, channelVariance[0] * channelVariance[2])),
    channelCovariance[2] / Math.sqrt(Math.max(1e-12, channelVariance[1] * channelVariance[2]))
  ];
  const rgbCorrelation = clamp(pairCorrelation.reduce((sum, value) => sum + value, 0) / 3, 0, 1);
  const chromaMix = 1 - rgbCorrelation;

  const binSigmas = toneBins.map((bin) => bin.length >= 64 ? robustSigma(bin) : 0);
  const fullSigma = residualSigma / Math.max(fitted.residualStd, 1e-6);
  const fallback = residualSigma || 0.01;
  const toneCurve = binSigmas.map((value) => clamp((value || fallback) / fallback, 0.45, 2.2));
  const selectedBins = binSigmas.filter((value) => value > 0).length;
  const sampleCoverage = cleanLuma.length / Math.max(1, samples.length);

  return {
    amount: clamp(fullSigma * 100, 0.1, 12),
    size: clamp(fitted.size * documentScale, 0.5, 6),
    structure: fitted.structure,
    chroma: clamp(100 * chromaMix, 0, 100),
    toneCurve,
    sampleCount: cleanLuma.length,
    confidence: clamp((cleanLuma.length / 5000) * sampleCoverage * (0.7 + 0.1 * selectedBins), 0, 1),
    tonalCoverage: selectedBins
  };
}

// Integer hash with no external provenance/dependency. Returns [0, 1).
function hash2D(x, y, seed) {
  let h = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function gaussianNoise(x, y, seed) {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += hash2D(x, y, seed ^ Math.imul(i + 1, 0x45d9f3b));
  return (sum - 3) * Math.SQRT2;
}

function correlatedNoiseField(width, height, originX, originY, size, structure, seed) {
  const model = correlationKernel(size, structure);
  const padding = model.radius;
  const paddedWidth = width + padding * 2;
  const paddedHeight = height + padding * 2;
  const white = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < paddedHeight; y++) {
    for (let x = 0; x < paddedWidth; x++) {
      white[y * paddedWidth + x] = gaussianNoise(originX + x - padding, originY + y - padding, seed);
    }
  }
  if (model.mix <= 0) {
    const result = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const sourceOffset = (y + padding) * paddedWidth + padding;
      result.set(white.subarray(sourceOffset, sourceOffset + width), y * width);
    }
    return result;
  }

  const horizontal = new Float32Array(paddedHeight * width);
  for (let y = 0; y < paddedHeight; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -padding; k <= padding; k++) {
        value += white[y * paddedWidth + x + padding + k] * model.weights[k + padding];
      }
      horizontal[y * width + x] = value;
    }
  }

  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let blurred = 0;
      for (let k = -padding; k <= padding; k++) {
        blurred += horizontal[(y + padding + k) * width + x] * model.weights[k + padding];
      }
      const center = white[(y + padding) * paddedWidth + x + padding];
      result[y * width + x] = ((1 - model.mix) * center + model.mix * blurred) / model.normalization;
    }
  }
  return result;
}

function toneGain(luma, curve) {
  const values = curve && curve.length === 3 ? curve : [1.18, 1, 0.72];
  if (luma <= 0.5) {
    return values[0] + (values[1] - values[0]) * smoothstep(luma * 2);
  }
  return values[1] + (values[2] - values[1]) * smoothstep((luma - 0.5) * 2);
}

function generateGrainBand(options) {
  const {
    targetData, width, height, components, componentSize, originX, originY,
    amount, size, structure = 0.65, chroma, seed, toneCurve
  } = options;
  const maxValue = componentSize === 16 ? 65535 : 255;
  const OutputArray = componentSize === 16 ? Uint16Array : Uint8Array;
  const output = new OutputArray(width * height * 3);
  const amplitude = amount / 100 * 0.5;
  const chromaMix = clamp(chroma / 100, 0, 1);
  const commonWeight = Math.sqrt(1 - chromaMix);
  const independentWeight = Math.sqrt(chromaMix);
  const lumaIndependentEnergy = 0.2126 ** 2 + 0.7152 ** 2 + 0.0722 ** 2;
  const lumaNormalization = Math.sqrt(commonWeight ** 2 + independentWeight ** 2 * lumaIndependentEnergy);
  const common = correlatedNoiseField(width, height, originX, originY, size, structure, seed);
  const independentR = chromaMix > 0 ? correlatedNoiseField(width, height, originX, originY, size, structure, seed ^ 0x243f6a88) : null;
  const independentG = chromaMix > 0 ? correlatedNoiseField(width, height, originX, originY, size, structure, seed ^ 0x85a308d3) : null;
  const independentB = chromaMix > 0 ? correlatedNoiseField(width, height, originX, originY, size, structure, seed ^ 0x13198a2e) : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = (y * width + x) * components;
      const outputIndex = (y * width + x) * 3;
      const r = targetData[sourceIndex] / maxValue;
      const g = targetData[sourceIndex + 1] / maxValue;
      const b = targetData[sourceIndex + 2] / maxValue;
      const luma = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      // The Photoshop layer is clipped to the target, so target alpha is
      // already applied by the host. Multiplying it here as well creates an
      // alpha-squared, unnaturally clean fringe around antialiased edges.
      const gain = toneGain(luma, toneCurve);
      const pixel = y * width + x;
      const shared = common[pixel] * commonWeight;
      const nr = (shared + (independentR ? independentR[pixel] * independentWeight : 0)) / lumaNormalization;
      const ng = (shared + (independentG ? independentG[pixel] * independentWeight : 0)) / lumaNormalization;
      const nb = (shared + (independentB ? independentB[pixel] * independentWeight : 0)) / lumaNormalization;
      output[outputIndex] = Math.round(clamp(0.5 + nr * amplitude * gain, 0, 1) * maxValue);
      output[outputIndex + 1] = Math.round(clamp(0.5 + ng * amplitude * gain, 0, 1) * maxValue);
      output[outputIndex + 2] = Math.round(clamp(0.5 + nb * amplitude * gain, 0, 1) * maxValue);
    }
  }
  return output;
}

if (typeof module !== "undefined") {
  module.exports = {clamp, median, robustSigma, combineGrainAnalyses, analyzeGrain, hash2D, gaussianNoise, correlationKernel, correlatedNoiseField, toneGain, generateGrainBand};
}

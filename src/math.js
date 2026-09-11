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

function pixelAt(data, width, components, x, y, component, maxValue) {
  return data[(y * width + x) * components + Math.min(component, components - 1)] / maxValue;
}

function channelResidual(data, width, height, components, maxValue, x, y, component) {
  const center = pixelAt(data, width, components, x, y, component, maxValue);
  const blur = (
    pixelAt(data, width, components, x - 1, y - 1, component, maxValue) +
    2 * pixelAt(data, width, components, x, y - 1, component, maxValue) +
    pixelAt(data, width, components, x + 1, y - 1, component, maxValue) +
    2 * pixelAt(data, width, components, x - 1, y, component, maxValue) +
    4 * center +
    2 * pixelAt(data, width, components, x + 1, y, component, maxValue) +
    pixelAt(data, width, components, x - 1, y + 1, component, maxValue) +
    2 * pixelAt(data, width, components, x, y + 1, component, maxValue) +
    pixelAt(data, width, components, x + 1, y + 1, component, maxValue)
  ) / 16;
  return center - blur;
}

function analyzeGrain(options) {
  const {data, width, height, components, componentSize, mask, documentScale = 1} = options;
  if (width < 8 || height < 8 || components < 3) {
    throw new Error("样本太小，请选择至少 8×8 像素的背景区域。");
  }
  const maxValue = componentSize === 16 ? 65535 : 255;
  const lumaResiduals = [];
  const samples = [];
  const toneBins = [[], [], []];
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 180000)));

  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const maskIndex = y * width + x;
      if (mask && mask[maskIndex] < 192) continue;
      const r = pixelAt(data, width, components, x, y, 0, maxValue);
      const g = pixelAt(data, width, components, x, y, 1, maxValue);
      const b = pixelAt(data, width, components, x, y, 2, maxValue);
      const rr = channelResidual(data, width, height, components, maxValue, x, y, 0);
      const rg = channelResidual(data, width, height, components, maxValue, x, y, 1);
      const rb = channelResidual(data, width, height, components, maxValue, x, y, 2);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const residual = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
      const chroma = Math.sqrt(((rr - rg) ** 2 + (rb - rg) ** 2) / 2);

      // Strong high-pass responses are usually edges/detail rather than grain.
      if (Math.abs(residual) > 0.16 || chroma > 0.22) continue;
      lumaResiduals.push(residual);
      toneBins[Math.min(2, Math.floor(luma * 3))].push(residual);
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
  const grid = new Map();
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i].value) <= threshold) {
      cleanLuma.push(samples[i].value);
      grid.set(samples[i].x + ":" + samples[i].y, samples[i].value);
    }
  }
  const sigma = robustSigma(cleanLuma);
  let correlation = 0;
  let correlationCount = 0;
  let variance = 0;
  const channelVariance = [0, 0, 0];
  const channelCovariance = [0, 0, 0]; // RG, RB, GB
  for (const sample of samples) {
    if (Math.abs(sample.value) > threshold) continue;
    variance += sample.value * sample.value;
    const [rr, rg, rb] = sample.channels;
    channelVariance[0] += rr * rr;
    channelVariance[1] += rg * rg;
    channelVariance[2] += rb * rb;
    channelCovariance[0] += rr * rg;
    channelCovariance[1] += rr * rb;
    channelCovariance[2] += rg * rb;
    const neighbor = grid.get((sample.x + stride) + ":" + sample.y);
    if (neighbor !== undefined) {
      correlation += sample.value * neighbor;
      correlationCount++;
    }
  }
  variance /= Math.max(1, cleanLuma.length);
  correlation = variance > 0 ? correlation / Math.max(1, correlationCount) / variance : 0;
  correlation = clamp(correlation, 0, 0.9);

  const pairCorrelation = [
    channelCovariance[0] / Math.sqrt(Math.max(1e-12, channelVariance[0] * channelVariance[1])),
    channelCovariance[1] / Math.sqrt(Math.max(1e-12, channelVariance[0] * channelVariance[2])),
    channelCovariance[2] / Math.sqrt(Math.max(1e-12, channelVariance[1] * channelVariance[2]))
  ];
  const rgbCorrelation = clamp(pairCorrelation.reduce((sum, value) => sum + value, 0) / 3, 0, 1);
  // Invert the common/independent mixture used by generateGrainBand.
  const independent = Math.sqrt(1 - rgbCorrelation);
  const common = Math.sqrt(rgbCorrelation);
  const chromaMix = independent / Math.max(1e-6, independent + common);

  const binSigmas = toneBins.map((bin) => bin.length >= 64 ? robustSigma(bin) : 0);
  const fallback = sigma || 0.01;
  const toneCurve = binSigmas.map((value) => clamp((value || fallback) / fallback, 0.45, 2.2));
  const selectedBins = binSigmas.filter((value) => value > 0).length;
  const sampleCoverage = cleanLuma.length / Math.max(1, samples.length);

  return {
    amount: clamp(sigma * 100 * 2.35, 0.1, 12),
    size: clamp((0.65 + correlation * 3.2) * documentScale, 0.5, 6),
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

function valueNoise(x, y, scale, seed) {
  const sx = x / scale;
  const sy = y / scale;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const tx = smoothstep(sx - x0);
  const ty = smoothstep(sy - y0);
  const a = hash2D(x0, y0, seed) * 2 - 1;
  const b = hash2D(x0 + 1, y0, seed) * 2 - 1;
  const c = hash2D(x0, y0 + 1, seed) * 2 - 1;
  const d = hash2D(x0 + 1, y0 + 1, seed) * 2 - 1;
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}

function grainNoise(x, y, size, seed) {
  const fine = valueNoise(x, y, Math.max(0.55, size), seed);
  const coarse = valueNoise(x, y, Math.max(1.1, size * 2.35), seed ^ 0x6d2b79f5);
  // Empirical normalization keeps Amount broadly stable as Size changes.
  return (fine * 0.82 + coarse * 0.34) * 1.75;
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
    amount, size, chroma, seed, toneCurve
  } = options;
  const maxValue = componentSize === 16 ? 65535 : 255;
  const OutputArray = componentSize === 16 ? Uint16Array : Uint8Array;
  const output = new OutputArray(width * height * 3);
  const amplitude = amount / 100 * 0.5;
  const chromaMix = clamp(chroma / 100, 0, 1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = (y * width + x) * components;
      const outputIndex = (y * width + x) * 3;
      const r = targetData[sourceIndex] / maxValue;
      const g = targetData[sourceIndex + 1] / maxValue;
      const b = targetData[sourceIndex + 2] / maxValue;
      const alpha = components === 4 ? targetData[sourceIndex + 3] / maxValue : 1;
      const luma = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      const gain = toneGain(luma, toneCurve) * alpha;
      const gx = originX + x;
      const gy = originY + y;
      const common = grainNoise(gx, gy, size, seed);
      const nr = common * (1 - chromaMix) + grainNoise(gx, gy, size, seed ^ 0x243f6a88) * chromaMix;
      const ng = common * (1 - chromaMix) + grainNoise(gx, gy, size, seed ^ 0x85a308d3) * chromaMix;
      const nb = common * (1 - chromaMix) + grainNoise(gx, gy, size, seed ^ 0x13198a2e) * chromaMix;
      output[outputIndex] = Math.round(clamp(0.5 + nr * amplitude * gain, 0, 1) * maxValue);
      output[outputIndex + 1] = Math.round(clamp(0.5 + ng * amplitude * gain, 0, 1) * maxValue);
      output[outputIndex + 2] = Math.round(clamp(0.5 + nb * amplitude * gain, 0, 1) * maxValue);
    }
  }
  return output;
}

if (typeof module !== "undefined") {
  module.exports = {clamp, median, robustSigma, analyzeGrain, hash2D, valueNoise, grainNoise, toneGain, generateGrainBand};
}

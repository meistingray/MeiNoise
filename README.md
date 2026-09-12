# MeiNoise

[中文](#中文) · [English](#english)

## 中文

MeiNoise 是一个开源 Photoshop UXP 插件，用于让合成图层的数码摄影噪点与周围背景更一致。它分析目标图层周边或用户选定的背景样本，估算噪点强度、空间相关尺度、成团程度、通道相关性和明暗响应，再生成独立的 Linear Light 中性灰剪贴层。

### 功能

- 支持 Photoshop RGB 8-bit / 16-bit 文档。
- 自动分析目标图层四周的多个原尺寸背景块。
- 可手动框选矩形或不规则背景区域作为样本。
- 自动估算 Amount、Size、隐藏的 Structure、Chroma、方向性和三段明暗响应。
- Amount、Size、Chroma、Seed 可直接输入或拖动调节，并自动更新。
- 使用确定性 Seed，可重复生成同一颗粒排列。
- 按 192 像素高的条带渲染大图，避免整图多缓冲区占用。
- 输出为目标图层上方的独立剪贴颗粒层，不改写目标像素。
- 中文 Photoshop 显示中文；其他界面语言自动显示英文。

### 安装

要求 Photoshop 25.0 或更新版本。

#### 推荐：通过 Creative Cloud Desktop 安装

1. 从 [GitHub Releases](https://github.com/meistingray/MeiNoise/releases/latest) 下载 `MeiNoise.ccx`。
2. 关闭 Photoshop，然后双击 `MeiNoise.ccx`。Creative Cloud Desktop 会自动打开。
3. 阅读“非 Marketplace 插件”警告；确认文件来自本项目后，选择**安装**。
4. 安装成功后重新打开 Photoshop，在**插件 > MeiNoise** 中打开面板。

已安装的插件可在 Creative Cloud Desktop 的**插件 > 管理插件**中禁用或卸载。参见 [Adobe 官方 UXP 插件安装指南](https://developer.adobe.com/uxp/guides/how-to/distribution/install/)。

#### 备选：使用 UPIA 命令行安装

UPIA 适合 Creative Cloud Desktop 未能关联 `.ccx`、离线环境或管理员部署。下面的 `<path-to-MeiNoise.ccx>` 应替换为用户实际下载位置，不要求项目位于特定磁盘或文件夹。

Windows PowerShell：

```powershell
$upia = Join-Path $env:CommonProgramFiles "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
& $upia /install "<path-to-MeiNoise.ccx>"
```

macOS Terminal：

```bash
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
"$UPIA" --install "<path-to-MeiNoise.ccx>"
```

#### 开发与本地打包

在 Adobe UXP Developer Tool 中选择仓库根目录的 `manifest.json`。在仓库根目录运行以下命令，安装包会生成到当前仓库的 `dist/MeiNoise.ccx`，无需固定绝对路径：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

### 使用

1. 选择需要添加颗粒的目标图层。
2. 点击“自动生成噪点”，或先点击“手动采集样本”并框选干净背景。
3. 调节 Amount、Size、Chroma 和 Seed；颗粒层会自动更新。
4. 在图层面板切换 MeiNoise 颗粒层可见性即可比较前后效果。

### 参数

- **Amount**：最终颗粒的近似标准差强度，界面范围为 0–12%。
- **Size**：空间相关模型的视觉尺度，单位为文档像素，范围为 0.5–6 px；它不是单独的“颗粒宽度”或“密度”。
- **Chroma**：RGB 通道独立噪点的混合比例。0% 为完全共用的亮度颗粒，100% 为高度独立的彩色颗粒。
- **Seed**：0–255 的确定性排列编号。
- **Structure（隐藏）**：白噪声分量与高斯相关成团分量的能量混合比例。
- **Aspect（隐藏）**：横纵相关尺度之比；只有多个样本对同一方向达成一致时才启用。
- **Tone curve（隐藏）**：暗部、中间调和亮部三个噪点增益锚点，渲染时平滑插值。

### 当前颗粒算法

#### 1. 自动与手动采样

自动模式根据目标图层短边选择 24–128 px 的方形样本，在图层上、下、左、右的 18%、50%、82% 位置取样，最多保留 24 块。很小的目标会额外搜索较远的一圈；铺满画布且四周没有空间时提示改用手动采样。手动模式把选区切成最多 4×4 个原分辨率样本，每块最大 128×128 px。所有分析保持文档原始像素尺度，不先缩图。

#### 2. 去趋势与稳健残差

RGB 先归一化到 0–1。每个通道用积分图计算局部方框均值，再从像素中减去均值得到高频残差。分析同时使用半径 3 和半径 8 的窗口：小窗口主要测量细噪点，大窗口用于判断宽纹理是否把 Size 或 Amount 虚高。

亮度使用 Rec.709 权重 `0.2126 R + 0.7152 G + 0.0722 B`。过强亮度残差和色差残差先被剔除，随后使用 MAD 稳健标准差：

```text
sigma = 1.4826 × median(|x - median(x)|)
```

第二轮只保留 `|residual| <= max(4.5 × sigma, 2 / channelMax)` 的样本。少于 128 个有效像素时，该块被判为不可用。

#### 3. Size、Structure 与方向拟合

对清理后的亮度残差分别计算横向和纵向 1–6 像素延迟的归一化自相关。拟合模型是两个分量的能量混合：

```text
noise = sqrt(1 - structure) × white
      + sqrt(structure) × normalizedGaussianBlur(white)
```

各候选模型经过与分析相同的局部去趋势，再比较预测自相关与观测自相关。各向同性网格搜索：

- Size：0.5–6，步长 0.25。
- Structure：0–1，步长 0.1。

随后在最佳值附近测试受限方向比例 `2/3, 0.75, 0.8, 0.9, 1.1, 1.25, 4/3, 1.5`。只有方向模型至少改善 15%、样本纹理分数低于 0.35、并且至少 65% 的入选样本同意同一方向时，最终模型才使用 Aspect；否则保持 1:1。

#### 4. Amount、Chroma 与明暗响应

Amount 由稳健残差标准差除以拟合模型经过同样去趋势后的理论标准差得到，因此 Size 或 Structure 改变时不会无意改变总体能量。

Chroma 根据 RR、RG、RB 三个通道残差的两两相关系数估算：通道越相关，越接近亮度噪点；相关性越低，Chroma 越高。

样本按亮度分为暗、中、亮三段，每段有至少 64 个样本才单独估算增益；缺失段使用总体稳健值。三个增益限制在 0.45–2.2，渲染时使用 smoothstep 平滑插值。

#### 5. 多样本聚合与纹理抑制

场景纹理通常只会把噪点估计推高，因此聚合器不直接取所有样本平均值。它先按 Amount 排序，以约第 35 百分位为锚点，仅保留与锚点相差不超过 `max(0.45, 0.75 × anchor)` 的样本，至少保留最多三个最接近者。参数按有效像素数和置信度加权。半径 8 相对半径 3 的 Size、Amount、Structure 膨胀量组成 Texture Score，并降低受污染样本的置信度。

#### 6. 确定性颗粒合成

生成器用全局 `(x, y, seed)` 整数哈希产生可重复的均匀随机数，叠加六次后近似高斯分布。白噪声同时进入脉冲分量和可分离高斯模糊分量；卷积核能量及两分量交叉项均被归一化，因此调节 Size 和 Structure 时 Amount 尽量保持稳定。

Chroma 使用一个共用噪声场和三个独立 RGB 噪声场，以平方根权重混合，并按 Rec.709 亮度能量再次归一化。最终噪点围绕 50% 中性灰生成，应用明暗增益后写入 Linear Light 图层。透明度不在生成器中二次相乘；Photoshop 剪贴层负责目标透明边缘，避免出现 alpha 平方导致的干净光圈。

#### 7. 分块渲染与事务

大图按 192 px 高的条带处理。随机场使用文档全局坐标并为卷积读取足够的上下左右 padding，因此条带边界保持连续。一次更新被包装在 Photoshop 暂停历史事务中；失败或取消时回滚，成功时只留下一个历史步骤。所有 Imaging API 缓冲区都在 `finally` 中释放。

### 开发约束与回归测试

继续开发时应保持以下不变量：

- 分析器与生成器必须使用相同的相关核、去趋势方式和能量定义。
- Size/Structure 改变不应显著改变输出标准差。
- 相同 Seed 与全局坐标必须得到相同噪点，分块边界不得出现接缝。
- 自动聚合不得让单个强纹理块主导结果。
- 剪贴层不得再次乘目标 Alpha。
- 8-bit 和 16-bit 输出、异常回滚、语言切换都必须通过测试。

运行：

```powershell
npm test
```

### 已知限制

- 不支持 CMYK、Lab、灰度和 32-bit 文档。
- 极强纹理、JPEG 块效应、锐化光晕或降噪涂抹仍可能污染估计。
- 当前模型描述的是最终图像中的相关数码噪点，不是相机型号、ISO、曝光或胶片乳剂的物理模型。
- 方向模型只允许有限长宽比，不描述行噪声、固定图样噪声和热像素。
- 如果目标本身属于复杂剪贴组，Photoshop 的剪贴规则可能改变最终作用范围。
- 预览是 CPU 分块生成，不是 GPU 逐帧着色器。

### 许可证与参考

代码以 MIT 许可证发布，并从头实现。设计参考：

- [Adobe UXP Photoshop plugin samples](https://github.com/AdobeDocs/uxp-photoshop-plugin-samples)
- [cinegrain](https://github.com/mr-berndt/cinegrain)
- [SVT-AV1 film grain synthesis documentation](https://github.com/AOMediaCodec/SVT-AV1/blob/master/Docs/Appendix-Film-Grain-Synthesis.md)

---

## English

MeiNoise is an open-source Photoshop UXP plugin for matching the digital photographic noise of a composited layer to its surrounding background. It analyzes nearby or manually selected background samples, estimates amplitude, spatial correlation, clustering, channel correlation, and tonal response, then generates a separate clipped neutral-gray Linear Light layer.

### Features

- Photoshop RGB 8-bit and 16-bit documents.
- Automatic native-resolution sampling around the target layer.
- Manual rectangular or irregular background selections.
- Automatic estimation of Amount, Size, hidden Structure, Chroma, directionality, and a three-point tonal response.
- Direct numeric entry and sliders for Amount, Size, Chroma, and Seed.
- Deterministic Seed values for reproducible grain placement.
- 192-pixel render bands to bound memory use on large documents.
- A separate clipped grain layer; target pixels are never rewritten.
- Chinese UI in Chinese Photoshop and English UI in every other host locale.

### Installation

Photoshop 25.0 or newer is required.

#### Recommended: install through Creative Cloud Desktop

1. Download `MeiNoise.ccx` from [GitHub Releases](https://github.com/meistingray/MeiNoise/releases/latest).
2. Quit Photoshop, then double-click `MeiNoise.ccx`. Creative Cloud Desktop opens automatically.
3. Review the warning for a plugin obtained outside Marketplace. If the file came from this project, choose **Install**.
4. Reopen Photoshop and open the panel from **Plugins > MeiNoise**.

Installed plugins can be disabled or removed under **Plugins > Manage Plugins** in Creative Cloud Desktop. See Adobe's [official UXP plugin installation guide](https://developer.adobe.com/uxp/guides/how-to/distribution/install/).

#### Alternative: install from the UPIA command line

UPIA is useful when `.ccx` files are not associated with Creative Cloud Desktop, for offline systems, or for managed deployment. Replace `<path-to-MeiNoise.ccx>` with the actual downloaded file; the repository does not need to live on a particular drive or in a fixed directory.

Windows PowerShell:

```powershell
$upia = Join-Path $env:CommonProgramFiles "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
& $upia /install "<path-to-MeiNoise.ccx>"
```

macOS Terminal:

```bash
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
"$UPIA" --install "<path-to-MeiNoise.ccx>"
```

#### Development and local packaging

Add the repository-root `manifest.json` in Adobe UXP Developer Tool. From the repository root, run the following command; the package is written to `dist/MeiNoise.ccx` inside the current checkout, with no fixed absolute path:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

### Usage

1. Select the layer that needs grain.
2. Choose “Generate Grain,” or choose “Sample Manually” and select clean background.
3. Adjust Amount, Size, Chroma, and Seed; the grain layer updates automatically.
4. Toggle the MeiNoise layer in the Layers panel to compare before and after.

### Parameters

- **Amount:** approximate standard-deviation amplitude of visible grain, 0–12%.
- **Size:** visual scale of the spatial correlation model in document pixels, 0.5–6 px. It is not independently a particle width or density control.
- **Chroma:** mixture of channel-independent noise. At 0%, every channel shares luminance grain; higher values add independent RGB variation.
- **Seed:** deterministic placement index from 0 to 255.
- **Structure (hidden):** energy mixture between white noise and the Gaussian-correlated clustered component.
- **Aspect (hidden):** horizontal-to-vertical correlation ratio, enabled only when multiple samples agree.
- **Tone curve (hidden):** shadow, midtone, and highlight gain anchors with smooth interpolation.

### Current grain algorithm

#### 1. Automatic and manual sampling

Automatic mode derives 24–128 px square patches from the target's short edge and samples above, below, left, and right at 18%, 50%, and 82% positions, retaining at most 24 patches. Tiny targets add a farther search ring. Manual mode divides the selection into at most 4×4 native-resolution patches, each no larger than 128×128 px. Analysis never downsamples first.

#### 2. Detrending and robust residuals

RGB is normalized to 0–1. Integral images provide a local box mean per channel, which is subtracted to obtain high-frequency residuals. Radius-3 and radius-8 analyses are compared: the compact radius measures fine noise, while the broad radius detects scene texture that inflates Size or Amount.

Luminance uses Rec.709 weights, `0.2126 R + 0.7152 G + 0.0722 B`. Strong luminance and chroma residuals are rejected before a MAD estimate:

```text
sigma = 1.4826 × median(|x - median(x)|)
```

A second pass keeps `|residual| <= max(4.5 × sigma, 2 / channelMax)`. A patch with fewer than 128 valid pixels is rejected.

#### 3. Size, Structure, and direction fitting

Normalized horizontal and vertical autocorrelation is measured at lags 1–6. The fitted model is an energy mixture:

```text
noise = sqrt(1 - structure) × white
      + sqrt(structure) × normalizedGaussianBlur(white)
```

Every candidate is passed through the same detrending operator before its predicted correlation is compared with observation. The isotropic grid searches Size 0.5–6 in 0.25 steps and Structure 0–1 in 0.1 steps.

A local second pass tests aspect ratios `2/3, 0.75, 0.8, 0.9, 1.1, 1.25, 4/3, 1.5`. Directionality is accepted only when it improves fit by at least 15%, the patch texture score is below 0.35, and at least 65% of selected patches agree on the same orientation.

#### 4. Amount, Chroma, and tonal response

Amount is the robust residual deviation divided by the theoretical post-detrending deviation of the fitted model. This prevents Size or Structure from unintentionally changing total energy.

Chroma comes from pairwise RR/RG/RB residual correlation: strong cross-channel correlation implies luminance noise, while weak correlation increases Chroma.

Samples are divided into shadow, midtone, and highlight bins. A bin needs at least 64 samples for an independent estimate; missing bins fall back to the global robust value. Gains are clamped to 0.45–2.2 and interpolated with smoothstep.

#### 5. Multi-patch aggregation and texture suppression

Texture usually biases a noise estimate upward, so patches are not averaged blindly. Analyses are sorted by Amount; approximately the 35th percentile becomes the anchor, and only patches within `max(0.45, 0.75 × anchor)` are retained, with up to three nearest patches as a minimum fallback. Weight combines valid-pixel count and confidence. Inflation between radius-3 and radius-8 estimates forms a Texture Score that reduces contaminated-patch confidence.

#### 6. Deterministic synthesis

A global integer hash of `(x, y, seed)` produces reproducible uniform values; summing six values approximates Gaussian noise. The same white field feeds an impulse branch and a separable Gaussian branch. Kernel energy and branch cross-energy are normalized, keeping Amount approximately stable as Size and Structure change.

Chroma mixes one shared field with three independent RGB fields using square-root weights, followed by Rec.709 luminance-energy normalization. Output is centered on 50% gray, multiplied by the tonal gain, and written to a Linear Light layer. Target alpha is deliberately not multiplied again; Photoshop's clipping mask applies it once and avoids alpha-squared clean fringes.

#### 7. Banded rendering and transactions

Large targets render in 192 px bands. Noise uses global document coordinates and sufficient convolution padding, so band boundaries remain seamless. Each update runs inside a suspended Photoshop history transaction: failure or cancellation rolls back, while success creates one history step. Imaging buffers are disposed in `finally` blocks.

### Development invariants and regression tests

Future work should preserve these invariants:

- Analysis and synthesis use the same correlation kernel, detrending operation, and energy definition.
- Changing Size or Structure must not substantially change output deviation.
- Equal Seed and global coordinates produce equal noise, with no band seams.
- One textured patch must not dominate automatic aggregation.
- Target alpha is not applied twice.
- 8-bit/16-bit output, rollback behavior, and locale switching remain tested.

Run:

```powershell
npm test
```

### Known limitations

- CMYK, Lab, grayscale, and 32-bit documents are unsupported.
- Strong texture, JPEG blocking, sharpening halos, and denoising smears can still contaminate estimates.
- The model describes correlated digital noise in the final image, not camera model, ISO, exposure, or physical film emulsion.
- Limited aspect ratios cannot describe row noise, fixed-pattern noise, or hot pixels.
- Complex pre-existing clipping groups may alter the final clipping scope.
- Preview rendering is CPU-banded, not a frame-by-frame GPU shader.

### License and references

The project is released under the MIT License and implemented from scratch. Design references:

- [Adobe UXP Photoshop plugin samples](https://github.com/AdobeDocs/uxp-photoshop-plugin-samples)
- [cinegrain](https://github.com/mr-berndt/cinegrain)
- [SVT-AV1 film grain synthesis documentation](https://github.com/AOMediaCodec/SVT-AV1/blob/master/Docs/Appendix-Film-Grain-Synthesis.md)

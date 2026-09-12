# MeiNoise

MeiNoise 是一个开源 Photoshop UXP 插件。它自动从目标图层周边估算颗粒的强度、空间大小、彩色成分和明暗响应，再把颗粒生成为目标图层上方的独立剪贴图层。

## 当前功能

- Photoshop RGB 8-bit / 16-bit 文档
- 自动使用并锁定当前图层；切换图层后自动切换目标
- 自动分析目标图层四周的多个原尺寸背景块；手动大选区也按原尺寸分块采样
- 大图限制采样总量，小图自动扩大搜索范围
- 使用“手动采集样本”框选矩形或不规则背景选区作为兜底
- 自动估算 Amount、Size、隐藏的相关结构、Chroma 和三段明暗响应
- Amount / Size / Chroma 手动微调并自动预览
- 0–255 可重现 Seed
- 分块渲染，避免为整张大图一次性分配多个完整缓冲区
- Linear Light 中性灰颗粒层，并剪贴到目标图层
- 长按对比原图
- 完成保留可编辑颗粒层；取消不修改目标图层

## 安装与开发加载

要求 Photoshop 25.0 或更新版本以及 Adobe UXP Developer Tool。

1. 下载或克隆本仓库。
2. 打开 UXP Developer Tool。
3. 选择 **Add Plugin**，打开仓库根目录的 `manifest.json`。
4. 点击 **Load**。
5. 在 Photoshop 的 **Plugins** 菜单中打开 **MeiNoise**。

插件不依赖 Creative Cloud Marketplace，也没有运行时 npm 依赖。

### 命令行打包与永久安装（Windows）

生成 CCX：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

使用 Adobe Unified Plugin Installer Agent 永久安装：

```powershell
& "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "E:\MeiNoise\dist\MeiNoise.ccx"
```

安装完成后重新启动 Photoshop，然后从 **插件（Plugins）> MeiNoise** 打开面板。

## 使用方法

1. 在图层面板选择要添加颗粒的图层。
2. 直接拖动 Amount、Size、Chroma 或 Seed；插件会自动记录当前图层并生成预览。
3. 点击 **自动生成噪点**。插件会从图层四周筛选原尺寸样本，匹配参数并立即生成噪点图层。
4. 按住 **长按对比**临时隐藏颗粒，松开恢复。
5. 点击**完成**保留独立剪贴层，或点击**取消**删除预览。

如果目标图层铺满画布或周围没有足够背景，可点击 **手动采集样本**，再在画面中框选背景；松开鼠标后会自动分析并生成。如果样本只覆盖单一亮度，未覆盖的明暗响应会使用稳健回退值。

## 参数含义

- **Amount**：最终可见颗粒的近似强度。
- **Size**：颗粒空间相关尺度，单位为文档像素。
- **Chroma**：RGB 通道彼此独立的颗粒比例；0% 为纯亮度颗粒。
- **Seed**：0–255 的颗粒排列编号；同一个 Seed 始终得到相同排列。

明暗响应由背景样本自动估算，不额外占用主界面。三个响应值对应暗、中、亮区间的中心，并在区间之间平滑过渡；如果样本没有覆盖三段亮度，缺少的区间使用稳健回退值。

## 已知限制

- 暂不支持 CMYK、Lab、灰度和 32-bit 文档。
- Size 是视觉匹配参数，不代表胶片乳剂颗粒的物理直径。
- 极强纹理、压缩伪影和锐化光晕仍可能影响分析；自动模式会偏向较低噪声的稳定样本，必要时可用“手动”按钮框选更平坦的背景。
- 如果目标图层本身已经属于另一个剪贴组，Photoshop 的剪贴组规则可能使颗粒层继承该组的底层范围，而不是目标图层自身的透明度。普通带透明度或图层蒙版的基础图层不受影响。
- 参数数字会立即变化；画布预览在拖动短暂停顿后自动分块更新，不是 GPU 逐帧着色器。

## 算法与许可证

项目代码从头实现并以 MIT 许可证发布，没有复制 GPL 插件代码。总体设计参考了以下公开资料：

- [Adobe UXP Photoshop plugin samples](https://github.com/AdobeDocs/uxp-photoshop-plugin-samples)（MIT）：UXP 插件结构与 Photoshop API 用法。
- [cinegrain](https://github.com/mr-berndt/cinegrain)（MIT）：多尺度颗粒和亮度响应的设计思路。MeiNoise 使用自己实现的随机哈希。
- [SVT-AV1 film grain synthesis documentation](https://github.com/AOMediaCodec/SVT-AV1/blob/master/Docs/Appendix-Film-Grain-Synthesis.md)：从去噪残差估算颗粒模型的思路。

MeiNoise 的分析器同时比较短、长两个去趋势窗口，避免把背景纹理直接解释为粗噪声；随后使用横纵两个方向的多距离自相关、RGB 残差关系和分亮度统计。生成器把细噪声与能量归一化的高斯相关噪声混合：Size 控制视觉相关宽度，隐藏结构参数控制成团分量的权重；只有多个样本对方向性的判断一致并显著改善拟合时，才使用受限的横纵长宽比。它不是相机、ISO 或焦距数据库；直接匹配最终背景像素通常更符合合成工作流。

## 测试

纯算法模块可以在 Node.js 中测试：

```powershell
npm test
```

Photoshop API 适配层仍需通过 UXP Developer Tool 在 Photoshop 内验证。

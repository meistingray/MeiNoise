# MeiNoise

MeiNoise 是一个开源 Photoshop UXP 插件。它从背景选区估算颗粒的强度、空间大小、彩色成分和明暗响应，再把颗粒生成为目标图层上方的独立剪贴图层。背景和合成图层会始终在 Photoshop 画布中一起显示。

## 当前功能

- Photoshop RGB 8-bit / 16-bit 文档
- 手动指定目标图层
- 分析矩形或不规则背景选区
- 自动估算 Amount、Size、Chroma 和三段明暗响应
- Amount / Size / Chroma 手动微调
- 可重现 Seed 和 Randomize
- 分块渲染，避免为整张大图一次性分配多个完整缓冲区
- Linear Light 中性灰颗粒层，并剪贴到目标图层
- Apply 保留可编辑颗粒层；Cancel 不修改目标图层

## 安装与开发加载

要求 Photoshop 25.0 或更新版本以及 Adobe UXP Developer Tool。

1. 下载或克隆本仓库。
2. 打开 UXP Developer Tool。
3. 选择 **Add Plugin**，打开仓库根目录的 `manifest.json`。
4. 点击 **Load**。
5. 在 Photoshop 的 **Plugins** 菜单中打开 **MeiNoise**。

插件不依赖 Creative Cloud Marketplace，也没有运行时 npm 依赖。

## 使用方法

1. 在图层面板选择要合成进去的图层，点击 **使用当前图层**。
2. 在没有被目标图层遮挡的干净背景上创建一个选区。尽量避开清晰边缘和强纹理，并让选区覆盖足够的明暗范围。
3. 点击 **分析选区**。
4. 在 Photoshop 画布上比较背景与目标图层，微调 Amount、Size 和 Chroma。
5. 使用 Randomize 更换颗粒排列。
6. 点击 **应用**保留独立剪贴层，或点击**取消**删除预览。

## 参数含义

- **Amount**：最终可见颗粒的近似强度。
- **Size**：颗粒空间相关尺度，单位为文档像素。
- **Chroma**：RGB 通道彼此独立的颗粒比例；0% 为纯亮度颗粒。

明暗响应由背景样本自动估算，不额外占用主界面。如果样本没有覆盖三段亮度，缺少的区间使用稳健回退值。

## 已知限制

- 暂不支持 CMYK、Lab、灰度和 32-bit 文档。
- Size 是视觉匹配参数，不代表胶片乳剂颗粒的物理直径。
- 极强纹理、压缩伪影、锐化光晕可能被分析器误认为颗粒；应改选更平坦的背景区域。
- 如果目标图层本身已经属于另一个剪贴组，Photoshop 的剪贴组规则可能使颗粒层继承该组的底层范围，而不是目标图层自身的透明度。普通带透明度或图层蒙版的基础图层不受影响。
- 当前预览在参数确认后重新生成，而不是 GPU 实时着色器。

## 算法与许可证

项目代码从头实现并以 MIT 许可证发布，没有复制 GPL 插件代码。总体设计参考了以下公开资料：

- [Adobe UXP Photoshop plugin samples](https://github.com/AdobeDocs/uxp-photoshop-plugin-samples)（MIT）：UXP 插件结构与 Photoshop API 用法。
- [cinegrain](https://github.com/mr-berndt/cinegrain)（MIT）：多尺度颗粒和亮度响应的设计思路。MeiNoise 使用自己实现的随机哈希。
- [SVT-AV1 film grain synthesis documentation](https://github.com/AOMediaCodec/SVT-AV1/blob/master/Docs/Appendix-Film-Grain-Synthesis.md)：从去噪残差估算颗粒模型的思路。

MeiNoise 的分析器使用稳健高通残差、相邻像素自相关、RGB 残差关系和分亮度统计。它不是相机、ISO 或焦距数据库；直接匹配最终背景像素通常更符合合成工作流。

## 测试

纯算法模块可以在 Node.js 中测试：

```powershell
npm test
```

Photoshop API 适配层仍需通过 UXP Developer Tool 在 Photoshop 内验证。

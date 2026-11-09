# Inkline

Inkline 是一个完全在浏览器本地运行的插画纯色化与轮廓重建工具。默认管线使用 VTracer WebAssembly，把 PNG / JPEG / WebP 转换成共享边界的纯色曲线色块，再以统一深色描边栅格化为同尺寸 PNG。

图片不会上传到服务器，也不依赖 GPU、云端 AI API 或付费服务。

## 启动

只需要 Node.js 18+，无需安装项目依赖：

```bash
git clone https://github.com/HerculeLiu/Inkline.git
cd Inkline
npm start
```

打开 <http://127.0.0.1:4173>。不要直接双击 `index.html`，模块化 Web Worker 和 WebAssembly 需要通过 HTTP 加载。

## 默认处理流程

1. 在独立 Web Worker 中调用 VTracer WebAssembly。
2. 使用 `Poster` 颜色聚类抑制 AI 图片的细微渐变与颜色噪声。
3. 使用 `Cutout` 层级生成无缝共享边界，避免相邻色块各画一条互相抖动的边。
4. 使用 `Spline` 拟合平滑曲线，并以默认 16 色、9 px 碎片门槛处理。
5. 对每条色块曲线统一添加圆角深色描边。
6. 在浏览器 Canvas 中栅格化，导出与输入完全相同尺寸的 PNG。

“消除旧描边”是可选预处理：它只处理局部高反差的深色窄带，并要求窄带两侧存在明显不同的颜色，再把这些像素重新归属给邻近色块。该功能默认关闭，因为实图测试表明激进清除会误伤眼睛、手部、深色衣物和内部结构线。

## 使用

1. 拖入 PNG、JPEG 或 WebP，或选择内置样图。
2. 保持默认的“Inkline 曲线”和 16 色，点击“开始处理”。
3. 在“原图 / 纯色化 / 边界图 / 最终结果”之间切换；对比模式可拖动中线。
4. 原图旧线很粗、很灰且明显夹在两个色块之间时，可开启“消除旧描边”后重试，并检查脸、眼睛、手和深色服装。
5. 点击“下载 PNG”导出同尺寸结果。

原有像素分区、FH + RAG 和多尺度融合实现仍保留在方法下拉框中，作为回归与对照方案，没有被删除。

## 算法选择依据

本仓库用同一张 1122 × 1402 阿米娅插画实际比较了 VTracer、Linework Studio 和 ImageTracerJS。结果与完整决策记录见 [算法评估](docs/algorithm-evaluation.md)。结论是：

- VTracer Poster + Cutout + Spline 在纯色、共享边界、细节和浏览器性能之间最平衡，作为默认主引擎。
- Linework Studio 的“墨线像素重新归属”思路被改写成保守的纯 JavaScript 可选预处理；其 Python/FastAPI 整体没有引入。
- ImageTracerJS 集成成本低，但同图产生的路径和 SVG 体积远高于 VTracer，且噪点、锯齿更多，不作为主引擎。

## 测试

```bash
npm test
npm run fixtures
```

测试覆盖原有分区不变量、透明像素、字孔与高光保护，以及新增的旧描边分类、真实 VTracer 预设和 SVG 统一描边。集成还通过真实浏览器完成 1122 × 1402 PNG 的上传、WASM 处理、预览和下载验收。

## 浏览器与资源边界

- 建议使用最新版 Chrome、Edge、Firefox 或 Safari。
- 单边上限 4096 像素，总像素上限 4,194,304；超限会明确拒绝，不会静默缩放。
- 推荐工作尺寸约 1024 × 1024。高分辨率、较高颜色数和旧描边预处理都会增加内存与耗时。
- 更换图片或重新处理会终止旧 Worker，过期任务不会覆盖当前结果。

## 已知限制

- 16 色预设会简化非常细小的五官、文字和材质；需要时可提高到 24 色，但碎片与路径数也会增加。
- SVG 到 PNG 的抗锯齿只发生在色块边缘和描边附近；色块内部仍是单一填充色。
- 旧描边与真实深色结构在像素层面并无绝对可分的规则，因此旧描边消除不能安全地默认开启。
- 该算法不理解语义，无法自动判断某条深线究竟是外轮廓、衣物阴影还是眼睛结构。
- 透明输入在曲线栅格化边缘可能出现浏览器抗锯齿像素。

## 第三方代码

浏览器端 VTracer WASM 绑定和二进制位于 `src/vendor/vtracer/`，使用 MIT License，许可证原文见 [src/vendor/vtracer/LICENSE](src/vendor/vtracer/LICENSE)。其余新增旧描边逻辑为 Inkline 内部的纯 JavaScript 实现。

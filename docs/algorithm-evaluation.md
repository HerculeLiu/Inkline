# Inkline 图像处理引擎实测记录

## 测试方法

测试图为本地 `Amiya of Rhodes Island.png`，尺寸 1122 × 1402。三个项目均使用各自官方仓库代码，在同一台本机上处理同一输入，并把矢量结果栅格化到原始尺寸后目视比较脸部、发梢、字母孔洞、衣物结构、背景建筑和轮廓抖动。

研究版本：

- [VTracer](https://github.com/visioncortex/vtracer)：官方仓库提交 `8fd4be6`，MIT。
- [Linework Studio](https://github.com/ArchiusVuong-sudo/linework-studio)：官方仓库提交 `324db6c`，MIT。
- [ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs)：官方仓库提交 `cb0c84a`，Unlicense。

以下时间是本次本机实验的方向性数据，不是跨设备基准。

## 结果摘要

| 方案 | 主要参数 | 时间 | 路径数 | SVG 大小 | 实际观察 |
|---|---|---:|---:|---:|---|
| VTracer | Poster / Cutout / Spline / 16 色 | 约 0.70 s | 453 | 191 KB | 最干净；色块纯、共享边界流畅，关键细节基本保留 |
| VTracer | Poster / Cutout / Spline / 24 色 | 约 0.62 s | 772 | 255 KB | 细节更多，但衣物与背景更忙 |
| VTracer | Watershed detail 160 | 约 0.34 s | 61 | 52 KB | 过度抽象，脸、文字和配件细节明显丢失 |
| VTracer | Watershed detail 208 | 约 0.27 s | 212 | 114 KB | 仍比目标风格过度简化 |
| ImageTracerJS | 16 色 | 约 0.72 s | 7,829 | 1.75 MB | 黑点、碎片和锯齿明显，路径约为 VTracer 17 倍 |
| ImageTracerJS | 24 色 | 约 1.0 s | 20,525 | 4.4 MB | 细节增加，但碎片和体积失控 |
| ImageTracerJS | 32 色 | 约 1.3 s | 31,164 | 6.5 MB | 不适合作为默认浏览器管线 |
| Linework Studio | detail 4 / smoothing 3 | 约 2.17 s（热运行） | 282 | 291 KB | 墨线重建思路有效，但真实插画上局部发团、脸手细节损失 |

集成后的浏览器版本使用 raw RGBA WASM 接口，在真实页面内得到 631 条路径，并成功导出 1122 × 1402 RGBA PNG。路径数与命令行编码图接口有差异，但视觉结论一致。

## 技术判断

### VTracer

VTracer 能直接替代 Inkline 当前流程中的颜色量化、区域轮廓提取、共享边界和曲线拟合。`Cutout` 让相邻色块使用无缝层级边界，`Spline` 明显改善原有像素边界的心电图式抖动。Poster 16 色比 Watershed 更适合这张信息密度较高的角色插画，因此默认没有采用 Watershed。

保留现有实现的理由：它仍适合精确像素级回归测试、透明像素不变量和算法对照，也为未来混合式细节恢复保留了基础。

### Linework Studio

值得吸收的是“先找墨线、排除墨线像素、用周围色区重新归属、再统一画线”的思路。完整项目依赖 Python、FastAPI、OpenCV、scikit-image，不符合个人网站的浏览器本地优先目标；而且它的真实插画结果会把渐变分成色带，并可能误删内部结构。

Inkline 因此只实现了保守子集：像素必须同时满足局部深色高反差，并且在某个方向上能找到颜色明显不同的两侧，才视为可重新归属的旧描边。该步骤默认关闭。

### ImageTracerJS

ImageTracerJS 是纯 JavaScript，接入成本最低，但同图同色数产生了数量级更高的路径数和 SVG 体积，轮廓也更碎。它没有在实际画质或性能上接近 VTracer，因此没有集成到正式界面。

## 当前方案

```text
输入 RGBA
  └─ 可选：保守旧描边像素重新归属
      └─ VTracer Poster 颜色聚类（默认 16 色）
          └─ Cutout 共享边界
              └─ Spline 曲线拟合与碎片过滤
                  └─ 统一深色圆角描边
                      └─ Canvas 同尺寸 PNG
```

## 后续问题

1. 16 色对脸部、瞳孔和小字仍可能过度简化；24 色虽能恢复细节，但会增加碎片。
2. 旧描边与真实深色结构无法仅靠亮度可靠区分，需要继续改进方向一致性、线宽稳定性和端点判断。
3. 当前统一描边会给背景建筑和文字内部色块也加线；未来可按区域尺度和语义重要度分级线宽。
4. VTracer 的曲线几何已比原实现平滑，但极细发梢仍可能因颜色量化合并。

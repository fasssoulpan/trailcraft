# TrailCraft

越野跑三维路线巡游与传播视频生成系统。面向越野跑者与赛事组织者的**赛前**路线工具:把一条 GPX 轨迹变成能带去比赛的路书,以及一段能用来传播的三维巡游视频。

**纯前端本地应用**:没有账号、没有后端、没有服务器。轨迹存在浏览器 IndexedDB 与本地文件里,不上传任何地方。

---

## 快速开始

需要 Node 18+(开发时用的是 Node 20)。

```bash
npm install
```

```bash
npm run dev
```

开发服务器固定在 <http://localhost:5199>(`--strictPort`,端口被占用会直接报错而不是悄悄换端口)。

```bash
npm test -- --run
```

```bash
npm run build
```

构建产物是 `dist/`,**纯静态文件**,可直接部署到任何静态托管(Vercel / Netlify / Cloudflare Pages / 对象存储 + CDN 均可),不需要 Node 运行时,也不需要配置任何环境变量或密钥。

唯一需要注意的是 Cesium:它的静态资源(Workers / Assets / Widgets / ThirdParty)由 `vite.config.ts` 里的 `viteStaticCopy` 拷贝到 `dist/cesium/`,`window.CESIUM_BASE_URL` 指向该目录。**如果部署到子路径**(例如 `https://example.com/trailcraft/`),需要同时设置 Vite 的 `base` 和 `CESIUM_BASE_URL`,否则三维视图会因为找不到 worker 而白屏。

## 功能

**二维规划**
- 轨迹导入 GPX / KML / FIT。解析走 Web Worker,不阻塞界面;33 万点、105MB 的 GPX 约 1.1 秒。
- 坐标系自动识别 WGS-84 / GCJ-02 / BD-09,统一转 WGS-84 存储;置信度不足时让用户二选一并记住该来源的选择。
- MapLibre 二维地图 + Canvas 高程剖面,鼠标悬停双向联动,显示里程/累计爬升/当前坡度。
- 轨迹工具箱:分割、拼接、反向、异常点清洗、抽稀、**手绘新路线**。全部非破坏性,可撤销/重做。
- CP 节点:打卡点 / 补给站 / 强装检查 / 危险路段 / 退赛点 / 重要地标点。里程单调约束锚定,折返赛道上不会锚错趟次。可挂载实景照片,按 EXIF GPS 自动锚位。
- 分段统计与关门预警:阈值滞回爬升算法,三档配速模型推演各 CP 到达时间,红/黄/绿三级预警。

**三维巡游与成片**
- CesiumJS 三维地球,Esri 地形与影像(免密钥)。可切换 3D 卫星图 / 二维平面图,叠加等高线(带高程数值)与距离雷达。
- 相机路径按**里程**参数化而非帧序号,因此实时预览与逐帧导出走同一条采样路径,导出是确定性的。
- 4 套镜头模板 + 里程键控关键帧编辑器。
- 视频导出走 WebCodecs `VideoEncoder` + `mp4-muxer` 输出 H.264 MP4;不支持时降级到 MediaRecorder(界面标注为"预览级")。

**表现分析**
- 实跑/规划轨迹自动判别,只对实跑轨迹做表现分析。
- ITRA 风格表现分逆向拟合(幂律模型,见 `src/core/perf/score.ts`),含公开赛事数据回测。
- 表现分速算:直接输入距离/爬升/用时即可得分与分段预估。
- 传感器覆盖度概览 + 证据驱动的行动建议(无证据不输出结论)。

**导出**
- Excel 路书(两 Sheet + 内嵌高差图)、高差图 SVG/PNG(4×)、腕带配速卡(180×60mm)、自包含交互网页(单 HTML,无外部引用)。

## 目录结构

```
src/
├── core/          纯 TS 领域层(零框架依赖,可在 Worker 与 Node 下运行)
│   ├── parsers/   GPX / KML / FIT 解析
│   ├── crs/       坐标系识别与 GCJ-02 / BD-09 转换
│   ├── geo/       测地距离与累计里程
│   ├── toolbox/   轨迹编辑纯函数(含手绘)
│   ├── stats/     锚定、爬升、分段统计
│   ├── pace/      配速模型与关门预警
│   ├── perf/      表现分模型、轨迹判别、洞察
│   ├── export/    Excel / SVG / 配速卡 / 交互网页 / GPX
│   ├── photo/     EXIF 解析与照片锚定
│   └── model/     数据模型与工程文件格式
├── cesium/        三维视图、相机引擎、等高线、逐帧导出
├── overlay/       HUD / CP 卡片 / 雷达的画布绘制(视频可见的部分)
├── map/           MapLibre 图层与交互
├── profile/       高程剖面 Canvas
├── state/         Zustand store 与撤销栈
└── ui/            React 组件与设计原语
docs/
├── 方案/          需求、各阶段方案、进度交接记录
└── P*-验收记录.md  各阶段验收与已知限制
samples/           小体量真实轨迹样本(~7MB),供测试与试用
```

`src/core` 零框架依赖,单元测试覆盖。设计令牌集中在 `src/index.css`,组件原语在 `src/ui/primitives/`。

## 测试数据

`samples/` 里提交了一小份真实轨迹(GPX / KML / FIT 各有,覆盖实跑与规划两类),**克隆下来即可跑通绝大多数真实数据用例**。

若本机有更完整的语料,设 `TRAILCRAFT_TESTDATA` 指向该目录即可;针对超大文件(如 33 万点 GPX)的性能用例在文件缺失时会**逐个跳过**而不是报错。解析规则见 `tests/testData.ts`。

## 已知限制

- **渲染类功能未经真人系统验证**:三维巡游画面、导出视频里的 HUD / CP 卡片 / 雷达、等高线观感等,受开发环境限制无法自动验证。详见各阶段 `docs/P*-验收记录.md`。
- **路网吸附纠偏未实现**:四个 Overpass 镜像实测全部不可达,没有矢量步道数据源,因此没有写路由引擎。
- 底图国内访问速度取决于所选源;瓦片加载失败不影响轨迹、剖面、CP 等全部功能。

## 数据与许可署名

- 地图数据 © OpenStreetMap contributors(ODbL);地形与影像 © Esri 及其数据提供方
- MapLibre GL JS(BSD-3)、CesiumJS(Apache-2.0)、Turf.js / idb / fit-file-parser / ExcelJS / mp4-muxer(MIT/ISC)
- GCJ-02 / BD-09 坐标转换采用社区公开近似实现(MIT)。**面向国内商业发布前需就测绘相关法规完成合规评估。**
- `samples/` 中为项目作者本人的轨迹记录,仅用于开发测试。

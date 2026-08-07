# TrailCraft

越野跑三维路线巡游与传播视频生成系统 —— **P0 阶段:二维规划基础闭环**

面向越野跑者与赛事组织者的赛前路线工具。本阶段实现轨迹导入、坐标系自动处理、地图与高程剖面联动、轨迹编辑工具箱、CP 节点分段统计与关门时间预警。三维巡游与视频导出为后续阶段(P1~P3)内容。

纯前端本地应用:无账号、无后端、无服务器,数据存于浏览器 IndexedDB 与本地文件。

## P0 功能

- **轨迹导入**:GPX / KML / FIT。33 万点、105MB 的 GPX 解析约 1.1 秒,解析在 Web Worker 中进行,不阻塞界面。
- **坐标系自动处理**:自动识别 WGS-84 / GCJ-02 / BD-09 并统一转换为 WGS-84 存储;置信度不足时强制用户二选一,并记住该来源的选择。
- **地图与高程剖面**:MapLibre 二维地图 + Canvas 高程剖面,鼠标悬停双向联动。
- **轨迹工具箱**:分割、拼接、反向、异常点清洗、抽稀。所有操作非破坏性,可撤销/重做,原始轨迹不被改写。
- **CP 节点**:标注打卡点/补给站/强装检查/危险路段/退赛点。采用里程单调约束锚定,折返赛道上不会锚错趟次。
- **分段统计**:阈值滞回爬升算法(阈值 3~10m 可调),分别输出区间爬升率、下降率与净坡度;支持按赛事官方总爬升一键校准阈值。
- **关门预警**:三档配速模型(Tobler 徒步函数 / 实用档 / 参数可调),推演各 CP 预计到达时间,对照关门时间输出红/黄/绿三级预警。
- **持久化与导出**:工程保存至 IndexedDB;导出/导入工程 JSON(含 `schema_version`);导出 GPX,可选 WGS-84 或 GCJ-02。

## 开发

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test -- --run
```

```bash
npm run build
```

真实轨迹的性能测试默认读取 `C:/Users/Administrator/Desktop/越野跑地图软件开发/测试`,可用环境变量 `TRAILCRAFT_TESTDATA` 覆盖;目录不存在时这些用例自动跳过。

## 技术选型

| 层 | 选型 |
|---|---|
| 语言 / 构建 | TypeScript 5(strict)+ Vite |
| 界面 | React 18 + Zustand |
| 地图 | MapLibre GL JS |
| 高程剖面 | 自研 Canvas 渲染 |
| 解析 | 自研 GPX/KML 正则快路径 + fit-file-parser |
| 存储 | IndexedDB(idb) |
| 测试 | Vitest |

`src/core` 为零框架依赖的纯 TypeScript 领域层(解析、坐标转换、几何、统计、配速),可在 Web Worker 与 Node 下运行,单元测试全覆盖。

## 目录结构

```
src/
├── core/          纯 TS 领域层(零框架依赖)
│   ├── parsers/   GPX / KML / FIT 解析
│   ├── crs/       坐标系识别与 GCJ-02/BD-09 转换
│   ├── geo/       测地距离与累计里程
│   ├── toolbox/   轨迹编辑纯函数
│   ├── stats/     锚定、爬升、分段统计
│   ├── pace/      配速模型与关门预警
│   ├── export/    GPX 导出
│   └── model/     数据模型与工程文件格式
├── workers/       导入 Worker 与主线程封装
├── state/         Zustand store 与撤销栈
├── map/           MapLibre 图层与标记
├── profile/       高程剖面 Canvas
└── ui/            React 界面组件
```

## 数据与许可署名

- 地图数据 © OpenStreetMap contributors(ODbL)
- MapLibre GL JS(BSD-3)、Turf.js / idb / fit-file-parser(MIT/ISC)
- GCJ-02 / BD-09 坐标转换采用社区公开近似实现(MIT)。面向国内商业发布前需就测绘相关法规完成合规评估。

## 已知限制

见 [docs/P0-验收记录.md](docs/P0-验收记录.md) 第四节。其中影响使用体验最直接的一条:底图使用 OSM 官方瓦片,国内访问不稳定;瓦片加载失败不影响轨迹、剖面、CP 等全部功能。

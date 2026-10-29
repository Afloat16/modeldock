# ModelDock：让三维模型像代码一样，即点即看

[GitHub](https://github.com/Afloat16/modeldock) · [发布下载](https://github.com/Afloat16/modeldock/releases) · [English](README.md) · [架构](docs/architecture.md) · [验证记录](docs/validation.md)

为 AI 三维重建、点云和 CAD 工作流准备的本地查看工具。项目交付四个入口：**VS Code 原生自定义编辑器、DeepSeek Harness 原生文件预览插件、OpenAI 桌面端文件查看器插件、本地 CLI 查看器**。它们共用同一套渲染、解析、大文件采样预览和比较核心。

典型使用方式：AI 输出模型 → 点击文件 → 检查 → 修改 → 同一视角查看更新。评估多个重建结果时，使用 **添加模型 → 选择基准 / 真值 → 按需配准 → 评估**。STL 曲面可作为基准；模型保留源坐标，默认不自动配准。

## 快速开始

### VS Code / VS Code 中的 Codex

从[发布页面](https://github.com/Afloat16/modeldock/releases)下载后，在扩展面板的 `… → 从 VSIX 安装` 中选择 `modeldock-0.2.0.vsix`，然后点击 `.ply`、`.step` 等文件即可。

```sh
code --install-extension releases/modeldock-0.2.0.vsix
```

若已有其他三维插件占用格式，右键编辑器标题，选择 **Reopen Editor With… → ModelDock 3D Preview → Set as Default**。命令面板还提供 `ModelDock: Open 3D Preview` 和 `ModelDock: Reopen as Text`。安装以后可先试 `fixtures/demo-arch-cloud.ply` 与 `fixtures/mounting-bracket.step`。

在 VS Code 中使用 Codex 时，两者直接协作：Codex 生成文件，ModelDock 显示文件。其他 VS Code 兼容编辑器可尝试安装同一 VSIX，但要单独验收。Remote SSH/WSL 的文件读取接口已实现，具体远端提供者仍需实测；本版没有为 vscode.dev 声明浏览器扩展入口。

### OpenAI / Codex 桌面端

`adapters/openai` 是按 OpenAI MCP 文件入口协议实现的可安装插件，使用宿主授权的文件资源 URI，并通过宿主注入的选中文件元数据获取文件信息和有界字节区间。工具参数不接受任意文件路径。旧宿主仍可使用上限为 128 MiB 的完整资源读取；宿主不能传送大文件时，可在查看器中直接选择本地文件。详见 [安装说明](docs/openai-integration.md)。

**宿主必须支持桌面文件入口；仅接通 MCP 不代表它就会显示三维界面。** 纯 Codex CLI 没有图形画布，可使用下面的本地入口；协议当前列明的 Work Web 与移动端不是本项目原生文件入口目标。

### DeepSeek Harness

安装 `dsh-plugin-modeldock-0.2.0.tgz` 后，ModelDock 使用已有右侧文件标签页进行原生预览。适配目标是 `0.2.2-alpha.2` 的开发预览接口，升级 Harness 后应重新验收。

完整步骤见 [Harness 安装说明](adapters/deepseek-harness/README.md)，底层契约和固定源版本见 [集成文档](docs/harness-integration.md)。Harness CLI 的 Node 要求高于本地查看器，按对应宿主说明安装。

适配器采用 `loading: 'renderer'`，通过宿主的 `remote.workspaceFiles.stat/readBytes` 读取元数据和有界字节区间，保持宿主权限与版本检查。同一组件中的文件更新可保留相机、附加模型和配准状态；如果宿主卸载整个预览，32 项相机缓存只恢复视角，不保存完整比较场景。

### 任何能够执行命令的 AI 工具

交付包包含构建好的 `dist/`，使用 Node.js 22+ 可直接运行，无须先安装开发依赖：

```sh
node dist/cli.cjs ./output/reconstruction.ply --open
node dist/cli.cjs ./output/part.step --open
node dist/cli.cjs ./output/model.ply --max-size-mb 8192
```

不带文件时可拖入或选择文件。指定文件时会自动监测版本变化。CLI 只监听 `127.0.0.1`，打印随机私有 URL；进程需要保持运行。`--open` 打开默认浏览器，也可把 URL 放进支持本地页面的宿主内置浏览器。远程机器要按正常方式设置 SSH 端口转发。

## 支持哪些模型

| 格式           | 当前功能                                       | 具体边界                                                                                   |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PLY            | ASCII、大小端二进制；点云/网格；顶点颜色、法线 | Gaussian PLY 只显示中心点，不是完整 3DGS 渲染。                                            |
| STL            | ASCII / 二进制                                 | 几何预览，零法线可重建。                                                                   |
| OBJ            | 网格、组、线、点、负索引                       | 不加载 MTL 或外部贴图。                                                                    |
| OFF / XYZ      | 多边形网格 / 文本点云                          | 保留源坐标关系；不推测地理坐标系。                                                         |
| PCD            | ASCII、binary、binary_compressed/LZF           | 标准 XYZ 和常见 RGB 字段。                                                                 |
| GLB / glTF 2.0 | 内嵌缓冲区和贴图、节点变换                     | 需自包含且未压缩；不支持外部资源、Draco、Meshopt、KTX2、GPU instancing。动画显示初始姿态。 |
| STEP / STP     | OpenCascade 本地三角化                         | 保留部件名/颜色，坐标输出 mm。                                                             |
| IGES / IGS     | OpenCascade 本地三角化                         | 坐标输出 mm。                                                                              |
| BREP / BRP     | OpenCascade 本地三角化                         | 保留模型坐标单位，不猜测物理单位。                                                         |

本版不支持 DWG、DXF、SolidWorks/Creo/CATIA/Inventor 等原生工程格式、FCStd、USD、LAS/LAZ。CAD 请先导出 STEP，重建模型可导出 PLY/GLB/STL。

这是只读三维预览；CAD 曲面会三角化显示，不提供参数化编辑、约束求解、拓扑编辑或精密 CAD 测量。暂不还原面级 CAD 颜色或可编辑的装配树。

## 查看与检查

- 左键拖动旋转，右键或 Shift+左键拖动平移，滚轮/双指缩放，双击表面设置旋转中心。
- `F` 适应窗口，`R` 重置；`1/3/7` 前/右/顶视图，`5` 切换透视/正交。
- `G/B/A` 控制网格、包围盒、坐标轴；`W` 切换线框。
- 支持 Y-up/Z-up、点大小、实体/线框/点/法线显示、部件显隐、轴向剖切。
- `M` 后依次点击两点可测量近似距离，`Esc` 退出。先点击视口再使用键盘快捷键。
- 显示顶点数、三角面数、尺寸及单位。没有单位元数据的模型不会被自动当成毫米。
- 文件被 AI 或其他程序改写后，VS Code/已绑定文件的本地查看器会自动刷新并保留相机。损坏的中间结果不会抹掉上一次成功显示的模型。

界面支持中英文。模型解析与 CAD WebAssembly 均在本地完成，ModelDock 没有遥测、文件上传、云端转码或 API Key 依赖。

## 多模型配准与评估

1. 打开模型后，选择 **添加模型**，载入其他 PLY、STL、网格或点云。添加模型不会停止原始文件的自动刷新；普通“打开模型”操作会替换会话。
2. 选择 **基准 / 真值** 与 **目标**，为每个模型确认实际坐标单位。PLY/STL 通常没有可靠物理单位；选择 mm、m 等只是确认坐标含义，不会转换数值。
3. 使用彩色叠加或同步并排视图检查，分别调整显隐和透明度。需要保持已知注册误差时，直接评估源坐标；需要刚性配准时，显式点击 **刚性 ICP**。ICP 是局部方法，需要合理初始姿态；可先使用手动平移 / 旋转。手动面板还提供显式缩放，所有变换和缩放会写入导出报告。
4. 输入采用已确认坐标单位的距离阈值，选择 **评估两模型** 或 **全部对比基准**。修改模型、单位、变换或阈值后，旧结果会失效。可导出 JSON / CSV 保存指标和采样依据。

界面提供采样偏差热图、RMSE、P95、采样最大值、Chamfer 距离、精确率、召回率和 F-score。精确率表示目标采样点中落在基准容差内的比例；召回率表示基准采样点被目标覆盖的比例。Chamfer 为两个方向平均距离的平均值，不取平方。热图显示采样点；采样最大值不是精确 Hausdorff 距离。比较会按预算使用三角曲面距离或明确披露的有界近似，不能替代有符号距离、法线、体积、水密性或精密 CAD 测量。大型 PLY 的点式预览不能充当精确曲面真值。

## 大型模型与内存限制

| 边界                 | 默认值 / 行为                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------- |
| 源文件大小           | 四个入口均为 **8 GiB**；仍须满足宿主权限与传输能力。                                     |
| 普通完整输入解析     | **128 MiB**；ASCII 和其他非随机读取格式使用此路径。                                      |
| 大型二进制 PLY / STL | 超过 128 MiB 使用有界采样预览，支持至少 **5 GiB** 源文件，无需创建整文件 `ArrayBuffer`。 |
| 大文件显示几何       | 最多 **30 万点 / 10 万三角面**，披露源数量、显示数量与采样情况。                         |
| 单次大文件预览读取   | 默认最多 **128 MiB**，分块读取并检查文件版本。                                           |
| 普通几何             | 最多 1000 万顶点 / 1000 万三角面，仍受解析和内存约束。                                   |
| 比较会话             | 最多 **16 个模型 / 512 MiB 保留几何数据**。                                              |

大型二进制 PLY 网格目前省略面拓扑，只显示采样顶点，并在界面和报告中标明；大型二进制 STL 显示采样三角面。仅访问部分记录的预览不能证明完整文件有效。这是有界采样，不是八叉树 LOD，也不承诺完整渲染数十亿点。支持 5 GiB 源文件不等于把所有几何装入显存或 WASM；大型 STEP/IGES/BREP、GLB/glTF、OBJ 等仍受 128 MiB 普通解析路径约束，不承诺 5 GiB CAD 转换。

普通非 glTF 解析 Worker 有 120 秒超时，可取消；新加载会终止旧 Worker。GLB/glTF 在预检查后于主线程解析，可能短暂阻塞。大文件读取和比较在工作批次之间检查取消。CAD 内核返回结果前可能分配额外内存；这些上限是保护阈值，不是帧率或内存保证。

模型的双精度源原点会保留，并以共享显示锚点保持多个模型之间的坐标关系。GPU 顶点仍使用 Float32，极端绝对坐标和极小特征仍有精度限制；不会猜测 PLY 单位或悄悄缩放模型。

## 开发、打包与开源

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:openai-stdio
npx playwright install chromium
npm run test:browser
npm run test:openai-browser
npm run test:comparison
npm run test:openai-range
npm run test:extension
npm run package:vsix
npm run package:release
```

仓库包含原创建模样例、生成器、单元测试、真实浏览器交互测试和 CI 工作流。测试分层和实际执行结果见 [验证记录](docs/validation.md)。插件接入代码完成不等于所有操作系统、宿主版本均已实测，文档会明确这些区别。

发布自己的分支时，在 VS Code Marketplace 发布前，将 `package.json` 的 `publisher: modeldock-dev` 改为你已注册的发布者，并补齐仓库 URL/作者。发布到 npm/插件目录前同样确认自己的公开包名。

原始项目源码及原创样例使用 MIT；OpenCascade/occt-import-js 仍使用 LGPL 许可，不能把整个依赖集合描述为纯 MIT。保留附带的许可证、对应源码和重建说明。约 52 MB 的 CAD 对应源码压缩包不进入 Git；`node scripts/fetch-cad-source.mjs` 按固定版本下载并校验大小与 SHA-256，`npm run package:release` 会自动校验并将对应源码加入完整发布 ZIP。详见 [第三方说明](THIRD_PARTY_NOTICES.md) 与 [CAD 源码说明](docs/cad-source.md)。

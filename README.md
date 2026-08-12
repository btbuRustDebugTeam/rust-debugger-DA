<p align="center">
  <img src="docs/assets/校徽.png" alt="学校 Logo">
</p>

# 操作系统跨特权级统一调试平台

## 一、项目基本信息

| 项目 | 信息 |
| --- | --- |
| 赛题 | [proj55-源代码级内核调试器](https://github.com/chenzhiy2001/code-debug) |
| 队伍名称 | 做什么都会成功队 |
| 学校 | 北京工商大学 |
| 团队成员 | 曾小红、王浩铭、武雪妍 |
| 指导教师 | 吴竞邦 |
| 初赛文档 | [操作系统跨特权级统一调试平台初赛文档](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/%E5%88%9D%E8%B5%9B%E6%96%87%E6%A1%A3-%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F%E8%B7%A8%E7%89%B9%E6%9D%83%E7%BA%A7%E7%BB%9F%E4%B8%80%E8%B0%83%E8%AF%95%E5%B9%B3%E5%8F%B0.pdf) |
| 初赛 PPT | [操作系统跨特权级统一调试平台初赛 PPT](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/%E5%88%9D%E8%B5%9BPPT-%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F%E8%B7%A8%E7%89%B9%E6%9D%83%E7%BA%A7%E7%BB%9F%E4%B8%80%E8%B0%83%E8%AF%95%E5%B9%B3%E5%8F%B0.pdf) |
| 演示材料 | [项目演示视频与调试材料](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/tree/main/docs) |

## 二、项目简介

操作系统调试同时涉及内核态和用户态。两个特权级使用不同的页表、地址空间、符号表和断点集合；当 CPU 跨越特权级边界时，调试器必须同步切换调试上下文，否则断点、源码定位和调用栈都会失效。

Rust 异步操作系统又引入了第二层困难。`async` 函数被编译为由执行器反复 `poll` 的状态机，GDB 每次暂停时看到的物理调用栈只反映当前一次调用，无法直接回答“当前 Future 在等待谁”“控制流如何跨多个 poll 周期运行到这里”等问题。

本项目面向上述两类问题，构建操作系统跨特权级统一调试平台：

- 使用四状态机与断点组管理内核态、用户态之间的符号表和断点切换；
- 基于 await edge 与 call edge 还原 Rust 异步程序的逻辑执行流；
- 将异步跟踪由调试前全量预计算改为运行时按需发现；
- 在特权级切换过程中保存并恢复异步跟踪状态；
- 通过 VS Code Async Inspector 展示异步等待拓扑；
- 通过通用边界断点、动态进程组和稳定变量读取机制适配不同操作系统；
- 将调试能力扩展至 VisionFive 2 真实开发板和线上硬件实验平台。

项目代码由两个调试子系统组成：

- **osgdb**：负责操作系统跨特权级调试与断点组切换，仓库地址为 [OSDebugger/osgdb](https://github.com/OSDebugger/osgdb)。
- **async-debug（本仓库）**：负责 Rust 异步执行流跟踪、OS 调试能力融合以及 VS Code 图形化展示。

## 三、总体方案与完成情况

决赛阶段工作围绕四个核心技术问题展开，并进一步完成真实硬件与线上实验环境扩展。

| 技术项 | 状态 | 主要结果 |
| --- | :---: | --- |
| 运行时按需发现机制 | 完成 | 去除 DWARF 预解析和全量插桩；运行时读取 `__awaitee` 动态发现等待关系 |
| 协程实例级识别 | 完成 | 使用 `(poll_symbol, env_ptr)` 二元组区分同一异步函数的并发实例，并分配稳定 CID |
| Trace Root 与白名单动态管理 | 完成 | 支持手动指定或从 backtrace 推断追踪根节点；白名单按 crate 分组并支持运行时更新 |
| OS 调试能力融合 | 完成 | 将四状态机、断点组和 Border/Hook 断点机制移植到 async-debug |
| Save/Restore 跟踪状态保持 | 完成 | 保存断点、协程状态、追踪记录和白名单配置，按五步顺序恢复 |
| VS Code 插件化与 Async Inspector | 完成 | 实现 Debug Adapter、Extension、Webview 三层架构和异步逻辑调用树 |
| 面向不同 OS 的通用化改进 | 完成 | 实现函数名断点、通用 syscall 收敛点、方向属性、动态进程组自动注入和跨 Rust 版本变量读取 |
| 自动化测试 | 完成 | 37 个 OSStateMachine 单元测试和 4 个 MockMI2 集成测试全部通过 |
| 实际目标验证 | 完成 | 完成 embassy、StarryOS 和 Async-os 三类场景验证 |
| VisionFive 2 真机调试 | 完成 | 建立 J-Link、OpenOCD、GDB 与串口链路，完成处理器状态读取、暂停、恢复及跨特权级调试适配 |
| 线上硬件交互平台 | 完成 | 实现真实开发板预约、分配、释放、SSH 公钥注册、状态更新、日志和会话归档 |

## 四、核心工作

### 4.1 从静态预计算到运行时按需发现

已有异步跟踪方法需要在调试开始前离线解析完整 DWARF 信息、预计算依赖树，并为所有候选函数设置跟踪断点。该方案的准备开销随程序规模增长，而且使用类型偏移量识别协程时，无法区分同一异步函数的多个并发实例。

本项目改为运行时按需发现：调试器从当前 trace root 出发，仅在实际执行路径上读取编译器生成的 `__awaitee` 字段，发现真正被等待的子 Future；遇到同步包装层时，通过 call edge 跟踪真实函数调用，从而把异步等待关系与机器级控制流连接起来。

具体机制包括：

1. 设置 trace root，并为其安装 poll 入口断点；
2. 断点命中后读取 `__awaitee`，按需发现子 Future；
3. 使用 `(poll_symbol, env_ptr)` 作为实例键，为并发协程分配稳定 CID；
4. 通过轻量影子栈维护动态调用关系，并在函数返回时自动弹栈；
5. 将 await edge 与 call edge 合并，生成可供界面展示的逻辑调用树快照。

这一改进使跟踪成本由“与整个程序规模相关”变为“与当前实际执行路径相关”，同时解决了同一异步函数多实例混淆问题。

### 4.2 异步跟踪状态跨特权级保存与恢复

当调试器从内核态切换到用户态时，需要卸载内核符号表、替换断点组并加载用户程序符号。若直接沿用传统切换流程，异步跟踪积累的协程实例、跟踪断点、调用关系和白名单地址都会丢失。

为此，项目设计跨生命周期的 Save/Restore 机制。切换前统一保存四类数据：

- 调试器断点及其逻辑角色；
- 协程 CID、poll 次数、活跃状态和实例映射；
- trace root、await edge、call edge 与影子栈等追踪记录；
- 白名单函数及其在当前符号表中的地址映射。

切换符号文件后，调试器按“重载 Python 脚本 - 恢复白名单 - 恢复协程与追踪状态 - 重建动态跟踪断点 - 恢复用户断点”的顺序完成恢复，保证跨地址空间的异步追踪连续性。

### 4.3 Async Inspector 图形化调试界面

命令行文本难以呈现包含大量协程的异步依赖关系，而 VS Code 原生 Call Stack 只理解线程和物理栈帧。项目因此实现 Async Inspector Webview 面板，与原生调用栈形成“物理流 + 逻辑流”双轨调试模式。

界面采用三层架构：

- **数据层**：GDB Python 脚本生成包含 await edge、call edge、CID、poll 次数和状态的 JSON 快照；
- **传输层**：Debug Adapter 与 Extension 监听 stopped 事件，并通过消息通道传递快照；
- **展示层**：Webview 将快照渲染为可交互的多根逻辑调用树。

面板按颜色区分 async 协程与 sync 函数，节点显示 CID、poll 次数和活跃状态，并支持点击节点跳转源码。白名单的 Gen、Apply、Trace 操作也被集成到同一工作流中。

![Async Inspector 面板](docs/assets/async-inspector面板截图.png)

### 4.4 面向不同操作系统的通用化改进

教学 OS 上的调试机制通常隐含三个前提：内核与用户源码处于同一工作区、所有系统调用具有统一的用户态入口、用户程序能够在调试开始前静态配置。组件化 OS StarryOS 不满足这些前提，因此项目完成了三组改进。

#### 4.4.1 边界断点定位与方向识别

- 使用函数名断点定位外部 crate 中的特权级切换函数，摆脱本地源码路径和行号依赖；
- 将 user-to-kernel 边界收敛到内核唯一的 syscall handler，以一个断点覆盖所有用户态系统调用入口；
- 为边界断点增加 `kernel_to_user` 和 `user_to_kernel` 方向属性，区分同处内核地址空间的两类边界。

#### 4.4.2 跨 Rust 版本变量读取

Hook 断点需要读取 Rust `String` 参数，但其内部字段布局会随编译器版本变化。项目利用 GDB/MI console 输出与 result record 的严格顺序关系，在协议层捕获 GDB pretty printer 输出，再通过内存直读和字节重构得到字符串内容，避免依赖任何固定字段路径。

#### 4.4.3 动态进程组自动注入

组件化 OS 的用户程序在运行时通过 `execve` 动态出现。项目维护 user-to-kernel 边界断点待注入队列；无论进程组何时创建，都自动继承返回内核态所需的边界断点，使多次特权级切换链路保持闭合。

### 4.5 VisionFive 2 真机调试与线上化扩展

项目在已有工作的基础上完成 VisionFive 2 硬件调试适配。GDB 负责加载符号和发送调试命令，OpenOCD 在 3333 端口提供 GDB Server，J-Link 通过 JTAG 控制处理器，USB-TTL 串口用于观察 U-Boot 和目标系统输出。

调试环境采用 J-Link V12 与 OpenOCD 0.12.0，可识别 E24、U74 调试模块以及 5 个 XLEN=64 的 hart，并支持查看线程状态、读取 PC/SP/RA、暂停和恢复处理器。针对真实硬件单步期间 `dcsr.stepie=0` 且无法通过 OpenOCD 改写相关 CSR 的限制，采用边界断点和断点组切换完成内核态、用户态单步及跨特权级双向切换。

![VisionFive 2 真机硬件调试通信链路](docs/assets/VisionFive2硬件调试通信示意图.png)

项目同时实现线上硬件交互实验平台：Moodle 提供教学入口，Flask 提供注册、预约与查询接口，MariaDB 保存用户、预约、设备和调度状态，Docker 提供隔离实验环境，SSH、TFTP 和 RISC-V 工具链承担设备访问、文件传输与编译任务。平台已完成真实 VisionFive 2 的预约、分配、释放、提前提醒、状态更新、终端日志和实验会话归档。

![线上硬件交互实验平台结构](docs/assets/线上硬件交互平台结构图.png)

## 五、测试与验证

### 5.1 状态机单元测试与集成测试

项目编写 37 个 OSStateMachine 单元测试，覆盖四状态机合法转换、Border/Hook 断点、方向属性、连续单步和异常路径。`testOSDebugFlow.ts` 使用 MockMI2 模拟 GDB 后端，验证以下四类完整场景：

1. 内核启动后首次进入用户态；
2. Hook 断点发现新程序并动态创建进程组；
3. 用户态进入内核态时通过函数名边界断点走 PC 快速路径；
4. 连续三次 kernel-to-user-to-kernel 切换中，符号文件、断点和异步状态均正确保持。

37 个单元测试和 4 个集成测试场景全部通过。

### 5.2 embassy 异步跟踪验证

embassy 使用自定义 executor，不依赖 Tokio 等外部异步运行时。工具在 embassy `tick` 示例上恢复出 `main_task -> run_task -> timer::poll` 三层等待链，正确统计 poll 次数、返回次数和活跃状态，证明跟踪能力只依赖编译器生成的标准状态机结构与调试信息，而不依赖特定运行时内部实现。

![embassy 异步函数执行图](docs/assets/embassy异步函数执行图.png)

### 5.3 StarryOS 跨特权级调试验证

项目在组件化 Rust 操作系统 StarryOS 上完成从内核启动、进入 shell、动态加载用户程序到多次系统调用往返的完整调试流程。函数名边界断点、syscall handler 收敛点、方向属性、跨 Rust 版本路径读取和动态进程组注入均在真实流程中得到验证。整个过程中无需人工卸载符号表或重建断点组。

### 5.4 Async-os 统一调试验证

在 rel4 异步操作系统上同时启用 OS 调试与异步跟踪后，调试器实现：

- 内核态与用户态之间断点组、符号表自动切换；
- 特权级切换前后 CID、poll 次数、trace root 和 await/call edge 连续保持；
- Async Inspector 展示跨内核态和用户态的逻辑调用树。

该结果验证了跨特权级切换管理和异步执行流还原能够在统一平台中协同工作。

## 六、使用与运行

### 6.1 构建 VS Code 调试扩展

```bash
npm install
npm run compile
```

在 VS Code 中打开本仓库，按 `F5` 启动 Extension Development Host。根据被调试系统填写 `.vscode/launch.json`，配置 GDB 路径、远程调试端口、内核与用户地址范围、符号文件以及边界断点。

### 6.2 运行自动化测试

```bash
npm test
```

### 6.3 基本调试流程

1. 启动 QEMU GDB Server 或真实开发板 OpenOCD GDB Server；
2. 在 VS Code 中启动调试配置；
3. 按需打开 Async Inspector；
4. 生成并应用白名单，选择 trace root；
5. 在内核态和用户态源码设置普通断点，继续或单步执行；
6. 由状态机自动完成特权级切换、符号表加载和断点组恢复。

## 七、项目结构

```text
.
├── src/                    # VS Code Extension、Debug Adapter 与 MI2 协议层
├── async_rust_debugger/    # GDB Python 异步跟踪脚本
├── testcases/              # 状态机与集成测试
├── docs/                   # 演示视频、进度文档与图片资源
├── .vscode/                # 扩展调试配置
├── package.json
└── README.md
```

## 八、演示与文档

### 8.1 演示视频

- [async-debug 调试演示视频](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/docs/async-debug_%E8%B0%83%E8%AF%95%E6%BC%94%E7%A4%BA.mp4)
- [osgdb StarryOS 调试视频](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/docs/osgdb_StarryOS%E8%B0%83%E8%AF%95%E6%BC%94%E7%A4%BA.mp4)
- [async-debug embassy 调试演示视频](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/docs/embassy%E8%B0%83%E8%AF%95%E6%BC%94%E7%A4%BA.mp4)
- [Async-os 调试演示视频](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/docs/rel4%E5%BC%82%E6%AD%A5%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F%E8%B0%83%E8%AF%95%E6%BC%94%E7%A4%BA.mp4)

### 8.2 项目文档

- [操作系统跨特权级统一调试平台初赛文档](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/%E5%88%9D%E8%B5%9B%E6%96%87%E6%A1%A3-%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F%E8%B7%A8%E7%89%B9%E6%9D%83%E7%BA%A7%E7%BB%9F%E4%B8%80%E8%B0%83%E8%AF%95%E5%B9%B3%E5%8F%B0.pdf)
- [操作系统跨特权级统一调试平台初赛 PPT](https://gitlab.eduxiji.net/T2026100119910438/project3136859-387115/-/blob/main/%E5%88%9D%E8%B5%9BPPT-%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F%E8%B7%A8%E7%89%B9%E6%9D%83%E7%BA%A7%E7%BB%9F%E4%B8%80%E8%B0%83%E8%AF%95%E5%B9%B3%E5%8F%B0.pdf)

## 九、项目分工

| 成员 | 主要分工 |
| --- | --- |
| 曾小红 | 异步跟踪方案改进；异步跟踪与 OS 调试融合；Async Inspector 设计与实现；StarryOS、embassy 与 Async-os 适配验证；参赛文档和 PPT 制作 |
| 王浩铭 | OS 调试功能测试与验证；VisionFive 2 硬件调试环境搭建与适配；线上硬件交互实验平台设计与实现；真实开发板接入、预约调度与会话管理；硬件调试章节撰写 |
| 武雪妍 | 文档图片与示意图制作；参赛 PPT 制作 |

## 十、后续工作

1. 解析内核 ELF 与链接脚本，自动推导地址范围、syscall handler 和内核出口函数等调试配置；
2. 使用 GDB `finish` 和切换冷却机制优化 kernel-to-user 方向逐指令单步的性能；
3. 将 OpenOCD 进程启停、GDB 连接信息和串口日志纳入预约调度，形成完整的远程硬件调试会话。

## 十一、参考项目与资料

- [code-debug（2023-2024）](https://github.com/chenzhiy2001/code-debug)：四状态机与断点组管理机制。
- [ARDB（2025）](https://github.com/OSDebugger/code-debug_Asynchronous-trace)：await edge 与 call edge 双关系恢复方法。
- [StarryOS](https://github.com/Starry-OS/StarryOS)：组件化 Rust 操作系统验证目标。
- [rCore-Tutorial-v3](https://github.com/rcore-os/rCore-Tutorial-v3)：教学操作系统。
- [embassy](https://github.com/embassy-rs/embassy)：嵌入式异步框架验证目标。
- [rel4_kernel](https://github.com/rel4team/rel4_kernel)：Async-os 统一调试验证目标。
- [GDB/MI 协议文档](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI.html)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

# ARD Async Debugging User Guide

## 1. Introduction

ARD（Async Rust Debugger）是面向 Rust 异步程序的 VS Code 调试扩展。它在 GDB 基础上增加异步运行事件采集、调用历史重建、观察根投影和 Async Execution Graph 展示能力。

ARD 仓库与被调试工程是两个独立 workspace：

```text
ARD workspace
    负责运行和调试 VS Code extension

目标 OS workspace
    保存真实源码、ELF、launch.json 和源码断点
```

例如：

```text
/home/user/RustDebug/rust-debugger-DA
    ARD extension 开发目录

/home/user/embassy
    Embassy 真实工程目录

/home/user/AsyncOS/rel4-manifest-workspace
    Rel4 真实工程目录
```

首次 clone ARD 后，在 ARD 根目录安装 Node.js 依赖：

```bash
cd /home/user/RustDebug/rust-debugger-DA
npm install
```

此外还需要准备：

- Visual Studio Code；
- 与目标架构匹配的 GDB；
- 已生成且带 DWARF 调试信息的目标 ELF；
- remote 调试所需的 QEMU 或 gdbserver；
- 目标 workspace 自己的 `.vscode/launch.json`。

## 2. VS Code 双窗口模式

ARD 开发调试采用两个 VS Code 窗口。

```text
窗口 1：ARD Extension 开发窗口
打开目录：调试器所在根目录
启动配置：Extension Development Host (with OS)
作用：编译并启动开发中的 ARD extension

窗口 2：Extension Development Host
打开目录：Embassy 或 Rel4 的真实 workspace
启动配置：目标工程自己的 type: ardb 配置
作用：查看源码、设置断点并运行异步调试
```

启动步骤：

1. 使用 VS Code 打开 ARD 根目录。
2. 打开 Run and Debug 视图。
3. 选择 `Extension Development Host (with OS)`。
4. 按 F5，等待 Extension Development Host 窗口出现。
5. 在新窗口中选择需要的OS根目录做为 workspace。
6. 打开 Embassy 或 Rel4 的真实工程目录。

`Extension Development Host (with OS)` 只负责加载 ARD extension，不会自动打开某个 OS workspace。目标目录必须在窗口 2 中手动打开。

后续操作都在窗口 2 完成，包括：

- 选择目标 `launch.json` 配置；
- 设置源码断点；
- 启动 GDB；
- 打开 Async Inspector；
- 生成 whitelist；
- 设置 trace root；
- 查看 Async Execution Graph。

## 3. Target workspace launch.json 配置

目标工程通过以下 debugger type 使用 ARD：

```json
"type": "ardb"
```

不同 OS 的 ELF、GDB、架构和 remote endpoint 不同，因此不能把一个工程的 `launch.json` 当作所有目标的固定模板。

### 配置字段

| 字段 | 说明 | 使用要求 |
|---|---|---|
| `name` | VS Code 调试配置名称 | 建议填写 |
| `type` | ARD debugger type，必须为 `ardb` | 必需 |
| `request` | 当前使用 `launch` | 必需 |
| `program` | GDB 加载的可执行文件或 ELF | 必需 |
| `cwd` | GDB 和 Debug Adapter 的工作目录 | 建议明确填写 |
| `args` | 附加调试参数 | 可选 |
| `gdbPath` | GDB 可执行程序，默认是 `gdb` | 交叉调试时应明确填写 |
| `targetRemote` | remote 调试地址 | remote 模式必需，native 模式不需要 |
| `gdbArch` | GDB 目标架构 | 交叉架构调试时通常需要 |
| `env.PYTHONPATH` | ARD Python 包路径 | 通常可使用默认值，也可显式指定 |
| `env.ASYNC_RUST_DEBUGGER_TEMP_DIR` | whitelist、日志和 snapshot 等运行数据目录 | 强烈建议填写 |

### Native 配置特征

```text
program 指向本机可执行文件
gdbPath 使用本机 gdb
不设置 targetRemote
不设置 gdbArch
首次 Continue 直接启动本地程序
```

### Remote 配置特征

```text
program 指向带调试信息的目标 ELF
gdbPath 使用支持目标架构的 GDB
targetRemote 指向 QEMU 或 gdbserver
gdbArch 与目标架构一致
首次 Continue 连接远端并继续执行
```

## 4. Embassy 调试流程

Embassy 的 std `tick` 示例可以使用 native GDB 调试，不需要 QEMU。

### Embassy launch.json

在 Embassy workspace 中使用：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug embassy std tick (ARD)",
      "type": "ardb",
      "request": "launch",
      "program": "${workspaceFolder}/examples/std/target/debug/tick",
      "cwd": "${workspaceFolder}/examples/std",
      "gdbPath": "gdb",
      "env": {
        "ASYNC_RUST_DEBUGGER_TEMP_DIR": "${workspaceFolder}/temp/ardb-embassy"
      }
    }
  ]
}
```

目标 ELF 应位于：

```text
/home/user/embassy/examples/std/target/debug/tick
```

该 ELF 必须保留 DWARF 和符号表，不能使用被 strip 的发布产物。

### Native 调试步骤

1. 在窗口 1 启动 `Extension Development Host (with OS)`。
2. 在窗口 2 打开 `/home/user/embassy`。
3. 在 Run and Debug 视图选择 `Debug embassy std tick (ARD)`。
4. 在 `examples/std/src/bin/tick.rs` 中设置源码断点。
5. 启动 ARD 调试会话。
6. 打开 Async Inspector。
7. 点击 `Gen Whitelist`。
8. 在 Async Trace Candidates 中选择目标函数并点击 `Trace`。
9. 点击 Continue，启动本地 tick 程序。
10. 断点命中后检查源码定位和 Async Execution Graph。

### 可选的 gdbserver 模式

ARD testcase 提供了启动 Embassy gdbserver 的辅助脚本：

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std
./run_embassy_gdbserver.sh tick
```

默认行为是：

```text
构建 tick
    ↓
生成 testcase whitelist
    ↓
启动 gdbserver :1234
    ↓
调试 Embassy native x86-64 tick
```

当前 Embassy workspace 的配置是 native 模式，没有 `targetRemote`，不会自动连接上述 gdbserver。不要同时使用 native launch 和 gdbserver。若选择 remote/manual-connect 流程，必须确保 remote 连接方式、端口以及 whitelist/temp 路径属于同一个调试会话。

## 5. Rel4 调试流程

Rel4 使用 RISC-V remote 调试。目标程序由外部 QEMU 或兼容 remote target 运行，ARD 使用 `gdb-multiarch` 连接 `:1234`。

### Rel4 launch.json

在 Rel4 workspace 中使用：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug rel4 real workspace kernel (ARD attach)",
      "type": "ardb",
      "request": "launch",
      "program": "${workspaceFolder}/rel4_kernel/build-rel4-async-debuginfo-only/kernel/kernel.elf",
      "cwd": "${workspaceFolder}",
      "gdbPath": "gdb-multiarch",
      "targetRemote": ":1234",
      "gdbArch": "riscv:rv64",
      "env": {
        "PYTHONPATH": "/home/user/RustDebug/rust-debugger-DA",
        "ASYNC_RUST_DEBUGGER_TEMP_DIR": "${workspaceFolder}/temp/ardb"
      }
    }
  ]
}
```

### Remote 调试步骤

1. 确认配置中的 kernel ELF 已存在并带 DWARF 信息。
2. 启动与当前构建目录对应的 Rel4 QEMU/simulate 调试目标。
3. 让目标在 `:1234` 监听并等待 GDB。Rel4 的 simulate 调试模式通常使用 `-d` 或 `--gdbserver`，底层对应 QEMU 的 `-s -S`。
4. 在窗口 1 启动 `Extension Development Host (with OS)`。
5. 在窗口 2 打开 `/home/user/AsyncOS/rel4-manifest-workspace`。
6. 选择 `Debug rel4 real workspace kernel (ARD attach)`。
7. 在真实 Rel4 源码中设置 VS Code breakpoint。
8. 启动 ARD 调试会话。
9. 打开 Async Inspector，生成 whitelist 并设置 trace root。
10. 点击 Continue。ARD 会连接 `:1234`，然后让远端目标继续运行。
11. 断点命中后检查源码自动定位和 Async Execution Graph。

不要同时通过 launch 配置和 Async Inspector 的 `Connect :1234` 重复连接同一个目标。配置了 `targetRemote` 时，优先使用首次 Continue 的自动连接流程。

## 6. Whitelist 与 Trace Root

### Whitelist

Whitelist 定义哪些 Rust poll 函数允许进入 ARD 的 runtime instrumentation。它控制事件采集范围，但它本身不是调用图。

推荐在 Async Inspector 中点击 `Gen Whitelist`。该操作等价于生成 whitelist 后加载当前会话的文件：

```gdb
ardb-gen-whitelist
ardb-load-whitelist /absolute/path/to/poll_functions.txt
```

生成成功后，Async Trace Candidates 会显示当前会话 whitelist 中的完整函数符号。

需要确保：

- `ASYNC_RUST_DEBUGGER_TEMP_DIR` 指向当前 workspace 的会话目录；
- 生成和加载的是同一个 `poll_functions.txt`；
- 当前 GDB 已加载正确 ELF 和调试符号。

### Trace Root

在 Async Trace Candidates 中点击 `Trace`，或者在 Debug Console 中执行：

```gdb
ardb-trace embassy_time::timer::{impl#5}::poll
```

Trace root 是 Async Execution Graph 的观察根。它只选择从哪个函数开始展示已有执行历史，不会：

- 创建新的 runtime event；
- 创建 History 节点或边；
- 修改 whitelist；
- 修改 Snapshot；
- 自动制造调用关系。

完整关系如下：

```text
Whitelist
    决定哪些 poll 函数允许产生运行事件

Trace Root
    决定从哪个函数开始观察已记录的执行历史
```

## 7. Breakpoint 与源码自动定位

源码断点必须设置在窗口 2 的真实目标工程中，而不是 ARD 仓库中。

使用步骤：

1. 打开目标工程的 Rust 源文件。
2. 在 VS Code 编辑器行号左侧设置普通 breakpoint。
3. 启动 ARD 调试会话并让程序运行。
4. 等待 GDB 命中断点。

断点命中后，ARD 使用 GDB 停止帧中的 DWARF 文件路径和行号自动打开源码并定位当前行。

```text
GDB breakpoint hit
    ↓
物理停止帧中的文件路径和行号
    ↓
ARD Reveal Stop Location
    ↓
VS Code 打开真实源码并定位当前行
```

源码自动定位与异步逻辑调用图是两条独立链路：

```text
物理停止位置
    用于打开源码

异步逻辑执行关系
    用于 Async Execution Graph
```

如果 ELF 的 DWARF 路径与当前 workspace 源码不匹配，断点可能命中但无法正确打开源码。此时应优先检查构建目录、ELF 和源码是否来自同一份工程。

## 8. Async Execution Graph 使用

在窗口 2 中通过 VS Code 命令面板运行 `Open Async Inspector`。

当前主要功能：

| 功能 | 作用 |
|---|---|
| `Gen Whitelist` | 生成、加载 whitelist 并刷新候选函数 |
| `Trace` | 把候选函数设置为当前观察根 |
| `Locate` | 使用 GDB 符号信息定位候选函数源码 |
| `Refresh Graph` | 重新查询当前观察根对应的执行图 |
| `History` | 向 Debug Console 输出完整 History JSON |
| `Snapshot` | 查询当前时刻的异步快照 |

主页面标题为 `Async Execution Graph`。它显示 Observer projection，而不是完整 History Tree。

断点命中真实 stopped event 后，ARD 会自动刷新当前 Observer projection。也可以点击 `Refresh Graph` 手动刷新。

例如真实运行历史为：

```text
main
└── run
    └── timer
```

选择不同 trace root 后，图的观察范围不同：

```text
trace main
main
└── run
    └── timer

trace run
run
└── timer

trace timer
timer
```

只有对应函数已经产生真实运行事件并进入 History 后，Observer projection 才会显示节点。设置 trace root 不会让尚未执行的函数自动出现在图中。

## 9. History Debug Information

History 保存 whitelist 接纳的累计运行事实，包括已经观察到的异步函数节点和调用边。

Async Inspector 中的 `History` 按钮用于开发和诊断：

```text
点击 History
    ↓
查询完整 History Tree JSON
    ↓
输出到 VS Code Debug Console
```

`History` 按钮不会：

- 将主图切换为 History Tree；
- 改变当前 trace root；
- 修改 Async Execution Graph；
- 清除运行历史；
- 生成新的 runtime event。

需要手动查询时，可以在 Debug Console 执行：

```gdb
ardb-get-history-tree
```

History 适合验证以下问题：

- 目标函数是否已经产生运行事件；
- 父子调用关系是否已经被记录；
- Observer projection 为空是因为函数尚未执行，还是 trace root 不匹配；
- 当前完整执行历史是否包含预期节点。

## 10. ARD Async Debugging Architecture

ARD 的用户控制链：

```text
poll_functions.txt
    ↓
Async Trace Candidates
    ↓ 用户选择完整函数符号
Trace Root
    ↓
Observer projection 的观察起点
```

ARD 的运行事实链：

```text
程序真实运行
    ↓
GDB/runtime breakpoint hit
    ↓
RuntimeEvent
    ↓
History Builder
    ↓
History Tree
```

最终展示链：

```text
History Tree
    +
用户选择的 Trace Root
    ↓
Observer Tree projection
    ↓
Async Execution Graph
    ↓
VS Code Async Inspector
```

源码定位链独立运行：

```text
GDB physical stopped frame
    ↓
DWARF 文件路径和行号
    ↓
Reveal Stop Location
    ↓
VS Code source editor
```

因此，Async Execution Graph 不是预置图，也不是仅根据静态源码推测的调用关系。它由以下两部分共同决定：

```text
真实运行事件
    +
用户选择的观察根
```

用户选择哪个异步函数作为 trace root，ARD 就从真实 History 中投影该函数对应的已执行子树。

## Troubleshooting

### ELF 或 DWARF 问题

症状：

- GDB 无法加载程序；
- breakpoint 无法验证；
- 断点命中后无法打开源码；
- whitelist 中缺少预期函数。

检查：

```bash
file /absolute/path/to/program.elf
readelf -S /absolute/path/to/program.elf
```

确认：

- `program` 指向真实存在的 ELF；
- ELF 没有被 strip；
- ELF 包含 `.debug_info` 和 `.debug_line`；
- ELF 与当前 workspace 源码来自同一次构建；
- `gdbPath` 和 `gdbArch` 与目标架构匹配。

### Whitelist 为空

症状：Async Trace Candidates 没有可选函数。

处理步骤：

1. 确认 GDB 已加载正确 ELF。
2. 确认 ELF 包含函数符号和 DWARF 信息。
3. 在 Async Inspector 点击 `Gen Whitelist`。
4. 检查 `ASYNC_RUST_DEBUGGER_TEMP_DIR` 是否可用。
5. 确认生成和加载的是同一个 `poll_functions.txt`。

也可以在 Debug Console 中重新执行：

```gdb
ardb-gen-whitelist
ardb-load-whitelist /absolute/path/to/poll_functions.txt
```

### Execution Graph 为空

可能原因：

- 尚未设置 trace root；
- trace root 的完整符号与 History 节点不一致；
- 对应函数尚未实际执行；
- 函数不在 whitelist 中；
- 程序尚未 Continue；
- runtime event 尚未被记录。

处理步骤：

1. 在 Async Trace Candidates 中选择完整函数符号并点击 `Trace`。
2. 继续运行程序，使目标异步函数真实执行。
3. 等待断点命中或暂停程序。
4. 点击 `Refresh Graph`。
5. 点击 `History`，在 Debug Console 中确认完整 History 是否包含目标函数。

不要把空图直接理解为渲染失败。Observer projection 只能展示已经存在于真实 History 中的子树。

### Remote 连接失败

症状：Rel4 或 gdbserver 模式无法连接 `:1234`。

检查：

```bash
ss -ltn | grep 1234
```

确认：

- QEMU 或 gdbserver 已经启动；
- remote target 正在监听 1234；
- `targetRemote` 与实际监听地址一致；
- QEMU 使用了等待 GDB 的调试模式；
- `gdb-multiarch` 已安装并支持目标架构；
- 没有另一个 GDB 会话占用连接；
- 没有同时使用 launch 自动连接和 `Connect :1234` 重复连接。

Rel4 remote 会话中，先启动目标并确保其等待 GDB，再启动 ARD 调试配置并点击 Continue。Embassy 当前默认配置是 native 模式，不应在启动 gdbserver 后仍使用无 `targetRemote` 的 native launch。

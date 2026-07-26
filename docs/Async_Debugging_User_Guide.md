# ARD Async Debugging User Guide

## 1. ARD 要解决什么问题

ARD（Async Rust Debugger）是在 GDB 和 VS Code 调试流程之上增加 Rust 异步语义的调试器。它的目标不是把普通函数调用栈换一种样式显示，而是回答普通物理调用栈难以回答的四个问题：

- 异步运行时实际执行过哪些 async/sync 函数？
- 这些运行事件之间形成了什么父子关系？
- 程序暂停时，当前活跃的 Future、CID 和 await 链是什么？
- 如何把累计执行历史与当前暂停状态分别呈现在 VS Code 中？

Rust async 函数会被编译为 Future。执行器不断调用 `poll()`，Future 在 `Pending` 后退出当前物理栈，随后又可能从另一个物理调用路径恢复。因此，某一时刻的 GDB backtrace 通常只包含执行器、poll glue 和当前机器栈，不能完整表示源码中的逻辑 await 链。

ARD 为此保留两类互不替代的事实：

```text
运行期间累计事实                         暂停瞬间事实

GDB internal breakpoint                 Future / CID / TLS / runtime state
        │                                           │
        ▼                                           ▼
RuntimeEventGraph                              SnapshotV1
        │                                           │
        ▼                                           ▼
History / Execution Graph                  logical async frames
```

这一区分是理解当前架构的关键：

- **History** 回答“程序运行过程中发生过什么”。
- **Snapshot** 回答“程序现在暂停在哪里、当前异步状态是什么”。

## 2. 当前核心架构

### 2.1 RuntimeEvent capture

```text
whitelist 中的精确符号
        │
        ▼
GDB internal breakpoint
        │
        ▼
async_rust_debugger/runtime_trace.py
        │
        ▼
RuntimeEvent create → classify → admission
        │
        ▼
RuntimeEventGraph
```

Whitelist 是唯一的 runtime event 准入边界。加载 whitelist 后，`runtime_trace.py` 根据 grouped whitelist 中的 async/sync 语义安装两条探针路径：

- async/poll 符号使用 `RuntimeEventBP`（复用 `PollEntryBP`），同时采集 Future address、CID、poll state、TLS async stack、awaitee 和 Snapshot 所需事实；
- sync 符号使用 `GenericRuntimeEventBP`，只在已有 async graph stack 内记录普通运行调用，不创建 CID，也不写入 Snapshot async stack。

这些探针是 GDB internal breakpoints，`stop()` 返回 `False`。它们用于透明采集，不应因为自身命中而产生面向用户的 DAP stopped event。

### 2.2 Execution history

```text
RuntimeEventGraph
        │
        ▼
History Tree（累计执行历史）
        │
        ├── ardb-get-history-tree：完整图，供诊断
        │
        ▼
Observer projection（按 ACTIVE_TRACE_ROOT 选取子树）
        │
        ▼
Async Inspector / Execution Graph
```

代码中的 `Observer` 是内部投影名称。用户界面统一称为 **Execution Graph**。它不是第二套图，也不是新的采集器，而是完整 History 中以当前 Trace Root 为根的已执行子树。

`ardb-trace <symbol>` 只更新单个 `ACTIVE_TRACE_ROOT`。再次选择其他符号会覆盖旧 root；它不会安装一套新采集器、清空 History 或制造调用边。

### 2.3 Current snapshot 与 DAP Call Stack

```text
Future / CID / TLS / poll state
        │
        ▼
SnapshotV1
        │
        ▼
RuntimeTraceBridge.getSnapshot()
        │
        ▼
gdbDebugSession.stackTraceRequest()
        │
        ├── SnapshotV1.data.async_path → logical async frames
        │
        └── GDB MI stack             → physical frames
                    │
                    ▼
             VS Code Call Stack
```

DAP 的正式 Snapshot 消费路径是 GDB command 的 captured console output，经 `RuntimeTraceBridge` 解析 `ardb.async / snapshot / version: 1` envelope；正式链路不从磁盘诊断文件读取 Snapshot。

VS Code Call Stack 同时保留两种帧：

1. 顶部是 SnapshotV1 `async_path` 反转得到的 leaf-first logical async frames；
2. 后面是 GDB MI 返回的真实 physical frames。

Logical frame 用于解释异步关系，physical frame 仍负责真实机器状态、寄存器、变量和 GDB frame。ARD 不用 Snapshot 覆盖物理栈。

## 3. 开始使用

### 3.1 前置条件

需要准备：

- VS Code；
- 当前仓库构建出的 ARD extension；
- 与目标架构匹配的 GDB；
- 包含符号表、`.debug_info` 和 `.debug_line` 的 Rust ELF；
- 目标工程源码与 ELF 对应的构建版本；
- remote 场景所需的 QEMU 或 gdbserver。

不要在文档或配置中固化某台机器的绝对路径。ELF、workspace 和 GDB 路径应由当前开发环境的 `launch.json` 提供。

### 3.2 开发版 extension 启动

从源码调试 extension 时：

1. 在 VS Code 打开 ARD 仓库。
2. 运行仓库提供的 Extension Development Host 配置。
3. 在 Extension Development Host 中打开目标 workspace。
4. 选择该 workspace 的 `type: "ardb"` 调试配置。

一个最小 native 目标配置形态如下：

```json
{
  "name": "Debug Rust (ARD)",
  "type": "ardb",
  "request": "launch",
  "program": "${workspaceFolder}/target/debug/${workspaceFolderBasename}",
  "args": [],
  "cwd": "${workspaceFolder}"
}
```

OS/remote 工程应继续使用 main 调试框架已有的 attach、QEMU、BreakpointGroups 和 OSStateMachine 配置；async tracing 不替换这套控制链。

### 3.3 一次完整用户流程

1. 启动 `ardb` 调试会话，确认目标 ELF 和符号已经加载。
2. ARD 自动打开 Async Inspector。也可以从命令面板运行 `Open Async Inspector`。
3. 如果 workspace 的 `temp/poll_functions.txt` 已存在，Debug Adapter 会在 GDB `debug-ready` 后自动执行 `ardb-load-whitelist`。
4. 如果尚无 whitelist，在 Inspector 中点击 **Gen Whitelist**。
5. 在 grouped whitelist 中选择需要启用的 crate；更新后的 flat whitelist 会被加载，并安装 runtime probes。
6. 在候选 async 符号旁点击 **Trace**，设置单一 Trace Root。
7. 设置所需的普通 VS Code 源码断点，然后 Continue。
8. 程序运行期间，internal probes 透明采集 RuntimeEvent 并更新 RuntimeEventGraph。
9. 用户断点或暂停触发真实 stopped event 后，Inspector 自动刷新当前 Execution Graph。
10. 查看 VS Code Call Stack：logical async frames 位于 physical GDB frames 之前。
11. 需要检查暂停瞬间的原始 async 状态时点击 **Snapshot**；需要检查完整累计历史时在 Debug Console 查询 `ardb-get-history-tree`。

## 4. Whitelist 与 probe 安装

Whitelist 的职责是控制采集范围，避免对 ELF 中所有函数安装探针。它不是调用图，也不是 Snapshot。

当前生成物包含：

- `poll_functions.txt`：运行时加载的 flat whitelist；
- `poll_functions_grouped.json`：按 crate 和 async/sync kind 分组的 UI/分类元数据。

关键链路如下：

```text
Gen Whitelist
        │
        ▼
flat + grouped whitelist
        │
        ▼
ardb-load-whitelist / ardb-update-whitelist
        │
        ▼
读取 grouped kind
        │
        ├── kind=async → RuntimeEventBP / PollEntryBP path
        └── kind=sync  → GenericRuntimeEventBP path
```

Probe 分类优先使用 grouped whitelist 的 async 语义，而不是仅凭函数名中是否出现 `poll`。这使返回 `Poll<T>`、但名称并不“pollish”的 async wrapper 仍可进入完整 Future/CID 采集路径。

### 两条采集路径的边界

| 能力 | async/poll probe | sync generic probe |
|---|---:|---:|
| RuntimeEvent | 是 | 是 |
| RuntimeEventGraph node/edge | 是 | 是（仅作为已有 async 路径的 child） |
| Future address | 是 | 否 |
| CID | 是 | 否 |
| TLS async stack | 是 | 否 |
| poll state / awaitee | 是 | 否 |
| Snapshot async node | 是 | 否 |

因此，Execution Graph 可以显示 `ASYNC` 和 `SYNC` 节点，但 Snapshot 的 `async_path` 仍只表达 Future 事实。

## 5. RuntimeEventGraph 为什么存在

物理 stack trace 只反映“CPU 当前经过哪些 frame”。异步调试还需要“某个 Future 曾由谁驱动、退出后何时恢复、期间调用过什么”的累计事实。

RuntimeEventGraph 在 `runtime_trace.py` 内维护：

- nodes：被 whitelist 接纳的函数节点；
- edges：观察到的 parent → child 调用关系；
- events：有序的 enter、exit、edge 和诊断事件；
- roots/stable roots：已确认的执行入口；
- per-thread call stack：为 enter 时的动态 parent 选择提供运行上下文。

### Enter

Probe 命中后先创建 RuntimeEvent，再进行 classification 和 whitelist admission。只有结果为 `ALLOW` 的事件才能调用 `_record_call_enter()`：

```text
breakpoint hit
    → _make_runtime_event()
    → _classify_runtime_event()
    → _admit_trace_candidate()
    → _record_call_enter()
```

Enter 会创建或更新节点、增加 enter/active count、确定当前动态 parent、记录 edge，并把 frame 压入 thread-local graph stack。

### Exit

同一次 enter 只创建一个统一的 `_PopOnReturnBP` FinishBreakpoint。函数返回时先执行 `_record_call_exit()`，再完成原有 async TLS cleanup。Exit 更新 exit count、active count、last exit event，并从 graph stack 恢复上层调用上下文。

### Edge

Edge 表示实际 runtime event 观察到的父子调用拓扑。实现拒绝 self edge，并进行 cycle 检测、parent/children 同步和 stable-root 保护。

History 导出直接读取 RuntimeEventGraph；旧 CID History projector 不再是 Execution History 的事实来源。

## 6. History、Trace Root 与 Execution Graph

### History

History 是本次调试运行中累计的 execution topology：

```gdb
ardb-get-history-tree
```

返回内容包括 `nodes`、`edges`、`roots`、`events`、`counts` 和内部 `relation_annotations`。它用于开发诊断，不作为 Inspector 中的第三种树视图。

清理累计历史使用：

```gdb
ardb-clear-history-tree
```

该命令清理 RuntimeEventGraph、相关 annotation baseline，并使旧 Trace Root 失效。Snapshot 的 Future/CID producer 是独立链路。

### Trace Root

```gdb
ardb-trace '<full Rust symbol>'
```

Trace Root 只控制展示投影。推荐选择 grouped whitelist 中的 async 根符号。设置 root 后仍需让程序真实运行；尚未产生 RuntimeEvent 的函数不会仅因被选择而出现在图中。

### Execution Graph

Inspector 请求 `ardb-get-observer-tree`。后端先导出 History，再查找 `ACTIVE_TRACE_ROOT` 对应的 detached subtree。查询 projection 不改变 History counts，也不会重建或重新采集图。

内部仍保留 `observer_tree`、`ObserverTreeData`、`_find_observer_subtree()` 等名称以维持协议兼容；面向用户的概念是 Execution Graph。

## 7. SnapshotV1：当前暂停状态

SnapshotV1 是 versioned envelope 中的当前异步状态，不是历史树。核心字段包括：

- `thread_id`：暂停线程；
- `empty`：当前 TLS async path 是否为空；
- `async_path`：由当前 `_TLS_STACK` 中 CID 构成的 async 路径；
- 每个节点的 `function`、`cid`、`future_address`、poll sequence/state；
- `awaitee_candidate`；
- `relation_from_parent`；
- `source`（name/path/line）。

请求命令：

```gdb
ardb-get-snapshot
```

Inspector 的 **Snapshot** 按钮会查询并缓存/记录 Snapshot JSON，但不会调用 tree renderer，不会覆盖 Execution Graph。当前主树始终来自 Observer projection。

DAP `stackTraceRequest()` 也会查询 SnapshotV1，并将 `async_path` 转换为 logical frames。Logical frames 没有与某个 physical GDB frame 一一对应的变量 scope；变量、寄存器和真实 frame 操作仍应使用 physical stack frames。

## 8. Relation / await 证据层

ARD 在 async probe 中观察 parent CID、child CID、Future address、poll sequence 和 awaitee candidate。`RuntimeRelationBuilder` 与 `RuntimeRelationValidator` 对这些事实进行验证，`ValidatedRelationStore` 保存已验证的 await 证据。

它的职责是：

- 为 Snapshot 节点补充 `relation_from_parent`；
- 为 History edge 导出内部 `relation_annotations`；
- 记录 relation kind、confidence 和 evidence，供诊断使用。

它不负责：

- 创建 RuntimeEventGraph node；
- 决定或修改 History parent；
- 根据 Future address 重建 graph topology；
- 充当另一套 History 数据库。

这是刻意的职责边界：RuntimeEventGraph 表达实际执行拓扑，ValidatedRelationStore 表达 await 语义证据。两者粒度不同，不能用 Snapshot 或 relation 反向改写已观察到的运行事实。

Inspector 默认只显示节点的 `ASYNC`/`SYNC` 类型和函数树，不展示 CID、Future address、confidence 或 evidence。

## 9. Source 定位

ARD 有两条方向相反、但共享 source-root 事实的路径：

```text
Execution Graph 节点定位：DWARF/GDB path → local source
用户源码断点安装：       local source → GDB breakpoint location
```

### 9.1 Snapshot source

Snapshot source 优先使用 GDB 自己的符号/行号解析：

```text
gdb.decode_line(symbol)
        ↓
symtab.fullname()
        ↓ 失败或字段不完整
info line
        ↓
bounded workspace/testcase/whitelist-context fallback
```

`symtab.fullname()` 能利用 objfile compilation directory 和 GDB 的 source substitution。Fallback 不扫描整个磁盘，也不硬编码某个 testcase 或外部工程路径；多个候选匹配时拒绝猜测并记录诊断。

### 9.2 Execution Graph 节点点击

Rust async 内部符号可能在 DWARF 中只存在 closure 或 outer function 形式。节点定位按以下顺序尝试：

1. RuntimeEventGraph 中保存的原始 symbol；
2. `{async_fn#N}` 对应的 `{closure#N}`；
3. 去掉 async 内部后缀的 outer function；
4. 节点地址可用时执行 `info line *address`。

得到 DWARF file:line 后，TypeScript source resolver 在当前 workspace、extension root 和已知 testcase roots 内做安全的精确/后缀匹配。原 History symbol 和 node identity 不会为定位而改变。

### 9.3 用户源码断点

DAP 始终保留 VS Code 的 local source identity。发送给 GDB 时可以尝试原始 local path、source-root relative path 和 testcase-root relative path。BreakpointGroups 保存结构、OS 状态机和 MI2 核心协议不因此改变。

## 10. Async Inspector

Async Inspector 当前面向用户只有一个主树：**Execution Graph**。

### 工具栏

| 控件 | 当前行为 |
|---|---|
| `Reset` | 重置 runtime instrumentation 的运行期状态并重新安装已加载 whitelist 的 probes |
| `Gen Whitelist` | 生成 flat/grouped whitelist，并刷新 grouped candidates |
| `Snapshot` | 手动请求 SnapshotV1，记录并缓存当前异步状态；不改写主树 |
| `Execution Graph` | 重新请求当前 Trace Root 的 Observer projection |

### Whitelist 面板

- grouped view 将符号分为 Async 和 Sync；
- crate checkbox 控制 flat whitelist 中启用的 crate；
- **Trace** 设置单个 Trace Root；
- **Locate** 通过 GDB symbol lookup 和 source resolver 打开源码。

### stopped 生命周期

真实用户断点或 pause 产生 stopped event 后，Panel 只刷新 Execution Graph，不同时并发请求三套树，也不会自动让 Snapshot 覆盖 renderer。VS Code 请求 Call Stack 时，DAP 独立获取 SnapshotV1 并组合 logical/physical frames。

## 11. 常用后端命令

| 命令 | 用途 |
|---|---|
| `ardb-async-capabilities` | 查询 Snapshot、execution history、observer projection 等 capability |
| `ardb-gen-whitelist` | 生成 whitelist 文件 |
| `ardb-load-whitelist [path]` | 加载 flat whitelist 并安装 probes |
| `ardb-get-whitelist-grouped` | 读取 grouped whitelist |
| `ardb-trace <symbol>` | 覆盖当前单一 Trace Root |
| `ardb-get-history-tree` | 查询完整 RuntimeEventGraph History |
| `ardb-get-observer-tree` | 查询 Trace Root 对应的 Execution Graph projection |
| `ardb-clear-history-tree` | 清理 RuntimeEventGraph History 和失效 Trace Root |
| `ardb-get-snapshot` | 查询当前 SnapshotV1 |
| `ardb-trace-status` | 查询 probe 和 RuntimeEventGraph counts |
| `ardb-reset` | 重置运行期探针/CID/TLS/relation 状态并恢复 whitelist probes |

Capability 中保留 `history: 1` 作为兼容声明，同时通过 `execution_history: 1` 和 `observer_tree: 1` 明确当前正式架构。旧 CID History V1 TypeScript API仅保留 deprecated 兼容面，不是当前 UI 或 DAP 的 History 主链。

## 12. 支持范围与当前边界

当前迁移闭环重点在 `testcases/minimal` 上完成了后端和静态验证，包括：

- async/sync 双路径 RuntimeEvent；
- enter/exit、History 和 Observer projection；
- SnapshotV1、await relation evidence；
- DAP logical + physical stack；
- async symbol/source fallback；
- Execution Graph 展示。

Embassy、rel4 等外部 workspace 是后续适配重点，尤其需要继续人工验证：

- grouped whitelist 对复杂 runtime wrapper 的分类覆盖；
- 不同 GDB/目标架构下的 Future pointer 和 DWARF 布局；
- 外部构建目录的 `symtab.fullname()` 与 source mapping；
- 多 root、嵌套 async 和跨 OS privilege 场景。

因此，不应把 minimal 的验证结果夸大为所有 Rust executor、所有优化级别或所有 OS target 已完全支持。当前 async tracing 也不会替代 main 原有 GDB/DAP、OSStateMachine、BreakpointGroups、addrSpace 和 privilege 控制能力。

## 13. Troubleshooting

### Whitelist 为空或 probes 为 0

检查：

1. GDB 是否加载了正确且带 DWARF 的 ELF；
2. workspace `temp/poll_functions.txt` 是否存在；
3. grouped whitelist 是否包含预期 crate 和 symbol；
4. GDB 输出是否出现 `whitelist loaded: exact=... observers=...`；
5. `ardb-trace-status` 的 `runtime_probe_count` 是否大于 0。

### Execution Graph 为空

按链路定位：

```text
probe installed?
    ↓
RuntimeEvent created?
    ↓
admission ALLOW?
    ↓
History counts > 0?
    ↓
Trace Root 是否精确匹配 History func?
    ↓
Observer roots 非空?
```

先查询 `ardb-get-history-tree`。如果 History 非空而 Execution Graph 为空，优先检查 Trace Root；如果 History 也为空，优先检查 whitelist、probe 安装和程序是否实际运行到目标函数。

### Call Stack 没有 logical async frames

检查 `ardb-get-snapshot`：

- `empty: true` 表示暂停时当前线程没有活跃 `_TLS_STACK` async path；
- `async_path` 非空但 Call Stack 未显示时，再检查 RuntimeTraceBridge captured output 和 DAP stackTrace；
- physical frames 仍应存在，它们不依赖 Snapshot。

### Snapshot 与 Execution Graph 看起来不同

这是正常的时间边界，而不一定是 bug：

- Execution Graph 是运行以来累计 History 的投影；
- Snapshot 只包含暂停瞬间仍在 TLS async stack 中的 Future；
- 已经退出或当前不活跃的节点可以出现在 History 中，但不出现在 Snapshot 中。

### Source 无法打开

依次检查：

1. ELF 与源码是否来自同一次构建；
2. `info line '<symbol>'` 和 `gdb.decode_line()` 是否能返回有效 SAL；
3. `symtab.fullname()` 返回的路径是否存在；
4. workspace/source roots 中是否出现多个相同后缀候选；
5. 日志中的 `source resolve ambiguous` 或 `source unresolved` 诊断。

不要仅按 basename（例如 `main.rs`）猜测源文件，也不要用固定本机路径掩盖旧 ELF/DWARF 的构建来源问题。

## 14. 设计总结

ARD 当前设计的核心不是增加一棵“异步 UI 树”，而是把不同时间尺度的事实保持分离：

```text
GDB/DAP/OS control                     main 调试框架负责

RuntimeEventGraph                     累计执行拓扑
        ↓
History                               唯一 Execution History 事实源
        ↓
Observer projection                   单 Trace Root 的只读子树
        ↓
Execution Graph                       用户可见历史视图

Future/CID/TLS                        当前 runtime 状态
        ↓
SnapshotV1                            当前暂停事实
        ↓
DAP logical frames + GDB physical     用户可见 Call Stack

ValidatedRelationStore                await 证据层，不创建拓扑
```

这种设计避免了三类常见混淆：用物理栈冒充逻辑 await 栈、用 Snapshot 冒充累计历史、以及用 relation evidence 反向制造调用图。它也使 Debugger-2 已有的异步历史重建能力能够进入 main 调试框架，而不引入第二套 adapter、session 或 GDB 控制层。

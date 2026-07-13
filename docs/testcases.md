# ARD Async Future Testcase Coverage

## Purpose

本文档规划 ARD 对不同 Future 执行入口的 testcase 覆盖。重点不是 Rust 源码采用哪一种异步语法，而是编译后的函数是否形成 ARD 能够识别、设置断点并跟踪生命周期的 poll 执行入口。

ARD 通过 GDB 中可见的函数签名生成 whitelist，在运行时为 whitelist symbol 安装 breakpoint。只有真实命中且通过 whitelist admission 的事件才能写入 History Tree；Observer Tree 再根据用户选择的 trace root 投影子树，最终由 Async Execution Graph 展示。

核心链路如下：

```text
Future 的 poll 执行入口
        ↓
函数返回 core::task::poll::Poll<...>
        ↓
Whitelist generation
        ↓
Runtime poll breakpoint
        ↓
RuntimeEvent
        ↓
History Tree
        ↓
Observer Tree
        ↓
Async Execution Graph
```

该覆盖规划用于验证不同 Future 实现和 runtime wrapper 是否能够经过同一条 ARD 链路，不代表对所有编译器版本、优化级别、executor 或目标平台作出保证。

## Current Future Identification Mechanism

### Whitelist generation

当前生成流程调用 GDB `info functions`，从输出中解析：

- 源文件；
- 行号；
- 完整函数签名；
- `->` 后的返回类型；
- 第一个参数列表之前的完整 symbol。

函数进入自动生成的 whitelist 需要满足：

```text
return_type 包含 core::task::poll::Poll<
```

因此，ARD 当前自动识别返回 `Poll<T>` 的可执行函数入口，而不是直接识别源码中“返回某个 Future 对象”的普通构造函数。

例如，以下源码函数返回一个 Future 对象，但函数本身不返回 `Poll<T>`，不会仅凭其返回类型自动成为 poll whitelist entry：

```rust
fn make_future() -> impl Future<Output = ()> {
    CustomFuture::new()
}
```

真正被 ARD 跟踪的是该 Future 运行时执行的 poll 入口：

```rust
fn poll(...) -> Poll<Output>
```

### Matched return type

当前主扫描条件是对 GDB 返回类型文本执行精确子串检查：

```text
core::task::poll::Poll<
```

扫描不会根据 `Future::Output` 的具体类型进行分类，因此 `Poll<()>`、`Poll<Infallible>`、`Poll<Option<T>>` 等只要在 GDB 签名中采用上述 canonical 路径，都可以成为候选。

当前扫描也不是通过以下条件决定 whitelist membership：

- 函数名是否包含某个业务名称；
- symbol 是否包含编译器生成的异步标记；
- symbol 是否属于 Embassy、Rel4 或 Lilos；
- runtime 或 executor crate 名称；
- 函数是否由特定宏生成；
- 源码是否直接声明 `impl Future`。

编译器生成标记和少量 runtime 名称会在运行时的辅助分类、父调用者发现、状态读取或 snapshot 恢复中使用，但它们不是主 whitelist 生成条件，也不是 History Tree 写入的最终 admission 条件。

### Runtime whitelist admission

Whitelist 文件支持两种条目：

```text
完整 symbol
symbol 前缀加 * 通配
```

加载后，ARD 优先按解析后的地址匹配精确 symbol，并可回退到完整名称或显式前缀匹配。每个精确 whitelist symbol 都会安装 runtime event breakpoint。

一次命中只有同时满足以下条件才能写入 History Tree：

```text
真实 breakpoint hit
        +
symbol 通过已加载 whitelist
        ↓
admission = ALLOW
        ↓
History node / edge write
```

未加载 whitelist 时，动态 callee 不会自动成为 RuntimeEvent source 或 History node。Trace root 也不会绕过 whitelist：它只选择 Observer Tree 的观察根，不负责创建节点。

## Existing Testcase Evidence

### Embassy

Embassy `tick` 的现有 whitelist 包含三类入口：

```text
Embassy main task 的宏生成 Future poll 入口
Embassy spawned task 的宏生成 Future poll 入口
Embassy Timer 的 Future::poll 实现
```

已有运行记录验证了以下链路：

```text
main task
    ↓
spawned run task
    ↓
timer poll
```

这提供了以下覆盖：

- 编译器与 Embassy 宏共同生成的 task Future；
- executor task 的 coroutine identity；
- runtime library 提供的 Timer Future；
- 重复 poll 生命周期；
- History Tree 父子关系；
- 不同 trace root 对 Observer Tree 的投影；
- Async Execution Graph 重建。

### Rel4 async

Rel4 async 的现有 whitelist 包含：

```text
boxed Future 的通用 poll wrapper
async syscall handler 的编译器生成 poll 入口
Coroutine::execute runtime wrapper
```

`Coroutine::execute` 本身不是 `Future` trait 实现；它保存并驱动一个 boxed dynamic Future，直接返回 `Poll<()>`。它仍能被自动加入 whitelist，证明当前机制覆盖范围是 Poll-return execution entry，而不限于某种源代码声明。

已有 testcase 证据覆盖：

```text
Coroutine::execute
    ↓
async syscall handler
```

该系统用于验证：

- OS runtime 对 Future 的封装；
- dynamic Future poll；
- runtime wrapper 与内部 Future 的关系；
- scheduler 和内核执行环境中的 coroutine identity；
- remote GDB 环境下的 RuntimeEvent、History 和观察根投影。

### Lilos

Lilos 是非 Embassy executor，现有源码和 whitelist 覆盖多种 Future/poll 入口：

```text
executor 管理的多个顶层 task Future
Future combinator wrapper poll
TimeLimited 等泛型 Future wrapper
YieldCpu 等手动 Future::poll 实现
executor 内部 Future poll
```

Lilos 的 top-level executor 接收多个 `Future<Output = Infallible>` task，并按 wake bit 调度。现有 whitelist 还包含多个泛型 wrapper 和 runtime poll symbol，因此它适合验证：

- 非 Embassy executor 的适配能力；
- 手动实现的 Future 状态机；
- 泛型和长 symbol；
- 多 Future 组合；
- 多个并发 task 的 CID 隔离；
- wake 后重新 poll 的生命周期。

当前 Lilos whitelist 中存在部分由 GDB 多行签名解析产生的不完整泛型 symbol，且现有材料没有为所有手写 Future 提供完整的 RuntimeEvent → History → Observer 验证证据。因此相关覆盖记为 Partial，而不是 Supported。

## Future Return Patterns

### 1. async fn Generated Future

Rust 编译器会把 `async fn` 的执行体转换为匿名 Future 状态机。ARD 不依赖源码声明本身，而是从 GDB 暴露的、返回 `Poll<T>` 的生成函数中获得可跟踪 symbol。

```rust
async fn task() {
    work().await;
}
```

Status:

- Embassy: Supported
- Rel4 async: Supported
- Lilos: Partial

为什么需要测试：

- 生成 symbol 可能包含模块、泛型参数和编译器编号；
- 同一个 Future 会经历多次 poll；
- suspend 和 resume 必须保持同一 coroutine identity；
- 不同编译器和优化配置可能改变 GDB 展示的签名。

验证点：

- GDB 返回类型能被识别为 `Poll<T>`；
- whitelist 保留完整生成 symbol；
- runtime breakpoint 能命中 poll 生命周期；
- RuntimeEvent 关联正确 CID；
- History Tree 恢复真实父子关系；
- Observer Tree 可从该 Future 投影；
- Async Execution Graph 与实际执行顺序一致。

### 2. Executor Task Future

Executor task Future 是注册到 executor 并由其反复调度的顶层 Future。它可能由 attribute macro 生成，也可能作为 trait object 或 pinned Future 传给 executor。

```rust
#[executor::task]
async fn worker() {
    work().await;
}
```

Status:

- Embassy task: Supported
- Lilos executor task: Partial

为什么需要测试：

- executor 可能在用户 task 外增加 wrapper；
- task spawn 和 task poll 不是同一个执行时刻；
- 多个 task 可能共享相似或相同的 poll symbol；
- wake 和重新调度会产生交错的 poll 生命周期。

验证点：

- task 的实际 poll entry 进入 whitelist；
- spawn 后的 Future instance 获得稳定 CID；
- 重复 poll 不产生错误的新 task identity；
- executor wrapper 与 task Future 的关系来自真实 RuntimeEvent；
- History Tree 不把不同 task 实例错误合并；
- trace root 可以选择具体 task 执行子树。

### 3. Runtime Wrapper Future

Runtime wrapper 是 executor 或 OS async runtime 为存储、调度或驱动 Future 增加的 poll 层。它不一定实现 `Future` trait；只要其 GDB 函数签名返回匹配的 `Poll<T>`，就可能进入当前 whitelist。

Rel4 代表性结构：

```rust
struct Coroutine {
    future: Pin<Box<dyn Future<Output = ()>>>,
}

impl Coroutine {
    fn execute(self: Arc<Self>) -> Poll<()> {
        self.future.poll(...)
    }
}
```

Status:

- Rel4 `Coroutine::execute`: Supported
- Boxed Future poll wrapper: Supported
- Lilos generic runtime wrappers: Partial

为什么需要测试：

- wrapper 可能没有编译器生成标记；
- dynamic dispatch 会隐藏内部 Future 的具体类型；
- wrapper 和内部 Future 可能通过不同 symbol 和指针表示；
- scheduler 或 OS runtime 会改变物理调用栈。

验证点：

- 识别依据保持为 Poll 返回入口，而不是 runtime 名称；
- wrapper breakpoint 产生 RuntimeEvent；
- wrapper 和内部 Future 具有可区分的 CID；
- scheduler 交互不会制造错误父子边；
- History Tree 能恢复 wrapper → child Future；
- Observer Tree 能分别以 wrapper 或内部 Future 为根。

### 4. Manually Implemented Future

手动 Future 由用户直接实现 `Future::poll`，不依赖编译器生成的异步状态机名称。

```rust
struct CustomFuture {
    ready: bool,
}

impl Future for CustomFuture {
    type Output = ();

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Self::Output> {
        if self.ready {
            Poll::Ready(())
        } else {
            self.ready = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}
```

Status:

- Lilos manual Future implementations: Partial
- Dedicated minimal manual Future testcase: TODO

为什么需要测试：

- symbol 通常是 trait impl 的 `poll`，没有编译器生成标记；
- 状态字段和状态转换完全由用户定义；
- wake 行为可能同步发生，也可能延迟重新调度；
- GDB 可能把泛型 impl signature 跨多行输出。

验证点：

- `Future::poll` 的 `Poll<T>` 返回类型进入 whitelist；
- 完整 trait impl symbol 可解析并设置 breakpoint；
- Pending → wake → repoll → Ready 生命周期可观察；
- 同一对象指针保持同一 CID；
- state transition 不依赖编译器生成环境类型；
- History 和 Observer 不依赖函数名中的异步标记。

### 5. Nested Future Composition

Nested Future composition 表示一个 Future 在 poll 过程中驱动另一个 Future，包括直接 await、Timer、boxed Future、泛型 wrapper 和 combinator 等运行结构。

```rust
async fn parent() {
    child().await;
}
```

Status:

- Embassy task → Timer: Supported
- Rel4 wrapper → async handler: Supported
- Lilos generic Future composition: Partial

为什么需要测试：

- 父 Future 和子 Future 的 poll 可以分散在不同时间；
- 物理 GDB stack 不一定完整表达逻辑关系；
- wrapper 嵌套会产生很长的泛型 symbol；
- 同一子 Future 可能被父 Future 多次 poll。

验证点：

- 父子 poll 都通过 whitelist admission；
- 每次 RuntimeEvent 保留 thread、CID 和 Future pointer；
- History Tree 只根据真实命中恢复 parent-child edge；
- 重复 poll 不重复制造逻辑子节点；
- Observer Tree 切换 trace root 时只改变投影范围；
- Async Execution Graph 能展示完整或局部执行链。

### 6. Multiple Concurrent Future Tasks

该类型覆盖一个 executor 中同时存在多个 Future task，并且它们的 poll 和 wake 事件可能交错。

```rust
executor.run(&mut [task_a, task_b, task_c]);
```

Status:

- Lilos multiple top-level tasks: Partial
- Dedicated concurrent CID validation: TODO

为什么需要测试：

- 不同 Future instance 可能执行同一个 symbol；
- 多 task RuntimeEvent 会交错；
- thread id 单独不足以区分同线程 executor 中的多个 task；
- 一个 task 的 wake 不应改变另一个 task 的 lifecycle。

验证点：

- `(poll symbol, Future pointer)` 能区分 CID；
- 同一 Future 重复 poll 保持稳定 CID；
- 不同实例具有独立 poll count 和状态；
- History Tree 不生成跨 task 的错误 parent-child edge；
- Observer Tree 能投影用户选择的 task 子树；
- Async Execution Graph 在并发事件交错后仍保持稳定结构。

## Coverage Status

| Future Type | Example | Status |
|---|---|---|
| Compiler-generated Future poll | Embassy task、Rel4 async handler | Supported |
| Executor Task Future | Embassy executor task | Supported |
| Executor Task Future | Lilos top-level tasks | Partial |
| Runtime Wrapper Future | Rel4 `Coroutine::execute` | Supported |
| Dynamic/boxed Future poll | Rel4 boxed handler Future | Supported |
| Generic Future wrapper | Lilos `TimeLimited`、future combinator wrappers | Partial |
| Manually implemented Future | Lilos `YieldCpu` 等 `Future::poll` | Partial |
| Dedicated manual Future lifecycle | Minimal custom `Future::poll` | TODO |
| Nested Future composition | Embassy main → task → Timer | Supported |
| Nested Future composition | Rel4 Coroutine wrapper → handler | Supported |
| Multiple concurrent Future tasks | Lilos executor task set | Partial |
| Dedicated concurrent CID validation | Multiple instances of one poll symbol | TODO |

## Testcase Acceptance Criteria

一个 Future 类型只有在对应证据覆盖到所声明的阶段时，才应提升状态。完整验证顺序为：

```text
1. GDB info functions 中存在完整签名。
2. 返回类型匹配 core::task::poll::Poll<...>。
3. whitelist 中保存完整、可解析的 symbol。
4. runtime breakpoint 能安装并真实命中。
5. 命中产生通过 whitelist admission 的 RuntimeEvent。
6. History Tree 根据事件创建节点和真实父子边。
7. trace root 能在 History Tree 中找到对应节点。
8. Observer Tree 返回该节点的子树投影。
9. Async Execution Graph 正确展示投影结果。
```

跨 testcase 的共同检查项：

- 不使用缩短的 display label 代替完整 symbol；
- 不通过 runtime 名称硬编码 whitelist membership；
- 不因同一 Future 重复 poll 而创建新 CID；
- 不因不同 Future instance 共享 symbol 而合并生命周期；
- 不用 trace root 创建 History 节点或边；
- 不把 Snapshot 当作 History Tree 或 Execution Graph 的数据源；
- 不把预期调用链预置为实际运行结果；
- 源码断点定位与逻辑执行图分别验证。

## Known Coverage Gaps

当前规划中的主要缺口包括：

- GDB 多行泛型函数签名可能导致 whitelist symbol 不完整；
- 手写 Future 尚缺少独立、最小且完整的 lifecycle 验证证据；
- 多个相同类型 Future instance 的 CID 隔离尚缺少专门验证；
- Lilos 多 task 的 RuntimeEvent、History、Observer 和 Execution Graph 闭环证据仍不完整；
- 不同优化级别下 GDB 返回类型文本的稳定性尚未形成覆盖矩阵。

这些缺口用于指导后续 testcase 选择，不表示通过新增语法示例即可自动获得覆盖。新增或更新 testcase 时，应优先记录 Future poll 返回类型、完整 symbol、RuntimeEvent 序列、CID、History edge 和 Observer projection。

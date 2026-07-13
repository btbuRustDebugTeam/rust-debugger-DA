# ARD Async Testcase Coverage

## Purpose

This document is the Rust async testcase coverage plan for ARD. It tracks which forms of Rust `Future` construction and execution are represented by testcases, why each form needs coverage, and what each testcase should validate in the ARD debugging pipeline.

The goal is to verify whether ARD can observe the execution of different Future forms and preserve their runtime relationships through the complete tracing chain:

```text
GDB breakpoint
    ↓
RuntimeEvent
    ↓
History Tree
    ↓
Observer Tree
    ↓
Async Execution Graph
```

Coverage should distinguish language-level Future generation from executor behavior. Two testcases can contain similar `async fn` source code while producing different symbols, task identities, wake behavior, or parent-child relationships because they use different runtimes or executors.

The status values in this document describe current testcase coverage, not a guarantee about every compiler version, optimization level, runtime, or target platform.

## Supported Async Patterns

### 1. async fn

`async fn` is the most common Rust async form. The compiler transforms it into a generated Future state machine whose `poll` execution must be visible to ARD.

```rust
async fn task() {
    work().await;
}
```

Status:

- Embassy: Supported
- Rel4 async: Supported

Why this needs testing:

- Compiler-generated symbols can include modules, nested generated functions, generic parameters, and async state-machine suffixes.
- A single function can be polled repeatedly before it completes.
- `.await` introduces suspension and resume points that must not be mistaken for unrelated calls.

ARD validation points:

- The complete async function symbol is admitted by the whitelist.
- GDB poll breakpoints produce the expected RuntimeEvent lifecycle.
- Poll entry, suspension, resume, and completion remain associated with the correct coroutine identity.
- History Tree records the executed function rather than a display-only alias.
- Observer Tree can select the function as its trace root.
- Async Execution Graph reconstructs the observed execution path.

### 2. async block

An async block creates an anonymous Future inside an expression rather than declaring a named async function.

```rust
let future = async {
    task().await;
};
```

Status: TODO

Why this needs testing:

- The generated Future may be represented by an anonymous or enclosing-scope-derived symbol.
- Multiple async blocks in one function must remain distinguishable.
- Captured values can change the generated state-machine layout.

ARD validation points:

- Anonymous Future symbols can be discovered without truncation or accidental merging.
- The generated poll function produces RuntimeEvents.
- The async block and the awaited child task appear with the correct relationship in History Tree.
- Selecting the anonymous Future as the observation root produces the expected Observer Tree subtree.
- Async Execution Graph does not depend on a source-level `async fn` name.

### 3. async closure

An async closure combines closure capture semantics with an async-generated Future.

```rust
let f = async || {
    work().await;
};
```

Status: TODO

Why this needs testing:

- The compiler can generate both closure-related and Future-related symbol layers.
- Captures can be borrowed, moved, or reused, affecting generated types and lifetimes.
- Repeated closure invocation can create multiple Future instances from one source expression.

ARD validation points:

- The complete closure-generated Future symbol is preserved through whitelist and trace selection.
- Separate Future instances receive distinct coroutine identities where appropriate.
- RuntimeEvents are attributed to the closure Future rather than only to its enclosing function.
- History Tree and Observer Tree retain the child call to `work()`.
- Async Execution Graph presents the execution relationship without relying on a manually simplified label.

### 4. Manually Implemented Future

Manually constructed futures cover code that does not use `async fn` or an async block. The user directly implements the `Future` state machine and controls its `poll` behavior.

```rust
use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};

struct MyFuture;

impl Future for MyFuture {
    type Output = ();

    fn poll(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Self::Output> {
        let _ = cx;
        Poll::Ready(())
    }
}
```

Status: Supported

Why this needs testing:

- There is no compiler-generated `async fn` wrapper to identify the Future.
- State transitions are implemented explicitly by user code.
- Wake registration and repeated polling can differ from compiler-generated Futures.

ARD validation points:

- A user-defined `Future::poll` can be discovered and used as a poll breakpoint.
- RuntimeEvents preserve repeated poll attempts and completion.
- State transitions remain associated with the same Future instance.
- Pending and wake behavior do not create false parent-child relationships.
- History Tree records actual poll execution, and Observer Tree can project from the manual poll symbol.

### 5. Future Combinators

Future combinators wrap or combine Futures without necessarily introducing a directly named source-level async function. Relevant forms include mapping, sequencing, joining, and selecting Futures.

```rust
let mapped = future.map(transform);
let chained = future.then(next_step);
let joined = join(future_a, future_b);
let selected = select(future_a, future_b);
```

Status: TODO

Why this needs testing:

- Combinators create nested generic Future types with long symbols.
- Wrapper poll functions may delegate to one or more child Futures.
- `join` and `select` can poll branches in different orders and complete under different conditions.

ARD validation points:

- Long generic symbols remain complete in whitelist candidates and trace commands.
- Wrapper and child polls produce distinct RuntimeEvents.
- History Tree records only relationships supported by runtime execution.
- `join` preserves both executed branches where observed.
- `select` does not invent execution for a branch that was never polled.
- Observer Tree projection works when either a wrapper or a child is selected as trace root.

### 6. Nested Async Calls

Nested async calls cover an async function awaiting another async function. They are the primary pattern for validating parent-child reconstruction.

```rust
async fn parent() {
    child().await;
}

async fn child() {
    work().await;
}
```

Status: Partial

Why this needs testing:

- The physical GDB stack does not always express the logical async parent-child relationship directly.
- Suspension can separate parent and child poll events in time.
- Deeper nesting increases the chance of incorrect root or edge selection.

ARD validation points:

- Each poll hit creates the appropriate RuntimeEvent.
- History Tree reconstructs `parent → child` from observed execution.
- Repeated polls do not create duplicate logical children.
- Selecting `parent` produces a subtree containing `child`.
- Selecting `child` produces an Observer Tree rooted at `child` without retaining unrelated ancestors.
- Async Execution Graph matches the selected observation root.

### 7. Multiple Concurrent Tasks

This pattern covers multiple executor tasks that are alive and polled during the same debug session.

```rust
spawn(task_a());
spawn(task_b());
```

Status: Partial

Why this needs testing:

- Different tasks can execute the same poll symbol.
- Poll events from separate tasks can interleave.
- A wake can resume one task while another task remains pending.
- A function-only graph can accidentally merge unrelated coroutine instances.

ARD validation points:

- Coroutine identity distinguishes concurrently active Future instances.
- RuntimeEvents retain the relevant thread and coroutine context.
- Parent-child relationships do not cross task boundaries without runtime evidence.
- History Tree remains stable when events interleave.
- Observer Tree selects the intended execution subtree.
- Async Execution Graph does not collapse unrelated task instances into a false call chain.

### 8. Custom Executor

A custom executor testcase covers async code running outside the Embassy executor. Rel4 async and other executor designs can schedule, wake, and poll Futures through different call paths.

```rust
fn run<F: Future>(future: F) {
    // Executor-specific scheduling and polling.
}
```

Status: Partial

Why this needs testing:

- Executor frames and task metadata are runtime-specific.
- Poll entry may be reached through a different physical stack.
- Wake queues, task identity, thread usage, and privilege transitions can vary.
- Executor-specific wrappers must not become a requirement for generic Future tracking.

ARD validation points:

- Whitelist admission is based on observable poll symbols rather than one executor name.
- GDB breakpoints still produce RuntimeEvents through the custom scheduling path.
- Coroutine identity remains usable with executor-specific task representations.
- History Tree reconstructs relationships from runtime events rather than a predefined executor call chain.
- Observer Tree and Async Execution Graph continue to use the same projection protocol.
- Runtime-specific enhancements do not alter the generic tracing behavior for other executors.

## Coverage Status

| Async Pattern | Example | Status |
|---|---|---|
| `async fn` | Embassy task and Rel4 async function | Supported |
| Async block | Anonymous `async { ... }` Future | TODO |
| Async closure | Capturing `async || { ... }` Future | TODO |
| Manually implemented Future | User-defined `Future::poll` | Supported |
| Future combinators | `map`, `then`, `join`, `select` | TODO |
| Nested async calls | Parent Future awaiting child Future | Partial |
| Multiple concurrent tasks | Interleaved executor tasks | Partial |
| Custom executor | Non-Embassy scheduling and polling | Partial |

## Cross-Pattern Validation

Each testcase should document the symbols and execution relationships it expects without treating those expectations as preloaded graph data. Validation should follow the runtime chain in order:

```text
1. GDB breakpoint resolves to the intended poll function.
2. Breakpoint hits generate RuntimeEvents.
3. History Tree records nodes and edges from those events.
4. Trace root selects an existing History subtree.
5. Observer Tree contains only that projected subtree.
6. Async Execution Graph renders the Observer Tree result.
```

Common checks across patterns include:

- Full Rust symbols survive whitelist parsing, candidate display, and trace selection.
- Repeated polls update lifecycle information without fabricating extra logical nodes.
- Coroutine identity remains stable for one Future instance and distinct across concurrent instances.
- Parent-child edges reflect observed runtime execution.
- History Tree remains the cumulative record of execution.
- Observer Tree remains a projection and does not create runtime facts.
- Changing the trace root changes the displayed subtree without modifying History Tree.
- Source breakpoints and source reveal remain independent from logical graph rendering.

This plan should be updated when a testcase provides reproducible evidence for a pattern. A status change should identify the exercised runtime, compiler-generated symbol form, expected RuntimeEvent sequence, History relationship, and Observer Tree projection.

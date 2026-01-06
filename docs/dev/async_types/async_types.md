# Copilot Chat Conversation Export: Understanding async function representations in Rust

**User:** @chenzhiy2001
**Thread URL:** https://github.com/copilot/c/45f74dc2-3ceb-40e9-b70b-c5f7c8e5ea12

## @chenzhiy2001

suppose i have an async function called async_function_two

what is the difference of async_fn_two::{async_fn#0} and async_fn_two::{async_fn_env#0}?

## Copilot

This is a great question about Rust's internal representation of async functions! Let me explain the difference between these two constructs.

## `async_fn_two::{async_fn#0}` vs `async_fn_two::{async_fn_env#0}`

These are internal compiler-generated items that represent different aspects of an async function:

### `async_fn_two::{async_fn#0}`
This refers to the **async block body** or the **generator/coroutine itself** - essentially the code that runs when the future is polled.  It represents the actual async computation logic.

### `async_fn_two::{async_fn_env#0}`
This refers to the **environment/state struct** that captures all the variables and state needed across `.await` points. When you write an async function, the compiler generates a state machine struct that holds:
- Function arguments
- Local variables that live across await points
- The current state/resume point of the async function

## In Practice

When you write: 
```rust
async fn async_fn_two(x: i32) -> i32 {
    let y = some_async_call().await;
    x + y
}
```

The compiler generates something conceptually like:
```rust
// async_fn_env#0 - the state/environment struct
struct AsyncFnTwoFuture {
    x: i32,           // captured argument
    y: Option<i32>,   // local variable (lives across await)
    state: u8,        // which await point we're at
}

// async_fn#0 - the poll implementation/body
impl Future for AsyncFnTwoFuture {
    fn poll(... ) -> Poll<i32> {
        // The actual async logic here
    }
}
```

## Summary

| Item | Purpose |
|------|---------|
| `{async_fn#0}` | The async function body/generator - the code that executes |
| `{async_fn_env#0}` | The captured environment/state struct - the data that persists across awaits |

These are internal compiler details you'll typically encounter in error messages, debuginfo, or when looking at MIR/codegen output in the rust-lang/rust compiler. 

## @chenzhiy2001

is async_fn#0 the impl Future for AsyncFnTwoFuture { part or fn poll(... ) -> Poll<i32> {
 part?

## Copilot

Great follow-up question! Let me clarify: 

## `async_fn#0` refers to the **`fn poll()` part** - the actual function body/implementation

More specifically, `async_fn#0` represents the **coroutine/generator body** - the transformed code that becomes the `poll` function's logic. 

Here's a clearer breakdown:

```rust
// async_fn_env#0 - This is the STATE STRUCT (the type)
struct AsyncFnTwoFuture {
    x: i32,
    y: Option<i32>,
    state: u8,
}

// The impl block itself isn't directly named
impl Future for AsyncFnTwoFuture {
    type Output = i32;
    
    // async_fn#0 - This is the FUNCTION BODY (the code)
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<i32> {
        // ↓↓↓ async_fn#0 refers to THIS part - the actual executable code ↓↓↓
        match self.state {
            0 => { /* start some_async_call() */ }
            1 => { /* resume after await, compute x + y */ }
            _ => panic!("poll after completion"),
        }
        // ↑↑↑ The state machine logic generated from your async fn body ↑↑↑
    }
}
```

## Summary

| Symbol | What it represents |
|--------|-------------------|
| `{async_fn_env#0}` | The **struct type** (data/state) |
| `{async_fn#0}` | The **function/code** (the poll implementation logic) |

So `async_fn#0` is the **code** that runs, while `async_fn_env#0` is the **data structure** that holds the captured state.  Think of it as:  `env` = the noun (thing), `fn` = the verb (action).

## @chenzhiy2001

i saw async_function_two::{{closure}} in llvm ir's function dependency graph, what is it

## Copilot

Good question! The `async_function_two::{{closure}}` in LLVM IR is essentially **the same thing as `async_fn#0`** - it's just a different naming convention used at different stages of the compilation pipeline.

## Why the Different Names?

| Stage | Name | Description |
|-------|------|-------------|
| HIR/MIR (Rust level) | `async_fn_two: :{async_fn#0}` | Rust's internal naming |
| LLVM IR (codegen level) | `async_function_two:: {{closure}}` | LLVM-compatible symbol name |

## Why "closure"? 

Async functions in Rust are desugared into **generators/coroutines**, and generators are internally represented similarly to closures - they both: 

1. Capture an environment (variables from the surrounding scope)
2. Have a callable body
3. Are represented as a struct + implementation

So when the Rust compiler lowers async functions to LLVM IR, it uses the `{{closure}}` naming convention because:

- The async function's body becomes a closure-like construct
- LLVM symbols can't use Rust's internal `{async_fn#0}` syntax
- Closures and async blocks share similar codegen machinery

## Visual Summary

```
Your code:           async fn async_function_two() { ...  }
                              ↓
Rust MIR:           async_function_two: :{async_fn#0}      ← the body
                    async_function_two: :{async_fn_env#0}  ← the state struct
                              ↓
LLVM IR:            async_function_two::{{closure}}       ← the poll function
```

## Note

If your async function contains actual closures or multiple await points that generate additional internal functions, you might see multiple `{{closure}}` entries with different numbers like `{{closure}}#0`, `{{closure}}#1`, etc. in the LLVM IR dependency graph. 

## @chenzhiy2001

so
async_fn = poll function
async_fn_env = poll function's variables
closure = poll function

but why do i see ::poll() function sometimes?

## Copilot

Excellent observation! You're right to be confused - there are multiple related symbols.  Let me clarify:

## The Full Picture

```
async fn async_function_two() { ... }
```

Generates these symbols: 

| Symbol | What it is |
|--------|------------|
| `async_fn_two: :{async_fn_env#0}` | The state struct (captured variables) |
| `async_fn_two::{async_fn#0}` / `{{closure}}` | The **coroutine body** (the state machine logic) |
| `<async_fn_two: :{async_fn_env#0} as Future>::poll` | The **`poll` wrapper function** that calls the coroutine |

## They're NOT Exactly the Same! 

```rust
// async_fn_env#0 - the state struct
struct AsyncFnTwoFuture { /* state */ }

impl Future for AsyncFnTwoFuture {
    // :: poll - the TRAIT METHOD (thin wrapper)
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<... > {
        // This calls into the actual coroutine body: 
        self.resume(cx)  // ← This invokes {async_fn#0} / {{closure}}
    }
}

// {async_fn#0} / {{closure}} - the ACTUAL STATE MACHINE
// (the coroutine's resume function with all the match arms)
```

## Why Two Functions?

1. **`:: poll()`** - The trait method that satisfies `impl Future`. It's the public interface. 

2. **`{async_fn#0}` / `{{closure}}`** - The internal coroutine/generator body that contains the actual state machine logic (the `match self.state { ... }` code).

The `poll()` function is essentially a **thin wrapper** that calls into the coroutine body. 

## In LLVM IR Dependency Graph

```
<async_function_two: :{async_fn_env#0} as Future>::poll
                        │
                        ▼ calls
        async_function_two:: {{closure}}
```

So when you see both `::poll()` and `{{closure}}`, they are **separate functions** where `poll` calls into `{{closure}}` (the actual coroutine implementation).

## Summary

| Symbol | Role |
|--------|------|
| `{async_fn_env#0}` | Data (state struct) |
| `{async_fn#0}` / `{{closure}}` | The coroutine body (state machine logic) |
| `::poll()` | Trait method wrapper that invokes the coroutine |

## @chenzhiy2001

and what is async_block and async_block_env?

## Copilot

Great question! These are very similar to `async_fn` and `async_fn_env`, but for **async blocks** instead of **async functions**.

## `async_fn` vs `async_block`

| Construct | Code | Generated Symbols |
|-----------|------|-------------------|
| Async **function** | `async fn foo() { ... }` | `foo: :{async_fn#0}`, `foo::{async_fn_env#0}` |
| Async **block** | `async { ... }` | `parent: :{async_block#0}`, `parent::{async_block_env#0}` |

## Example

```rust
async fn async_function_two() {
    // This is an async BLOCK inside a function
    let future = async {
        do_something().await;
        42
    };
    
    future.await;
}
```

This generates: 

| Symbol | What it is |
|--------|------------|
| `async_function_two: :{async_fn_env#0}` | State struct for the async **function** |
| `async_function_two::{async_fn#0}` | Coroutine body for the async **function** |
| `async_function_two: :{async_block_env#0}` | State struct for the async **block** |
| `async_function_two::{async_block#0}` | Coroutine body for the async **block** |

## Visual Breakdown

```rust
async fn async_function_two() {          // ← async_fn_env#0 + async_fn#0
    let x = 1;
    
    let future = async {                 // ← async_block_env#0 + async_block#0
        let y = 2;
        some_call().await;
        y
    };
    
    future.await;
}
```

## Summary

| Suffix | Meaning |
|--------|---------|
| `async_fn` | From `async fn` declaration |
| `async_block` | From `async { }` expression |
| `_env` | The state struct (captured variables) |
| (no `_env`) | The coroutine body (executable code) |

So if you see `{async_block#0}` and `{async_block_env#0}`, there's an `async { }` block somewhere in that function! 

## @chenzhiy2001

i will write a async debugger so i want to know if poll wrapper always there? is it possible that poll exist and async_fn not exist, or vice versa?

## Copilot

Great question for building a debugger! Let me break this down:

## Are They Always Paired?

**Short answer: Not always!  They can exist independently depending on optimization and monomorphization.**

## Scenarios

### 1. Both `poll` and `async_fn`/`{{closure}}` exist (Common case)

```rust
async fn foo() { ...  }

// Somewhere it's actually used:
foo().await;
```
✅ `poll` exists (trait method)
✅ `async_fn#0`/`{{closure}}` exists (coroutine body)

---

### 2. `poll` exists, but `async_fn` is INLINED (Optimized)

```rust
#[inline(always)]
async fn foo() { ... }
```

At higher optimization levels (`-O2`, `-O3`): 
✅ `poll` exists 
❌ `async_fn#0`/`{{closure}}` might be **inlined into `poll`** and disappear as a separate symbol

---

### 3. `async_fn` exists, but `poll` is INLINED (Optimized)

The opposite can also happen:  
❌ `poll` wrapper gets inlined into the caller
✅ `async_fn#0`/`{{closure}}` still exists as a separate function

---

### 4. Neither exist (Dead code elimination)

```rust
async fn unused_async() { ...  }
// Never called anywhere
```
❌ Both may be eliminated entirely

---

### 5. Manual `Future` impl (No `async_fn` at all!)

```rust
struct MyFuture;

impl Future for MyFuture {
    type Output = i32;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<i32> {
        Poll::Ready(42)
    }
}
```
✅ `poll` exists
❌ No `async_fn#0` / `{{closure}}` - it's a hand-written future! 

---

## For Your Debugger

| Scenario | `poll` | `async_fn`/`{{closure}}` | How to detect |
|----------|--------|--------------------------|---------------|
| Normal async fn | ✅ | ✅ | Both symbols present |
| Inlined coroutine | ✅ | ❌ | Only poll, check for inlined code |
| Inlined poll | ❌ | ✅ | Only closure, poll was inlined |
| Manual Future impl | ✅ | ❌ | No `async_fn_env` type either |
| Dead code | ❌ | ❌ | Neither present |

## Key Insight for Debugger

```
To reliably detect async functions, check for:  

1. The `async_fn_env` TYPE (struct) - most reliable, survives optimization
2. The `poll` function with a receiver type containing `async_fn_env`
3. The `{{closure}}` / `async_fn#0` as a fallback
```

## Recommendation

For your async debugger, I'd suggest:  

```rust
// Pseudocode for detection logic
fn is_async_function(symbol: &str) -> AsyncKind {
    if contains("{async_fn_env#") || contains("{async_block_env#") {
        // Definitely an async construct (the state type)
        return AsyncKind:: StateStruct;
    }
    if contains("{async_fn#") || contains("{async_block#") {
        // The coroutine body
        return AsyncKind::CoroutineBody;
    }
    if contains(":: poll") && is_future_impl(symbol) {
        // Could be async OR manual Future impl
        // Check if the Self type contains async_fn_env to distinguish
        return AsyncKind:: PollMethod;
    }
    if contains("{{closure}}") {
        // Could be async OR regular closure - need more context
        return AsyncKind::MaybeClosure;
    }
    AsyncKind::NotAsync
}
```

## Debug Info Tip

If you have DWARF debug info available (`-g` flag), the `async_fn_env` struct will contain field names that match your original local variables - this is **very useful** for showing async state in a debugger!

Would you like more details about parsing debug info for async state machines? 

## @chenzhiy2001

if i make sure inline not happening on async functions, is it the case that, async_fn may not be there, but poll always there?

## Copilot

Yes, **exactly right!**

## With Inlining Disabled on Async Functions

| Symbol | Always Present?  |
|--------|-----------------|
| `poll` | ✅ **Yes, always** |
| `async_fn#0` / `{{closure}}` | ❌ **Not always** |

## Why? 

The `poll` function is the **trait method** - it's the public interface that the executor calls.  It **must** exist for the `Future` to be usable.

But the coroutine body (`async_fn#0`/`{{closure}}`) can be **inlined into `poll`** even if you disable inlining on the async function itself! 

```rust
#[inline(never)]
async fn async_function_two() {
    // ...
}
```

This prevents `async_function_two` (the function that returns the future) from being inlined.  But it does **NOT** prevent the compiler from inlining the internal coroutine body into `poll`!

## The Actual Call Chain

```
your_code()
    │
    ▼ calls
async_function_two()          ← #[inline(never)] protects THIS
    │
    │ returns Future
    ▼
executor calls poll()         ← always exists (trait requirement)
    │
    ▼ may inline
{async_fn#0} / {{closure}}    ← can be inlined INTO poll
```

## To Guarantee `async_fn#0` Exists Too

You'd need to also prevent the coroutine body from being inlined, but there's **no direct annotation for that** since it's compiler-generated. 

Your options: 

1. **Compile with `-C opt-level=0`** (no optimizations)
2. **Use `-C lto=off`** (disable link-time optimization)
3. **Check for `poll` only** in your debugger (most reliable)

## For Your Debugger

```rust
// Safe assumption with inlining disabled on async fns: 
// 
// ✅ poll ALWAYS exists → use this as your anchor point
// ❓ async_fn#0 MIGHT exist → bonus info if present
```

So yes - **anchor your debugger on `poll`**, and treat `async_fn#0`/`{{closure}}` as optional additional information! 

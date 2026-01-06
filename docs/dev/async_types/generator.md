> fn minimal::async_fn_leaf(i32) -> minimal::async_fn_leaf::{async_fn_env#0}; block object 0x64cf861211c0, 0x16700..0x16713 section .text

## this is output of maint print symbols gdb command. why do i see this line?

This line shows the **async function's generator constructor**, not the `poll` function:

```
fn minimal::async_fn_leaf(i32) -> minimal::async_fn_leaf::{async_fn_env#0}
```

## What this means

When you write:
```rust
async fn async_fn_leaf(x: i32) -> i32 {
    sync_a(x)
}
```

Rust compiles it into **two things**:

1. **A constructor function** (what you're seeing):
   - Takes the original parameters (`i32`)
   - Returns the state machine struct (`{async_fn_env#0}`)
   - Address: `0x16700..0x16713` (only 19 bytes — just initializes the struct)

2. **A `poll` method** (on the `Future` impl):
   - Takes `Pin<&mut Self>` + `Context`
   - Returns `Poll<i32>`
   - This is where the actual logic lives

## The transformation

```rust
// What you write:
async fn async_fn_leaf(x: i32) -> i32 {
    sync_a(x)
}

// What rustc generates (conceptually):
fn async_fn_leaf(x: i32) -> async_fn_leaf::{async_fn_env#0} {
    // Just captures x into the state machine struct
    async_fn_env#0 { x, state: Unresumed }
}

impl Future for async_fn_leaf::{async_fn_env#0} {
    type Output = i32;
    fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<i32> {
        // The actual logic: sync_a(self.x)
    }
}
```

## For your debugger

- The **constructor** (`minimal::async_fn_leaf`) is called when you create the future
- The **poll** is `<minimal::async_fn_leaf::{async_fn_env#0} as core::future::future::Future>::poll` — you can find it via `info functions poll` or by looking for the `impl` block

To find the poll function:
```gdb
(gdb) info functions async_fn_leaf.*poll
```

Or search in your `maint print symbols` output for `minimal::{impl#...}::poll` patterns.
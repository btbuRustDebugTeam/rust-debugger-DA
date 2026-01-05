//! Test case: async functions, async blocks, and manual futures WITHOUT external runtime.

mod executor;
mod manual_future;

use std::future::Future;
use std::pin::Pin;

use executor::block_on;
use manual_future::{ManualLeafFuture, ManualNonLeafFuture};

// ============================================================================
// Sync helper functions
// ============================================================================

fn sync_leaf_helper(value: i32) -> i32 {
    println!("  [sync_leaf_helper] value={}", value);
    sync_nested(value * 2)
}

fn sync_nested(value: i32) -> i32 {
    println!("  [sync_nested] value={}", value);
    value + 10
}

fn sync_nonleaf_helper(items: &[i32]) -> i32 {
    println!("  [sync_nonleaf_helper] items={:?}", items);
    items.iter().sum()
}

// ============================================================================
// Async Functions
// ============================================================================

/// Leaf async function - calls sync functions, no awaits
async fn async_leaf(input: i32) -> i32 {
    println!("[async_leaf] input={}", input);
    let result = sync_leaf_helper(input);
    println!("[async_leaf] result={}", result);
    result
}

/// Non-leaf async function - awaits other futures, calls sync functions
async fn async_nonleaf(x: i32, y: i32) -> i32 {
    println!("[async_nonleaf] x={}, y={}", x, y);

    let pre = sync_nonleaf_helper(&[x, y]);

    let a = async_leaf(x).await;
    let b = async_leaf(y).await;

    let post = sync_nonleaf_helper(&[a, b, pre]);
    println!("[async_nonleaf] result={}", post);
    post
}

/// Top-level coordinator using all future types
async fn async_coordinator(init: i32) -> i32 {
    println!("[async_coordinator] init={}", init);

    // Call sync before await
    let prepared = sync_leaf_helper(init);

    // Await async function
    let step1 = async_nonleaf(prepared, prepared + 1).await;

    // Await async block
    let step2 = async {
        println!("[async_block] inside");
        let inner = sync_leaf_helper(step1);
        async_leaf(inner).await
    }.await;

    // Await manual futures
    let step3 = ManualLeafFuture::new(step2).await;
    let step4 = ManualNonLeafFuture::new(step3).await;

    let result = sync_nonleaf_helper(&[step1, step2, step3, step4]);
    println!("[async_coordinator] result={}", result);
    result
}

// ============================================================================
// Async Blocks
// ============================================================================

fn create_async_block(value: i32) -> impl Future<Output = i32> {
    async move {
        println!("[async_block_fn] value={}", value);
        let step = sync_leaf_helper(value);
        async_leaf(step).await
    }
}

fn create_nested_blocks(value: i32) -> impl Future<Output = i32> {
    async move {
        println!("[outer_block]");
        let outer = sync_leaf_helper(value);

        let inner_result = async {
            println!("[inner_block]");
            let inner = sync_nested(outer);

            async {
                println!("[innermost_block]");
                sync_leaf_helper(inner)
            }.await
        }.await;

        inner_result
    }
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    println!("=== No-Runtime Futures Test ===\n");

    println!("--- Test 1: Leaf async fn ---");
    let r1 = block_on(async_leaf(5));
    println!("Result: {}\n", r1);

    println!("--- Test 2: Non-leaf async fn ---");
    let r2 = block_on(async_nonleaf(3, 7));
    println!("Result: {}\n", r2);

    println!("--- Test 3: Async block ---");
    let r3 = block_on(create_async_block(10));
    println!("Result: {}\n", r3);

    println!("--- Test 4: Nested async blocks ---");
    let r4 = block_on(create_nested_blocks(2));
    println!("Result: {}\n", r4);

    println!("--- Test 5: Manual leaf future ---");
    let r5 = block_on(ManualLeafFuture::new(42));
    println!("Result: {}\n", r5);

    println!("--- Test 6: Manual non-leaf future ---");
    let r6 = block_on(ManualNonLeafFuture::new(10));
    println!("Result: {}\n", r6);

    println!("--- Test 7: Coordinator (all types) ---");
    let r7 = block_on(async_coordinator(1));
    println!("Result: {}\n", r7);

    println!("--- Test 8: Boxed dyn Future ---");
    let boxed: Pin<Box<dyn Future<Output = i32>>> = Box::pin(async_leaf(99));
    let r8 = block_on(boxed);
    println!("Result: {}\n", r8);

    println!("=== Done ===");
}

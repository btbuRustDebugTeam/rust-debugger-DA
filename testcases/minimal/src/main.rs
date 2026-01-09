use std::{future::Future, pin::Pin, task::{Context, Poll, RawWaker, RawWakerVTable, Waker}};

// Minimal executor
fn block_on<F: Future>(mut f: Pin<&mut F>) -> F::Output {
    let w = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &MY_VTABLE)) };
    loop { if let Poll::Ready(v) = f.as_mut().poll(&mut Context::from_waker(&w)) { return v; } }
}
static MY_VTABLE: RawWakerVTable = RawWakerVTable::new(|p| RawWaker::new(p, &MY_VTABLE), |_| {}, |_| {}, |_| {});

// Sync functions
fn sync_a(x: i32) -> i32 { println!("sync_a({})", x); x + 1 }
fn sync_b(x: i32) -> i32 { println!("sync_b({})", x); x * 2 }

// leaf of async fn chain
// but calls a manually constructed future
// without .await (not generating __awaitee)
// so not leaf of async awaiting chain
//TODO: call async fn without .await
async fn async_fn_leaf(x: i32) -> i32 { 
    sync_a(x) 
    + block_on(std::pin::pin!(Manual(x, false)))
}

// Async function (non-leaf)
async fn nonleaf(x: i32) -> i32 {
    sync_b(async_fn_leaf(x).await) + 
    Manual(x, false).await 
}

// Manual future, the actual async leaf
struct Manual(i32, bool);
impl Future for Manual {
    type Output = i32;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<i32> {
        if self.1 { Poll::Ready(sync_b(self.0)) } else { self.1 = true; self.0 = sync_a(self.0); Poll::Pending }
    }
}

fn main() {
    println!("leaf: {}", block_on(std::pin::pin!(async_fn_leaf(1))));
    println!("nonleaf: {}", block_on(std::pin::pin!(nonleaf(2))));
    println!("block: {}", block_on(std::pin::pin!(async { sync_b(async_fn_leaf(3).await) })));
    println!("manual: {}", block_on(std::pin::pin!(Manual(4, false))));
}

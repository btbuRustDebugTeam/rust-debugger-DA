use std::{future::Future, pin::Pin, task::{Context, Poll, RawWaker, RawWakerVTable, Waker}};

// Minimal executor
fn block_on<F: Future>(mut f: Pin<&mut F>) -> F::Output {
    let w = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    loop { if let Poll::Ready(v) = f.as_mut().poll(&mut Context::from_waker(&w)) { return v; } }
}
static VTABLE: RawWakerVTable = RawWakerVTable::new(|p| RawWaker::new(p, &VTABLE), |_| {}, |_| {}, |_| {});

// Sync functions
fn sync_a(x: i32) -> i32 { println!("sync_a({})", x); x + 1 }
fn sync_b(x: i32) -> i32 { println!("sync_b({})", x); x * 2 }

// Async function (leaf)
async fn leaf(x: i32) -> i32 { sync_a(x) }

// Async function (non-leaf)
async fn nonleaf(x: i32) -> i32 { sync_b(leaf(x).await) }

// Manual future
struct Manual(i32, bool);
impl Future for Manual {
    type Output = i32;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<i32> {
        if self.1 { Poll::Ready(sync_b(self.0)) } else { self.1 = true; self.0 = sync_a(self.0); Poll::Pending }
    }
}

fn main() {
    println!("leaf: {}", block_on(std::pin::pin!(leaf(1))));
    println!("nonleaf: {}", block_on(std::pin::pin!(nonleaf(2))));
    println!("block: {}", block_on(std::pin::pin!(async { sync_b(leaf(3).await) })));
    println!("manual: {}", block_on(std::pin::pin!(Manual(4, false))));
}

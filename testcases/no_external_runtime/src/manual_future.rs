//! Manually implemented Future types (not using async/await syntax).

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

// Sync helpers called from manual futures
fn manual_sync_process(value: i32) -> i32 {
    println!("    [manual_sync_process] value={}", value);
    value * 3
}

fn manual_sync_finalize(value: i32) -> i32 {
    println!("    [manual_sync_finalize] value={}", value);
    value + 100
}

// ============================================================================
// Manual Leaf Future
// ============================================================================

pub struct ManualLeafFuture {
    value: i32,
    polls_remaining: u8,
}

impl ManualLeafFuture {
    pub fn new(value: i32) -> Self {
        println!("[ManualLeafFuture::new] value={}", value);
        Self { value, polls_remaining: 2 }
    }
}

impl Future for ManualLeafFuture {
    type Output = i32;

    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
        println!("[ManualLeafFuture::poll] polls_remaining={}", self.polls_remaining);

        if self.polls_remaining > 0 {
            self.value = manual_sync_process(self.value);
            self.polls_remaining -= 1;
            Poll::Pending
        } else {
            let result = manual_sync_finalize(self.value);
            Poll::Ready(result)
        }
    }
}

// ============================================================================
// Manual Non-Leaf Future
// ============================================================================

pub struct ManualNonLeafFuture {
    state: NonLeafState,
}

enum NonLeafState {
    Start { value: i32 },
    WaitingFirst { child: ManualLeafFuture },
    WaitingSecond { child: ManualLeafFuture, first_result: i32 },
    Done,
}

impl ManualNonLeafFuture {
    pub fn new(value: i32) -> Self {
        println!("[ManualNonLeafFuture::new] value={}", value);
        Self { state: NonLeafState::Start { value } }
    }

    fn sync_combine(&self, a: i32, b: i32) -> i32 {
        println!("  [ManualNonLeafFuture::sync_combine] {} + {}", a, b);
        manual_sync_finalize(a + b)
    }
}

impl Future for ManualNonLeafFuture {
    type Output = i32;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            match std::mem::replace(&mut self.state, NonLeafState::Done) {
                NonLeafState::Start { value } => {
                    println!("[ManualNonLeafFuture::poll] Start");
                    let prepared = manual_sync_process(value);
                    self.state = NonLeafState::WaitingFirst {
                        child: ManualLeafFuture::new(prepared),
                    };
                }
                NonLeafState::WaitingFirst { mut child } => {
                    println!("[ManualNonLeafFuture::poll] WaitingFirst");
                    match Pin::new(&mut child).poll(cx) {
                        Poll::Ready(result) => {
                            self.state = NonLeafState::WaitingSecond {
                                child: ManualLeafFuture::new(result),
                                first_result: result,
                            };
                        }
                        Poll::Pending => {
                            self.state = NonLeafState::WaitingFirst { child };
                            return Poll::Pending;
                        }
                    }
                }
                NonLeafState::WaitingSecond { mut child, first_result } => {
                    println!("[ManualNonLeafFuture::poll] WaitingSecond");
                    match Pin::new(&mut child).poll(cx) {
                        Poll::Ready(second_result) => {
                            let final_result = self.sync_combine(first_result, second_result);
                            return Poll::Ready(final_result);
                        }
                        Poll::Pending => {
                            self.state = NonLeafState::WaitingSecond { child, first_result };
                            return Poll::Pending;
                        }
                    }
                }
                NonLeafState::Done => panic!("Polled after completion"),
            }
        }
    }
}

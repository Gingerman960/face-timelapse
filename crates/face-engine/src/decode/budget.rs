//! The shared pixel budget: full-resolution buffers in flight across all
//! threads stay within [`PIXEL_BUDGET`](super::PIXEL_BUDGET).

#[allow(clippy::wildcard_imports)]
use super::*;

/// Holds `pixels` of the shared [`PIXEL_BUDGET`] until dropped.
#[derive(Debug)]
pub(crate) struct PixelPermit {
    pixels: u64,
    /// Thread that took the share (whose held count it adds to).
    owner: Option<std::thread::ThreadId>,
}

#[cfg(test)]
thread_local! {
    /// Budget requests made by this thread (tests).
    static REQUESTS: std::cell::RefCell<Vec<u64>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Returns and clears this thread's budget requests (tests).
#[cfg(test)]
pub(crate) fn take_requests() -> Vec<u64> {
    REQUESTS.with(|r| std::mem::take(&mut *r.borrow_mut()))
}

/// The budget's books.
struct Ledger {
    in_flight: u64,
    /// FIFO: the next ticket to hand out and the one being served, so a
    /// large request at the head is never overtaken (no starvation).
    next_ticket: u64,
    serving: u64,
    /// Shares held per thread (a thread holding one must never wait).
    held: Vec<(std::thread::ThreadId, u32)>,
}

impl Ledger {
    fn held_by(&self, t: std::thread::ThreadId) -> u32 {
        self.held
            .iter()
            .find(|(id, _)| *id == t)
            .map_or(0, |(_, n)| *n)
    }

    fn add_held(&mut self, t: std::thread::ThreadId) {
        match self.held.iter_mut().find(|(id, _)| *id == t) {
            Some((_, n)) => *n += 1,
            None => self.held.push((t, 1)),
        }
    }

    fn remove_held(&mut self, t: std::thread::ThreadId) {
        if let Some(i) = self.held.iter().position(|(id, _)| *id == t) {
            self.held[i].1 -= 1;
            if self.held[i].1 == 0 {
                self.held.swap_remove(i);
            }
        }
    }
}

static LEDGER: Mutex<Ledger> = Mutex::new(Ledger {
    in_flight: 0,
    next_ticket: 0,
    serving: 0,
    held: Vec::new(),
});
static RELEASED: Condvar = Condvar::new();

fn ledger() -> std::sync::MutexGuard<'static, Ledger> {
    LEDGER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Debug check for the rule that keeps the budget deadlock-free: no thread
/// runs parallel (rayon) work while holding a share — a worker waiting on a
/// stolen task could otherwise run a sibling item that waits for budget its
/// own stack holds. Call it before every parallel loop over pixels.
pub(crate) fn assert_no_share_held(what: &str) {
    if cfg!(debug_assertions) {
        let held = ledger().held_by(std::thread::current().id());
        debug_assert_eq!(
            held, 0,
            "{what}: parallel work while holding a pixel budget share"
        );
    }
}

impl PixelPermit {
    /// Takes `pixels` of the budget. Small requests are free. Otherwise the
    /// request queues in FIFO order and is served once it fits, or once
    /// nothing else is held (a single request may exceed the budget). A
    /// thread that already holds a share never waits — that could wait on
    /// itself — and debug builds flag it as a bug.
    pub(crate) fn acquire(pixels: u64) -> Self {
        #[cfg(test)]
        REQUESTS.with(|r| r.borrow_mut().push(pixels));
        if pixels < BUDGET_THRESHOLD {
            return Self {
                pixels: 0,
                owner: None,
            };
        }
        let me = std::thread::current().id();
        let mut l = ledger();
        if l.held_by(me) > 0 {
            drop(l);
            debug_assert!(
                false,
                "a thread asked for a pixel budget share while holding one"
            );
            l = ledger();
        } else {
            let ticket = l.next_ticket;
            l.next_ticket += 1;
            while !(l.serving == ticket
                && (l.in_flight == 0 || l.in_flight + pixels <= PIXEL_BUDGET))
            {
                l = RELEASED
                    .wait(l)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            l.serving += 1;
        }
        l.in_flight += pixels;
        l.add_held(me);
        drop(l);
        RELEASED.notify_all(); // the next in line may fit too
        Self {
            pixels,
            owner: Some(me),
        }
    }

    /// Pixels held.
    pub(crate) fn pixels(&self) -> u64 {
        self.pixels
    }

    /// Keeps only `pixels` of this share (never grows; small ⇒ nothing).
    pub(crate) fn shrink(&mut self, pixels: u64) {
        let keep = if pixels < BUDGET_THRESHOLD { 0 } else { pixels };
        if keep >= self.pixels {
            return;
        }
        let mut l = ledger();
        l.in_flight = l.in_flight.saturating_sub(self.pixels - keep);
        self.pixels = keep;
        if keep == 0
            && let Some(owner) = self.owner.take()
        {
            l.remove_held(owner);
        }
        drop(l);
        RELEASED.notify_all();
    }
}

/// Budget for decoding a non-sequential (progressive or lossless) JPEG:
/// jpeg-decoder keeps i16 coefficients for every component at full
/// resolution (2 bytes per sample, vs 3 bytes per RGB pixel), assuming no
/// chroma subsampling — and never less than the full image.
pub(super) fn coefficient_pixels(full_pixels: u64, format: jpeg_decoder::PixelFormat) -> u64 {
    use jpeg_decoder::PixelFormat as P;
    let components: u64 = match format {
        P::L8 | P::L16 => 1,
        P::RGB24 => 3,
        P::CMYK32 => 4,
        #[allow(unreachable_patterns)]
        _ => 4,
    };
    (full_pixels * 2 * components / 3).max(full_pixels)
}

impl Drop for PixelPermit {
    fn drop(&mut self) {
        self.shrink(0);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// Serializes the tests that take large shares of the (process-wide)
    /// budget, so they do not measure each other.
    pub(crate) static BUDGET_TESTS: Mutex<()> = Mutex::new(());

    pub(crate) fn budget_lock() -> std::sync::MutexGuard<'static, ()> {
        BUDGET_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn a_thread_holding_a_share_never_waits_for_another() {
        let _serial = budget_lock();
        // Before the fix this hung: the nested full-budget request waited for
        // the budget to empty, which its own held share prevented.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = std::panic::catch_unwind(|| {
                let _held = PixelPermit::acquire(BUDGET_THRESHOLD + 1);
                let _nested = PixelPermit::acquire(PIXEL_BUDGET);
            });
            let _ = tx.send(outcome.is_err());
        });
        let panicked = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("hung: a nested request waited on its own share");
        assert_eq!(
            panicked,
            cfg!(debug_assertions),
            "debug builds flag the nesting; release builds proceed"
        );
    }

    #[test]
    fn a_full_budget_request_is_served_under_steady_load() {
        let _serial = budget_lock();
        // Two threads keep the budget busy in relay: one acquires before the
        // other releases, so it never empties. Before the fix a request for
        // the whole budget waited for it to be empty, i.e. forever.
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (baton_tx, baton_rx) = mpsc::channel::<()>();
        let baton_rx = std::sync::Arc::new(Mutex::new(baton_rx));
        let relay = |first: bool| {
            let (stop, baton_tx, baton_rx) = (stop.clone(), baton_tx.clone(), baton_rx.clone());
            std::thread::spawn(move || {
                if !first {
                    let _ = baton_rx
                        .lock()
                        .map(|r| r.recv_timeout(Duration::from_secs(5)));
                }
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    let share = PixelPermit::acquire(PIXEL_BUDGET / 3);
                    let _ = baton_tx.send(());
                    // Hand over: wait (briefly) for the other to acquire.
                    let _ = baton_rx
                        .lock()
                        .map(|r| r.recv_timeout(Duration::from_millis(50)));
                    drop(share);
                }
            })
        };
        let (a, b) = (relay(true), relay(false));
        std::thread::sleep(Duration::from_millis(50));
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _whole = PixelPermit::acquire(PIXEL_BUDGET);
            let _ = tx.send(());
        });
        let served = rx.recv_timeout(Duration::from_secs(10));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = (a.join(), b.join());
        served.expect("starved: the budget never emptied under steady load");
    }

    #[test]
    fn pixel_budget_waits_for_room_and_releases() {
        let _serial = budget_lock();
        let a = PixelPermit::acquire(PIXEL_BUDGET - 1_000);
        let small = PixelPermit::acquire(100);
        assert_eq!(small.pixels(), 0, "small decodes are free");
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let _b = PixelPermit::acquire(BUDGET_THRESHOLD);
            tx.send(()).expect("send");
        });
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "over budget: waits"
        );
        drop(a);
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("admitted after release");
        waiter.join().expect("join");
    }
}

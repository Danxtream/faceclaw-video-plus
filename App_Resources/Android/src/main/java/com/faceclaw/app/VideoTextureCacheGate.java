package com.faceclaw.app;

import java.util.function.LongSupplier;

/** Write-fenced cache release/reacquire; all calls hold the communicator lock. */
final class VideoTextureCacheGate {
    interface Queue {
        void enqueue(int operation, boolean left, Runnable written, Runnable failed);
    }

    private static final int FB_RELEASE = 6;
    private static final int FB_ACQUIRE = 5;
    private final Queue queue;
    private final Runnable resetModel;
    private final LongSupplier clock;
    private boolean suspended;
    private boolean preparing;
    private int generation;
    private int step;
    private long deadline;
    private long preparedStream;
    private long pendingStream;
    private Runnable failure;

    VideoTextureCacheGate(Queue queue, Runnable resetModel) {
        this(queue, resetModel, () -> System.nanoTime() / 1_000_000L);
    }

    VideoTextureCacheGate(Queue queue, Runnable resetModel, LongSupplier clock) {
        this.queue = queue;
        this.resetModel = resetModel;
        this.clock = clock;
    }

    boolean suspended() { return suspended; }
    boolean preparing() { return preparing; }

    void prepare(long stream, Runnable ready, Runnable failed) {
        poll();
        if (preparing) throw new IllegalStateException("Video cache preparation already pending");
        if (stream == preparedStream && suspended) { ready.run(); return; }
        suspended = preparing = true;
        pendingStream = stream;
        failure = failed;
        deadline = clock.getAsLong() + 3_000;
        resetModel.run();
        step = 0;
        advance(++generation, ready, failed);
    }

    private void advance(int ticket, Runnable ready, Runnable failed) {
        poll();
        if (ticket != generation) return;
        if (step == 4) {
            preparing = false;
            preparedStream = pendingStream;
            failure = null;
            ready.run();
            return;
        }
        final int expected = step;
        queue.enqueue(step < 2 ? FB_RELEASE : FB_ACQUIRE, (step & 1) != 0, () -> {
            poll();
            if (ticket == generation && expected == step) {
                step++;
                advance(ticket, ready, failed);
            }
        }, () -> {
            if (ticket == generation && preparing) fail();
        });
    }

    void poll() {
        if (preparing && clock.getAsLong() >= deadline) fail();
    }

    private void fail() {
        Runnable callback = failure;
        retire();
        resetModel.run();
        if (callback != null) callback.run();
    }

    void retire() {
        generation++;
        preparing = false;
        preparedStream = pendingStream = 0;
        failure = null;
    }

    void resume() {
        retire();
        suspended = false;
        resetModel.run();
    }
}

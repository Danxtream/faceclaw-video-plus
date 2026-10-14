package com.faceclaw.app;

/** ACK-fenced cache release/reacquire; all calls hold the communicator lock. */
final class VideoTextureCacheGate {
    interface Queue {
        void enqueue(int operation, boolean left, Runnable acknowledged, Runnable failed);
    }

    private static final int FB_RELEASE = 6;
    private static final int FB_ACQUIRE = 5;
    private final Queue queue;
    private final Runnable resetModel;
    private boolean suspended;
    private boolean preparing;
    private int generation;
    private int step;

    VideoTextureCacheGate(Queue queue, Runnable resetModel) {
        this.queue = queue;
        this.resetModel = resetModel;
    }

    boolean suspended() { return suspended; }
    boolean preparing() { return preparing; }

    void prepare(Runnable ready, Runnable failed) {
        if (preparing) throw new IllegalStateException("Video cache preparation already pending");
        suspended = preparing = true;
        resetModel.run();
        step = 0;
        advance(++generation, ready, failed);
    }

    private void advance(int ticket, Runnable ready, Runnable failed) {
        if (ticket != generation) return;
        if (step == 4) {
            preparing = false;
            ready.run();
            return;
        }
        final int expected = step;
        queue.enqueue(step < 2 ? FB_RELEASE : FB_ACQUIRE, (step & 1) != 0, () -> {
            if (ticket == generation && expected == step) {
                step++;
                advance(ticket, ready, failed);
            }
        }, () -> {
            if (ticket == generation) {
                generation++;
                preparing = false;
                failed.run();
            }
        });
    }

    void retire() {
        generation++;
        preparing = false;
    }

    void resume() {
        generation++;
        suspended = preparing = false;
        resetModel.run();
    }
}

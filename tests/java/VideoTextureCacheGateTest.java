package com.faceclaw.app;

import java.util.ArrayList;

public class VideoTextureCacheGateTest {
    public static void main(String[] args) {
        ArrayList<String> sent = new ArrayList<>();
        ArrayList<Runnable> acks = new ArrayList<>(), failures = new ArrayList<>();
        int[] reset = {0}, ready = {0}, failed = {0};
        VideoTextureCacheGate gate = new VideoTextureCacheGate((op, left, ack, failure) -> {
            sent.add(op + ":" + left); acks.add(ack); failures.add(failure);
        }, () -> reset[0]++);
        gate.prepare(() -> ready[0]++, () -> failed[0]++);
        assert gate.suspended() && gate.preparing() && reset[0] == 1;
        assert sent.size() == 1 && ready[0] == 0;
        for (int i = 0; i < 4; i++) {
            assert sent.size() == i + 1 && ready[0] == 0;
            acks.get(i).run();
        }
        assert sent.equals(java.util.List.of("6:false", "6:true", "5:false", "5:true"));
        assert ready[0] == 1 && !gate.preparing() && gate.suspended();
        gate.resume();
        assert !gate.suspended() && reset[0] == 2;
        gate.prepare(() -> ready[0]++, () -> failed[0]++);
        failures.get(4).run();
        assert failed[0] == 1 && ready[0] == 1 && gate.suspended() && !gate.preparing();
        acks.get(4).run();
        assert sent.size() == 5 && ready[0] == 1;
        gate.resume();
        gate.prepare(() -> ready[0]++, () -> failed[0]++);
        gate.resume();
        acks.get(5).run();
        assert sent.size() == 6 && ready[0] == 1 && !gate.suspended();
        gate.prepare(() -> ready[0]++, () -> failed[0]++);
        gate.retire();
        acks.get(6).run();
        assert sent.size() == 7 && ready[0] == 1 && gate.suspended() && !gate.preparing();
        gate.prepare(() -> ready[0]++, () -> failed[0]++);
        assert sent.size() == 8 && gate.preparing();
    }
}

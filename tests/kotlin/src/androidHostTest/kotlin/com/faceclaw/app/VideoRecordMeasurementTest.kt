package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VideoRecordMeasurementTest {
    private fun command(op: Int, stream: Long = 50) = ByteArray(24).also {
        it[0] = 31; it[1] = op.toByte()
        VideoUploadEngine.put(it, if (op in listOf(6,24,28,29)) 2 else 8, stream)
    }
    @Test fun generationAndRecordKindsDoNotMixPumpLifetimeOrOtherStreams() {
        var now = 0L
        val m = VideoRecordMeasurement { now }
        m.begin(50, 7)
        for (op in listOf(6,14,10)) {
            val ticket = m.queued(command(op), 7, 0)
            now += 12_000_000; m.written(ticket)
            now += 38_000_000; m.acknowledged(ticket); m.finished(ticket)
        }
        assertEquals(null, m.queued(command(6, 49), 7, 0))
        assertEquals(null, m.queued(command(6), 6, 0))
        val raw = m.snapshot()
        for (name in listOf("nal", "metadata", "credit")) {
            assertTrue(raw.contains("\"$name\":{\"records\":1,\"queueToWrite\":{\"count\":1,\"totalMs\":12.0,\"maxMs\":12.0},\"writeToAck\":{\"count\":1,\"totalMs\":38.0"))
        }
        assertTrue(VideoMeasurement { now }.snapshot().contains("\"queueToWrite\":{\"count\":0"))
        m.begin(51, 7)
        assertTrue(m.snapshot().contains("\"stream\":51"))
        assertTrue(m.snapshot().contains("\"nal\":{\"records\":0"))
    }
    @Test fun earlyAckMissingTimestampsLateCallbacksAndRetiredEpochStayHonest() {
        var now = 0L
        val m = VideoRecordMeasurement { now }; m.begin(50, 7)
        val early = m.queued(command(6), 7, 0)
        m.acknowledged(early); now += 12_000_000; m.written(early)
        m.acknowledged(early); m.finished(early); m.written(early)
        val missing = m.queued(command(14), 7, 0)
        m.finished(missing); m.acknowledged(missing)
        val page = m.queued(command(5), 7, 10)
        val raw = m.snapshot()
        assertTrue(raw.contains("\"writeToAck\":{\"count\":0,\"totalMs\":0.0"))
        assertTrue(raw.contains("\"ackBeforeWrite\":1,\"missingWrite\":0,\"lateCallbacks\":1,\"missingAck\":0"))
        assertTrue(raw.contains("\"ackBeforeWrite\":0,\"missingWrite\":1,\"lateCallbacks\":1,\"missingAck\":1"))
        assertTrue(raw.contains("\"creditPage\":{\"records\":1"))
        m.begin(51, 8); val before = m.snapshot()
        m.written(page); m.acknowledged(page); m.finished(page)
        assertEquals(before, m.snapshot())
    }
    @Test fun roomNalOperationsKeepTheExistingPerGenerationNalTimingBucket() {
        val m = VideoRecordMeasurement { 0L }; m.begin(50, 7)
        for (op in listOf(28,29)) {
            val ticket = m.queued(command(op), 7, 0)
            m.written(ticket); m.acknowledged(ticket); m.finished(ticket)
            assertEquals(null, m.queued(command(op, 49), 7, 0))
        }
        assertTrue(m.snapshot().contains("\"nal\":{\"records\":2"))
    }
}

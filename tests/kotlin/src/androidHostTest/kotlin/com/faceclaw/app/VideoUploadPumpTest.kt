package com.faceclaw.app

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoUploadPumpTest {
    private fun word(bytes: ByteArray, at: Int) = VideoUploadEngine.word(bytes, at)
    private fun reply(expected: Long, packed: Int = 36, error: Int = 0) = ByteArray(6).also {
        VideoUploadEngine.put(it, 0, expected); it[4] = packed.toByte(); it[5] = error.toByte()
    }
    private fun plan(count: Int = 8) = VideoUploadPlan(50, longArrayOf(101, 102), intArrayOf(), 0, count,
        (0 until count).map { VideoUploadPicture(it, it * 63L) })

    @Test fun missingCreditsRetryFreshIdsThenWaitWithoutInventingCreditOrFailingPump() {
        var id = 1L; var failures = 2; var pipelines = 0
        val requests = mutableListOf<Long>()
        val engine = VideoUploadEngine(plan(), 8, { byteArrayOf(0x65) }, { id++ }, {}, { command ->
            if (command[1].toInt() == 10) {
                requests.add(word(command, 4))
                if (failures-- > 0) throw VideoQueryUnavailable("Frozen page refused op=10")
                arrayOf(reply(0, 33), reply(0, 33))
            } else arrayOf(reply(word(command, 12), 1), reply(word(command, 12), 1))
        }, { records, following -> pipelines++; intArrayOf(records.size, following.count { it != null }) })
        assertFalse(engine.step()); assertTrue(engine.blocked)
        assertEquals(listOf(1L, 2L), requests); assertEquals(0, engine.budget)
        assertEquals(0, engine.index); assertEquals(0, pipelines)
        assertTrue(engine.step()); assertEquals(1, engine.index); assertEquals(1, pipelines)
        assertEquals(listOf(1L, 2L, 3L), requests)
    }

    @Test fun waitingControlPreventsAnotherCreditRetryAfterTimeout() {
        var requests = 0
        val engine = VideoUploadEngine(plan(), 8, { error("Uncredited read") }, { 1 }, {}, {
            requests++; throw VideoQueryUnavailable("Video exact ACK or frozen page timed out")
        }, { _, _ -> error("Uncredited send") })
        assertFalse(engine.step { false }); assertTrue(engine.blocked)
        assertEquals(1, requests); assertEquals(0, engine.index); assertEquals(0, engine.budget)
    }

    @Test fun pumpUsesDurableIdsAndExistingPipelineForBusyMetadataOnBothIngresses() {
        for (left in listOf(true, false)) {
            val f = VideoTransportTest.Fixture()
            var saved = 10L; var saves = 0; var expected = 0L; var busy = true
            val ids = mutableListOf<Long>(); val sent = mutableListOf<Int>()
            val range = VideoIdentityRange(object : VideoIdentityStore {
                override fun read() = saved
                override fun save(reservedEnd: Long): Boolean { saved = reservedEnd; saves++; return true }
            })
            f.respond = { record ->
                val op = record.payload[1].toInt()
                if (op == 6) {
                    assertEquals(expected, word(record.payload, 6))
                    assertContentEquals(byteArrayOf(listOf(0x67, 0x68, 0x65, 0x61)[expected.toInt()].toByte(), 42), record.payload.copyOfRange(10, record.payload.size))
                    expected++
                    sent.add(record.payload[10].toInt() and 31)
                } else {
                    val id = word(record.payload, 4); ids.add(id)
                    assertTrue(id < saved, "Durable block must precede every emitted request")
                    val refuse = op == 14 && busy
                    for (side in 1..2) {
                        val row = if (op == 10) reply(expected) else reply(word(record.payload, 12), 1, if (refuse && side == 2) 3 else 0)
                        f.page(id, side, 0, 1, row, left)
                        f.ack(record, side, success = row[5].toInt() == 0)
                    }
                    if (refuse) busy = false
                }
                if (op == 6) { f.ack(record, 1); f.ack(record, 2) }
            }
            val config = VideoUploadPlan(50, longArrayOf(101, 102), intArrayOf(), 0, 4,
                listOf(VideoUploadPicture(2, 0), VideoUploadPicture(3, 63)))
            val payloads = listOf(0x67, 0x68, 0x65, 0x61).map { byteArrayOf(it.toByte(), 42) }
            val engine = VideoUploadEngine(config, 4, { payloads[it] }, range::reserve, {},
                { f.transport.exchange(it, 6, 3, left, 5) },
                { records, following -> f.transport.pipeline(records, following, 3, left) })
            while (!engine.done) engine.step()
            assertEquals(listOf(7, 8, 5, 1), sent)
            assertEquals(2, engine.metadata); assertEquals(4, engine.index)
            assertEquals(ids.size, ids.toSet().size); assertEquals(1, saves)
            assertEquals(1034, VideoIdentityRange(object : VideoIdentityStore {
                override fun read() = saved
                override fun save(reservedEnd: Long) = true
            }).reserve())
        }
    }

    @Test fun creditsEpochReadFailureAndInvalidPipelineCannotAdvancePump() {
        for (raw in listOf(reply(1), reply(0, 39), reply(0, 164), reply(0, 20), reply(0, 36, 8))) {
            var sent = false
            val e = VideoUploadEngine(plan(), 8, { byteArrayOf(0x65) }, { 1 }, {}, { arrayOf(raw, raw) },
                { _, _ -> sent = true; intArrayOf(1, 1) })
            assertFails { e.step() }; assertFalse(sent); assertEquals(0, e.index)
        }
        for (mode in listOf("epoch", "read", "completion")) {
            var live = true
            val e = VideoUploadEngine(plan(), 8, {
                if (mode == "read") error("Audited NAL changed")
                if (mode == "epoch") live = false
                byteArrayOf(0x65)
            }, { 1 }, { check(live) { "Video generation retired" } },
                { val row = if (it[1].toInt() == 14) reply(word(it, 12), 1) else reply(0); arrayOf(row, row) },
                { _, _ -> intArrayOf(0, 0) })
            assertFails { e.step() }; assertEquals(0, e.index)
        }
        var ready = false; var pipelines = 0
        val blocked = VideoUploadEngine(plan(), 8, { byteArrayOf(0x65) }, { 1 }, {},
            { if (it[1].toInt() == 10) arrayOf(reply(0, if (ready) 33 else 32), reply(0, if (ready) 33 else 32))
                else arrayOf(reply(word(it, 12), 1), reply(word(it, 12), 1)) },
            { records, following -> pipelines++; intArrayOf(records.size, following.count { it != null }) })
        assertFalse(blocked.step()); assertTrue(blocked.blocked); assertEquals(0, pipelines)
        ready = true; assertTrue(blocked.step()); assertEquals(1, blocked.index)
    }

    @Test fun pauseFencesTheInflightBatchAndRetainsWorkerFailures() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val engine = VideoUploadEngine(plan(), 8, { byteArrayOf(0x65) }, { 1 }, {},
            { if (it[1].toInt() == 10) arrayOf(reply(0, 33), reply(0, 33)) else arrayOf(reply(word(it, 12), 1), reply(word(it, 12), 1)) },
            { records, following -> entered.countDown(); check(release.await(2, TimeUnit.SECONDS)); intArrayOf(records.size, following.count { it != null }) })
        val pump = VideoUploadPump { engine }
        fun fenced(p: VideoUploadPump) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (p.uploadSnapshot().contains("\"running\":true")) { check(System.nanoTime() < until); Thread.sleep(1) }
        }
        try {
            pump.resumeUpload(); assertTrue(entered.await(1, TimeUnit.SECONDS)); pump.pauseUpload()
            assertTrue(pump.uploadSnapshot().contains("\"running\":true")); assertFails { pump.closeUpload() }
            release.countDown(); fenced(pump)
            assertTrue(pump.uploadSnapshot().contains("\"index\":1"))
            Thread.sleep(30); assertEquals(1, engine.index)
        } finally { release.countDown(); pump.pauseUpload(); fenced(pump); pump.closeUpload() }
        val broken = VideoUploadPump { error("generation retired\nexact failure") }
        fenced(broken)
        assertTrue(broken.uploadSnapshot().contains("\"error\":true"))
        assertEquals("generation retired\nexact failure", broken.uploadFailure()); broken.closeUpload()
    }

    @Test fun nativeLoopAvoidsTenMillisecondJsAwaitsOnTheAckLatencyTransport() {
        fun measure(jsMs: Long): Double {
            val f = VideoTransportTest.Fixture()
            val timer = Executors.newSingleThreadScheduledExecutor()
            var expected = 0L; var id = 1L
            f.respond = { record ->
                val op = record.payload[1].toInt()
                timer.schedule({
                    if (op == 6) expected++
                    for (side in 1..2) {
                        if (op != 6) f.page(word(record.payload, 4), side, 0, 1,
                            if (op == 10) reply(expected) else reply(word(record.payload, 12), 1), true)
                        f.ack(record, side)
                    }
                }, if (op == 6) 45 else 30, TimeUnit.MILLISECONDS)
            }
            fun jsAwait() { if (jsMs > 0) Thread.sleep(jsMs) }
            val engine = VideoUploadEngine(plan(24), 24, { jsAwait(); byteArrayOf(0x61, 42) }, { jsAwait(); id++ }, {},
                { f.transport.exchange(it, 6, 3, true, 5).also { jsAwait() } },
                { records, following -> f.transport.pipeline(records, following, 3, true).also { jsAwait() } })
            try {
                val begin = System.nanoTime()
                while (!engine.done) engine.step()
                return 24e9 / (System.nanoTime() - begin)
            } finally { timer.shutdownNow() }
        }
        val before = measure(10); val after = measure(0)
        println("Upload pump JS-overhead model NAL/s: before=$before after=$after; JS await=10ms, metadata/credit=30ms, NAL ACK=45ms")
        assertTrue(after > before * 1.1, "Removing UI-thread await boundaries must improve the same transport model")
    }
}

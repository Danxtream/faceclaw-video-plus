package com.faceclaw.app

import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoTransportTest {
    @Test fun largeVideoRepliesAndFreshPaddedFetchesPreserveBothIngressesAndSmallPages() {
        for (left in listOf(true, false)) for (stride in listOf(1, 6, 22, 192)) {
            val f = Fixture()
            val raw = ByteArray(192) { it.toByte() }.also { it[2] = 0 }
            val count = (raw.size + stride - 1) / stride
            val padding = mutableListOf<ByteArray>()
            val encoder = CfwTransport(testPlatform())
            f.respond = { record ->
                val page = if (record.payload[1].toInt() == 5) {
                    assertEquals(195, record.payload.size)
                    assertEquals(70, record.payload[4].toInt())
                    val packets = encoder.encode(record.payload, record.message!!.magic, record.targets, 247)
                    assertTrue(packets.maxOf { it.size - 11 } >= FaceclawVideoTransport.VIDEO_REPLY_MAX_BYTES)
                    padding.add(record.payload.copyOfRange(9, record.payload.size))
                    record.payload[8].toInt() and 255
                } else 0
                for (side in 1..2) if (record.targets and side != 0) {
                    f.page(70, side, page, count, raw.copyOfRange(page * stride, minOf(raw.size, (page + 1) * stride)), left)
                    f.ack(record, side)
                }
            }
            val replies = f.transport.exchange(byteArrayOf(31, 4, 1, 0, 70, 0, 0, 0), 192, 3, left, 2)
            replies.forEach { assertContentEquals(raw, it) }
            if (padding.size > 1) assertFalse(padding[0].contentEquals(padding[1]))
            assertEquals(2 * (count - 1), padding.size)
            encoder.close()
        }
    }

    internal class Fixture {
        val records = LinkedBlockingQueue<VideoSubmission>()
        var next = 40
        var respond: ((VideoSubmission) -> Unit)? = null
        val transport = FaceclawVideoTransport(VideoRecordQueue { record ->
            val message = OutboundMessage("video", "test", 0xf0, 0, next++ and 255, record.payload, 100, -1, record.ingressLeft)
            record.message = message
            message.onAck = MessageCallback { record.delivered() }
            records.add(record)
            respond?.invoke(record)
            true
        })

        fun ack(record: VideoSubmission, side: Int, success: Boolean = true, left: Boolean = record.ingressLeft,
                size: Int = record.payload.size, checksum: Int = CfwTransport.crc(record.payload), attempt: Int = record.message!!.magic) {
            val body = byteArrayOf(if (success) 1 else 3, attempt.toByte(), 0, 0, side.toByte(),
                size.toByte(), (size shr 8).toByte(), checksum.toByte(), (checksum shr 8).toByte())
            assertFalse(transport.receive(left, packet(body)))
            for (completion in transport.drainCompleted()) {
                if (completion.attempt == completion.message.magic && completion.epoch == transport.epoch)
                    completion.message.onAck!!.run()
            }
        }

        fun page(id: Long, side: Int, page: Int, count: Int, content: ByteArray, left: Boolean) {
            transport.receive(left, packet(byteArrayOf(31, side.toByte(), id.toByte(),
                (id shr 8).toByte(), (id shr 16).toByte(), (id shr 24).toByte(), page.toByte(), count.toByte()) + content))
        }
    }

    @Test fun bothIngressesRequireEachSelectedLensAndOwnPayloadIdentity() {
        for (left in listOf(true, false)) {
            val f = Fixture()
            val worker = Executors.newSingleThreadExecutor()
            try {
                val result = worker.submit<IntArray> { f.transport.sendWindow(arrayOf(byteArrayOf(31, 6)), 3, left) }
                val record = f.records.poll(1, TimeUnit.SECONDS)!!
                f.ack(record, 1, left = !left)
                f.ack(record, 1, size = 99)
                f.ack(record, 1, checksum = 0)
                assertFalse(result.isDone)
                f.ack(record, 1)
                assertFalse(result.isDone)
                f.ack(record, 2)
                assertContentEquals(intArrayOf(3), result.get(1, TimeUnit.SECONDS))
            } finally { worker.shutdownNow() }
        }
    }

    @Test fun fourRecordWindowIsBoundedAndSingleLensRefusalIsNotSuccess() {
        val f = Fixture()
        f.respond = { record ->
            f.ack(record, 1)
            f.ack(record, 2, success = false)
        }
        assertContentEquals(intArrayOf(1, 1, 1, 1),
            f.transport.sendWindow(Array(4) { byteArrayOf(31, 6) }, 3, true))
        assertFailsWith<IllegalArgumentException> {
            f.transport.sendWindow(Array(5) { byteArrayOf(31, 6) }, 3, true)
        }
        assertFailsWith<IllegalArgumentException> {
            f.transport.sendWindow(arrayOf(ByteArray(4097)), 3, true)
        }
    }

    @Test fun replayAndRetirementCannotCompleteFromOldAttemptOrCallbacks() {
        val f = Fixture()
        val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<IntArray> { f.transport.sendWindow(arrayOf(byteArrayOf(31, 6)), 3, false) }
            val record = f.records.poll(1, TimeUnit.SECONDS)!!
            val old = record.message!!.magic
            f.ack(record, 1)
            record.message!!.prepareCfwReplay(old + 1)
            assertEquals(3, f.transport.targetsFor(record.message!!))
            f.ack(record, 2, attempt = old)
            assertFalse(result.isDone)
            f.transport.retire("peer disconnected")
            assertFailsWith<java.util.concurrent.ExecutionException> { result.get(1, TimeUnit.SECONDS) }
            record.delivered()
            assertEquals(2L, f.transport.epoch)
            assertTrue(f.transport.drainCompleted().isEmpty())
        } finally { worker.shutdownNow() }
    }

    @Test fun frozenPagesKeepBothSourcesAndRejectConflictingReplay() {
        for (left in listOf(true, false)) {
            val f = Fixture()
            val id = 0xfffffffeL
            val command = byteArrayOf(31, 4, 1, 0, -2, -1, -1, -1)
            f.respond = { record ->
                val page = if (record.payload[1].toInt() == 5) record.payload[8].toInt() else 0
                for (side in 1..2) if (record.targets and side != 0) {
                    // Page can arrive before the transport ACK.
                    f.page(id, side, page, 2, if (page == 0) byteArrayOf(1, 7, 0, side.toByte()) else byteArrayOf(9, 8), left)
                    f.ack(record, side)
                }
            }
            val replies = f.transport.exchange(command, 6, 3, left, 2)
            assertContentEquals(byteArrayOf(1, 7, 0, 1, 9, 8), replies[0])
            assertContentEquals(byteArrayOf(1, 7, 0, 2, 9, 8), replies[1])
            f.respond = { record ->
                f.page(id, 1, 0, 2, byteArrayOf(1, 7, 0, 1), left)
                f.page(id, 1, 0, 2, byteArrayOf(1, 7, 0, 2), left)
                f.ack(record, 1); f.ack(record, 2)
            }
            assertFailsWith<IllegalStateException> { f.transport.exchange(command, 6, 3, left, 2) }
        }
    }

    @Test fun invalidEnvelopeAndUnselectedLensCannotPublishPages() {
        val f = Fixture()
        assertFalse(f.transport.receive(true, byteArrayOf(0)))
        val corrupt = packet(byteArrayOf(31, 1, 1, 0, 0, 0, 0, 1, 0))
        corrupt[corrupt.lastIndex] = (corrupt.last() + 1).toByte()
        assertTrue(f.transport.receive(true, corrupt))
        assertTrue(f.transport.drainCompleted().isEmpty())
    }

    @Test fun minimumMtuKeepsExistingFramingAndBothLenses() {
        val source = ByteArray(4096) { it.toByte() }
        val frames = CfwTransport.frame(source, 250, 3, 23)
        assertTrue(frames.all { it.size <= 20 })
        assertEquals(0x83, frames.first()[8].toInt() and 255)
        assertEquals(0x43, frames.last()[8].toInt() and 255)
    }

    @Test fun asynchronousWindowCopiesInputAndConsumesItsResultOnce() {
        val f = Fixture()
        f.respond = { record -> f.ack(record, 1); f.ack(record, 2) }
        val input = byteArrayOf(1, 2, 0, 31, 6)
        val id = f.transport.beginWindow(java.nio.ByteBuffer.wrap(input), 3, true)
        input[3] = 0
        val limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
        while (f.transport.pollOperation(id) == 0 && System.nanoTime() < limit) Thread.yield()
        assertEquals(1, f.transport.pollOperation(id))
        assertEquals("[3]", f.transport.takeOperation(id))
        assertEquals(-1, f.transport.pollOperation(id))
        assertEquals(31, f.records.poll()!!.payload[0].toInt())
    }

    @Test fun queuedAsyncOperationsRetireWithoutSendingIntoNewGeneration() {
        val f = Fixture()
        val input = java.nio.ByteBuffer.wrap(byteArrayOf(1, 2, 0, 31, 6))
        val first = f.transport.beginWindow(input, 3, true)
        assertTrue(f.records.poll(1, TimeUnit.SECONDS) != null)
        val second = f.transport.beginWindow(input, 3, true)
        f.transport.retire("disconnected")
        assertEquals(-1, f.transport.pollOperation(first))
        assertEquals(-1, f.transport.pollOperation(second))
        assertFailsWith<IllegalStateException> { f.transport.takeOperation(first) }
        assertFailsWith<IllegalStateException> { f.transport.takeOperation(second) }
        Thread.sleep(20)
        assertTrue(f.records.isEmpty())
    }

    @Test fun admittedPictureAndNextMetadataKeepBothAckMasksAndCompactRefusals() {
        for (left in listOf(true, false)) for (busy in listOf(true, false)) {
            val f = Fixture()
            val nal = byteArrayOf(31, 6, 50, 0, 0, 0, 3, 0, 0, 0, 0x65)
            val metadata = byteArrayOf(31, 14, 1, 0, 88, 0, 0, 0, 50, 0, 0, 0,
                2, 0, 0, 0, 4, 0, 0, 0, 63, 0, 0, 0)
            f.respond = { record ->
                for (side in 1..2) {
                    if (record.payload[1].toInt() == 14) {
                        f.page(88, side, 0, 1, byteArrayOf(2, 0, 0, 0, 2, if (busy) 3 else 0), left)
                        f.ack(record, side, success = !busy)
                    } else f.ack(record, side)
                }
            }
            val id = f.transport.beginPicture(java.nio.ByteBuffer.wrap(nal), java.nio.ByteBuffer.wrap(metadata), 3, left)
            nal[10] = 0
            val limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
            while (f.transport.pollOperation(id) == 0 && System.nanoTime() < limit) Thread.yield()
            assertEquals(1, f.transport.pollOperation(id))
            assertEquals(if (busy) "[\"020000000203\", \"020000000203\"]" else "[\"020000000200\", \"020000000200\"]",
                f.transport.takeOperation(id))
            assertEquals(6, f.records.poll()!!.payload[1].toInt())
            assertEquals(14, f.records.poll()!!.payload[1].toInt())
        }
    }

    @Test fun futureMetadataCannotHideARefusedCurrentPictureOrCrossRetirement() {
        val nal = byteArrayOf(31, 6, 50, 0, 0, 0, 3, 0, 0, 0, 0x65)
        val metadata = byteArrayOf(31, 14, 1, 0, 88, 0, 0, 0, 50, 0, 0, 0,
            2, 0, 0, 0, 4, 0, 0, 0, 63, 0, 0, 0)
        val f = Fixture()
        f.respond = { record ->
            for (side in 1..2) f.ack(record, side, success = record.payload[1].toInt() != 6 || side == 1)
        }
        assertFailsWith<IllegalStateException> { f.transport.exchange(metadata, 6, 3, true, 5, leading = arrayOf(nal)) }
        assertFailsWith<IllegalArgumentException> {
            f.transport.beginPicture(java.nio.ByteBuffer.wrap(nal), java.nio.ByteBuffer.wrap(metadata.copyOf().also { it[16] = 3 }), 3, true)
        }
        val retired = Fixture()
        val id = retired.transport.beginPicture(java.nio.ByteBuffer.wrap(nal), java.nio.ByteBuffer.wrap(metadata), 3, false)
        assertTrue(retired.records.poll(1, TimeUnit.SECONDS) != null)
        retired.transport.retire("disconnected")
        assertEquals(-1, retired.transport.pollOperation(id))
        assertFailsWith<IllegalStateException> { retired.transport.takeOperation(id) }
    }

    private fun nal(sequence: Int) = byteArrayOf(31, 6, 50, 0, 0, 0, sequence.toByte(), 0, 0, 0, 0x65)
    private fun metadata(sequence: Int) = byteArrayOf(31, 14, 1, 0, (100 + sequence).toByte(), 0, 0, 0,
        50, 0, 0, 0, sequence.toByte(), 0, 0, 0, sequence.toByte(), 0, 0, 0, 0, 0, 0, 0)

    @Test fun acknowledgedQueryWithoutFrozenReplyNamesItsOperationAndMissingLenses() {
        val f = Fixture()
        f.respond = { record -> f.ack(record, 1); f.ack(record, 2) }
        val command = byteArrayOf(31, 10, 1, 0, 77, 0, 0, 0, 50, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0)
        val error = assertFailsWith<IllegalStateException> {
            f.transport.exchange(command, 6, 3, true, 5, deadline = System.nanoTime() + 50_000_000L)
        }
        assertTrue(error.message!!.contains("op=10 request=77"))
        assertTrue(error.message!!.contains("waiting=page0"))
        assertTrue(error.message!!.contains("missing=1,2"))
    }

    @Test fun refusedPageUsesThreeBackoffsAndLogsEveryExactRefusal() {
        for (permanent in listOf(false, true)) {
            val f = Fixture(); var tries = 0; var parents = 0
            val times = mutableListOf<Long>()
            val log = java.io.ByteArrayOutputStream()
            val previous = System.err
            System.setErr(java.io.PrintStream(log))
            val encoder = CfwTransport(testPlatform())
            f.respond = { record ->
                val parent = record.payload[1].toInt() != 5
                if (parent) parents++
                else assertTrue(encoder.encode(record.payload, record.message!!.magic, record.targets, 247)
                    .maxOf { it.size - 11 } >= FaceclawVideoTransport.VIDEO_REPLY_MAX_BYTES)
                val page = if (parent) 0 else record.payload[8].toInt()
                for (side in 1..2) if (record.targets and side != 0) {
                    if (side == 2 && page == 1) times.add(System.nanoTime())
                    val refuse = side == 2 && page == 1 && (++tries <= 3 || permanent)
                    if (!refuse) {
                        val raw = byteArrayOf(1, 7, 0, side.toByte(), 9, 8)
                        f.page(70, side, page, 3, raw.copyOfRange(page * 2, page * 2 + 2), true)
                    }
                    f.ack(record, side, success = !refuse)
                }
            }
            val query = byteArrayOf(31, 4, 1, 0, 70, 0, 0, 0)
            try {
                if (permanent) {
                    val error = assertFailsWith<VideoQueryUnavailable> { f.transport.exchange(query, 6, 3, true, 2) }
                    assertTrue(error.message!!.contains("op=4 request=70 side=2 page=1 pages=3 attempt=4 attempts=4"))
                } else assertContentEquals(byteArrayOf(1, 7, 0, 2, 9, 8), f.transport.exchange(query, 6, 3, true, 2)[1])
                assertEquals(4, tries); assertEquals(1, parents)
                val entries = log.toString().lineSequence().filter { it.contains("Frozen page refused") }.toList()
                assertEquals(if (permanent) 4 else 3, entries.size)
                entries.forEachIndexed { i, line ->
                    assertTrue(line.contains("op=4 request=70 side=2 page=1 pages=3 attempt=${i + 1}"))
                    assertTrue(line.contains("elapsedMs=") && line.contains("attemptMs="))
                }
                for (i in 1..3) assertTrue(times[i] - times[i - 1] >= longArrayOf(50, 150, 400)[i - 1] * 1_000_000)
            } finally { System.setErr(previous); encoder.close() }
        }
    }

    @Test fun exactNackResetsOnlyItsIngressContextOnTheNextWriterRecord() {
        for (left in listOf(true, false)) {
            val f = Fixture(); var calls = 0
            f.respond = { record ->
                when (calls++) {
                    0 -> {
                        f.ack(record, 1, success = false, left = !left)
                        f.ack(record, 1, success = false, attempt = (record.message!!.magic + 1) and 255)
                        assertFalse(f.transport.needsContextReset(record.message!!))
                        f.ack(record, 1, success = false)
                    }
                    1 -> { assertFalse(f.transport.needsContextReset(record.message!!)); f.ack(record, 1) }
                    2 -> {
                        assertTrue(f.transport.needsContextReset(record.message!!))
                        assertFalse(f.transport.needsContextReset(record.message!!))
                        f.ack(record, 1)
                    }
                    3 -> f.ack(record, 1, success = false)
                    else -> {
                        assertFalse(f.transport.needsContextReset(record.message!!))
                        f.page(91, 1, 0, 1, byteArrayOf(1, 7, 0, 1, 0, 0), left)
                        f.ack(record, 1)
                    }
                }
            }
            assertContentEquals(intArrayOf(0), f.transport.sendWindow(arrayOf(nal(1)), 1, left))
            assertContentEquals(intArrayOf(1), f.transport.sendWindow(arrayOf(nal(2)), 1, !left))
            assertContentEquals(intArrayOf(1), f.transport.sendWindow(arrayOf(nal(3)), 1, left))
            assertContentEquals(intArrayOf(0), f.transport.sendWindow(arrayOf(nal(4)), 1, left))
            f.transport.retire("reconnect")
            assertEquals(1, f.transport.exchange(byteArrayOf(31, 4, 1, 0, 91, 0, 0, 0), 6, 1, left, 2).size)
        }
    }

    @Test fun asynchronousPipelineCopiesAndBoundsItsPacket() {
        val f = Fixture()
        f.respond = { record -> f.ack(record, 1); f.ack(record, 2) }
        val packet = byteArrayOf(1, 11, 0) + nal(1) + byteArrayOf(0)
        val id = f.transport.beginPipeline(java.nio.ByteBuffer.wrap(packet), 3, true)
        packet[3] = 0
        val limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
        while (f.transport.pollOperation(id) == 0 && System.nanoTime() < limit) Thread.yield()
        assertEquals(1, f.transport.pollOperation(id))
        assertEquals("[1, 0]", f.transport.takeOperation(id))
        assertEquals(31, f.records.poll()!!.payload[0].toInt())
        for (invalid in listOf(byteArrayOf(5), byteArrayOf(1, 11, 0), byteArrayOf(1, 11, 0) + nal(1) + byteArrayOf(1)))
            assertFailsWith<IllegalArgumentException> { f.transport.beginPipeline(java.nio.ByteBuffer.wrap(invalid), 3, true) }
    }

    @Test fun pipelineStopsBeforeNalsWhoseMetadataEitherLensRefused() {
        for (left in listOf(true, false)) {
            val f = Fixture()
            f.respond = { record -> for (side in 1..2) {
                val busy = record.payload[1].toInt() == 14 && side == 2
                if (record.payload[1].toInt() == 14) f.page(102, side, 0, 1,
                    byteArrayOf(2, 0, 0, 0, 2, if (busy) 3 else 0), left)
                f.ack(record, side, success = !busy)
            } }
            assertContentEquals(intArrayOf(1, 0), f.transport.pipeline(arrayOf(nal(1), nal(2)),
                arrayOf(metadata(2), null), 3, left))
            assertEquals(listOf(6, 14), f.records.map { it.payload[1].toInt() })
        }
    }

    @Test fun pipelineCannotHideNalRefusalRetirementOrMalformedMetadata() {
        val f = Fixture()
        f.respond = { record -> f.ack(record, 1); f.ack(record, 2, success = false) }
        assertFailsWith<IllegalStateException> { f.transport.pipeline(arrayOf(nal(1)), arrayOf(null), 3, true) }
        assertFailsWith<IllegalArgumentException> { f.transport.pipeline(arrayOf(nal(1)), arrayOf(metadata(3)), 3, true) }
        val retired = Fixture()
        val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<IntArray> { retired.transport.pipeline(arrayOf(nal(1), nal(2)), arrayOf(null, null), 3, true) }
            val old = retired.records.poll(1, TimeUnit.SECONDS)!!
            retired.transport.retire("disconnected")
            old.delivered()
            assertFailsWith<java.util.concurrent.ExecutionException> { result.get(1, TimeUnit.SECONDS) }
        } finally { worker.shutdownNow() }
    }

    @Test fun pipelineReplayStillRequiresBothLensesOnTheNewAttempt() {
        val f = Fixture(); val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<IntArray> { f.transport.pipeline(arrayOf(nal(1)), arrayOf(null), 3, false) }
            val record = f.records.poll(1, TimeUnit.SECONDS)!!
            val old = record.message!!.magic
            f.ack(record, 1)
            record.message!!.prepareCfwReplay(old + 1)
            f.transport.targetsFor(record.message!!)
            f.ack(record, 2, attempt = old)
            assertFalse(result.isDone)
            f.ack(record, 2); assertFalse(result.isDone)
            f.ack(record, 1)
            assertContentEquals(intArrayOf(1, 0), result.get(1, TimeUnit.SECONDS))
        } finally { worker.shutdownNow() }
    }

    @Test fun latencyRealisticPipelineOverlapsThirtyToFortyFiveMillisecondAcks() {
        fun measure(pipelined: Boolean): Pair<Double, Int> {
            val f = Fixture()
            val timer = Executors.newSingleThreadScheduledExecutor()
            val live = java.util.concurrent.atomic.AtomicInteger()
            val peak = java.util.concurrent.atomic.AtomicInteger()
            f.respond = { record ->
                peak.accumulateAndGet(live.incrementAndGet(), ::maxOf)
                val meta = record.payload[1].toInt() == 14
                timer.schedule({
                    live.decrementAndGet()
                    for (side in 1..2) {
                        if (meta) f.page((record.payload[4].toInt() and 255).toLong(), side, 0, 1,
                            byteArrayOf(record.payload[12], 0, 0, 0, 2, 0), true)
                        f.ack(record, side)
                    }
                }, if (meta) 30 else 45, TimeUnit.MILLISECONDS)
            }
            try {
                val begin = System.nanoTime()
                for (first in 1..24 step 4) {
                    if (pipelined) f.transport.pipeline(Array(4) { nal(first + it) },
                        Array(4) { metadata(first + it + 1) }, 3, true)
                    else for (i in first until first + 4) f.transport.exchange(metadata(i + 1), 6, 3, true, 5, leading = arrayOf(nal(i)))
                    // One compact credit request per four NALs: 2.25 messages/NAL.
                    Thread.sleep(35)
                }
                return Pair(24e9 / (System.nanoTime() - begin), peak.get())
            } finally { timer.shutdownNow() }
        }
        val before = measure(false); val after = measure(true)
        println("ACK latency fake NAL/s: before=${before.first} after=${after.first} maxOutstanding=${after.second}")
        assertTrue(after.first > before.first * 1.1, "Pipeline must beat the per-picture fence")
        assertTrue(after.second in 2..3)
    }

    companion object {
        private fun packet(body: ByteArray): ByteArray {
            val crc = CfwTransport.crc(body)
            return byteArrayOf(-86, 0x12, 0, (body.size + 2).toByte(), 1, 1, -16, 0) +
                body + byteArrayOf(crc.toByte(), (crc shr 8).toByte())
        }
    }
}

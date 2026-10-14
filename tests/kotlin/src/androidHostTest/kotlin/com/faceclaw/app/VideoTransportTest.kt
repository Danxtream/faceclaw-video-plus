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
    private class Fixture {
        val records = LinkedBlockingQueue<VideoSubmission>()
        var next = 40
        var respond: ((VideoSubmission) -> Unit)? = null
        val transport = FaceclawVideoTransport(VideoRecordQueue { record ->
            val message = OutboundMessage("video", "test", 0xf0, 0, next++, record.payload, 100, -1, record.ingressLeft)
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

    companion object {
        private fun packet(body: ByteArray): ByteArray {
            val crc = CfwTransport.crc(body)
            return byteArrayOf(-86, 0x12, 0, (body.size + 2).toByte(), 1, 1, -16, 0) +
                body + byteArrayOf(crc.toByte(), (crc shr 8).toByte())
        }
    }
}

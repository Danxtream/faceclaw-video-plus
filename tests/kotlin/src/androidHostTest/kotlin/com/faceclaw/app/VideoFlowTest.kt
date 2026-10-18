package com.faceclaw.app

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class VideoFlowTest {
    @Test fun productionEngineUsesLiveGrantsAndLostGrantsFallBackOnlyAtAFence() {
        for (lose in listOf(false, true)) {
            var delivered = 0; var pictures = 0; var queries = 0; var sends = 0
            val config = VideoUploadPlan(50, longArrayOf(101,102), intArrayOf(), 0, 32,
                (2 until 32).map { VideoUploadPicture(it, (it - 2) * 50L) }, timed = true, flow = true)
            val engine = VideoUploadEngine(config, 32, { byteArrayOf(if (it == 0) 0x67 else if (it == 1) 0x68 else 0x61) },
                { 1L }, {}, { command ->
                    assertEquals(10, command[1].toInt()); assertEquals(3L, VideoUploadEngine.word(command, 20)); queries++
                    arrayOf(row(1, delivered, ordinal = pictures), row(2, delivered, ordinal = pictures))
                }, { _, _ -> error("No batch drain in flow mode") }, continuous = { next, grant, keep ->
                    while (keep()) {
                        val record = next() ?: break
                        assertEquals(delivered.toLong(), VideoUploadEngine.word(record, 6)); sends++
                        if (record[1].toInt() == 27) pictures++
                        delivered++
                        if (!lose) for (side in 1..2)
                            grant(VideoFlowCredit(side, delivered - 1, row(side, delivered, ordinal = pictures)))
                    }
                })
            while (!engine.done) assertTrue(engine.step())
            assertEquals(32, sends); assertEquals(30, engine.metadata)
            assertEquals(if (lose) 5 else 1, queries)
            assertEquals(32, engine.evidenceRows().size)
        }
    }
    @Test fun latencyModelComparesBatchDrainAgainstIndividualAckRefill() {
        fun run(flow: Boolean, writeMs: Long): Pair<Double, Int> {
            var now = 0L; var writeReady = 0L; var accepted = 0; var queries = 0
            val completions = java.util.PriorityQueue<Pair<Long, Int>>(compareBy { it.first })
            fun submit(record: ByteArray) {
                assertEquals(accepted.toLong(), VideoUploadEngine.word(record, 6))
                writeReady = maxOf(writeReady, now) + writeMs
                completions.add(writeReady + 38L to accepted++)
            }
            val config = VideoUploadPlan(50, longArrayOf(101,102), intArrayOf(), 0, 120,
                (0 until 120).map { VideoUploadPicture(it, it * 50L) }, timed = true, flow = flow)
            val engine = VideoUploadEngine(config, 120, { byteArrayOf(0x61) }, { 1L }, {}, { _ ->
                queries++; now += 36
                if (flow) arrayOf(row(1, accepted, ordinal = accepted), row(2, accepted, ordinal = accepted))
                else arrayOf(ByteArray(6).also { VideoUploadEngine.put(it,0,accepted.toLong()); it[4]=46; it[5]=(6 shl 5).toByte() },
                    ByteArray(6).also { VideoUploadEngine.put(it,0,accepted.toLong()); it[4]=46; it[5]=(6 shl 5).toByte() })
            }, { records, _ ->
                for (record in records) {
                    if (completions.size == 3) now = maxOf(now, completions.remove().first)
                    submit(record)
                }
                while (completions.isNotEmpty()) now = maxOf(now, completions.remove().first)
                intArrayOf(records.size, 0)
            }, VideoMeasurement { now * 1_000_000 }, continuous = if (!flow) null else { next, grant, _ ->
                while (true) {
                    var filled = false
                    if (completions.size < 6) {
                        val record = next()
                        if (record != null) { submit(record); filled = true }
                    }
                    if (filled) continue
                    if (completions.isEmpty()) break
                    val (at, sequence) = completions.remove(); now = maxOf(now, at)
                    for (side in 1..2) grant(VideoFlowCredit(side, sequence,
                        row(side, sequence + 1, ordinal = sequence + 1)))
                }
            })
            while (!engine.done) engine.step()
            return 120000.0 / now to queries
        }
        for (writeMs in listOf(12L, 24L, 30L)) {
            val before=run(false,writeMs);val after=run(true,writeMs)
            println("Flow model serializedNALWriteMs=$writeMs ACKms=38 queryMs=36 NALs/s=${before.first}->${after.first} queries=${before.second}->${after.second}; not a glasses FPS prediction")
            assertTrue(after.first > before.first); assertEquals(1,after.second)
        }
    }
    private fun row(side: Int, expected: Int, free: Int = 12, capacity: Int = 12,
        ordinal: Int = 0, room: Int = 6) = ByteArray(16).also {
        VideoUploadEngine.put(it, 0, expected.toLong())
        it[4] = 46; it[5] = (room shl 5).toByte(); it[6] = free.toByte(); it[7] = capacity.toByte()
        VideoUploadEngine.put(it, 8, ordinal.toLong()); VideoUploadEngine.put(it, 12, 100L + side)
    }
    @Test fun onlyPairedMonotonicOwnerGrantsProvideRoomAfterSubtractingOutstandingWork() {
        val grants = VideoFlowBudget(50, longArrayOf(101, 102))
        assertEquals(null, grants.accept(VideoFlowCredit(1, 3, row(1, 2, 10, ordinal = 2)), 6, 4))
        assertEquals(6 to 3, grants.accept(VideoFlowCredit(2, 2, row(2, 0, 9, ordinal = 1)), 6, 4))
        assertEquals(null, grants.accept(VideoFlowCredit(2, 1, row(2, 0)), 6, 4))
        assertFails { grants.accept(VideoFlowCredit(1, 4, row(1, 1)), 6, 4) }
        assertFails { VideoFlowBudget(50,longArrayOf(101,102)).accept(
            VideoFlowCredit(1,3,row(1,0,4,4)),6,4) }
        assertFails { VideoFlowBudget(50,longArrayOf(101,102)).accept(
            VideoFlowCredit(1,5,row(1,6)),6,7) }
        for (mutate in listOf<(ByteArray) -> Unit>(
            { VideoUploadEngine.put(it, 12, 999) }, { it[6] = 13 }, { it[7] = 9 },
            { VideoUploadEngine.put(it, 0, 7) }, { it[4] = 62 }, { it[4] = 0x80.toByte() },
            { it[5] = 1 }, { VideoUploadEngine.put(it, 8, 5) })) {
            val raw = row(1, 0); mutate(raw)
            assertFails { VideoFlowBudget(50, longArrayOf(101,102)).accept(VideoFlowCredit(1, 3, raw), 6, 4) }
        }
    }
    private fun nal(sequence: Int) = ByteArray(11).also {
        it[0] = 31; it[1] = 26; VideoUploadEngine.put(it, 2, 50)
        VideoUploadEngine.put(it, 6, sequence.toLong()); it[10] = 0x61
    }
    private fun grant(f: VideoTransportTest.Fixture, record: VideoSubmission, side: Int,
        left: Boolean = record.ingressLeft, token: Long = 100L + side) {
        val sequence = VideoUploadEngine.word(record.payload, 6).toInt()
        val raw = row(side, 0, 12 - sequence - 1)
        VideoUploadEngine.put(raw, 12, token)
        val stream = ByteArray(4); VideoUploadEngine.put(stream, 0, 50)
        f.page(sequence.toLong(), side, 0, 1, byteArrayOf(0xd1.toByte()) + raw + stream, left)
    }
    @Test fun individualCompletionRefillsWithoutWaitingForOldestAndPauseFencesEveryRecord() {
        for (left in listOf(true, false)) {
            val f = VideoTransportTest.Fixture(); val executor = Executors.newSingleThreadExecutor()
            val keep = AtomicBoolean(true); var sequence = 0
            val grants = mutableListOf<VideoFlowCredit>()
            f.respond = { record -> for (side in 1..2) grant(f, record, side) }
            try {
                val result = executor.submit { f.transport.continuous(
                    { if (sequence < 12) nal(sequence++) else null }, { grants.add(it); 12 }, { keep.get() }, 3, left, 1) }
                val first = (0 until 6).map { assertNotNull(f.records.poll(2, TimeUnit.SECONDS)) }
                assertEquals(6, f.transport.windowSize()); assertEquals(null, f.records.poll())
                // Complete the second record while the first is still outstanding.
                for (side in 1..2) { grant(f, first[1], side); f.ack(first[1], side) }
                val seventh = assertNotNull(f.records.poll(2, TimeUnit.SECONDS))
                assertEquals(6L, VideoUploadEngine.word(seventh.payload, 6))
                keep.set(false)
                assertFalse(result.isDone)
                for (record in first.filter { it !== first[1] } + seventh)
                    for (side in 1..2) { grant(f, record, side); f.ack(record, side) }
                result.get(2, TimeUnit.SECONDS)
                assertEquals(3, f.transport.windowSize()); assertEquals(null, f.records.poll())
                assertTrue(grants.any { it.sequence == 1 && it.side == 2 })
            } finally { f.transport.retire("test end"); executor.shutdownNow() }
        }
    }
    @Test fun missingOldestAckCannotRunPastTheSmallestReplayWindow() {
        val f = VideoTransportTest.Fixture(); val executor = Executors.newSingleThreadExecutor(); var sequence = 0
        try {
            val future = executor.submit { f.transport.continuous(
                { if (sequence < 8) nal(sequence++) else null }, { 4 }, { true }, 3, true, 1) }
            val first = (0 until 4).map { assertNotNull(f.records.poll(2, TimeUnit.SECONDS)) }
            for (record in first.drop(1)) for (side in 1..2) f.ack(record, side)
            assertEquals(null, f.records.poll(80, TimeUnit.MILLISECONDS))
            // A retry of sequence zero still has its bytes in the four-slot cache.
            for (side in 1..2) f.ack(first[0], side)
            val rest = (0 until 4).map { assertNotNull(f.records.poll(2, TimeUnit.SECONDS)) }
            for (record in rest) for (side in 1..2) f.ack(record, side)
            future.get(2, TimeUnit.SECONDS)
        } finally { f.transport.retire("end"); executor.shutdownNow() }
    }
    @Test fun peerRefusalAndEpochRetirementNeverTurnIntoAnImplicitSuccess() {
        for (retire in listOf(false, true)) {
            val f = VideoTransportTest.Fixture(); val executor = Executors.newSingleThreadExecutor(); var sent = false
            try {
                val future = executor.submit { f.transport.continuous(
                    { if (sent) null else nal(0).also { sent = true } }, { 4 }, { true }, 3, true, 1) }
                val record = assertNotNull(f.records.poll(2, TimeUnit.SECONDS))
                if (retire) f.transport.retire("seek generation")
                else { f.ack(record, 1); f.ack(record, 2, success = false) }
                assertFails { future.get(2, TimeUnit.SECONDS) }
                assertEquals(3, f.transport.windowSize())
            } finally { f.transport.retire("end"); executor.shutdownNow() }
        }
    }
}

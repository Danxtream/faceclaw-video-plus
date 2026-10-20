package com.faceclaw.app

import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoTransportTest {
    @Test fun flowRefillsBeforeBatchDrainAndFencesPauseOnBothIngresses() {
        for(left in listOf(true,false)) {
            val f=Fixture();val worker=Executors.newSingleThreadExecutor()
            var sent=0;var keep=true;val grants=mutableListOf<Int>()
            try {
                val result=worker.submit {
                    f.transport.flow({if(sent<12) nal(sent++).also{it[1]=28} else null},
                        {seq,_,_->grants.add(seq)},{keep},VideoMeasurement(),left,1)
                }
                val first=List(3){f.records.poll(1,TimeUnit.SECONDS)!!}
                assertEquals(null,f.records.poll(30,TimeUnit.MILLISECONDS))
                f.ack(first[0],1);f.ack(first[0],2)
                val fourth=f.records.poll(1,TimeUnit.SECONDS)!!
                assertEquals(3,VideoUploadEngine.word(fourth.payload,6))
                // Fourth is submitted before the other two initial records ACK.
                keep=false;f.ack(fourth,1);f.ack(fourth,2)
                assertFalse(result.isDone)
                for(r in first.drop(1)){f.ack(r,1);f.ack(r,2)}
                result.get(1,TimeUnit.SECONDS)
                assertEquals(4,sent);assertEquals(4,grants.size)
                f.respond={r->f.ack(r,1);f.ack(r,2)}
                assertContentEquals(intArrayOf(3),f.transport.sendWindow(arrayOf(nal(20)),3,left))
            } finally {worker.shutdownNow()}
        }
    }

    @Test fun flowCannotHideRefusalDisconnectOrReplayIdentity() {
        for(left in listOf(true,false)) {
            val f=Fixture();var sent=0
            f.respond={r->f.ack(r,1);f.ack(r,2,success=false)}
            assertFails { f.transport.flow({if(sent++==0)nal(0).also{it[1]=28}else null},
                {_,_,_->error("No refused grant")},{true},VideoMeasurement(),left,1) }
            val retired=Fixture();val worker=Executors.newSingleThreadExecutor()
            try {
                var next=0
                val result=worker.submit {retired.transport.flow({nal(next++).also{it[1]=28}},
                    {_,_,_->},{true},VideoMeasurement(),left,1)}
                retired.records.poll(1,TimeUnit.SECONDS)!!
                retired.transport.retire("seek")
                assertFails {result.get(1,TimeUnit.SECONDS)}
            }finally{worker.shutdownNow()}
        }
    }

    private fun query(id: Int) = byteArrayOf(31, 25, 1, 0, id.toByte(), 0, 0, 0)
    private fun answer(f: Fixture, record: VideoSubmission, left: Boolean) {
        val id = VideoUploadEngine.word(record.payload, 4)
        for (side in 1..2) { f.page(id, side, 0, 1, byteArrayOf(1, 25, 0, side.toByte(), 0, 0), left); f.ack(record, side) }
    }

    @Test fun statusQueryRidesInARunningFlowWithoutDrainingItOrExceedingThree() {
        for (left in listOf(true, false)) {
            val f = Fixture(); val worker = Executors.newFixedThreadPool(2)
            var sent = 0; var keep = true; val nals = mutableListOf<VideoSubmission>()
            f.respond = { record ->
                if (record.payload[1].toInt() == 25) {
                    // Two video records at most share the window with the query.
                    assertTrue(synchronized(nals) { nals.count { !it.delivered } } <= 2)
                    answer(f, record, left)
                } else synchronized(nals) { nals.add(record) }
            }
            try {
                val flow = worker.submit { f.transport.flow({ if (keep) nal(sent++).also { it[1] = 28 } else null },
                    { _, _, _ -> }, { keep }, VideoMeasurement(), left, 1) }
                val first = List(3) { f.records.poll(1, TimeUnit.SECONDS)!! }
                val reply = worker.submit<Array<ByteArray>> { f.transport.exchange(query(90), 6, 3, left, 2) }
                assertEquals(null, f.records.poll(150, TimeUnit.MILLISECONDS), "The window is full until one ACK")
                f.ack(first[0], 1); f.ack(first[0], 2)
                assertEquals(25, f.records.poll(1, TimeUnit.SECONDS)!!.payload[1].toInt(), "The freed slot goes to the query")
                assertEquals(2, reply.get(1, TimeUnit.SECONDS).size)
                assertFalse(flow.isDone, "The flow kept running through the query")
                // The flow refills the query's slot and keeps going.
                assertEquals(28, f.records.poll(1, TimeUnit.SECONDS)!!.payload[1].toInt())
                keep = false
                while (!flow.isDone) {
                    synchronized(nals) { nals.filter { !it.delivered } }.forEach { f.ack(it, 1); f.ack(it, 2) }
                    Thread.sleep(5)
                }
                flow.get(1, TimeUnit.SECONDS)
            } finally { worker.shutdownNow() }
        }
    }

    @Test fun writerAndNextQueryWaitForARiderInsteadOfFailing() {
        for (left in listOf(true, false)) {
            val f = Fixture(); val worker = Executors.newFixedThreadPool(2)
            var sent = 0
            f.respond = null
            try {
                val flow = worker.submit { f.transport.flow({ if (sent == 0) nal(sent++).also { it[1] = 28 } else null },
                    { _, _, _ -> }, { true }, VideoMeasurement(), left, 1) }
                val video = f.records.poll(1, TimeUnit.SECONDS)!!
                val reply = worker.submit<Array<ByteArray>> { f.transport.exchange(query(91), 6, 3, left, 2) }
                val rider = f.records.poll(1, TimeUnit.SECONDS)!!
                assertEquals(25, rider.payload[1].toInt())
                f.ack(video, 1); f.ack(video, 2); flow.get(1, TimeUnit.SECONDS)
                // The flow has ended but the rider's record is still unacknowledged.
                f.respond = { record -> f.ack(record, 1); f.ack(record, 2) }
                val batch = worker.submit<IntArray> { f.transport.pipeline(arrayOf(nal(5)), arrayOf(null), 3, left) }
                assertEquals(null, f.records.poll(50, TimeUnit.MILLISECONDS), "The batch waits for the rider's record")
                assertFalse(batch.isDone)
                f.ack(rider, 1); f.ack(rider, 2)
                assertContentEquals(intArrayOf(1, 0), batch.get(1, TimeUnit.SECONDS))
                // The rider still holds the single reply slot: a fenced query waits for it.
                f.respond = { record -> answer(f, record, left) }
                val next = worker.submit<Array<ByteArray>> { f.transport.exchange(query(92), 6, 3, left, 2) }
                Thread.sleep(50)
                assertFalse(next.isDone)
                for (side in 1..2) f.page(91, side, 0, 1, byteArrayOf(1, 25, 0, side.toByte(), 0, 0), left)
                assertEquals(2, reply.get(1, TimeUnit.SECONDS).size)
                assertEquals(2, next.get(1, TimeUnit.SECONDS).size)
            } finally { worker.shutdownNow() }
        }
    }

    @Test fun overtakenQueryTakesAFreshRequestNumberAtItsTurn() {
        for (left in listOf(true, false)) {
            val f = Fixture(); var fresh = 200L
            f.transport.requestReserve = { fresh++ }
            f.respond = { record -> answer(f, record, left) }
            assertEquals(2, f.transport.exchange(query(95), 6, 3, left, 2).size)
            // Reserved before 95 was sent: the lenses would refuse 90 as a replay.
            assertEquals(2, f.transport.exchange(query(90), 6, 3, left, 2).size)
            val ids = generateSequence { f.records.poll() }.map { VideoUploadEngine.word(it.payload, 4) }.toList()
            assertEquals(listOf(95L, 200L), ids)
        }
    }

    @Test fun refusedRiderWithoutAReplyFreesTheReplySlotQuickly() {
        for (left in listOf(true, false)) {
            val f = Fixture(); val worker = Executors.newFixedThreadPool(2); var keep = true; var sent = 0
            try {
                val flow = worker.submit { f.transport.flow({ if (keep && sent == 0) nal(sent++).also { it[1] = 28 } else null },
                    { _, _, _ -> }, { keep }, VideoMeasurement(), left, 1) }
                val video = f.records.poll(1, TimeUnit.SECONDS)!!
                // Both lenses refuse the rider and freeze no reply, as for a replayed number.
                f.respond = { record -> f.ack(record, 1, success = false); f.ack(record, 2, success = false) }
                val began = System.nanoTime()
                assertFailsWith<VideoQueryUnavailable> { f.transport.exchange(query(97), 6, 3, left, 2) }
                assertTrue(System.nanoTime() - began < 1_500_000_000L, "A refused rider must not hold the reply slot for its full deadline")
                f.respond = null; keep = false
                f.ack(video, 1); f.ack(video, 2); flow.get(1, TimeUnit.SECONDS)
            } finally { worker.shutdownNow() }
        }
    }

    @Test fun retirementFailsAWaitingRiderAndItsFlow() {
        for (left in listOf(true, false)) {
            val f = Fixture(); val worker = Executors.newFixedThreadPool(2); var sent = 0
            try {
                val flow = worker.submit { f.transport.flow({ nal(sent++).also { it[1] = 28 } },
                    { _, _, _ -> }, { true }, VideoMeasurement(), left, 1) }
                repeat(3) { f.records.poll(1, TimeUnit.SECONDS)!! }
                val reply = worker.submit<Array<ByteArray>> { f.transport.exchange(query(93), 6, 3, left, 2) }
                Thread.sleep(30)
                f.transport.retire("seek")
                assertFails { reply.get(1, TimeUnit.SECONDS) }
                assertFails { flow.get(1, TimeUnit.SECONDS) }
            } finally { worker.shutdownNow() }
        }
    }

    @Test fun metadataPipelineAcceptsSixRoomsButNotSevenOnBothIngresses() {
        for (left in listOf(true, false)) for (room in listOf(6, 7)) {
            val f = Fixture()
            f.respond = { record -> for (side in 1..2) {
                if (record.payload[1].toInt() == 14)
                    f.page(102, side, 0, 1, byteArrayOf(2, 0, 0, 0, room.toByte(), 0), left)
                f.ack(record, side)
            } }
            if (room == 6) assertContentEquals(intArrayOf(1, 1), f.transport.pipeline(arrayOf(nal(1)), arrayOf(metadata(2)), 3, left))
            else assertFails { f.transport.pipeline(arrayOf(nal(1)), arrayOf(metadata(2)), 3, left) }
        }
    }

    @Test fun diagnosticIdsCannotOvertakePreallocatedMetadataInsideTheUploadPipeline() {
        val f = Fixture(); var identity = 1000L; var high = 0L; var once = true
        val events = mutableListOf<String>()
        f.transport.evidenceReserve = { identity++ }
        f.respond = { record ->
            val op = record.payload[1].toInt()
            val id = if (op == 6) 0 else VideoUploadEngine.word(record.payload, 4)
            if (op == 14 || op == 7) { assertTrue(id > high); high = id; events.add("$op:$id") }
            for (side in 1..2) if (record.targets and side != 0) {
                val refuse = op == 5 && side == 1 && once
                if (refuse) once = false
                if (op == 14 || op == 5) {
                    val raw = byteArrayOf((id - 100).toByte(), 0, 0, 0, 1, 0)
                    val page = if (op == 5) record.payload[8].toInt() else 0
                    if (!refuse) f.page(id, side, page, 2, raw.copyOfRange(page * 3, page * 3 + 3), true)
                } else if (op == 7) {
                    val raw = ByteArray(128); raw[0] = 1; raw[1] = 7; raw[3] = 4; raw[4] = 1
                    raw[5] = 1; raw[6] = side.toByte(); raw[16] = 24
                    f.page(id, side, 0, 1, raw, true)
                }
                f.ack(record, side, success = !refuse)
            }
        }
        assertContentEquals(intArrayOf(2, 2), f.transport.pipeline(arrayOf(nal(1), nal(2)),
            arrayOf(metadata(2), metadata(3)), 3, true))
        assertEquals(listOf("14:102", "14:103", "7:1000"), events)
    }
    @Test fun refusalEvidenceIsFetchedAfterParentFenceWithoutRecursiveFetchOrMaskedFailure() {
        for (left in listOf(true, false)) for (diagnosticRefused in listOf(false, true)) {
            val f = Fixture(); var next = 80L; var diagnostics = 0; var parentAttempts = 0
            f.transport.evidenceReserve = { next++ }
            val log = java.io.ByteArrayOutputStream(); val previous = System.err
            System.setErr(java.io.PrintStream(log))
            f.respond = { record ->
                val diagnostic = record.payload[1].toInt() == 7
                val fetch = record.payload[1].toInt() == 5
                val id = VideoUploadEngine.word(record.payload, 4)
                if (diagnostic) {
                    diagnostics++; assertEquals(4, parentAttempts)
                    assertEquals(4, record.payload[8].toInt()); assertEquals(if (left) 0 else 1, record.payload[9].toInt())
                }
                for (side in 1..2) if (record.targets and side != 0) {
                    val refuse = fetch || diagnostic && diagnosticRefused
                    if (fetch) parentAttempts++
                    if (!fetch) {
                        if (diagnostic) {
                            val raw = ByteArray(128); raw[0] = 1; raw[1] = 7; raw[3] = 4; raw[4] = 1
                            raw[5] = if (left) 1 else 2; raw[6] = side.toByte(); raw[7] = 1; raw[16] = 24
                            raw[44] = 15; raw[45] = 1; raw[46] = 7
                            if (diagnosticRefused) { raw[2] = 3; raw[7] = 0 }
                            f.page(id, side, 0, 1, raw, left)
                        } else f.page(id, side, 0, 2, byteArrayOf(1, 7, 0), left)
                    }
                    f.ack(record, side, success = !refuse)
                }
            }
            try {
                val error = assertFailsWith<VideoQueryUnavailable> {
                    f.transport.exchange(byteArrayOf(31,15,1,0,70,0,0,0), 6, 1, left, 2)
                }
                assertTrue(error.message!!.contains("op=15 request=70")); assertEquals(1, diagnostics)
                assertTrue(log.toString().contains(if (diagnosticRefused) "evidence unavailable side=1" else "reason=send failure"))
            } finally { System.setErr(previous) }
            f.transport.retire("disconnect"); assertEquals(null, f.transport.evidenceReserve)
        }
    }
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
                size: Int = record.payload.size, checksum: Int = CfwTransport.crc(record.payload), attempt: Int = record.message!!.magic,
                room: ByteArray? = null) {
            val body = byteArrayOf(if (!success) 3 else if (room == null) 1 else 5, attempt.toByte(), 0, 0, side.toByte(),
                size.toByte(), (size shr 8).toByte(), checksum.toByte(), (checksum shr 8).toByte()) + (room ?: byteArrayOf())
            assertEquals(room != null, transport.receive(left, packet(body)))
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

    @Test fun roomConfirmationUsesBothExactPrimaryAttemptsAndIsSingleUse() {
        for (left in listOf(true, false)) for (missing in listOf(false, true)) {
            val f = Fixture()
            f.respond = { record ->
                f.ack(record, 1, room = byteArrayOf(0, 0, 0, 0, 43, 96))
                f.ack(record, 2, room = if (missing) null else byteArrayOf(0, 0, 0, 0, 42, 64))
            }
            val record = nal(0).also { it[1] = 28 }
            assertContentEquals(intArrayOf(1, 0), f.transport.pipeline(arrayOf(record), arrayOf(null), 3, left))
            val rows = f.transport.takeConfirmationCredits()
            if (missing) assertEquals(null, rows) else {
                assertEquals(listOf(43, 42), rows!!.map { it[4].toInt() })
                assertEquals(listOf(96, 64), rows.map { it[5].toInt() })
            }
            assertEquals(null, f.transport.takeConfirmationCredits())
            f.transport.retire("seek"); assertEquals(null, f.transport.takeConfirmationCredits())
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

    @Test fun flaggedCreditRepliesCarryTimelineRoomBesideAnAcceptedResult() {
        for (code in listOf(0, 2)) {
            val f = Fixture()
            f.respond = { record -> for (side in 1..2) {
                f.page(105, side, 0, 1, byteArrayOf(4, 0, 0, 0, 46, ((3 shl 5) or code).toByte()), true)
                f.ack(record, side) // An accepted ACK must agree with a zero 5-bit code.
            } }
            val request = byteArrayOf(31, 10, 1, 0, 105, 0, 0, 0, 50, 0, 0, 0, 101, 0, 0, 0, 102, 0, 0, 0, 1, 0, 0, 0)
            if (code == 0) assertEquals(listOf(3 shl 5, 3 shl 5), f.transport.exchange(request, 6, 3, true, 5).map { it[5].toInt() and 255 })
            else assertFails { f.transport.exchange(request, 6, 3, true, 5) }
        }
        // The plain 20-byte request still requires a zero result byte with an accepted ACK.
        val f = Fixture()
        f.respond = { record -> for (side in 1..2) {
            f.page(106, side, 0, 1, byteArrayOf(4, 0, 0, 0, 46, (3 shl 5).toByte()), true); f.ack(record, side)
        } }
        assertFails { f.transport.exchange(byteArrayOf(31, 10, 1, 0, 106, 0, 0, 0, 50, 0, 0, 0, 101, 0, 0, 0, 102, 0, 0, 0), 6, 3, true, 5) }
    }

    @Test fun timedNalRecordsUseTheirOwnHeaderAndCannotCarryFollowingMetadata() {
        val f = Fixture()
        f.respond = { record -> f.ack(record, 1); f.ack(record, 2) }
        val timed = byteArrayOf(31, 24, 50, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 63, 0, 0, 0, 0x65)
        assertContentEquals(intArrayOf(1, 0), f.transport.pipeline(arrayOf(timed), arrayOf(null), 3, true))
        assertEquals(24, f.records.poll()!!.payload[1].toInt())
        assertFailsWith<IllegalArgumentException> { f.transport.pipeline(arrayOf(timed.copyOf(18)), arrayOf(null), 3, true) }
        assertFailsWith<IllegalArgumentException> { f.transport.pipeline(arrayOf(timed), arrayOf(metadata(2)), 3, true) }
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

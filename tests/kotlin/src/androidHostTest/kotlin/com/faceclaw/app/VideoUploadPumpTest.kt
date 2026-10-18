package com.faceclaw.app

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.nio.ByteBuffer
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoUploadPumpTest {
    @Test fun failureEvidenceSurvivesRefusedPipelineAndBoundsHistory() {
        for (timed in listOf(false, true)) {
            val config = if (timed) timedPlan() else plan()
            val engine = VideoUploadEngine(config, 8, { "hello".toByteArray() }, { 1 }, {},
                { command -> if (command[1].toInt() == 10) arrayOf(reply(0, 46, if (timed) 6 shl 5 else 0), reply(0, 46, if (timed) 6 shl 5 else 0))
                    else arrayOf(reply(word(command, 12), 6), reply(word(command, 12), 6)) },
                { _, _ -> error("refused") })
            assertFails { engine.step() }
            val rows = engine.evidenceRows()
            assertTrue(rows.isNotEmpty())
            assertEquals(0, rows[0].sequence)
            assertEquals(1335831723L, rows[0].checksum)
            assertEquals(5, rows[0].length)
            assertTrue(engine.evidence().contains("\"checksum\":1335831723"))
        }
        var sent = 0
        val engine = VideoUploadEngine(plan(96), 96, { byteArrayOf(0x61) }, { 1 }, {},
            { command -> if (command[1].toInt() == 10) arrayOf(reply(sent.toLong(), 46), reply(sent.toLong(), 46))
                else arrayOf(reply(word(command, 12), 1), reply(word(command, 12), 1)) },
            { records, following -> sent += records.size; intArrayOf(records.size, following.count { it != null }) })
        while (!engine.done) engine.step()
        val rows = engine.evidenceRows()
        assertEquals(64, rows.size); assertEquals(32, rows[0].sequence)
        assertEquals(95, rows[63].sequence)
    }
    @Test fun sixTimedRoomsUseFourThenTwoAndRespectTheSmallerPeer() {
        for ((peer, wanted) in listOf(6 to 6, 4 to 4, 2 to 2)) {
            var sent = 0; var queries = 0
            val batches = mutableListOf<Int>()
            val engine = VideoUploadEngine(timedPlan(), 8, { byteArrayOf(0x65) }, { 1 }, {},
                { _ -> queries++; arrayOf(reply(sent.toLong(), 46, 6 shl 5), reply(sent.toLong(), 46, peer shl 5)) },
                { records, following ->
                    assertTrue(following.all { it == null }); batches.add(records.size); sent += records.size
                    intArrayOf(records.size, 0)
                })
            while (engine.index < wanted) assertTrue(engine.step())
            assertEquals(wanted, engine.index); assertEquals(1, queries)
            assertEquals(if (peer == 6) listOf(4, 2) else listOf(peer), batches)
            assertEquals(0, engine.pictureBudget)
        }
        val bad = arrayOf(reply(0, 46, 7 shl 5), reply(0, 46, 6 shl 5))
        val engine = VideoUploadEngine(timedPlan(), 8, { error("Uncredited read") }, { 1 }, {}, { bad },
            { _, _ -> error("Uncredited upload") })
        assertFalse(engine.offerCredits(50, longArrayOf(101, 102), 0, bad, 0))
        assertFails { engine.step() }
    }

    @Test fun oversizedTimedNalAcceptsSixMetadataRoomsButRejectsSeven() {
        for (room in listOf(6, 7)) {
            var sent = 0
            val engine = VideoUploadEngine(timedPlan(), 8, { ByteArray(4079) { 0x65 } }, { 1 }, {},
                { command -> if (command[1].toInt() == 10) arrayOf(reply(0, 46, 6 shl 5), reply(0, 46, 6 shl 5))
                    else arrayOf(reply(word(command, 12), room), reply(word(command, 12), room)) },
                { records, _ -> sent += records.size; intArrayOf(records.size, 0) })
            if (room == 6) { assertTrue(engine.step()); assertEquals(1, sent) }
            else { assertFails { engine.step() }; assertEquals(0, sent) }
        }
    }

    @Test fun conservativeCreditReuseLatencyModelReportsRateStarvationAndFenceCost() {
        data class Result(val rate: Double, val queries: Int, val inputDryMs: Double, val fenceMs: Double)
        fun measure(legacy: Boolean): Result {
            var now=0.0;var completed=0;var accepted=0;var nextDone=Double.POSITIVE_INFINITY
            var dry=0.0;var maxFence=0.0;var queries=0;var id=1L
            fun advance(ms: Double) {
                val end=now+ms
                while(nextDone<=end) {
                    now=nextDone;completed++
                    nextDone=if(completed<accepted)now+58 else Double.POSITIVE_INFINITY
                }
                if(completed==accepted)dry+=end-now
                now=end
            }
            fun credits(): Array<ByteArray> {
                queries++
                val free=6-(accepted-completed)
                check(free in 0..6)
                val row=reply(completed.toLong(),40+if(legacy)minOf(4,free)else free)
                advance(38.0)
                return arrayOf(row,row)
            }
            val engine=VideoUploadEngine(plan(96),96,{advance(3.0);byteArrayOf(0x61)},{id++},{},
                {command->if(command[1].toInt()==10)credits()else {
                    advance(38.0);val row=reply(word(command,12),1);arrayOf(row,row)
                }},
                {records,following->
                    val began=now
                    records.forEachIndexed{i,record->
                        assertEquals(accepted.toLong(),word(record,6))
                        advance(listOf(9.0,12.0,15.0)[accepted%3])
                        if(accepted++==completed)nextDone=now+58
                        check(accepted-completed<=6)
                        if(following[i]!=null)advance(listOf(30.0,38.0,45.0)[accepted%3])
                    }
                    advance(38.0)
                    maxFence=maxOf(maxFence,now-began)
                    intArrayOf(records.size,following.count{it!=null})
                },VideoMeasurement{(now*1_000_000).toLong()})
            var due=1500.0
            while(!engine.done) {
                if(now>=due) {
                    engine.invalidateCredits();engine.refreshCredits()
                    val rows=credits()
                    if(!legacy)assertTrue(engine.offerCredits(50,longArrayOf(101,102),engine.index,rows,38))
                    engine.refreshCredits();due=now+1500
                }
                engine.step()
            }
            return Result(96_000/now,queries,dry,maxFence)
        }
        val before=measure(true);val after=measure(false)
        println("D1 latency model NAL/s before=${before.rate} after=${after.rate}; credit requests=${before.queries}->${after.queries}; input-dry ms=${before.inputDryMs}->${after.inputDryMs}; max batch fence ms=${before.fenceMs}->${after.fenceMs}; writes9/12/15ms, ACK30/38/45ms, service58ms; not a phone FPS prediction")
        assertTrue(after.queries<before.queries);assertTrue(after.rate>=before.rate)
        assertTrue(after.inputDryMs<=before.inputDryMs)
        assertTrue(after.fenceMs<=4*(15+45)+38)
    }
    @Test fun handoffIsPairedExactPositionOneUseAndConservesPartiallySpentGrant() {
        var now = 1_000_000_000L; var id = 1L; var queries = 0; var sent = 0; var capacity = 6
        val batches = mutableListOf<Int>()
        val engine = VideoUploadEngine(plan(12), 12, { byteArrayOf(0x61) }, { id++ }, {},
            { command ->
                val row = if (command[1].toInt() == 10) {
                    queries++; reply(sent.toLong(), 32 + if(capacity == 6) 14 else 4)
                } else reply(word(command,12),1)
                arrayOf(row,row)
            }, { records, following ->
                batches.add(records.size); sent += records.size
                intArrayOf(records.size, following.count { it != null })
            }, VideoMeasurement { now })
        val rows = arrayOf(reply(0,46),reply(0,46))
        assertTrue(engine.offerCredits(50,longArrayOf(101,102),0,rows,40))
        rows[0][4] = 0 // The handed-off reply is immutable.
        engine.refreshCredits(); assertEquals(6,engine.budget)
        engine.step(); assertEquals(2,engine.budget)
        engine.step(); assertEquals(listOf(4,2),batches); assertEquals(0,queries)
        // The exact same snapshot cannot be spent a second time.
        assertFalse(engine.offerCredits(50,longArrayOf(101,102),0,arrayOf(reply(0,46),reply(0,46)),0))
        capacity = 4; engine.refreshCredits(); engine.step()
        assertEquals(1,queries); assertEquals(10,engine.index)
    }

    @Test fun mismatchedStaleRefusedUncertainOrRetiredHandoffsNeverCreateCredits() {
        var now = 1_000_000_000L; var live = true; var safe = true; var queries = 0
        val engine = VideoUploadEngine(plan(),8,{byteArrayOf(0x61)},{1},{check(live)},
            { command ->
                val row = if(command[1].toInt()==10) {queries++;reply(0,33)} else reply(word(command,12),1)
                arrayOf(row,row)
            },{records,following->intArrayOf(records.size,following.count{it!=null})},
            VideoMeasurement {now}, {safe})
        val good = arrayOf(reply(0,46),reply(0,46))
        assertFalse(engine.offerCredits(49,longArrayOf(101,102),0,good,0))
        assertFalse(engine.offerCredits(50,longArrayOf(101,103),0,good,0))
        assertFalse(engine.offerCredits(50,longArrayOf(101,102),1,good,0))
        assertFalse(engine.offerCredits(50,longArrayOf(101,102),0,good,501))
        assertFalse(engine.offerCredits(50,longArrayOf(101,102),0,arrayOf(good[0]),0))
        for (bad in listOf(reply(0,46,8),reply(0,174),reply(1,46),reply(0,47),ByteArray(5))) {
            assertFalse(engine.offerCredits(50,longArrayOf(101,102),0,arrayOf(good[0],bad),0))
        }
        safe=false; assertFalse(engine.offerCredits(50,longArrayOf(101,102),0,good,0)); safe=true
        assertTrue(engine.offerCredits(50,longArrayOf(101,102),0,good,0))
        now += 501_000_000; engine.refreshCredits(); assertEquals(0,engine.budget)
        assertTrue(engine.offerCredits(50,longArrayOf(101,102),0,good,0))
        safe=false;engine.refreshCredits();assertEquals(0,engine.budget);safe=true
        assertTrue(engine.offerCredits(50,longArrayOf(101,102),0,good,0))
        engine.invalidateCredits();engine.refreshCredits();assertEquals(0,engine.budget)
        live=false;assertFails{engine.offerCredits(50,longArrayOf(101,102),0,good,0)}
        assertFails{engine.refreshCredits()};live=true
        engine.step();assertEquals(1,queries);assertEquals(1,engine.index)
    }

    @Test fun mixedLensCapacitiesAndOccupiedSlotsUseTheSmallerConservativeGrant() {
        for ((rows,wanted) in listOf(
            arrayOf(reply(0,46),reply(0,36)) to 4,
            arrayOf(reply(0,46),reply(0,42)) to 2,
            arrayOf(reply(0,40),reply(0,46)) to 0)) {
            val engine=VideoUploadEngine(plan(),8,{byteArrayOf(0x61)},{1},{},{rows},
                {_,_->error("No upload in this test")})
            assertTrue(engine.offerCredits(50,longArrayOf(101,102),0,rows,0))
            engine.refreshCredits();assertEquals(wanted,engine.budget)
        }
    }

    @Test fun reportHandoffCannotCrossAnUnfencedPumpOrAControlFence() {
        // The same fenced handoff is spent on resume, unless a control fence came first.
        for (invalidate in listOf(false, true)) {
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        var queries=0
        val engine=VideoUploadEngine(plan(),8,{byteArrayOf(0x61)},{1},{},
            {command->val row=if(command[1].toInt()==10){queries++;reply(0,33)}else reply(word(command,12),1);arrayOf(row,row)},
            {records,following->entered.countDown();check(release.await(2,TimeUnit.SECONDS));intArrayOf(records.size,following.count{it!=null})})
        val pump=VideoUploadPump{engine}
        fun fence(){val until=System.nanoTime()+2_000_000_000L;while(pump.uploadSnapshot().contains("\"running\":true")){check(System.nanoTime()<until);Thread.sleep(1)}}
        val raw=ByteBuffer.wrap(reply(0,33)+reply(0,33))
        try {
            fence()
            assertTrue(pump.offerCreditSnapshot(raw,50,101,102,0,0))
            if (invalidate) pump.pauseUpload() // Another control invalidates the proposed handoff.
            pump.resumeUpload();assertTrue(entered.await(1,TimeUnit.SECONDS))
            assertFails{pump.offerCreditSnapshot(raw,50,101,102,0,0)}
            pump.pauseUpload();release.countDown();fence()
            assertEquals(if (invalidate) 1 else 0,queries);assertEquals(1,engine.index)
        } finally {release.countDown();pump.pauseUpload();fence();pump.closeUpload()}
        }
    }
    @Test fun sixSlotGrantIsSpentAsFourThenTwoWithoutAnExtraQuery() {
        var id = 1L; var sent = 0; var queries = 0
        val batches = mutableListOf<Int>()
        val engine = VideoUploadEngine(plan(12), 12, { byteArrayOf(0x61) }, { id++ }, {},
            { command ->
                val row = if (command[1].toInt() == 10) {
                    queries++; reply(sent.toLong(), 46)
                } else reply(word(command, 12), 1)
                arrayOf(row, row)
            }, { records, following ->
                batches.add(records.size); sent += records.size
                intArrayOf(records.size, following.count { it != null })
            })
        engine.step(); engine.step()
        assertEquals(listOf(4, 2), batches)
        assertEquals(1, queries)
        assertEquals(6, engine.index)
        assertEquals(0, engine.budget)
    }
    private fun word(bytes: ByteArray, at: Int) = VideoUploadEngine.word(bytes, at)
    private fun reply(expected: Long, packed: Int = 36, error: Int = 0) = ByteArray(6).also {
        VideoUploadEngine.put(it, 0, expected); it[4] = packed.toByte(); it[5] = error.toByte()
    }
    private fun plan(count: Int = 8) = VideoUploadPlan(50, longArrayOf(101, 102), intArrayOf(), 0, count,
        (0 until count).map { VideoUploadPicture(it, it * 63L) })
    private fun timedPlan(count: Int = 8) = plan(count).copy(timed = true)

    @Test fun timedPlanCarriesFrameTimesInVclNalsWithinTimelineRoomAndNoMetadataExchange() {
        var id = 1L; var sent = 0
        val queries = mutableListOf<ByteArray>(); val batches = mutableListOf<List<ByteArray>>()
        val engine = VideoUploadEngine(timedPlan(8), 8, { byteArrayOf(0x65, 1) }, { id++ }, {},
            { command -> queries.add(command); val row = reply(sent.toLong(), 46, 3 shl 5); arrayOf(row, row) },
            { records, following ->
                assertTrue(following.all { it == null }); batches.add(records.toList()); sent += records.size
                intArrayOf(records.size, 0)
            })
        assertTrue(engine.step())
        assertEquals(1, queries.size); assertEquals(10, queries[0][1].toInt())
        assertEquals(24, queries[0].size); assertEquals(1L, word(queries[0], 20))
        // Six NAL credits but room for three frame times: the fourth picture waits.
        assertEquals(3, batches[0].size); assertEquals(3, engine.metadata); assertEquals(0, engine.pictureBudget)
        batches[0].forEachIndexed { i, record ->
            assertEquals(24, record[1].toInt()); assertEquals(20, record.size)
            assertEquals(i.toLong(), word(record, 6)); assertEquals(i + 1L, word(record, 10)); assertEquals(i * 63L, word(record, 14))
        }
        assertTrue(engine.step())
        assertEquals(2, queries.size); assertEquals(listOf(3L, 4L, 5L), batches[1].map { word(it, 6) })
        assertTrue(queries.none { it[1].toInt() == 14 })
    }

    @Test fun oversizedVclNalAdmitsItsFrameTimeSeparatelyThenTimedRecordsResume() {
        var id = 1L; var sent = 0
        val ops = mutableListOf<Int>(); val records = mutableListOf<ByteArray>()
        val engine = VideoUploadEngine(timedPlan(3), 3, { i -> if (i == 0) ByteArray(4079) { 0x65 } else byteArrayOf(0x41) },
            { id++ }, {},
            { command ->
                ops.add(command[1].toInt())
                val row = if (command[1].toInt() == 10) reply(sent.toLong(), 46, 4 shl 5) else reply(word(command, 12), 1)
                arrayOf(row, row)
            }, { batch, _ -> records.addAll(batch); sent += batch.size; intArrayOf(batch.size, 0) })
        assertTrue(engine.step()); assertTrue(engine.step())
        assertEquals(listOf(10, 14), ops)
        assertEquals(6, records[0][1].toInt()); assertEquals(4089, records[0].size)
        assertEquals(listOf(24, 24), records.drop(1).map { it[1].toInt() })
        assertEquals(2L, word(records[1], 10)); assertEquals(3, engine.index); assertEquals(3, engine.metadata)
    }

    @Test fun timedNalWaitsWhileEitherLensReportsNoTimelineRoomAndRejectsCodeBits() {
        var room = 0; var queries = 0; var batches = 0
        val engine = VideoUploadEngine(timedPlan(4), 4, { byteArrayOf(0x65) }, { 1 }, {},
            { _ -> queries++; arrayOf(reply(0, 46, 2 shl 5), reply(0, 46, room shl 5)) },
            { batch, _ -> batches++; intArrayOf(batch.size, 0) })
        assertFalse(engine.step()); assertTrue(engine.blocked); assertEquals(0, batches); assertEquals(1, queries)
        room = 2; assertTrue(engine.step()); assertEquals(2, queries); assertEquals(1, batches); assertEquals(2, engine.index)
        val refused = VideoUploadEngine(timedPlan(4), 4, { byteArrayOf(0x65) }, { 1 }, {},
            { _ -> arrayOf(reply(0, 46, (3 shl 5) or 2), reply(0, 46, 3 shl 5)) }, { _, _ -> error("No upload") })
        assertFails { refused.step() }
    }

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

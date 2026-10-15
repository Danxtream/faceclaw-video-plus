package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class VideoMeasurementTest {
    @Test fun elapsedCountersIncludeFailedOperationsAndDoNotUseSampledBlockedShare() {
        var now = 0L
        val m = VideoMeasurement { now }
        m.time(VideoMeasurement.READ) { now += 5_000_000 }
        assertFails { m.time(VideoMeasurement.READ) { now += 12_000_000; error("read failed") } }
        m.add(VideoMeasurement.NALS, count = 3)
        val snapshot = m.snapshot()
        assertTrue(snapshot.contains("\"read\":{\"count\":2,\"totalMs\":17.0,\"maxMs\":12.0}"))
        assertTrue(snapshot.contains("\"nals\":{\"count\":3"))
    }
    @Test fun nativePumpMeasuresActualReadIdentityCreditAndBusyWaitSpansWithoutExtraRequests() {
        var now = 0L; var id = 1L; var queries = 0; var busy = true
        val m = VideoMeasurement { now }
        fun reply(expected: Long, result: Int = 0) = ByteArray(6).also {
            VideoUploadEngine.put(it, 0, expected); it[4] = 33; it[5] = result.toByte()
        }
        val plan = VideoUploadPlan(50, longArrayOf(1,2), intArrayOf(), 0, 2,
            listOf(VideoUploadPicture(0,0),VideoUploadPicture(1,63)))
        val e = VideoUploadEngine(plan, 2, {now += 7_000_000; byteArrayOf(0x61)},
            {now += 2_000_000; id++}, {}, { command ->
                queries++; now += 35_000_000
                if (command[1].toInt() == 10) arrayOf(reply(0),reply(0))
                else arrayOf(reply(1,if(busy)3 else 0),reply(1,if(busy)3 else 0)).also { rows ->
                    rows.forEach { it[4]=1 }; busy=false
                }
            }, { records,_ -> now += 45_000_000; intArrayOf(records.size,0)}, m)
        assertTrue(!e.step()); assertEquals(VideoMeasurement.BUSY,e.waitKind)
        assertEquals(2,queries); assertEquals(0,e.index)
        assertEquals(0L,e.leftConsumed);assertEquals(0L,e.rightConsumed)
        assertTrue(e.step());assertEquals(1,e.index)
        assertTrue(m.snapshot().contains("\"read\":{\"count\":1,\"totalMs\":7.0"))
        assertEquals(3,queries)
    }
}

package com.faceclaw.app

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class VideoIdentityTest {
    private class Store(var end: Long = 40, var succeeds: Boolean = true) : VideoIdentityStore {
        var saves = 0
        override fun read(): Long = end
        override fun save(reservedEnd: Long): Boolean { saves++; if (succeeds) end = reservedEnd; return succeeds }
    }
    @Test fun reservationsAreDurableBeforeUseAndRestartSkipsUnusedIds() {
        val store = Store()
        val range = VideoIdentityRange(store)
        assertEquals(40, range.reserve()); assertEquals(41, range.reserve())
        assertEquals(1064, store.end); assertEquals(1, store.saves)
        assertEquals(1064, VideoIdentityRange(store).reserve())
        val failed = Store(succeeds = false)
        assertFails { VideoIdentityRange(failed).reserve() }
        assertEquals(40, failed.end)
        failed.succeeds = true
        assertEquals(40, VideoIdentityRange(failed).reserve())
    }
    @Test fun concurrentReservationsDoNotDuplicateAndNeverWrap() {
        val store = Store()
        val range = VideoIdentityRange(store)
        val worker = Executors.newFixedThreadPool(4)
        try {
            val tasks = (1..1500).map { worker.submit<Long> { range.reserve() } }
            val values = tasks.map { it.get(5, TimeUnit.SECONDS) }
            assertEquals(1500, values.toSet().size)
            assertEquals(40, values.min()); assertEquals(1539, values.max())
            assertTrue(store.saves == 2)
        } finally { worker.shutdownNow() }
        val last = VideoIdentityRange(Store(0xfffffffdL))
        assertEquals(0xfffffffdL, last.reserve())
        assertFails { last.reserve() }
        assertFails { VideoIdentityRange(Store(0)).reserve() }
    }
}

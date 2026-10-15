package com.faceclaw.app

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal interface VideoIdentityStore {
    fun read(): Long
    fun save(reservedEnd: Long): Boolean
}

/** Unused reserved IDs are skipped after a process restart, never reused. */
internal class VideoIdentityRange(private val store: VideoIdentityStore) {
    private var next = 0L
    private var end = 0L
    @Synchronized fun reserve(): Long {
        if (next == end) {
            val first = store.read()
            require(first in 1..0xfffffffdL) { "Video request identity exhausted or invalid" }
            val limit = minOf(first + 1024, 0xfffffffeL)
            check(store.save(limit)) { "Could not durably reserve video request identities" }
            next = first; end = limit
        }
        return next++
    }
}

/** Dedicated video preferences and worker; upstream's settings store is unchanged. */
class VideoIdentityAllocator(private val context: Context, private val legacyNext: Long) {
    private var pending: Future<Long>? = null
    init { require(legacyNext in 1..0xfffffffdL) { "Invalid legacy video request identity" } }
    @Synchronized fun beginReserve() {
        check(pending == null) { "Video identity reservation already pending" }
        pending = worker.submit<Long> { reserveNow() }
    }

    /** Native writers consume the same durable block without a UI round trip. */
    internal fun reserveNow(): Long = synchronized(lock) {
        if (range == null) {
            val prefs = context.getSharedPreferences("faceclaw_video_identity", Context.MODE_PRIVATE)
            range = VideoIdentityRange(object : VideoIdentityStore {
                override fun read(): Long = prefs.getLong("reservedEnd", legacyNext)
                override fun save(reservedEnd: Long): Boolean = prefs.edit().putLong("reservedEnd", reservedEnd).commit()
            })
        }
        range!!.reserve()
    }
    @Synchronized fun poll(): Int = if (checkNotNull(pending).isDone) 1 else 0
    @Synchronized fun takeResult(): Long {
        val result = checkNotNull(pending)
        check(result.isDone)
        pending = null
        return result.get()
    }
    companion object {
        private val lock = Any()
        private var range: VideoIdentityRange? = null
        private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "video-identity").apply { isDaemon = true } }
    }
}

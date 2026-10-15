package com.faceclaw.app

/** Fixed counters only; elapsed brackets can overlap and are not exclusive CPU time. */
internal class VideoMeasurement(private val clock: () -> Long = System::nanoTime) {
    private val counts = LongArray(NAMES.size)
    private val total = LongArray(NAMES.size)
    private val maximum = LongArray(NAMES.size)
    private val began = clock()
    @Synchronized fun add(kind: Int, nanos: Long = 0, count: Long = 1) {
        val elapsed = maxOf(0, nanos)
        counts[kind] += count; total[kind] += elapsed
        maximum[kind] = maxOf(maximum[kind], elapsed)
    }
    inline fun <T> time(kind: Int, block: () -> T): T {
        val from = now()
        try { return block() } finally { add(kind, now() - from) }
    }
    fun now() = clock()
    @Synchronized fun snapshot(): String = buildString {
        append("{\"elapsedMs\":").append((clock() - began) / 1_000_000.0)
        // Keys are fixed internal identifiers; values are finite numeric counters.
        for (i in NAMES.indices) {
            append(",\"").append(NAMES[i]).append("\":{\"count\":").append(counts[i])
            append(",\"totalMs\":").append(total[i] / 1_000_000.0)
            append(",\"maxMs\":").append(maximum[i] / 1_000_000.0).append('}')
        }
        append('}')
    }
    companion object {
        const val READ = 0; const val IDENTITY = 1; const val PIPELINE = 2
        const val CREDITS = 3; const val METADATA = 4; const val ZERO_CREDIT = 5
        const val BUSY = 6; const val NALS = 7; const val BYTES = 8
        const val QUEUE = 9; const val ACK = 10; const val QUERY = 11
        const val PAGE = 12; const val REFUSAL = 13; const val FAILURE = 14
        const val BUILD = 15
        const val REPLY_WAIT = 16; const val REPLY_BYTES = 17; const val PLANNED_PAGES = 18
        val NAMES = arrayOf("read", "identity", "pipeline", "credits", "metadata", "creditWait",
            "metadataWait", "nals", "bytes", "queueToWrite", "writeToAck", "query", "pageFetch",
            "refusal", "failure", "build", "pageReplyWait", "replyBytes", "declaredPages")
    }
}

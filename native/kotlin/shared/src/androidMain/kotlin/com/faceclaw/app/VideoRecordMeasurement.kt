package com.faceclaw.app

/** One bounded generation, separate from lifetime transport and pump counters. */
internal class VideoRecordMeasurement(private val clock: () -> Long = System::nanoTime) {
    private class Scope(val stream: Long, val epoch: Long, val at: Long) {
        val rows = Array(KINDS.size) { LongArray(11) }
    }
    internal class Ticket internal constructor(internal val scope: Any, internal val kind: Int,
        internal val queued: Long) {
        internal var written: Long? = null
        internal var acknowledged = false
        internal var closed = false
    }
    private var scope: Scope? = null
    @Synchronized fun begin(stream: Long, epoch: Long) { scope = Scope(stream, epoch, clock()) }
    @Synchronized fun queued(payload: ByteArray, epoch: Long, parentOp: Int): Ticket? {
        val s = scope ?: return null
        if (epoch != s.epoch) return null
        val op = payload[1].toInt() and 255
        val offset = when (op) { 6 -> 2; 10, 14 -> 8; else -> -1 }
        if (offset >= 0 && (payload.size < offset + 4 || VideoUploadEngine.word(payload, offset) != s.stream)) return null
        val kind = when (op) { 6 -> 0; 14 -> 1; 10 -> 2
            5 -> when (parentOp) { 14 -> 3; 10 -> 4; else -> 5 }; else -> 6 }
        s.rows[kind][0]++
        return Ticket(s, kind, clock())
    }
    @Synchronized fun written(ticket: Ticket?) {
        if (ticket == null || ticket.scope !== scope) return
        val row = scope!!.rows[ticket.kind]
        if (ticket.closed) { row[9]++; return }
        if (ticket.written != null) return
        val now = clock(); ticket.written = now
        val elapsed = maxOf(0, now - ticket.queued)
        row[1]++; row[2] += elapsed; row[3] = maxOf(row[3], elapsed)
    }
    @Synchronized fun acknowledged(ticket: Ticket?) {
        if (ticket == null || ticket.scope !== scope) return
        val row = scope!!.rows[ticket.kind]
        if (ticket.closed) { row[9]++; return }
        if (ticket.acknowledged) return
        ticket.acknowledged = true
        val written = ticket.written
        if (written == null) { row[7]++; return }
        val elapsed = maxOf(0, clock() - written)
        row[4]++; row[5] += elapsed; row[6] = maxOf(row[6], elapsed)
    }
    @Synchronized fun finished(ticket: Ticket?) {
        if (ticket == null || ticket.scope !== scope || ticket.closed) return
        ticket.closed = true
        if (ticket.written == null) scope!!.rows[ticket.kind][8]++
        if (!ticket.acknowledged) scope!!.rows[ticket.kind][10]++
    }
    @Synchronized fun snapshot(): String {
        val s = scope ?: return "null"
        return buildString {
            append("{\"stream\":").append(s.stream).append(",\"epoch\":").append(s.epoch)
            append(",\"elapsedMs\":").append((clock() - s.at) / 1_000_000.0)
            KINDS.forEachIndexed { i, name ->
                val r = s.rows[i]
                append(",\"").append(name).append("\":{\"records\":").append(r[0])
                append(",\"queueToWrite\":{\"count\":").append(r[1])
                append(",\"totalMs\":").append(r[2] / 1_000_000.0)
                append(",\"maxMs\":").append(r[3] / 1_000_000.0).append('}')
                append(",\"writeToAck\":{\"count\":").append(r[4])
                append(",\"totalMs\":").append(r[5] / 1_000_000.0)
                append(",\"maxMs\":").append(r[6] / 1_000_000.0).append('}')
                append(",\"ackBeforeWrite\":").append(r[7])
                append(",\"missingWrite\":").append(r[8])
                append(",\"lateCallbacks\":").append(r[9])
                append(",\"missingAck\":").append(r[10]).append('}')
            }
            append('}')
        }
    }
    companion object {
        private val KINDS = arrayOf("nal", "metadata", "credit", "metadataPage", "creditPage", "otherPage", "other")
    }
}

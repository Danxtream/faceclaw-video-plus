package com.faceclaw.app

import org.json.JSONObject
import java.nio.ByteBuffer

internal data class VideoUploadPicture(val source: Int, val pts: Long)
internal data class VideoNalEvidence(val sequence: Int, val source: Int, val type: Int,
    val length: Int, val checksum: Long)
internal data class VideoUploadPlan(val stream: Long, val tokens: LongArray, val prefix: IntArray,
    val firstNal: Int, val count: Int, val pictures: List<VideoUploadPicture>, val timed: Boolean = false)

/** Credit-bounded state; the report handoff may stage a grant only while fenced. */
internal class VideoUploadEngine(private val plan: VideoUploadPlan, nalCount: Int,
    private val read: (Int) -> ByteArray, private val reserve: () -> Long,
    private val checkEpoch: () -> Unit, private val exchange: (ByteArray) -> Array<ByteArray>,
    private val pipeline: (Array<ByteArray>, Array<ByteArray?>) -> IntArray,
    val measurement: VideoMeasurement = VideoMeasurement(),
    private val canReuse: () -> Boolean = { true }) {
    var index = 0; private set
    var metadata = 0; private set
    var consumed = -1L; private set
    var budget = 0; private set
    var blocked = false; private set
    var waitKind = VideoMeasurement.ZERO_CREDIT; private set
    var leftConsumed = -1L; private set
    var rightConsumed = -1L; private set
    var creditAt = 0L; private set
    /** Timed mode: free timeline records on the fuller lens, spent by timed NALs. */
    var pictureBudget = 0; private set
    private data class Grant(val index: Int, val rows: Array<ByteArray>, val at: Long)
    private var offered: Grant? = null
    private val recentNals = ArrayDeque<VideoNalEvidence>()
    /** Payload attempts, including a batch whose acknowledgement later failed. */
    @Synchronized private fun recordNal(sequence: Int, bytes: ByteArray) {
        var checksum = 2166136261L.toInt()
        for (byte in bytes) checksum = (checksum xor u(byte)) * 16777619
        recentNals.addLast(VideoNalEvidence(sequence, source(sequence), u(bytes[0]) and 31,
            bytes.size, checksum.toLong() and 0xffffffffL))
        if (recentNals.size > 64) recentNals.removeFirst()
    }
    @Synchronized fun evidenceRows(): List<VideoNalEvidence> = recentNals.toList()
    @Synchronized fun evidence(): String = recentNals.joinToString(",", "[", "]") { row ->
        "{\"sequence\":${row.sequence},\"source\":${row.source},\"type\":${row.type}," +
            "\"length\":${row.length},\"checksum\":${row.checksum}}"
    }
    val done get() = index == plan.count
    init {
        require(plan.stream in 1..0xfffffffeL && plan.tokens.size == 2 && plan.tokens.all { it in 1..0xffffffffL })
        require(plan.count > 0 && plan.prefix.size <= 2 && plan.prefix.all { it in 0 until nalCount } && plan.firstNal in 0 until nalCount &&
            plan.count == plan.prefix.size + nalCount - plan.firstNal)
        require(plan.pictures.isNotEmpty() && plan.pictures.withIndex().all { (i, p) ->
            p.source in plan.firstNal until nalCount && p.pts in 0..0xfffffffeL &&
                (i == 0 || p.source > plan.pictures[i - 1].source && p.pts > plan.pictures[i - 1].pts)
        })
    }
    fun invalidateCredits() { offered = null }
    /** A report grant is single-use, exact-position and at most 500 ms old. */
    fun offerCredits(stream: Long, tokens: LongArray, sent: Int, rows: Array<ByteArray>, ageMs: Long): Boolean {
        checkEpoch(); offered = null
        if (!canReuse() || stream != plan.stream || !tokens.contentEquals(plan.tokens) || sent != index || ageMs !in 0..500) return false
        try { creditBudget(rows) } catch (_: IllegalStateException) { return false }
        offered = Grant(index, rows.map { it.copyOf() }.toTypedArray(), measurement.now() - ageMs * 1_000_000)
        return true
    }
    fun refreshCredits() {
        checkEpoch(); budget = 0
        val grant = offered; offered = null
        if (grant == null) return
        val age = measurement.now() - grant.at
        if (!canReuse() || grant.index != index || age !in 0..500_000_000L) {
            measurement.add(VideoMeasurement.CREDIT_DISCARD); return
        }
        acceptCredits(grant.rows)
        creditAt = grant.at
        measurement.add(VideoMeasurement.CREDIT_REUSE)
    }
    private fun creditBudget(credit: Array<ByteArray>): Int {
        check(credit.size == 2 && credit.all { it.size == 6 }) { "Missing lens video reply" }
        var available = 6
        for ((side, raw) in credit.withIndex()) {
            val expected = word(raw, 0)
            val packed = u(raw[4]); val capacity = if (packed and 8 != 0) 6 else 4; val free = packed and 7
            check(u(raw[5]) and resultMask == 0 && (!plan.timed || (u(raw[5]) shr TIMELINE_ROOM_SHIFT) <= 6) &&
                packed and 128 == 0 && (packed shr 4 and 7) == 2 && free <= capacity &&
                expected <= index && index - expected <= capacity &&
                expected >= if (side == 0) leftConsumed else rightConsumed) { "Video owner credit window failed" }
            available = minOf(available, free, (capacity + expected - index).toInt())
        }
        return available
    }
    private val resultMask = if (plan.timed) TIMELINE_RESULT_MASK else 255
    private fun acceptCredits(credit: Array<ByteArray>) {
        budget = creditBudget(credit)
        pictureBudget = if (plan.timed) credit.minOf { u(it[5]) shr TIMELINE_ROOM_SHIFT } else 0
        consumed = credit.minOf { word(it, 0) }
        leftConsumed = word(credit[0], 0); rightConsumed = word(credit[1], 0)
        creditAt = measurement.now()
        blocked = false
    }
    private fun source(sequence: Int): Int = if (sequence < plan.prefix.size) plan.prefix[sequence]
        else plan.firstNal + sequence - plan.prefix.size
    private fun query(op: Int, size: Int): ByteArray {
        checkEpoch()
        val id = measurement.time(VideoMeasurement.IDENTITY) { reserve() }
        require(id in 1..0xfffffffeL) { "Video request ID exhausted" }
        return ByteArray(size).also { it[0] = 31; it[1] = op.toByte(); it[2] = 1; put(it, 4, id); put(it, 8, plan.stream) }
    }
    private fun metadataCommand(ordinal: Int, sequence: Int): ByteArray = query(14, 24).also {
        put(it, 12, ordinal.toLong()); put(it, 16, sequence.toLong()); put(it, 20, plan.pictures[ordinal - 1].pts)
    }
    private fun metadataAccepted(command: ByteArray): Boolean {
        val rows = measurement.time(VideoMeasurement.METADATA) { exchange(command) }; checkEpoch()
        require(rows.size == 2 && rows.all { it.size == 6 && u(it[5]) in listOf(0, 3) && u(it[4]) <= 6 &&
            (u(it[5]) != 0 || word(it, 0) == word(command, 12)) }) { "Picture metadata refused" }
        val accepted = rows.all { u(it[5]) == 0 }
        if (!accepted) { waitKind = VideoMeasurement.BUSY; measurement.add(VideoMeasurement.REFUSAL) }
        return accepted
    }
    private fun credits(shouldContinue: () -> Boolean): Boolean {
        var rows: Array<ByteArray>? = null
        for (attempt in 1..2) {
            val command = query(10, if (plan.timed) 24 else 20)
            put(command, 12, plan.tokens[0]); put(command, 16, plan.tokens[1])
            if (plan.timed) put(command, 20, 1) // Ask for timeline room in the result byte.
            try { rows = measurement.time(VideoMeasurement.CREDITS) { exchange(command) }; break }
            catch (error: VideoQueryUnavailable) {
                checkEpoch()
                System.err.println("Video upload credits request=${word(command, 4)} attempt=$attempt: ${error.message}")
                budget = 0; blocked = true
                // Yield to a waiting control before starting another bounded query.
                if (!shouldContinue()) return false
                measurement.time(VideoMeasurement.ZERO_CREDIT) { Thread.sleep(if (attempt == 1) 50 else 400) }
            }
        }
        checkEpoch()
        val credit = rows ?: return false
        acceptCredits(credit)
        return true
    }
    private fun nalRecord(sequence: Int, bytes: ByteArray): ByteArray = ByteArray(10 + bytes.size).also { record ->
        recordNal(sequence, bytes)
        record[0] = 31; record[1] = 6; put(record, 2, plan.stream); put(record, 6, sequence.toLong())
        bytes.copyInto(record, 10)
    }
    private fun timedRecord(sequence: Int, ordinal: Int, bytes: ByteArray): ByteArray =
        ByteArray(TIMED_HEADER + bytes.size).also { record ->
            recordNal(sequence, bytes)
            record[0] = 31; record[1] = TIMED_NAL.toByte(); put(record, 2, plan.stream); put(record, 6, sequence.toLong())
            put(record, 10, ordinal.toLong()); put(record, 14, plan.pictures[ordinal - 1].pts)
            bytes.copyInto(record, TIMED_HEADER)
        }
    /**
     * Each picture's VCL NAL carries its own frame time, so no per-picture
     * metadata round trip blocks the batch. Timed NALs are sent only within the
     * timeline room both lenses last reported; an oversized one uses the old path.
     */
    private fun stepTimed(shouldContinue: () -> Boolean): Boolean {
        val picture = plan.pictures.getOrNull(metadata)?.source == source(index)
        if ((budget == 0 || picture && pictureBudget == 0) && !credits(shouldContinue)) return false
        if (picture && pictureBudget == 0) { waitKind = VideoMeasurement.BUSY; blocked = true; return false }
        val limit = minOf(4, budget, plan.count - index)
        if (limit == 0) { blocked = true; return false }
        val records = ArrayList<ByteArray>(limit)
        var next = metadata; var timed = 0; var payload = 0L
        measurement.time(VideoMeasurement.BUILD) {
            while (records.size < limit) {
                checkEpoch()
                val sequence = index + records.size
                val starts = plan.pictures.getOrNull(next)?.source == source(sequence)
                if (starts && timed == pictureBudget) break
                val bytes = measurement.time(VideoMeasurement.READ) { read(source(sequence)) }; checkEpoch()
                require(bytes.size in 1..4086) { "Complete NAL exceeds advertised limit" }
                if (starts && TIMED_HEADER + bytes.size > 4096) {
                    if (records.isNotEmpty()) break
                    // Too large to carry its frame time: admit the metadata separately.
                    if (!metadataAccepted(metadataCommand(next + 1, sequence))) { blocked = true; return false }
                    metadata++; pictureBudget--
                    records.add(nalRecord(sequence, bytes)); payload += bytes.size
                    break
                }
                records.add(if (starts) timedRecord(sequence, ++next, bytes) else nalRecord(sequence, bytes))
                if (starts) timed++
                payload += bytes.size
            }
        }
        if (records.isEmpty()) { waitKind = VideoMeasurement.BUSY; blocked = true; return false }
        val result = measurement.time(VideoMeasurement.PIPELINE) {
            pipeline(records.toTypedArray(), arrayOfNulls(records.size))
        }; checkEpoch()
        require(result.size == 2 && result[0] == records.size && result[1] == 0) { "Invalid video pipeline completion" }
        index += records.size; metadata += timed; budget -= records.size; pictureBudget -= timed
        measurement.add(VideoMeasurement.NALS, count = records.size.toLong())
        measurement.add(VideoMeasurement.BYTES, count = payload)
        return true
    }
    /** Finish exactly one existing native pipeline batch before any writer handoff. */
    fun step(shouldContinue: () -> Boolean = { true }): Boolean {
        checkEpoch(); blocked = false; waitKind = VideoMeasurement.ZERO_CREDIT
        if (done) return false
        if (plan.timed) return stepTimed(shouldContinue)
        if (budget == 0 && !credits(shouldContinue)) return false
        val first = plan.pictures.getOrNull(metadata)
        if (first?.source == source(index)) {
            if (!metadataAccepted(metadataCommand(metadata + 1, index))) { blocked = true; return false }
            metadata++
        }
        val count = minOf(4, budget, plan.count - index)
        if (count == 0) { blocked = true; return false }
        val following = arrayOfNulls<ByteArray>(count)
        var next = metadata
        val records = measurement.time(VideoMeasurement.BUILD) { Array(count) { i ->
            checkEpoch()
            val sequence = index + i
            val bytes = measurement.time(VideoMeasurement.READ) { read(source(sequence)) }; checkEpoch()
            require(bytes.size in 1..4086) { "Complete NAL exceeds advertised limit" }
            val record = ByteArray(10 + bytes.size)
            recordNal(sequence, bytes)
            record[0] = 31; record[1] = 6; put(record, 2, plan.stream); put(record, 6, sequence.toLong())
            bytes.copyInto(record, 10)
            if (plan.pictures.getOrNull(next)?.source == source(sequence + 1)) {
                following[i] = metadataCommand(next + 1, sequence + 1); next++
            }
            record
        } }
        val result = measurement.time(VideoMeasurement.PIPELINE) { pipeline(records, following) }; checkEpoch()
        require(result.size == 2) { "Invalid video pipeline completion" }
        val sent = result[0]; val admitted = result[1]
        require(sent in 1..count) { "Invalid video pipeline completion" }
        val expected = following.take(sent).count { it != null }
        require(admitted in 0..expected && (admitted == expected || admitted == expected - 1 && following[sent - 1] != null) &&
            (sent == count || admitted != expected)) { "Invalid video pipeline completion" }
        index += sent; metadata += admitted; budget -= sent
        measurement.add(VideoMeasurement.NALS, count = sent.toLong())
        measurement.add(VideoMeasurement.BYTES, count = records.take(sent).sumOf { it.size - 10 }.toLong())
        return true
    }
    companion object {
        /** Firmware op for a VCL NAL with its ordinal and pts, and its 18-byte header. */
        internal const val TIMED_NAL = 24
        internal const val TIMED_HEADER = 18
        private const val TIMELINE_RESULT_MASK = 31
        private const val TIMELINE_ROOM_SHIFT = 5
        private fun u(value: Byte) = value.toInt() and 255
        internal fun word(data: ByteArray, offset: Int): Long =
            (0..3).fold(0L) { value, i -> value or (u(data[offset + i]).toLong() shl (8 * i)) }
        internal fun put(data: ByteArray, offset: Int, value: Long) {
            require(value in 0..0xffffffffL)
            for (i in 0..3) data[offset + i] = (value shr (8 * i)).toByte()
        }
    }
}

/** Cooperatively fence uploads before JS controls/reports use the same transport writer. */
class VideoUploadPump internal constructor(create: () -> VideoUploadEngine) {
    private val monitor = java.lang.Object()
    private var requested = false
    private var closed = false
    private var running = true
    private var progress = "\"index\":0,\"metadata\":0,\"consumed\":-1,\"budget\":0,\"blocked\":false"
    private var failure = ""
    private var engine: VideoUploadEngine? = null
    private var sampleAt = Long.MIN_VALUE
    private var sample = "{}"
    private var offeredCredits = false

    constructor(transport: FaceclawVideoTransport, reader: VideoFileReader, identities: VideoIdentityAllocator,
        plan: String, ingressLeft: Boolean, epoch: Long) : this({
        val json = JSONObject(plan)
        val prefix = json.getJSONArray("prefix")
        val pictures = json.getJSONArray("pictures")
        val config = VideoUploadPlan(json.getLong("stream"), longArrayOf(json.getJSONArray("tokens").getLong(0), json.getJSONArray("tokens").getLong(1)),
            IntArray(prefix.length()) { prefix.getInt(it) }, json.getInt("firstNal"), json.getInt("count"),
            (0 until pictures.length()).map { i -> pictures.getJSONObject(i).let { VideoUploadPicture(it.getInt("nal"), it.getLong("pts")) } },
            json.optBoolean("timed", false))
        VideoUploadEngine(config, reader.nalCount(), reader::readNalBytes, identities::reserveNow,
            { check(transport.epoch == epoch) { "Video connection generation changed; restart at IDR" } },
            { transport.exchange(it, 6, 3, ingressLeft, 5, epoch) },
            { records, following -> transport.pipeline(records, following, 3, ingressLeft, epoch) },
            canReuse = { transport.creditReuseSafe(epoch) })
    })

    init {
        Thread({
            try {
                val engine = create()
                synchronized(monitor) { this.engine = engine }
                while (true) {
                    synchronized(monitor) {
                        running = false; monitor.notifyAll()
                        while (!requested && !closed) monitor.wait()
                        if (closed) return@Thread
                        if (!offeredCredits) engine.invalidateCredits()
                        offeredCredits = false
                        running = true
                    }
                    engine.refreshCredits()
                    while (synchronized(monitor) { requested && !closed }) {
                        engine.step { synchronized(monitor) { requested && !closed } }
                        synchronized(monitor) {
                            progress = "\"index\":${engine.index},\"metadata\":${engine.metadata},\"consumed\":${engine.consumed}," +
                                "\"budget\":${engine.budget},\"blocked\":${engine.blocked}," +
                                "\"consumedL\":${engine.leftConsumed},\"consumedR\":${engine.rightConsumed}," +
                                "\"creditAgeMs\":${if (engine.creditAt == 0L) -1 else (engine.measurement.now() - engine.creditAt) / 1_000_000}"
                            if (engine.done) requested = false
                            else if (engine.blocked && requested && !closed) {
                                val from = engine.measurement.now()
                                monitor.wait(20)
                                engine.measurement.add(engine.waitKind, engine.measurement.now() - from)
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                synchronized(monitor) { failure = error.message ?: error.javaClass.simpleName }
            } finally { synchronized(monitor) { closed = true; running = false; monitor.notifyAll() } }
        }, "video-upload").apply { isDaemon = true; start() }
    }
    fun resumeUpload() = synchronized(monitor) {
        if (failure.isEmpty()) check(!closed) { "Video upload pump closed" }
        requested = true; monitor.notifyAll()
    }
    fun pauseUpload() = synchronized(monitor) {
        requested = false
        // Only the fenced writer can install a grant; never mutate its budget here.
        offeredCredits = false
        monitor.notifyAll()
    }
    fun closeUpload() = synchronized(monitor) {
        check(!running) { "Video upload pump is not fenced" }
        closed = true; requested = false; monitor.notifyAll()
    }
    /** Copy one validated paired report while no upload batch owns the writer. */
    fun offerCreditSnapshot(buffer: ByteBuffer, stream: Long, leftToken: Long, rightToken: Long,
        sent: Int, ageMs: Long): Boolean = synchronized(monitor) {
        check(!running && !requested && !closed) { "Video credit writer is not fenced" }
        offeredCredits = false
        val bytes = buffer.duplicate()
        if (bytes.remaining() != 12) return@synchronized false
        val rows = Array(2) { ByteArray(6).also { bytes.get(it) } }
        engine!!.offerCredits(stream, longArrayOf(leftToken, rightToken), sent, rows, ageMs)
            .also { offeredCredits = it }
    }
    fun uploadSnapshot(): String = synchronized(monitor) {
        val now = System.nanoTime()
        if (engine != null && (sampleAt == Long.MIN_VALUE || now - sampleAt >= 1_000_000_000L || !running)) {
            sample = engine!!.measurement.snapshot(); sampleAt = now
        }
        "{$progress,\"running\":${running || requested && !closed},\"error\":${failure.isNotEmpty()},\"measurement\":$sample}"
    }
    fun uploadFailure(): String = synchronized(monitor) { failure }
    /** Read only after fencing; survives a worker exception until JS closes it. */
    fun uploadEvidence(): String = synchronized(monitor) {
        check(!running) { "Video upload pump is not fenced" }
        engine?.evidence() ?: "[]"
    }
}

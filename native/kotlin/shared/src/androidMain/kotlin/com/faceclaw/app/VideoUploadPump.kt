package com.faceclaw.app

import org.json.JSONObject
import java.nio.ByteBuffer

internal data class VideoUploadPicture(val source: Int, val pts: Long)
internal data class VideoNalEvidence(val sequence: Int, val source: Int, val type: Int,
    val length: Int, val checksum: Long)
internal data class VideoUploadPlan(val stream: Long, val tokens: LongArray, val prefix: IntArray,
    val firstNal: Int, val count: Int, val pictures: List<VideoUploadPicture>, val timed: Boolean = false,
    val confirmationRoom: Boolean = false, val queueCapacity: Int = 6) {
    init { require(queueCapacity in 6..15) { "Invalid video queue capacity" } }
}

internal typealias VideoRoomFlow = (() -> ByteArray?, (Int, Array<ByteArray>?, Long) -> Unit,
    () -> Boolean, VideoMeasurement) -> Unit

/** Credit-bounded state; the report handoff may stage a grant only while fenced. */
internal class VideoUploadEngine(private val plan: VideoUploadPlan, nalCount: Int,
    private val read: (Int) -> ByteArray, private val reserve: () -> Long,
    private val checkEpoch: () -> Unit, private val exchange: (ByteArray) -> Array<ByteArray>,
    private val pipeline: (Array<ByteArray>, Array<ByteArray?>) -> IntArray,
    val measurement: VideoMeasurement = VideoMeasurement(),
    private val canReuse: () -> Boolean = { true },
    private val confirmation: () -> Array<ByteArray>? = { null },
    private val roomFlow: VideoRoomFlow? = null) {
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
    private var previousBatchEnd = 0L
    private var lastRoomSequence = -1
    private val timedReservations = ArrayDeque<Int>()
    internal var progressSink: (() -> Unit)? = null

    private inline fun batch(work: () -> Unit) {
        if (previousBatchEnd != 0L) measurement.add(VideoMeasurement.BATCH_GAP, measurement.now() - previousBatchEnd)
        val first = index
        try { work() } finally {
            val size = index - first
            measurement.add(VideoMeasurement.BATCHES)
            measurement.add(VideoMeasurement.BATCH_RECORDS, count = size.toLong())
            measurement.add(when (size) {
                0 -> VideoMeasurement.BATCH_ZERO
                1 -> VideoMeasurement.BATCH_ONE; 2 -> VideoMeasurement.BATCH_TWO
                3 -> VideoMeasurement.BATCH_THREE; 4 -> VideoMeasurement.BATCH_FOUR
                else -> VideoMeasurement.BATCH_LARGER
            })
            previousBatchEnd = measurement.now()
        }
    }
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
    /** Status queries ride in the confirmation-room flow; other paths still need a fence. */
    val ridesQueries get() = plan.timed && plan.confirmationRoom && roomFlow != null
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
            // Flag 8: the queue grew past four slots, to six on older firmware.
            val packed = u(raw[4]); val capacity = if (packed and 8 != 0) plan.queueCapacity else 4; val free = packed and 7
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
        timedReservations.clear() // Called only with the transport fully fenced.
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
        measurement.add(VideoMeasurement.QUERY_FALLBACK)
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
        record[0] = 31; record[1] = (if (plan.confirmationRoom) 28 else 6).toByte(); put(record, 2, plan.stream); put(record, 6, sequence.toLong())
        bytes.copyInto(record, 10)
    }
    private fun timedRecord(sequence: Int, ordinal: Int, bytes: ByteArray): ByteArray =
        ByteArray(TIMED_HEADER + bytes.size).also { record ->
            recordNal(sequence, bytes)
            record[0] = 31; record[1] = (if (plan.confirmationRoom) 29 else TIMED_NAL).toByte(); put(record, 2, plan.stream); put(record, 6, sequence.toLong())
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
        if (picture && pictureBudget == 0) {
            measurement.add(VideoMeasurement.TIMELINE_WAIT)
            waitKind = VideoMeasurement.BUSY; blocked = true; return false
        }
        if (plan.confirmationRoom && roomFlow != null) return stepFlow(shouldContinue)
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
        if (records.size == 4) measurement.add(VideoMeasurement.BATCH_CAP)
        if (budget == 0) measurement.add(VideoMeasurement.CREDIT_END)
        if (plan.confirmationRoom) {
            val rows = confirmation()
            // BUSY marks an accepted replay/future NAL without an ordered room
            // promise. Never invent room from a missing or history-only ACK.
            if (rows != null && canReuse() && rows.size == 2 && rows.all { it.size == 6 && u(it[5]) and 31 == 0 })
                acceptCredits(rows)
        }
        measurement.add(VideoMeasurement.NALS, count = records.size.toLong())
        measurement.add(VideoMeasurement.BYTES, count = payload)
        return true
    }

    /** Reserve every later NAL and timed picture against both PRIMARY grants.
     * A grant at S predates those later submissions even when their ACKs arrived
     * first. Never reuse history, old attempts, stale grants or uncertain epochs. */
    private fun acceptRoom(sequence: Int, rows: Array<ByteArray>?, ageMs: Long) {
        checkEpoch()
        if (rows == null) { measurement.add(VideoMeasurement.ROOM_MISSING); return }
        if (ageMs !in 0..500) { measurement.add(VideoMeasurement.ROOM_STALE); return }
        if (!canReuse() || sequence <= lastRoomSequence || rows.size != 2 ||
            rows.any { it.size != 6 || u(it[5]) and 31 != 0 }) {
            measurement.add(VideoMeasurement.ROOM_REJECT); return
        }
        check(sequence in 0 until index) { "Room grant is ahead of submitted NALs" }
        val available = creditBudget(rows) // Retain the fatal owner/epoch/window checks.
        val later = index - sequence - 1
        while (timedReservations.isNotEmpty() && timedReservations.first() <= sequence) timedReservations.removeFirst()
        budget = maxOf(0, minOf(available, rows.minOf { u(it[4]) and 7 } - later))
        pictureBudget = maxOf(0, rows.minOf { u(it[5]) shr TIMELINE_ROOM_SHIFT } - timedReservations.size)
        consumed = rows.minOf { word(it, 0) }; leftConsumed = word(rows[0], 0); rightConsumed = word(rows[1], 0)
        creditAt = measurement.now() - ageMs * 1_000_000; lastRoomSequence = sequence
        measurement.add(VideoMeasurement.ROOM_ACCEPT)
        progressSink?.invoke()
    }

    private fun stepFlow(shouldContinue: () -> Boolean): Boolean {
        val first = index
        measurement.time(VideoMeasurement.PIPELINE) {
            roomFlow!!({
                checkEpoch()
                val starts = !done && plan.pictures.getOrNull(metadata)?.source == source(index)
                if (done || !shouldContinue()) null
                else if (budget == 0) { measurement.add(VideoMeasurement.CREDIT_END); null }
                else if (starts && pictureBudget == 0) { measurement.add(VideoMeasurement.TIMELINE_WAIT); null }
                else {
                    val bytes = measurement.time(VideoMeasurement.READ) { read(source(index)) }; checkEpoch()
                    require(bytes.size in 1..4086) { "Complete NAL exceeds advertised limit" }
                    // Oversized timed records need a separately fenced metadata command.
                    if (starts && TIMED_HEADER + bytes.size > 4096) null
                    else measurement.time(VideoMeasurement.BUILD) {
                        val sequence = index
                        val record = if (starts) timedRecord(sequence, metadata + 1, bytes) else nalRecord(sequence, bytes)
                        index++; budget--
                        if (starts) { metadata++; pictureBudget--; timedReservations.addLast(sequence) }
                        measurement.add(VideoMeasurement.NALS)
                        measurement.add(VideoMeasurement.BYTES, count = bytes.size.toLong())
                        progressSink?.invoke()
                        record
                    }
                }
            }, ::acceptRoom, { shouldContinue() && !done }, measurement)
        }
        if (index == first && shouldContinue() && !done && budget > 0 && pictureBudget > 0) {
            // Nothing is pending here; only the large-record metadata fallback
            // can need the legacy batch builder. It never overlaps a query.
            return stepOversized(shouldContinue)
        }
        blocked = index == first
        return index != first
    }
    private fun stepOversized(shouldContinue: () -> Boolean): Boolean {
        checkEpoch()
        if (!shouldContinue()) return false
        val bytes = measurement.time(VideoMeasurement.READ) { read(source(index)) }
        require(bytes.size in (4096 - TIMED_HEADER + 1)..4086)
        if (!metadataAccepted(metadataCommand(metadata + 1, index))) { blocked = true; return false }
        metadata++; pictureBudget--
        val result = pipeline(arrayOf(nalRecord(index, bytes)), arrayOfNulls(1)); checkEpoch()
        require(result.contentEquals(intArrayOf(1, 0))) { "Invalid video pipeline completion" }
        index++; budget--
        measurement.add(VideoMeasurement.NALS); measurement.add(VideoMeasurement.BYTES, count = bytes.size.toLong())
        return true
    }
    /** Finish exactly one existing native pipeline batch before any writer handoff. */
    fun step(shouldContinue: () -> Boolean = { true }): Boolean {
        checkEpoch(); blocked = false; waitKind = VideoMeasurement.ZERO_CREDIT
        if (done) return false
        if (plan.timed) {
            var result = false
            batch { result = stepTimed(shouldContinue) }
            return result
        }
        var result = false
        batch { result = stepUntimed(shouldContinue) }
        return result
    }
    private fun stepUntimed(shouldContinue: () -> Boolean): Boolean {
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
        if (sent == 4) measurement.add(VideoMeasurement.BATCH_CAP)
        if (budget == 0) measurement.add(VideoMeasurement.CREDIT_END)
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
            json.optBoolean("timed", false), json.optBoolean("confirmationRoom", false), json.optInt("queueCapacity", 6))
        val stats = VideoMeasurement()
        VideoUploadEngine(config, reader.nalCount(), reader::readNalBytes, identities::reserveNow,
            { check(transport.epoch == epoch) { "Video connection generation changed; restart at IDR" } },
            { transport.exchange(it, 6, 3, ingressLeft, 5, epoch) },
            { records, following -> transport.pipelineMeasured(records, following, 3, ingressLeft, epoch, stats) },
            measurement = stats, canReuse = { transport.creditReuseSafe(epoch) }, confirmation = transport::takeConfirmationCredits,
            roomFlow = { next, grant, keep, meter -> transport.flow(next, grant, keep, meter, ingressLeft, epoch) })
    })

    init {
        Thread({
            try {
                val engine = create()
                engine.progressSink = { synchronized(monitor) { publishProgress(engine) } }
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
                            publishProgress(engine)
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
    /** Called on the native writer, under the monitor; no JS callback/poll. */
    private fun publishProgress(engine: VideoUploadEngine) {
        progress = "\"index\":${engine.index},\"metadata\":${engine.metadata},\"consumed\":${engine.consumed}," +
            "\"budget\":${engine.budget},\"blocked\":${engine.blocked},\"rides\":${engine.ridesQueries}," +
            "\"consumedL\":${engine.leftConsumed},\"consumedR\":${engine.rightConsumed}," +
            "\"creditAgeMs\":${if (engine.creditAt == 0L) -1 else (engine.measurement.now() - engine.creditAt) / 1_000_000}"
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

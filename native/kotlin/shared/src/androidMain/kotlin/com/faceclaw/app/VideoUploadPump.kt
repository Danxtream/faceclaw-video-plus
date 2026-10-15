package com.faceclaw.app

import org.json.JSONObject

internal data class VideoUploadPicture(val source: Int, val pts: Long)
internal data class VideoUploadPlan(val stream: Long, val tokens: LongArray, val prefix: IntArray,
    val firstNal: Int, val count: Int, val pictures: List<VideoUploadPicture>)

/** Credit-bounded upload state; only the pump's background writer mutates it. */
internal class VideoUploadEngine(private val plan: VideoUploadPlan, nalCount: Int,
    private val read: (Int) -> ByteArray, private val reserve: () -> Long,
    private val checkEpoch: () -> Unit, private val exchange: (ByteArray) -> Array<ByteArray>,
    private val pipeline: (Array<ByteArray>, Array<ByteArray?>) -> IntArray) {
    var index = 0; private set
    var metadata = 0; private set
    var consumed = -1L; private set
    var budget = 0; private set
    var blocked = false; private set
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
    fun refreshCredits() { budget = 0 }
    private fun source(sequence: Int): Int = if (sequence < plan.prefix.size) plan.prefix[sequence]
        else plan.firstNal + sequence - plan.prefix.size
    private fun query(op: Int, size: Int): ByteArray {
        checkEpoch()
        val id = reserve()
        require(id in 1..0xfffffffeL) { "Video request ID exhausted" }
        return ByteArray(size).also { it[0] = 31; it[1] = op.toByte(); it[2] = 1; put(it, 4, id); put(it, 8, plan.stream) }
    }
    private fun metadataCommand(ordinal: Int, sequence: Int): ByteArray = query(14, 24).also {
        put(it, 12, ordinal.toLong()); put(it, 16, sequence.toLong()); put(it, 20, plan.pictures[ordinal - 1].pts)
    }
    private fun metadataAccepted(command: ByteArray): Boolean {
        val rows = exchange(command); checkEpoch()
        require(rows.size == 2 && rows.all { it.size == 6 && u(it[5]) in listOf(0, 3) && u(it[4]) <= 4 &&
            (u(it[5]) != 0 || word(it, 0) == word(command, 12)) }) { "Picture metadata refused" }
        return rows.all { u(it[5]) == 0 }
    }
    private fun credits() {
        val command = query(10, 20)
        put(command, 12, plan.tokens[0]); put(command, 16, plan.tokens[1])
        val rows = exchange(command); checkEpoch()
        require(rows.size == 2 && rows.all { it.size == 6 }) { "Missing lens video reply" }
        budget = 4
        for (raw in rows) {
            val expected = word(raw, 0)
            val packed = u(raw[4]); val capacity = if (packed and 8 != 0) 6 else 4; val free = packed and 7
            check(u(raw[5]) == 0 && packed and 128 == 0 && (packed shr 4 and 7) == 2 && free <= capacity &&
                expected <= index && index - expected <= capacity) { "Video owner credit window failed" }
            budget = minOf(budget, free, (capacity + expected - index).toInt())
        }
        consumed = rows.minOf { word(it, 0) }
    }
    /** Finish exactly one existing native pipeline batch before any writer handoff. */
    fun step(): Boolean {
        checkEpoch(); blocked = false
        if (done) return false
        if (budget == 0) credits()
        val first = plan.pictures.getOrNull(metadata)
        if (first?.source == source(index)) {
            if (!metadataAccepted(metadataCommand(metadata + 1, index))) { blocked = true; return false }
            metadata++
        }
        val count = minOf(budget, plan.count - index)
        if (count == 0) { blocked = true; return false }
        val following = arrayOfNulls<ByteArray>(count)
        var next = metadata
        val records = Array(count) { i ->
            checkEpoch()
            val sequence = index + i
            val bytes = read(source(sequence)); checkEpoch()
            require(bytes.size in 1..4086) { "Complete NAL exceeds advertised limit" }
            val record = ByteArray(10 + bytes.size)
            record[0] = 31; record[1] = 6; put(record, 2, plan.stream); put(record, 6, sequence.toLong())
            bytes.copyInto(record, 10)
            if (plan.pictures.getOrNull(next)?.source == source(sequence + 1)) {
                following[i] = metadataCommand(next + 1, sequence + 1); next++
            }
            record
        }
        val result = pipeline(records, following); checkEpoch()
        require(result.size == 2) { "Invalid video pipeline completion" }
        val sent = result[0]; val admitted = result[1]
        require(sent in 1..count) { "Invalid video pipeline completion" }
        val expected = following.take(sent).count { it != null }
        require(admitted in 0..expected && (admitted == expected || admitted == expected - 1 && following[sent - 1] != null) &&
            (sent == count || admitted != expected)) { "Invalid video pipeline completion" }
        index += sent; metadata += admitted; budget -= sent
        return true
    }
    companion object {
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

    constructor(transport: FaceclawVideoTransport, reader: VideoFileReader, identities: VideoIdentityAllocator,
        plan: String, ingressLeft: Boolean, epoch: Long) : this({
        val json = JSONObject(plan)
        val prefix = json.getJSONArray("prefix")
        val pictures = json.getJSONArray("pictures")
        val config = VideoUploadPlan(json.getLong("stream"), longArrayOf(json.getJSONArray("tokens").getLong(0), json.getJSONArray("tokens").getLong(1)),
            IntArray(prefix.length()) { prefix.getInt(it) }, json.getInt("firstNal"), json.getInt("count"),
            (0 until pictures.length()).map { i -> pictures.getJSONObject(i).let { VideoUploadPicture(it.getInt("nal"), it.getLong("pts")) } })
        VideoUploadEngine(config, reader.nalCount(), reader::readNalBytes, identities::reserveNow,
            { check(transport.epoch == epoch) { "Video connection generation changed; restart at IDR" } },
            { transport.exchange(it, 6, 3, ingressLeft, 5, epoch) },
            { records, following -> transport.pipeline(records, following, 3, ingressLeft, epoch) })
    })

    init {
        Thread({
            try {
                val engine = create()
                while (true) {
                    synchronized(monitor) {
                        running = false; monitor.notifyAll()
                        while (!requested && !closed) monitor.wait()
                        if (closed) return@Thread
                        running = true
                    }
                    engine.refreshCredits()
                    while (synchronized(monitor) { requested && !closed }) {
                        engine.step()
                        synchronized(monitor) {
                            progress = "\"index\":${engine.index},\"metadata\":${engine.metadata},\"consumed\":${engine.consumed}," +
                                "\"budget\":${engine.budget},\"blocked\":${engine.blocked}"
                            if (engine.done) requested = false
                            else if (engine.blocked && requested && !closed) monitor.wait(20)
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
    fun pauseUpload() = synchronized(monitor) { requested = false; monitor.notifyAll() }
    fun closeUpload() = synchronized(monitor) {
        check(!running) { "Video upload pump is not fenced" }
        closed = true; requested = false; monitor.notifyAll()
    }
    fun uploadSnapshot(): String = synchronized(monitor) {
        "{$progress,\"running\":${running || requested && !closed},\"error\":${failure.isNotEmpty()}}"
    }
    fun uploadFailure(): String = synchronized(monitor) { failure }
}

package com.faceclaw.app

import java.util.concurrent.locks.ReentrantLock
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.Executors
import kotlin.concurrent.withLock

/** Missing transport evidence, not an invalid owner, reply or decoder state. */
internal class VideoQueryUnavailable(message: String) : IllegalStateException("Video query unavailable: $message")

/** Enqueues records on the existing authenticated communicator, never a new link. */
fun interface VideoRecordQueue {
    fun enqueue(record: VideoSubmission): Boolean
}

/** One immutable logical record; native attempt identity remains queue-owned. */
class VideoSubmission internal constructor(
    @JvmField val payload: ByteArray,
    @JvmField val targets: Int,
    @JvmField val ingressLeft: Boolean,
    @JvmField val epoch: Long,
    private val transport: FaceclawVideoTransport,
) {
    @JvmField var message: OutboundMessage? = null
    internal var attempt = -1
    internal var acknowledged = 0
    internal var accepted = 0
    internal var listed = false
    internal var delivered = false
    internal var failure: String? = null
    internal val queuedAt = System.nanoTime()
    internal var writtenAt = 0L
    internal val timing = transport.recordMeasurement.queued(payload, epoch, transport.queryTimingOp)

    fun delivered() = transport.delivered(this)
    fun written() = transport.written(this)
    fun failed(reason: String) = transport.failed(this, reason)
}

/** Queue completion is fenced against the exact native replay attempt. */
class VideoCompletion(
    @JvmField val message: OutboundMessage,
    @JvmField val attempt: Int,
    @JvmField val epoch: Long,
)

/**
 * Bounded video records and immutable, source-tagged reply pages.
 * Blocking methods run on a caller's background worker. Notifications never wait
 * for a writer or call the native queue while holding the notification monitor.
 */
class FaceclawVideoTransport(private val queue: VideoRecordQueue) {
    internal val measurement = VideoMeasurement()
    internal val recordMeasurement = VideoRecordMeasurement()
    internal var queryTimingOp = 0
    fun measurementSnapshot(): String =
        "{\"lifetime\":${measurement.snapshot()},\"generation\":${recordMeasurement.snapshot()}}"
    /** Called once after START while the single writer is fenced. */
    fun beginMeasurement(stream: Long) = synchronized(monitor) {
        check(pending.isEmpty() && request == 0L) { "Video measurement writer is not fenced" }
        recordMeasurement.begin(stream, epoch)
    }
    internal fun creditReuseSafe(generation: Long): Boolean = synchronized(monitor) {
        epoch == generation && uncertainContexts == 0
    }
    private val writer = ReentrantLock()
    private val pagePadding = SecureRandom()
    private val monitor = java.lang.Object()
    private val pending = mutableListOf<VideoSubmission>()
    private val completions = mutableListOf<VideoCompletion>()
    private val pages = mutableMapOf<Pair<Int, Int>, Pair<Int, ByteArray>>()
    private var request = 0L
    private var requestedTargets = 0
    private var queryIngressLeft = true
    private var replyFailure: String? = null
    private var uncertainContexts = 0
    @Volatile internal var evidenceReserve: (() -> Long)? = null
    private var collectingEvidence = false
    private var refusalEvidenceTargets = 0
    private class Operation(val epoch: Long) {
        var complete = false
        var result = ""
        var error = ""
    }
    private val operations = mutableMapOf<Long, Operation>()
    private var nextOperation = 1L
    private val executor by lazy {
        Executors.newSingleThreadExecutor { task -> Thread(task, "video-control").apply { isDaemon = true } }
    }
    @Volatile var epoch = 1L
        private set

    /** Enable only after both lenses advertise receive/clock diagnostics. */
    fun configureEvidence(identities: VideoIdentityAllocator, enabled: Boolean) {
        evidenceReserve = if (enabled) identities::reserveNow else null
    }

    /** Return only this class's envelope mask; ordinary CFW records stay unchanged. */
    fun targetsFor(message: OutboundMessage): Int = synchronized(monitor) {
        val record = pending.firstOrNull { it.message === message && it.epoch == epoch }
            ?: throw IllegalStateException("Video record generation retired")
        if (record.attempt != message.magic) {
            record.attempt = message.magic
            record.acknowledged = 0
            record.accepted = 0
            record.listed = false
        }
        record.targets
    }

    /** A refused record invalidates the ingress inflater; reset on the writer. */
    fun needsContextReset(message: OutboundMessage): Boolean = synchronized(monitor) {
        val record = pending.firstOrNull { it.message === message && it.epoch == epoch }
            ?: throw IllegalStateException("Video record generation retired")
        val bit = if (record.ingressLeft) 1 else 2
        (uncertainContexts and bit != 0).also { uncertainContexts = uncertainContexts and bit.inv() }
    }

    /** Remove native queue entries only after every selected lens answered exactly. */
    fun drainCompleted(): Array<VideoCompletion> = synchronized(monitor) {
        completions.toTypedArray().also { completions.clear() }
    }

    internal fun delivered(record: VideoSubmission) = synchronized(monitor) {
        recordMeasurement.acknowledged(record.timing)
        if (record.epoch == epoch && record in pending) {
            if (record.writtenAt != 0L && !record.delivered) measurement.add(VideoMeasurement.ACK, System.nanoTime() - record.writtenAt)
            record.delivered = true
            monitor.notifyAll()
        }
    }
    internal fun written(record: VideoSubmission) = synchronized(monitor) {
        recordMeasurement.written(record.timing)
        if (record.epoch == epoch && record in pending && record.writtenAt == 0L) {
            record.writtenAt = System.nanoTime()
            measurement.add(VideoMeasurement.QUEUE, record.writtenAt - record.queuedAt)
        }
    }

    internal fun failed(record: VideoSubmission, reason: String) = synchronized(monitor) {
        if (record in pending) {
            record.failure = reason
            monitor.notifyAll()
        }
    }

    /** Fence all old owners and callbacks on any queue/session retirement. */
    fun retire(reason: String) = synchronized(monitor) {
        check(epoch != Long.MAX_VALUE) { "Video connection epoch exhausted" }
        epoch++
        uncertainContexts = 0
        evidenceReserve = null
        refusalEvidenceTargets = 0
        pending.forEach { it.failure = reason }
        pending.forEach { recordMeasurement.finished(it.timing) }
        pending.clear()
        completions.clear()
        pages.clear()
        request = 0
        replyFailure = reason
        operations.values.filter { !it.complete }.forEach { it.error = reason; it.complete = true }
        monitor.notifyAll()
    }

    /** Copy a phone command and run it off the NativeScript/UI thread. */
    fun beginExchange(buffer: ByteBuffer, length: Int, targets: Int, ingressLeft: Boolean, resultOffset: Int): Long {
        val payload = snapshot(buffer)
        require(payload.size in 8..4096)
        return begin { generation ->
            val evidence = unsigned(payload[1]) == 7 && ((payload.size == 12 && unsigned(payload[8]) in 4..5) ||
                (payload.size == 24 && unsigned(payload[8]) == 6))
            exchange(payload, length, targets, ingressLeft, resultOffset, generation,
                deadline = System.nanoTime() + if (evidence) 2_000_000_000L else 15_000_000_000L)
                .joinToString(prefix = "[", postfix = "]") { data ->
                    "\"" + data.joinToString("") { unsigned(it).toString(16).padStart(2, '0') } + "\""
                }
        }
    }

    /** Fence an admitted NAL and the next picture's metadata in one queue window. */
    fun beginPicture(nalBuffer: ByteBuffer, metadataBuffer: ByteBuffer, targets: Int, ingressLeft: Boolean): Long {
        val nal = snapshot(nalBuffer)
        val metadata = snapshot(metadataBuffer)
        require(nal.size in 11..4096 && unsigned(nal[0]) == MESSAGE && unsigned(nal[1]) == 6)
        require(metadata.size == 24 && unsigned(metadata[0]) == MESSAGE && unsigned(metadata[1]) == 14)
        require(u32(nal, 2) == u32(metadata, 8) && u32(nal, 6) + 1 == u32(metadata, 16))
        return begin { generation ->
            exchange(metadata, 6, targets, ingressLeft, 5, generation, arrayOf(nal))
                .joinToString(prefix = "[", postfix = "]") { data ->
                    "\"" + data.joinToString("") { unsigned(it).toString(16).padStart(2, '0') } + "\""
                }
        }
    }

    /** A count and uint16 lengths bound one copied, four-record phone window. */
    fun beginWindow(buffer: ByteBuffer, targets: Int, ingressLeft: Boolean): Long {
        val data = snapshot(buffer)
        require(data.isNotEmpty() && unsigned(data[0]) in 1..4)
        var offset = 1
        val records = Array(unsigned(data[0])) {
            require(offset + 2 <= data.size)
            val size = u16(data, offset)
            offset += 2
            require(size in 2..4096 && offset + size <= data.size)
            data.copyOfRange(offset, offset + size).also { offset += size }
        }
        require(offset == data.size)
        return begin { generation -> writer.withLock {
            send(records, targets, ingressLeft, generation).joinToString(prefix = "[", postfix = "]")
        } }
    }

    /** Copy one credit-bounded batch; each optional command admits the next NAL. */
    fun beginPipeline(buffer: ByteBuffer, targets: Int, ingressLeft: Boolean): Long {
        val data = snapshot(buffer)
        require(data.isNotEmpty() && unsigned(data[0]) in 1..4)
        var offset = 1
        val following = arrayOfNulls<ByteArray>(unsigned(data[0]))
        val records = Array(following.size) { index ->
            require(offset + 2 <= data.size)
            val size = u16(data, offset); offset += 2
            require(size in 11..4096 && offset + size < data.size)
            val nal = data.copyOfRange(offset, offset + size); offset += size
            val present = unsigned(data[offset++]); require(present in 0..1)
            if (present == 1) {
                require(offset + 24 <= data.size)
                following[index] = data.copyOfRange(offset, offset + 24); offset += 24
            }
            nal
        }
        require(offset == data.size)
        return begin { generation -> pipeline(records, following, targets, ingressLeft, generation).joinToString(prefix = "[", postfix = "]") }
    }

    /** Metadata acceptance gates the next NAL, not the preceding NAL's ACK. */
    fun pipeline(records: Array<ByteArray>, following: Array<ByteArray?>, targets: Int,
                 ingressLeft: Boolean, generation: Long = epoch): IntArray = writer.withLock {
        require(targets in 1..3 && records.size in 1..4 && following.size == records.size)
        require(records.all { it.size in 11..4096 })
        val stream = u32(records[0], 2)
        records.forEachIndexed { i, nal ->
            require(nal.size in 11..4096 && unsigned(nal[0]) == MESSAGE && unsigned(nal[1]) == 6)
            require(u32(nal, 2) == stream && u32(nal, 6) == u32(records[0], 6) + i)
            following[i]?.let { meta ->
                require(meta.size == 24 && unsigned(meta[0]) == MESSAGE && unsigned(meta[1]) == 14)
                require(u32(meta, 8) == stream && u32(meta, 16) == u32(nal, 6) + 1)
            }
        }
        val deadline = System.nanoTime() + 15_000_000_000L
        val submitted = mutableListOf<VideoSubmission>()
        var admitted = 0
        synchronized(monitor) {
            check(epoch == generation) { "Video generation retired before submission" }
            check(pending.isEmpty()) { "Video record window is not fenced" }
        }
        fun room() = await(generation, deadline) {
            val done = submitted.filter { it in pending && it.delivered }
            check(done.all { it.accepted == targets }) { "Paired NAL transport refused" }
            done.forEach { recordMeasurement.finished(it.timing) }
            pending.removeAll(done.toSet())
            pending.size < 3
        }
        try {
            for (i in records.indices) {
                room()
                val record = VideoSubmission(records[i].copyOf(), targets, ingressLeft, generation, this)
                synchronized(monitor) {
                    check(epoch == generation) { "Video generation retired before submission" }
                    pending.add(record); submitted.add(record)
                }
                if (!queue.enqueue(record)) failed(record, "Video session is not ready")
                val meta = following[i] ?: continue
                room()
                val rows = exchange(meta, 6, targets, ingressLeft, 5, generation,
                    overlap = true, deadline = deadline)
                check(rows.all { unsigned(it[5]) in listOf(0, 3) && unsigned(it[4]) <= 4 &&
                    (unsigned(it[5]) != 0 || u32(it, 0) == u32(meta, 12)) }) { "Picture metadata refused" }
                if (rows.any { unsigned(it[5]) != 0 }) break
                admitted++
            }
            await(generation, deadline) { submitted.all { it.delivered } }
            check(submitted.all { it.accepted == targets }) { "Paired NAL transport refused" }
            intArrayOf(submitted.size, admitted)
        } finally {
            synchronized(monitor) {
                submitted.forEach { recordMeasurement.finished(it.timing) }
                pending.removeAll(submitted.toSet())
            }
            flushRefusalEvidence(ingressLeft, generation)
        }
    }

    private fun begin(work: (Long) -> String): Long {
        val id: Long
        val operation: Operation
        synchronized(monitor) {
            check(operations.size < 16 && nextOperation < 9_007_199_254_740_991L) { "Video operation limit reached" }
            id = nextOperation++
            operation = Operation(epoch)
            operations[id] = operation
        }
        executor.execute {
            try {
                check(epoch == operation.epoch) { "Video operation generation retired" }
                val result = work(operation.epoch)
                synchronized(monitor) {
                    if (!operation.complete && epoch == operation.epoch) operation.result = result
                    else if (operation.error.isEmpty()) operation.error = "Video operation generation retired"
                }
            } catch (error: Exception) {
                synchronized(monitor) { if (operation.error.isEmpty()) operation.error = error.message ?: error.javaClass.simpleName }
            } finally {
                synchronized(monitor) { operation.complete = true }
            }
        }
        return id
    }

    /** Zero is pending, one complete, minus one a retained failure or missing ID. */
    fun pollOperation(id: Long): Int = synchronized(monitor) {
        val operation = operations[id] ?: return -1
        if (!operation.complete) 0 else if (operation.error.isEmpty()) 1 else -1
    }

    /** Consume a completed operation exactly once, including its error evidence. */
    fun takeOperation(id: Long): String = synchronized(monitor) {
        val operation = operations[id] ?: throw IllegalStateException("Unknown video operation")
        check(operation.complete) { "Video operation still pending" }
        operations.remove(id)
        check(operation.error.isEmpty()) { operation.error }
        operation.result
    }

    private fun snapshot(buffer: ByteBuffer): ByteArray {
        val view = buffer.duplicate()
        require(view.remaining() <= 16_493)
        return ByteArray(view.remaining()).also { view.get(it) }
    }

    /** Route only CRC-validated video pages or exact ACKs for our native attempts. */
    fun receive(ingressLeft: Boolean, packet: ByteArray): Boolean {
        if (packet.size < 10 || unsigned(packet[0]) != 0xaa || unsigned(packet[1]) != 0x12 ||
            unsigned(packet[3]) != packet.size - 8 || unsigned(packet[4]) != 1 ||
            unsigned(packet[5]) != 1 || unsigned(packet[6]) != CfwTransport.SID || packet[7].toInt() != 0) return false
        if (unsigned(packet[8]) == MESSAGE) {
            val body = packet.copyOfRange(8, packet.size - 2)
            if (body.size !in 9..VIDEO_REPLY_MAX_BYTES || CfwTransport.crc(body) != u16(packet, packet.size - 2)) return true
            val side = unsigned(body[1])
            val id = u32(body, 2)
            val page = unsigned(body[6])
            val count = unsigned(body[7])
            if (side !in 1..2 || count !in 1..192 || page >= count) return true
            synchronized(monitor) {
                if (id != request || requestedTargets and side == 0 ||
                    queryIngressLeft != ingressLeft) return true
                val key = Pair(side, page)
                val value = Pair(count, body.copyOfRange(8, body.size))
                val old = pages[key]
                if (old != null && (old.first != count || !old.second.contentEquals(value.second)))
                    replyFailure = "Conflicting frozen video reply"
                else pages[key] = value
                monitor.notifyAll()
            }
            return true
        }
        val acks = CfwTransport.parseAcks(packet) ?: return false
        synchronized(monitor) {
            for (ack in acks) {
                val record = pending.firstOrNull {
                    it.epoch == epoch && it.ingressLeft == ingressLeft && it.message?.magic == ack.streamId
                } ?: continue
                val message = record.message!!
                if (record.attempt != message.magic) {
                    record.attempt = message.magic
                    record.acknowledged = 0
                    record.accepted = 0
                }
                if (ack.messageId != 0 || record.targets and ack.lens == 0 ||
                    (!ack.nack && (ack.size != message.message.size || ack.checksum != message.cfwChecksum))) continue
                if (record.acknowledged and ack.lens == 0) {
                    if (ack.nack) uncertainContexts = uncertainContexts or if (ingressLeft) 1 else 2
                    record.acknowledged = record.acknowledged or ack.lens
                    if (!ack.nack) record.accepted = record.accepted or ack.lens
                }
                if (record.acknowledged == record.targets && !record.listed) {
                    record.listed = true
                    completions.add(VideoCompletion(message, message.magic, epoch))
                }
            }
        }
        // Redundant ACK packets can also contain ordinary image successes.
        // Their native handler still needs the packet after our completions.
        return false
    }

    /** Submit up to four records without granting decoder credits implicitly. */
    fun sendWindow(records: Array<ByteArray>, targets: Int, ingressLeft: Boolean): IntArray = writer.withLock {
        send(records, targets, ingressLeft)
    }

    private fun send(records: Array<ByteArray>, targets: Int, ingressLeft: Boolean,
                     generation: Long = epoch, deadline: Long = System.nanoTime() + 15_000_000_000L,
                     overlap: Boolean = false): IntArray {
        require(targets in 1..3 && records.size in 1..4)
        require(records.all { it.size in 2..4096 && unsigned(it[0]) == MESSAGE })
        val submitted = records.map { VideoSubmission(it.copyOf(), targets, ingressLeft, generation, this) }
        synchronized(monitor) {
            check(epoch == generation) { "Video generation retired before submission" }
            check(pending.isEmpty() || overlap && pending.size + submitted.size <= 3) { "Video record window is not fenced" }
            pending.addAll(submitted)
        }
        try {
            for (record in submitted) {
                check(epoch == generation) { "Video generation retired before enqueue" }
                if (!queue.enqueue(record)) failed(record, "Video session is not ready")
            }
            await(generation, deadline) { submitted.all { it.delivered } }
            return submitted.map { it.accepted }.toIntArray()
        } finally {
            synchronized(monitor) {
                submitted.forEach { recordMeasurement.finished(it.timing) }
                pending.removeAll(submitted.toSet())
            }
        }
    }

    /** Fetch bounded pages of one frozen command reply, preserving refusal evidence. */
    fun exchange(payload: ByteArray, length: Int, targets: Int, ingressLeft: Boolean, resultOffset: Int,
                 generation: Long = epoch, leading: Array<ByteArray> = emptyArray(), overlap: Boolean = false,
                 deadline: Long = System.nanoTime() + 15_000_000_000L): Array<ByteArray> = writer.withLock {
        require(payload.size >= 8 && length in 1..192 && resultOffset in 0 until length)
        val id = u32(payload, 4)
        require(id in 1..0xfffffffeL)
        require(leading.size <= 1 && leading.all { it.size in 11..4096 && unsigned(it[0]) == MESSAGE && unsigned(it[1]) == 6 })
        synchronized(monitor) {
            check(epoch == generation) { "Video query generation retired" }
            check(request == 0L) { "Video query already active" }
            request = id
            queryTimingOp = unsigned(payload[1])
            requestedTargets = targets
            queryIngressLeft = ingressLeft
            replyFailure = null
            pages.clear()
        }
        val began = System.nanoTime()
        var complete = false
        var refusalTargets = 0
        var waiting = "transport ACK"
        try {
            val masks = send(leading + payload, targets, ingressLeft, generation, deadline, overlap)
            check(masks.take(leading.size).all { it == targets }) { "Paired NAL transport refused" }
            val accepted = masks.last()
            val sides = (1..2).filter { targets and it != 0 }
            for (side in sides.filter { accepted and it == 0 }) {
                val count = synchronized(monitor) { pages[Pair(side, 0)]?.first ?: 0 }
                System.err.println("Video command refused op=${unsigned(payload[1])} request=$id side=$side " +
                    "page=0 pages=$count attempt=1 elapsedMs=${(System.nanoTime() - began) / 1_000_000}")
            }
            waiting = "page0"
            await(generation, deadline) { sides.all { Pair(it, 0) in pages } }
            val result = mutableListOf<ByteArray>()
            for (side in sides) {
                val first = synchronized(monitor) { pages[Pair(side, 0)]!! }
                measurement.add(VideoMeasurement.PLANNED_PAGES, count = first.first.toLong())
                require(first.second.isNotEmpty() && first.first == (length + first.second.size - 1) / first.second.size)
                val data = ByteArray(length)
                first.second.copyInto(data)
                var offset = first.second.size
                for (page in 1 until first.first) {
                    waiting = "page=$page lens=$side ACK"
                    for (attempt in 1..4) {
                        // Refresh padding on retries too: persistent compression
                        // must not erase the proof of the reply packet budget.
                        val command = ByteArray(VIDEO_REPLY_MAX_BYTES - 5).also {
                            pagePadding.nextBytes(it)
                            byteArrayOf(31, 5, 1, 0, id.toByte(), (id shr 8).toByte(),
                                (id shr 16).toByte(), (id shr 24).toByte(), page.toByte()).copyInto(it)
                        }
                        val attemptAt = System.nanoTime()
                        val acceptedPage = send(arrayOf(command), side, ingressLeft, generation, deadline)[0] == side
                        measurement.add(VideoMeasurement.PAGE, System.nanoTime() - attemptAt)
                        if (acceptedPage) break
                        measurement.add(VideoMeasurement.REFUSAL)
                        refusalTargets = refusalTargets or side
                        val evidence = "Frozen page refused op=${unsigned(payload[1])} request=$id side=$side " +
                            "page=$page pages=${first.first} attempt=$attempt attempts=$attempt " +
                            "elapsedMs=${(System.nanoTime() - began) / 1_000_000} " +
                            "attemptMs=${(System.nanoTime() - attemptAt) / 1_000_000}"
                        System.err.println(evidence)
                        if (attempt == 4) throw VideoQueryUnavailable(evidence)
                        // Only repeat the read-only PAGE, never its owning command or NAL.
                        await(generation, deadline) { true }
                        val backoff = longArrayOf(50, 150, 400)[attempt - 1]
                        check(deadline - System.nanoTime() > backoff * 1_000_000) { "Video exact ACK or frozen page timed out" }
                        Thread.sleep(backoff)
                    }
                    waiting = "page=$page lens=$side reply"
                    val replyAt = System.nanoTime()
                    await(generation, deadline) { Pair(side, page) in pages }
                    measurement.add(VideoMeasurement.REPLY_WAIT, System.nanoTime() - replyAt)
                    val part = synchronized(monitor) { pages[Pair(side, page)]!! }
                    require(part.first == first.first && part.second.size == minOf(first.second.size, length - offset))
                    part.second.copyInto(data, offset)
                    offset += part.second.size
                }
                require(offset == length && (accepted and side != 0) == (unsigned(data[resultOffset]) == 0))
                result.add(data)
                measurement.add(VideoMeasurement.REPLY_BYTES, count = data.size.toLong())
            }
            complete = true
            result.toTypedArray()
        } catch (error: IllegalStateException) {
            if (error.message !in listOf("Video exact ACK or frozen page timed out", "Video native ACK timeout")) throw error
            val missing = synchronized(monitor) {
                if (epoch == generation) uncertainContexts = uncertainContexts or if (ingressLeft) 1 else 2
                (1..2).filter { targets and it != 0 && Pair(it, 0) !in pages }.joinToString(",")
            }
            val ingress = if (ingressLeft) "LEFT" else "RIGHT"
            throw VideoQueryUnavailable("Video query op=${unsigned(payload[1])} request=$id targets=$targets " +
                "ingress=$ingress waiting=$waiting missing=$missing " +
                "elapsedMs=${(System.nanoTime() - began) / 1_000_000}: ${error.message}")
        } finally {
            measurement.add(VideoMeasurement.QUERY, System.nanoTime() - began)
            if (!complete) measurement.add(VideoMeasurement.FAILURE)
            synchronized(monitor) { request = 0; pages.clear() }
            if (!collectingEvidence && epoch == generation) {
                refusalEvidenceTargets = refusalEvidenceTargets or refusalTargets
                if (!overlap) flushRefusalEvidence(ingressLeft, generation)
            }
        }
    }

    private fun flushRefusalEvidence(ingressLeft: Boolean, generation: Long) {
        if (collectingEvidence || epoch != generation) return
        val targets = refusalEvidenceTargets
        refusalEvidenceTargets = 0
        if (targets != 0) collectRefusalEvidence(targets, ingressLeft, generation)
    }

    /* Fence the whole pipeline: its unsent metadata already has reserved IDs.
     * An earlier diagnostic would advance high-water past those IDs, while a
     * fetch between every PAGE retry could also evict the parent's replay. */
    private fun collectRefusalEvidence(targets: Int, ingressLeft: Boolean, generation: Long) {
        val reserve = evidenceReserve ?: return
        collectingEvidence = true
        val deadline = System.nanoTime() + 2_000_000_000L
        try {
            for (side in 1..2) if (targets and side != 0 && epoch == generation) {
                try {
                    val id = reserve()
                    require(id in 1..0xfffffffeL)
                    val command = ByteArray(12)
                    command[0] = 31; command[1] = 7; command[2] = 1
                    for (i in 0..3) command[4 + i] = (id shr (8 * i)).toByte()
                    command[8] = 4; command[9] = if (ingressLeft) 0 else 1
                    val raw = exchange(command, 128, side, ingressLeft, 2, generation, deadline = deadline)[0]
                    require(raw[0].toInt() == 1 && raw[1].toInt() == 7 && raw[2].toInt() == 0 &&
                        raw[3].toInt() == 4 && raw[4].toInt() == 1 && unsigned(raw[5]) == (if (ingressLeft) 1 else 2) &&
                        unsigned(raw[6]) == side && unsigned(raw[7]) <= 4 && unsigned(raw[16]) == 24)
                    System.err.println("Video refusal ring side=$side origin=${unsigned(raw[5])} request=$id " +
                        "serial=${u32(raw, 8)} dropped=${u32(raw, 12)} rows=${unsigned(raw[7])}")
                    val reasons = arrayOf("none", "lock timeout", "missing entry", "page range", "capacity", "pending",
                        "reply allocation", "send failure", "format", "replay", "command")
                    for (i in 0 until unsigned(raw[7])) {
                        val at = 32 + i * 24
                        System.err.println("Video refusal side=$side serial=${u32(raw, at)} tick=${u32(raw, at + 4)} " +
                            "request=${u32(raw, at + 8)} op=${unsigned(raw[at + 12])} page=${unsigned(raw[at + 13])} " +
                            "reason=${reasons.getOrElse(unsigned(raw[at + 14])) { "unknown" }} " +
                            "budget=${unsigned(raw[at + 15])} frozen=${unsigned(raw[at + 16])} " +
                            "pages=${unsigned(raw[at + 17])} detail=${u32(raw, at + 20)}")
                    }
                } catch (error: Exception) {
                    System.err.println("Video refusal evidence unavailable side=$side: ${error.message}")
                }
            }
        } finally { collectingEvidence = false }
    }

    private fun await(generation: Long, deadline: Long, ready: () -> Boolean) {
        synchronized(monitor) {
            while (true) {
                check(epoch == generation) { "Video generation retired" }
                replyFailure?.let { throw IllegalStateException(it) }
                pending.firstOrNull { it.failure != null }?.let { throw IllegalStateException(it.failure) }
                if (ready()) return
                val remaining = deadline - System.nanoTime()
                check(remaining > 0) { "Video exact ACK or frozen page timed out" }
                monitor.wait(minOf(100L, remaining / 1_000_000L + 1))
            }
        }
    }

    companion object {
        const val MESSAGE = 31
        const val VIDEO_REPLY_MAX_BYTES = 200
        private fun unsigned(value: Byte) = value.toInt() and 255
        private fun u16(data: ByteArray, offset: Int) = unsigned(data[offset]) or (unsigned(data[offset + 1]) shl 8)
        private fun u32(data: ByteArray, offset: Int): Long =
            (0..3).fold(0L) { value, index -> value or (unsigned(data[offset + index]).toLong() shl (8 * index)) }
    }
}

package com.faceclaw.app

import java.util.concurrent.locks.ReentrantLock
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import kotlin.concurrent.withLock

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

    fun delivered() = transport.delivered(this)
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
    private val writer = ReentrantLock()
    private val monitor = java.lang.Object()
    private val pending = mutableListOf<VideoSubmission>()
    private val completions = mutableListOf<VideoCompletion>()
    private val pages = mutableMapOf<Pair<Int, Int>, Pair<Int, ByteArray>>()
    private var request = 0L
    private var requestedTargets = 0
    private var queryIngressLeft = true
    private var replyFailure: String? = null
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

    /** Remove native queue entries only after every selected lens answered exactly. */
    fun drainCompleted(): Array<VideoCompletion> = synchronized(monitor) {
        completions.toTypedArray().also { completions.clear() }
    }

    internal fun delivered(record: VideoSubmission) = synchronized(monitor) {
        if (record.epoch == epoch && record in pending) {
            record.delivered = true
            monitor.notifyAll()
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
        pending.forEach { it.failure = reason }
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
            exchange(payload, length, targets, ingressLeft, resultOffset, generation)
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
        require(view.remaining() <= 16_393)
        return ByteArray(view.remaining()).also { view.get(it) }
    }

    /** Route only CRC-validated video pages or exact ACKs for our native attempts. */
    fun receive(ingressLeft: Boolean, packet: ByteArray): Boolean {
        if (packet.size < 10 || unsigned(packet[0]) != 0xaa || unsigned(packet[1]) != 0x12 ||
            unsigned(packet[3]) != packet.size - 8 || unsigned(packet[4]) != 1 ||
            unsigned(packet[5]) != 1 || unsigned(packet[6]) != CfwTransport.SID || packet[7].toInt() != 0) return false
        if (unsigned(packet[8]) == MESSAGE) {
            val body = packet.copyOfRange(8, packet.size - 2)
            if (body.size !in 9..30 || CfwTransport.crc(body) != u16(packet, packet.size - 2)) return true
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
                     generation: Long = epoch, deadline: Long = System.nanoTime() + 15_000_000_000L): IntArray {
        require(targets in 1..3 && records.size in 1..4)
        require(records.all { it.size in 2..4096 && unsigned(it[0]) == MESSAGE })
        val submitted = records.map { VideoSubmission(it.copyOf(), targets, ingressLeft, generation, this) }
        synchronized(monitor) {
            check(epoch == generation) { "Video generation retired before submission" }
            check(pending.isEmpty()) { "Video record window is not fenced" }
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
            synchronized(monitor) { pending.removeAll(submitted.toSet()) }
        }
    }

    /** Fetch bounded pages of one frozen command reply, preserving refusal evidence. */
    fun exchange(payload: ByteArray, length: Int, targets: Int, ingressLeft: Boolean, resultOffset: Int,
                 generation: Long = epoch): Array<ByteArray> = writer.withLock {
        require(payload.size >= 8 && length in 1..192 && resultOffset in 0 until length)
        val id = u32(payload, 4)
        require(id in 1..0xfffffffeL)
        val deadline = System.nanoTime() + 15_000_000_000L
        synchronized(monitor) {
            check(epoch == generation) { "Video query generation retired" }
            check(request == 0L) { "Video query already active" }
            request = id
            requestedTargets = targets
            queryIngressLeft = ingressLeft
            replyFailure = null
            pages.clear()
        }
        try {
            val accepted = send(arrayOf(payload), targets, ingressLeft, generation, deadline)[0]
            val sides = (1..2).filter { targets and it != 0 }
            await(generation, deadline) { sides.all { Pair(it, 0) in pages } }
            val result = mutableListOf<ByteArray>()
            for (side in sides) {
                val first = synchronized(monitor) { pages[Pair(side, 0)]!! }
                require(first.second.isNotEmpty() && first.first == (length + first.second.size - 1) / first.second.size)
                val data = ByteArray(length)
                first.second.copyInto(data)
                var offset = first.second.size
                for (page in 1 until first.first) {
                    val command = byteArrayOf(31, 5, 1, 0,
                        id.toByte(), (id shr 8).toByte(), (id shr 16).toByte(), (id shr 24).toByte(), page.toByte())
                    check(send(arrayOf(command), side, ingressLeft, generation, deadline)[0] == side) { "Frozen page refused" }
                    await(generation, deadline) { Pair(side, page) in pages }
                    val part = synchronized(monitor) { pages[Pair(side, page)]!! }
                    require(part.first == first.first && part.second.size == minOf(first.second.size, length - offset))
                    part.second.copyInto(data, offset)
                    offset += part.second.size
                }
                require(offset == length && (accepted and side != 0) == (unsigned(data[resultOffset]) == 0))
                result.add(data)
            }
            result.toTypedArray()
        } finally {
            synchronized(monitor) { request = 0; pages.clear() }
        }
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
        private fun unsigned(value: Byte) = value.toInt() and 255
        private fun u16(data: ByteArray, offset: Int) = unsigned(data[offset]) or (unsigned(data[offset + 1]) shl 8)
        private fun u32(data: ByteArray, offset: Int): Long =
            (0..3).fold(0L) { value, index -> value or (unsigned(data[offset + index]).toLong() shl (8 * index)) }
    }
}

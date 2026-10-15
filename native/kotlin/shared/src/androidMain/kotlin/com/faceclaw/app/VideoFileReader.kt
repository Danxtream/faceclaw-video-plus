package com.faceclaw.app

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Bounded Annex B payloads; all disk scans and reads run off the UI thread. */
class VideoFileReader(private val path: String) : AutoCloseable {
    data class Nal(val offset: Long, val bytes: Int, val type: Int, val sha256: String)
    data class Audit(val bytes: Long, val sha256: String, val nals: List<Nal>)

    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "video-file").apply { isDaemon = true }
    }
    private var pending: Future<String>? = null
    private var audited: Audit? = null
    private var modified = 0L
    private var closed = false
    // Opening the file for every NAL cost ~3 ms per picture on the phone; keep one
    // handle per audit. Guarded by `io`, which is never held while taking `this`.
    private val io = Any()
    private var input: RandomAccessFile? = null
    private var inputClosed = false

    @Synchronized fun beginAudit() {
        submit {
            val file = File(path)
            val stamp = file.lastModified()
            val result = audit(file)
            require(file.length() == result.bytes && file.lastModified() == stamp) { "Video changed during audit" }
            synchronized(io) { input?.close(); input = null }
            synchronized(this) { check(!closed); audited = result; modified = stamp }
            "{\"bytes\":${result.bytes},\"sha256\":\"${result.sha256}\",\"nals\":[" +
                result.nals.joinToString(",") { "{\"offset\":${it.offset},\"bytes\":${it.bytes},\"type\":${it.type},\"sha256\":\"${it.sha256}\"}" } + "]}"
        }
    }

    @Synchronized fun beginRead(index: Int) {
        val checked = checkNotNull(audited) { "Video has not been audited" }
        require(index in checked.nals.indices) { "NAL index outside audited source" }
        submit { "\"${hex(readNalBytes(index))}\"" }
    }

    internal fun nalCount(): Int = synchronized(this) { check(!closed); checkNotNull(audited).nals.size }

    /** Caller must be a background writer; never convert payload bytes to hex. */
    internal fun readNalBytes(index: Int): ByteArray {
        val (checked, stamp) = synchronized(this) { check(!closed); Pair(checkNotNull(audited), modified) }
        require(index in checked.nals.indices) { "NAL index outside audited source" }
        check(!Thread.currentThread().isInterrupted) { "Video read cancelled" }
        val nal = checked.nals[index]
        val file = File(path)
        require(file.length() == checked.bytes && file.lastModified() == stamp) { "Video source changed" }
        val bytes = ByteArray(nal.bytes)
        synchronized(io) {
            check(!inputClosed) { "Video file reader is closed" }
            val handle = input ?: RandomAccessFile(file, "r").also { input = it }
            handle.seek(nal.offset); handle.readFully(bytes)
        }
        require(digest(bytes) == nal.sha256) { "Audited NAL changed" }
        synchronized(this) { check(!closed) }
        return bytes
    }

    /** 0 pending, 1 complete; takeResult propagates worker errors unchanged. */
    @Synchronized fun poll(): Int = if (checkNotNull(pending).isDone) 1 else 0
    @Synchronized fun takeResult(): String {
        val result = checkNotNull(pending)
        check(result.isDone) { "Video file operation is still pending" }
        pending = null
        return result.get()
    }

    @Synchronized private fun submit(task: () -> String) {
        check(!closed && pending == null) { "Video file reader is closed or busy" }
        pending = worker.submit<String> { task() }
    }

    @Synchronized override fun close() {
        if (closed) return
        closed = true
        pending?.cancel(true)
        pending = null
        audited = null
        worker.shutdownNow()
        synchronized(io) { inputClosed = true; input?.close(); input = null }
    }

    companion object {
        private const val MAX_NAL_BYTES = 4086
        private const val SCAN_BUFFER_BYTES = 256 * 1024

        internal fun hex(bytes: ByteArray): String {
            val digits = "0123456789abcdef"
            val output = CharArray(bytes.size * 2)
            for (i in bytes.indices) {
                val value = bytes[i].toInt() and 255
                output[i * 2] = digits[value shr 4]
                output[i * 2 + 1] = digits[value and 15]
            }
            return String(output)
        }
        internal fun digest(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

        /** Index start codes without treating a VCL NAL as a completed picture. */
        internal fun audit(file: File): Audit {
            val hash = MessageDigest.getInstance("SHA-256")
            val nals = ArrayList<Nal>()
            val payload = ByteArrayOutputStream(MAX_NAL_BYTES)
            var position = 0L
            var start = -1L
            var zeros = 0
            fun append(value: Int) {
                require(payload.size() < MAX_NAL_BYTES) { "Complete NAL exceeds 4086 bytes" }
                payload.write(value)
            }
            fun finish() {
                require(payload.size() > 0) { "Empty Annex B NAL" }
                val bytes = payload.toByteArray()
                val header = bytes[0].toInt() and 255
                val type = header and 31
                require(header and 128 == 0 && type in listOf(1, 5, 6, 7, 8, 9, 12)) { "Unsupported video NAL type" }
                nals.add(Nal(start, bytes.size, type, digest(bytes)))
                payload.reset()
            }
            BufferedInputStream(file.inputStream(), SCAN_BUFFER_BYTES).use { input ->
                val buffer = ByteArray(SCAN_BUFFER_BYTES)
                while (true) {
                    check(!Thread.currentThread().isInterrupted) { "Video audit cancelled" }
                    val count = input.read(buffer)
                    if (count < 0) break
                    hash.update(buffer, 0, count)
                    for (i in 0 until count) {
                        val value = buffer[i].toInt() and 255
                        if (value == 0) {
                            require(zeros < MAX_NAL_BYTES + SCAN_BUFFER_BYTES) { "Excessive Annex B padding" }
                            zeros++
                        } else if (value == 1 && zeros >= 2) {
                            if (start >= 0) finish()
                            start = position + 1
                            zeros = 0
                        } else {
                            require(start >= 0) { "Missing Annex B start code" }
                            repeat(zeros) { append(0) }
                            zeros = 0
                            append(value)
                        }
                        position++
                    }
                }
            }
            require(start >= 0) { "Empty or non-Annex B video" }
            finish() // Annex B trailing_zero_8bits are not part of the final NAL.
            require(nals.any { it.type == 7 } && nals.any { it.type == 8 } && nals.any { it.type == 5 }) {
                "Video lacks SPS, PPS or IDR"
            }
            return Audit(position, hex(hash.digest()), nals)
        }
    }
}

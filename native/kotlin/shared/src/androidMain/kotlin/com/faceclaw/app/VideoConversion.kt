package com.faceclaw.app

import android.system.Os
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegKitConfig
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Scope the process-wide report setting so subsequent probes retain JSON output. */
internal fun <T> withVideoReport(report: String, read: () -> String? = { System.getenv("FFREPORT") },
    write: (String) -> Unit = { check(FFmpegKitConfig.setEnvironmentVariable("FFREPORT", it) == 0) },
    unset: () -> Unit = { Os.unsetenv("FFREPORT") }, block: () -> T): T {
    require(report.isNotEmpty())
    val previous = read()?.takeIf { it.isNotEmpty() }
    try { write(report); return block() }
    finally { if (previous == null) unset() else write(previous) }
}

/** Pair no-reordering access units with decoded pictures; FFmpeg 8 omits frame packet fields. */
internal fun <T> videoDecodedPictures(frames: List<T>, packets: List<T>, number: (T, String) -> Long,
    text: (T, String) -> String, checkActive: () -> Unit = {}): List<VideoDecodedPicture> {
    require(frames.size == packets.size) { "Packet and decoded picture counts disagree" }
    return frames.mapIndexed { index, frame ->
        checkActive()
        val packet = packets[index]
        val key = number(frame, "key_frame")
        require(key in 0L..1L && text(packet, "flags").contains('K') == (key == 1L)) {
            "Packet and decoded keyframe flags disagree at picture $index"
        }
        VideoDecodedPicture(number(packet, "pos"), number(packet, "size"), key == 1L,
            number(frame, "width").toInt(), number(frame, "height").toInt(), text(frame, "pix_fmt"), text(frame, "pict_type"),
            number(frame, "interlaced_frame").toInt(), number(frame, "repeat_pict").toInt())
    }
}

/** A single native conversion job; no BLE, firmware, repair pass or auto-downrate. */
class VideoConversion(private val input: File, private val deblocking: Boolean, private val overwrite: Boolean,
    private val fps: Int = 15,
    private val progress: (String, Double) -> Unit) {
    init { VideoEncodePlan.checkRate(fps) }
    private val cancelled = AtomicBoolean(false)
    private val sessionId = AtomicLong(0)
    @Volatile private var thread: Thread? = null

    fun cancel() {
        cancelled.set(true)
        val id = sessionId.get()
        if (id > 0) FFmpegKit.cancel(id)
        thread?.interrupt()
    }
    private fun checkActive() { check(!cancelled.get() && !Thread.currentThread().isInterrupted) { "Video conversion cancelled" } }
    private fun hash(file: File): String {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered(256 * 1024).use { source ->
            val bytes = ByteArray(256 * 1024)
            while (true) { checkActive(); val count = source.read(bytes); if (count < 0) break; hash.update(bytes, 0, count) }
        }
        return VideoFileReader.hex(hash.digest())
    }
    private fun execute(args: Array<String>, duration: Double = 0.0): FFmpegSession {
        checkActive()
        val done = CountDownLatch(1)
        val session = FFmpegKit.executeWithArgumentsAsync(args, { done.countDown() }, {}, { stat ->
            if (!cancelled.get() && duration > 0) progress("encoding", (stat.time / duration).coerceIn(0.0, 0.99))
        })
        sessionId.set(session.sessionId)
        try {
            while (!done.await(200, TimeUnit.MILLISECONDS)) checkActive()
            checkActive()
            check(ReturnCode.isSuccess(session.returnCode)) { "FFmpeg failed: ${session.output.takeLast(1000)}" }
            return session
        } finally {
            if (cancelled.get() || Thread.currentThread().isInterrupted) FFmpegKit.cancel(session.sessionId)
            sessionId.set(0)
        }
    }
    private fun probe(args: Array<String>): JSONObject {
        checkActive()
        val done = CountDownLatch(1)
        val session = FFprobeKit.executeWithArgumentsAsync(args) { done.countDown() }
        sessionId.set(session.sessionId)
        try {
            while (!done.await(200, TimeUnit.MILLISECONDS)) checkActive()
            checkActive()
            check(ReturnCode.isSuccess(session.returnCode)) { "FFprobe failed: ${session.output.takeLast(1000)}" }
            return JSONObject(session.output)
        } finally {
            if (cancelled.get() || Thread.currentThread().isInterrupted) session.cancel()
            sessionId.set(0)
        }
    }
    fun run(): File {
        thread = Thread.currentThread()
        require(input.isFile && input.name.endsWith(".mp4", true)) { "Select an MP4 source" }
        val bytes = input.length()
        val modified = input.lastModified()
        val base = input.name.substringBeforeLast('.')
        val encoded = File(input.parentFile, "$base.h264")
        val metadata = File(input.parentFile, "$base.g2.json")
        val publication = VideoPublication(encoded, metadata, overwrite)
        try {
            progress("verifying source", 0.0)
            val sourceHash = hash(input)
            val sourceInfo = probe(arrayOf("-v", "error", "-show_entries", "format=duration", "-of", "json", input.path))
            val duration = sourceInfo.getJSONObject("format").getDouble("duration") * 1000
            require(duration.isFinite() && duration > 0) { "Invalid MP4 duration" }
            val args = VideoEncodePlan.arguments(input.path, publication.candidate.path, deblocking, fps)
            progress("encoding", 0.0)
            execute(args, duration)
            progress("auditing headers", 0.99)
            // FFmpeg's report logs to disk at INFO while stderr remains ERROR;
            // trace output does not accumulate in FFmpegKit's session history.
            withVideoReport("file=${publication.report.path}:level=32") {
                execute(arrayOf("-nostdin", "-report", "-v", "error", "-f", "h264", "-i", publication.candidate.path,
                    "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"))
            }
            val headerAudit = VideoHeaderAudit(deblocking, fps)
            publication.report.bufferedReader().useLines { lines -> lines.forEach { checkActive(); headerAudit.accept(it + "\n") } }
            headerAudit.finish()
            val audit = VideoFileReader.audit(publication.candidate)
            progress("decoding audit", 0.99)
            // Keep arrays separate: combined packet/frame probes interleave JSON records.
            val packets = probe(arrayOf("-v", "error", "-framerate", fps.toString(), "-f", "h264", "-show_packets",
                "-show_entries", "packet=pos,size,flags", "-of", "json", publication.candidate.path)).getJSONArray("packets")
            val decoded = probe(arrayOf("-v", "error", "-err_detect", "explode", "-framerate", fps.toString(), "-f", "h264",
                "-show_frames", "-show_entries", "frame=key_frame,width,height,pix_fmt,pict_type,repeat_pict,interlaced_frame",
                "-of", "json", publication.candidate.path)).getJSONArray("frames")
            val frames = videoDecodedPictures((0 until decoded.length()).map(decoded::getJSONObject),
                (0 until packets.length()).map(packets::getJSONObject),
                JSONObject::getLong, JSONObject::getString, ::checkActive)
            val pictures = VideoPictureMap.build(audit, frames, fps)
            require(headerAudit.slices == pictures.size) { "Header and decoded picture counts disagree" }
            require(input.length() == bytes && input.lastModified() == modified && hash(input) == sourceHash) { "MP4 changed during conversion" }
            checkActive()
            val sidecar = JSONObject().put("version", 1).put("width", 320).put("height", 192).put("fps", fps)
                .put("duration", (pictures.size * 1000L + fps / 2) / fps).put("range", "full").put("deblocking", deblocking)
                .put("encoder", "${VideoEncodePlan.ENCODER}; FFmpeg ${FFmpegKitConfig.getFFmpegVersion()}")
                .put("options", JSONArray(args.toList())).put("source", JSONObject().put("name", input.name).put("bytes", bytes).put("sha256", sourceHash))
                .put("h264", JSONObject().put("bytes", audit.bytes).put("sha256", audit.sha256)
                    .put("nals", JSONArray(audit.nals.map { JSONObject().put("offset", it.offset).put("bytes", it.bytes).put("type", it.type).put("sha256", it.sha256) })))
                .put("pictures", JSONArray(pictures.map { JSONObject().put("pts", it.pts).put("nal", it.nal).put("idr", it.idr).put("sps", it.sps).put("pps", it.pps) }))
            FileOutputStream(publication.sidecar).use { output -> output.write(sidecar.toString().toByteArray(Charsets.UTF_8)); output.fd.sync() }
            FileOutputStream(publication.candidate, true).use { it.fd.sync() }
            checkActive()
            publication.publish()
            progress("complete", 1.0)
            return encoded
        } finally { publication.cleanup(); thread = null }
    }
}

package com.faceclaw.app

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.PlaybackParams
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import kotlin.math.abs

internal interface VideoAudioDevice : AutoCloseable {
    val duration: Int
    val position: Int
    val playing: Boolean
    fun prepare(path: String)
    fun seek(position: Int)
    fun speed(value: Float)
    fun play()
    fun pause()
}

private class AndroidVideoAudioDevice : VideoAudioDevice {
    private val player = MediaPlayer()
    override val duration: Int get() = player.duration
    override val position: Int get() = player.currentPosition
    override val playing: Boolean get() = player.isPlaying
    override fun prepare(path: String) {
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
        player.setDataSource(path)
        val prepared = CountDownLatch(1)
        var failure: String? = null
        player.setOnPreparedListener { prepared.countDown() }
        player.setOnErrorListener { _, what, extra -> failure = "Phone audio preparation failed: $what/$extra"; prepared.countDown(); true }
        try {
            player.prepareAsync()
            check(prepared.await(10, TimeUnit.SECONDS)) { "Phone audio preparation timed out" }
            check(failure == null) { failure!! }
        } finally { player.setOnPreparedListener(null); player.setOnErrorListener(null) }
    }
    override fun seek(position: Int) {
        val complete = CountDownLatch(1)
        player.setOnSeekCompleteListener { complete.countDown() }
        try {
            player.seekTo(position)
            check(complete.await(10, TimeUnit.SECONDS)) { "Phone audio seek timed out" }
        } finally { player.setOnSeekCompleteListener(null) }
    }
    override fun speed(value: Float) {
        // setPlaybackParams may start a prepared player; the adapter restores pause.
        player.playbackParams = PlaybackParams().setSpeed(value).setPitch(1f)
    }
    override fun play() = player.start()
    override fun pause() = player.pause()
    override fun close() = player.release()
}

/** Verified MP4 audio on the normal media route, with no video Surface. */
class VideoAudioPlayer internal constructor(private val factory: () -> VideoAudioDevice) : AutoCloseable {
    constructor() : this({ AndroidVideoAudioDevice() })
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "video-audio").apply { isDaemon = true } }
    private var device: VideoAudioDevice? = null
    private var pending: Future<Int>? = null
    private var closed = false
    private var speed = 1f
    @Volatile private var preparingMedia = false
    fun isPreparingMedia(): Boolean = preparingMedia

    @Synchronized fun beginPrepare(path: String, bytes: Long, sha256: String) {
        require(bytes > 0 && sha256.matches(Regex("[0-9a-f]{64}"))) { "Invalid source audio identity" }
        submit {
            val file = File(path)
            val modified = file.lastModified()
            require(file.length() == bytes) { "Source MP4 size changed" }
            val hash = MessageDigest.getInstance("SHA-256")
            file.inputStream().buffered(256 * 1024).use { input ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    check(!Thread.currentThread().isInterrupted) { "Audio verification cancelled" }
                    val count = input.read(buffer)
                    if (count < 0) break
                    hash.update(buffer, 0, count)
                }
            }
            require(VideoFileReader.hex(hash.digest()) == sha256 && file.length() == bytes && file.lastModified() == modified) {
                "Source MP4 does not match the video conversion"
            }
            check(device == null) { "Phone audio already prepared" }
            val created = factory()
            try {
                preparingMedia = true
                try { created.prepare(path) } finally { preparingMedia = false }
                require(created.duration > 0 && file.length() == bytes && file.lastModified() == modified) { "Invalid or changed source audio" }
                device = created
                created.duration
            } catch (error: Throwable) { created.close(); throw error }
        }
    }

    @Synchronized fun beginSync(position: Int, playing: Boolean, rate: Double, tolerance: Int) {
        require(position >= 0 && tolerance >= 0 && rate.isFinite() && rate in 0.25..2.0) { "Invalid phone audio observation" }
        submit {
            val audio = checkNotNull(device) { "Phone audio is not prepared" }
            val target = position.coerceAtMost(audio.duration)
            if (abs(audio.position.toLong() - target) > tolerance) {
                if (audio.playing) audio.pause()
                audio.seek(target)
            }
            if (playing && speed != rate.toFloat()) { audio.speed(rate.toFloat()); speed = rate.toFloat() }
            if (playing && !audio.playing) audio.play()
            if (!playing && audio.playing) audio.pause()
            audio.position
        }
    }

    @Synchronized fun beginPause() {
        submit { device?.let { if (it.playing) it.pause() }; 0 }
    }
    @Synchronized fun poll(): Int = if (checkNotNull(pending).isDone) 1 else 0
    @Synchronized fun takeResult(): Int {
        val result = checkNotNull(pending)
        check(result.isDone) { "Phone audio is still pending" }
        pending = null
        return result.get()
    }
    @Synchronized private fun submit(task: () -> Int) {
        check(!closed && pending == null) { "Phone audio is closed or busy" }
        pending = worker.submit<Int> { task() }
    }
    /** Release stays ordered behind any cancelled preparation; no UI-thread I/O. */
    @Synchronized override fun close() {
        if (closed) return
        closed = true
        pending?.cancel(true)
        pending = null
        worker.submit { device?.close(); device = null }
        worker.shutdown()
    }
}

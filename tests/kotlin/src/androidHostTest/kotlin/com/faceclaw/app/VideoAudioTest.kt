package com.faceclaw.app

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoAudioTest {
    private class Device : VideoAudioDevice {
        val events = CopyOnWriteArrayList<String>()
        override val duration = 2000
        override var position = 0
        override var playing = false
        override val presented: Long get() = position.toLong()
        override fun prepare(path: String) { events.add("prepare") }
        override fun seek(position: Int) { check(!playing); this.position = position; events.add("seek:$position") }
        override fun speed(value: Float) { events.add("speed:$value"); playing = true }
        override fun play() { playing = true; events.add("play") }
        override fun pause() { playing = false; events.add("pause") }
        override fun close() { playing = false; events.add("close") }
    }
    private fun result(player: VideoAudioPlayer): Int {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (player.poll() == 0) { check(System.nanoTime() < deadline); Thread.sleep(1) }
        return player.takeResult()
    }
    @Test fun sourceHashMustMatchBeforeCreatingAMediaPlayer() {
        val file = File.createTempFile("video-audio", ".mp4").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        var created = 0
        val player = VideoAudioPlayer { created++; Device() }
        try {
            player.beginPrepare(file.path, 3, "0".repeat(64))
            assertFails { result(player) }
            assertEquals(0, created)
            player.beginPrepare(file.path, 3, VideoFileReader.digest(file.readBytes()))
            assertEquals(2000, result(player))
            assertEquals(1, created)
        } finally { player.close(); file.delete() }
    }
    @Test fun seekIsPausedAndClampedAndRateUsesObservedCopyCadence() {
        val file = File.createTempFile("video-audio", ".mp4").apply { writeBytes(byteArrayOf(1)) }
        val device = Device()
        val player = VideoAudioPlayer { device }
        try {
            player.beginPrepare(file.path, 1, VideoFileReader.digest(file.readBytes())); result(player)
            player.beginSync(1000, true, 0.8, 100); assertEquals(1000, result(player))
            assertTrue(device.playing)
            assertEquals(listOf("prepare", "seek:1000", "speed:0.8"), device.events.toList())
            player.beginSync(5000, false, 1.0, 0); assertEquals(2000, result(player))
            assertFalse(device.playing)
            assertEquals(listOf("pause", "seek:2000"), device.events.takeLast(2))
            player.beginSync(1990, false, 1.0, 100); result(player)
            assertEquals("seek:2000", device.events.last())
            player.beginPause(); result(player)
            assertFails { player.beginSync(-1, true, 1.0, 0) }
            assertFails { player.beginSync(0, true, Double.NaN, 0) }
        } finally { player.close(); file.delete() }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!device.events.contains("close")) { check(System.nanoTime() < deadline); Thread.sleep(1) }
        assertEquals(1, device.events.count { it == "close" })
        player.close()
        assertFails { player.beginPause() }
    }
}

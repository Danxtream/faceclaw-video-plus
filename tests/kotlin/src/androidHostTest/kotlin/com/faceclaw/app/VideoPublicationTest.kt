package com.faceclaw.app

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoPublicationTest {
    @Test fun pairAppearsOnlyFromCompleteCandidatesAndOverwriteIsExplicit() {
        val directory = Files.createTempDirectory("video-publication").toFile()
        val encoded = File(directory, "video.h264")
        val metadata = File(directory, "video.g2.json")
        try {
            val first = VideoPublication(encoded, metadata, false)
            first.candidate.writeText("encoded")
            assertFails { first.publish() }
            assertFalse(encoded.exists())
            first.sidecar.writeText("sidecar")
            first.publish(); first.cleanup()
            assertEquals("encoded", encoded.readText()); assertEquals("sidecar", metadata.readText())
            assertEquals(2, directory.listFiles()!!.size)
            assertFails { VideoPublication(encoded, metadata, false) }
            val replacement = VideoPublication(encoded, metadata, true)
            replacement.candidate.writeText("new-encoded"); replacement.sidecar.writeText("new-sidecar")
            replacement.publish(); replacement.cleanup()
            assertEquals("new-encoded", encoded.readText()); assertEquals("new-sidecar", metadata.readText())
            assertEquals(2, directory.listFiles()!!.size)
        } finally { directory.listFiles().orEmpty().forEach { if (it.isFile) it.delete() }; directory.delete() }
    }
    @Test fun cancellationDiscardsOnlyOwnedPartsAndPreservesExistingFiles() {
        val directory = Files.createTempDirectory("video-cancellation").toFile()
        val encoded = File(directory, "video.h264").apply { writeText("old") }
        val metadata = File(directory, "video.g2.json").apply { writeText("old-meta") }
        try {
            val candidate = VideoPublication(encoded, metadata, true)
            candidate.candidate.writeText("cancelled")
            candidate.cleanup()
            assertEquals("old", encoded.readText()); assertEquals("old-meta", metadata.readText())
            assertEquals(2, directory.listFiles()!!.size)
            assertTrue(encoded.isFile)
        } finally { encoded.delete(); metadata.delete(); directory.delete() }
    }
    @Test fun cleanupEmptiesTheReportFfmpegStillHolds() {
        val directory = Files.createTempDirectory("video-report").toFile()
        val held = File(directory, "held-report.txt")
        try {
            val job = VideoPublication(File(directory, "video.h264"), File(directory, "video.g2.json"), false)
            job.report.writeText("trace headers")
            // A second link stands in for FFmpeg's report handle, which is never closed.
            Files.createLink(held.toPath(), job.report.toPath())
            job.cleanup()
            assertFalse(job.report.exists())
            assertEquals(0L, held.length())
        } finally { directory.listFiles().orEmpty().forEach { if (it.isFile) it.delete() }; directory.delete() }
    }
}

package com.faceclaw.app

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class VideoFileReaderTest {
    private val prefix = byteArrayOf(0, 0, 0, 1)
    private fun file(bytes: ByteArray): File = File.createTempFile("video-reader", ".h264").apply { writeBytes(bytes) }
    private fun valid() = prefix + byteArrayOf(0x67, 42) + byteArrayOf(0, 0, 1, 0x68, 43) + prefix + byteArrayOf(0x65, 44)
    private fun result(reader: VideoFileReader): String {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (reader.poll() == 0) { check(System.nanoTime() < deadline); Thread.sleep(1) }
        return reader.takeResult()
    }

    @Test fun indexesMixedStartCodesAndPreservesWholeFileHash() {
        val source = file(valid() + byteArrayOf(0, 0))
        try {
            val audit = VideoFileReader.audit(source)
            assertEquals(listOf(4L, 9L, 15L), audit.nals.map { it.offset })
            assertEquals(listOf(7, 8, 5), audit.nals.map { it.type })
            assertEquals(listOf(2, 2, 2), audit.nals.map { it.bytes })
            assertEquals(VideoFileReader.digest(source.readBytes()), audit.sha256)
        } finally { source.delete() }
    }

    @Test fun exactNalLimitAndMalformedInputAreRefusedWithoutGuessing() {
        val sources = listOf(byteArrayOf(), byteArrayOf(1, 2), prefix + prefix,
            prefix + byteArrayOf(0xe7.toByte(), 1), prefix + byteArrayOf(0x67, 1),
            valid() + prefix + byteArrayOf(0x61) + ByteArray(4086) { 2 })
        for (bytes in sources) {
            val source = file(bytes)
            try { assertFails { VideoFileReader.audit(source) } } finally { source.delete() }
        }
        val source = file(valid() + prefix + byteArrayOf(0x61) + ByteArray(4085) { 2 })
        try { assertEquals(4086, VideoFileReader.audit(source).nals.last().bytes) } finally { source.delete() }
    }

    @Test fun boundarySpanningStartCodesAndLargeFilesStayBounded() {
        val source = file(valid() + (1..150_000).flatMap { (prefix + byteArrayOf(0x61, 42)).toList() }.toByteArray())
        try { assertEquals(150_003, VideoFileReader.audit(source).nals.size) } finally { source.delete() }
    }

    @Test fun asyncReaderOwnsItsIndexAndDetectsSameSizeMutation() {
        val source = file(valid())
        val reader = VideoFileReader(source.path)
        try {
            assertFails { reader.beginRead(0) }
            reader.beginAudit()
            assertFails { reader.beginAudit() }
            assertTrue(result(reader).contains("\"nals\""))
            assertEquals(listOf(0x67.toByte(), 42.toByte()), reader.readNalBytes(0).toList())
            assertFails { reader.beginRead(3) }
            reader.beginRead(0)
            assertEquals("\"672a\"", result(reader))
            val stamp = source.lastModified()
            source.writeBytes(valid().apply { this[5] = 99 })
            source.setLastModified(stamp)
            assertFails { reader.readNalBytes(0) }
            reader.beginRead(0)
            assertFails { result(reader) }
        } finally { reader.close(); source.delete() }
        assertFails { reader.beginAudit() }
        reader.close()
    }
}

package com.faceclaw.app

import java.io.File

/** Same-directory publication: sidecar hash is the commit marker for the pair. */
class VideoPublication(private val encoded: File, private val metadata: File, private val overwrite: Boolean) {
    private val directory = encoded.canonicalFile.parentFile
    private val work = File(directory, ".g2-video-${java.util.UUID.randomUUID()}")
    val candidate: File
    val sidecar: File
    val report: File
    private val previousEncoded: File
    private val previousMetadata: File
    init {
        require(encoded != metadata && metadata.canonicalFile.parentFile == directory)
        require(!encoded.isDirectory && !metadata.isDirectory)
        require(overwrite || !encoded.exists() && !metadata.exists()) { "Converted output exists; explicit overwrite required" }
        check(work.mkdir()) { "Could not create private conversion workspace" }
        candidate = File(work, "video.h264.part")
        sidecar = File(work, "video.g2.json.part")
        report = File(work, "headers.txt")
        previousEncoded = File(work, "previous.h264")
        previousMetadata = File(work, "previous.g2.json")
    }
    /** No copy fallback: a failed rename is an error, never a half-written final file. */
    fun publish() {
        require(candidate.isFile && sidecar.isFile) { "Missing audited conversion candidate" }
        require(overwrite || !encoded.exists() && !metadata.exists()) { "Converted output appeared during conversion" }
        var oldEncoded = false
        var oldMetadata = false
        var newEncoded = false
        var newMetadata = false
        try {
            if (encoded.exists()) { check(encoded.renameTo(previousEncoded)); oldEncoded = true }
            if (metadata.exists()) { check(metadata.renameTo(previousMetadata)); oldMetadata = true }
            check(candidate.renameTo(encoded)); newEncoded = true
            check(sidecar.renameTo(metadata)); newMetadata = true
        } catch (error: Throwable) {
            if (newMetadata) check(metadata.delete()) { "Could not roll back new sidecar" }
            if (newEncoded) check(encoded.delete()) { "Could not roll back new encoded video" }
            if (oldEncoded) check(previousEncoded.renameTo(encoded)) { "Previous video retained in private workspace; restoration failed" }
            if (oldMetadata) check(previousMetadata.renameTo(metadata)) { "Previous sidecar retained in private workspace; restoration failed" }
            throw error
        }
    }
    /** Clean only this job's verified private directory; leave rollback backups on errors. */
    fun cleanup() {
        require(work.canonicalFile.parentFile == directory && work.name.startsWith(".g2-video-"))
        // Published files no longer live here. Backups are deleted only after a
        // valid final pair exists; otherwise preserve them for recovery.
        val pairExists = encoded.isFile && metadata.isFile && !candidate.exists() && !sidecar.exists()
        for (file in work.listFiles().orEmpty()) {
            if ((file == previousEncoded || file == previousMetadata) && !pairExists) continue
            require(file.canonicalFile.parentFile == work.canonicalFile && file.isFile)
            file.delete()
        }
        if (work.listFiles().isNullOrEmpty()) work.delete()
    }
}

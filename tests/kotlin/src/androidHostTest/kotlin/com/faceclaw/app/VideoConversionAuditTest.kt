package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class VideoConversionAuditTest {
    @Test fun chosenRatesPreserveRecipeBitrateAndKeyframeSecondsAndRejectLegacyRate() {
        for (fps in listOf(10,15,20)) {
            val args=VideoEncodePlan.arguments("in.mp4","out.h264",false,fps)
            assertTrue(args[args.indexOf("-vf")+1].startsWith("fps=$fps,scale=320:192:"))
            val recipe=args[args.indexOf("-x264-params")+1]
            assertTrue(recipe.contains("keyint=${fps*8}:min-keyint=${fps*4+1}:"))
            assertTrue(recipe.contains("ipratio=1.00:vbv-maxrate=110:vbv-bufsize=32:"))
            val audit=VideoHeaderAudit(false,fps)
            audit.accept(section("Sequence Parameter Set",sps+("time_scale" to fps*2L))+
                section("Picture Parameter Set",pps)+section("Slice Header",slice(false)))
            audit.finish()
        }
        assertFails{VideoEncodePlan.arguments("in.mp4","out.h264",false,16)}
        assertFails{VideoHeaderAudit(false,16)}
    }
    @Test fun conversionAuditLeavesDecodingAndSecondProbeWithoutReportPrefix() {
        for (initial in listOf(null, "")) {
            var environment: String? = initial
            val report = "file=/writable/conversion.log:level=32"
            val json = "{\"frames\":[]}"
            fun probe() = if (environment != null) "Failed to open report: Read-only file system\n$json" else json
            withVideoReport(report, read = { environment }, write = { environment = it }, unset = { environment = null }) {
                assertEquals(report, environment)
            }
            assertEquals(null, environment)
            assertEquals(json, probe(), "Decoding audit must receive only JSON")
            assertEquals(json, probe(), "A subsequent probe must receive only JSON")
        }
    }

    @Test fun reportEnvironmentRestoresNonemptyValueAndUnsetsAfterAuditFailure() {
        for (initial in listOf(null, "", "file=/writable/prior.log:level=16")) {
            var environment: String? = initial
            assertFails {
                withVideoReport("file=/writable/conversion.log:level=32", read = { environment },
                    write = { environment = it }, unset = { environment = null }) {
                    error("Audit failed or cancelled")
                }
            }
            assertEquals(initial?.takeIf { it.isNotEmpty() }, environment)
        }
    }

    private fun section(name: String, fields: Map<String, Long>): String = "[trace_headers @ test] $name\n" +
        fields.entries.joinToString("") { "[trace_headers @ test] 1 ${it.key} 101 = ${it.value}\n" }
    private val sps = linkedMapOf("profile_idc" to 66L, "max_num_ref_frames" to 1L, "pic_width_in_mbs_minus1" to 19L,
        "pic_height_in_map_units_minus1" to 11L, "frame_mbs_only_flag" to 1L, "frame_cropping_flag" to 0L,
        "vui_parameters_present_flag" to 1L, "video_signal_type_present_flag" to 1L, "video_full_range_flag" to 1L,
        "timing_info_present_flag" to 1L, "num_units_in_tick" to 1L, "time_scale" to 30L,
        "max_num_reorder_frames" to 0L, "max_dec_frame_buffering" to 1L, "seq_parameter_set_id" to 0L)
    private val pps = linkedMapOf("entropy_coding_mode_flag" to 0L, "num_slice_groups_minus1" to 0L,
        "weighted_pred_flag" to 0L, "weighted_bipred_idc" to 0L, "num_ref_idx_l0_default_active_minus1" to 0L,
        "num_ref_idx_l1_default_active_minus1" to 0L, "bottom_field_pic_order_in_frame_present_flag" to 0L,
        "deblocking_filter_control_present_flag" to 1L, "redundant_pic_cnt_present_flag" to 0L,
        "pic_parameter_set_id" to 0L, "seq_parameter_set_id" to 0L)
    private fun slice(db: Boolean) = mapOf("first_mb_in_slice" to 0L, "slice_type" to 7L, "nal_unit_type" to 5L,
        "pic_parameter_set_id" to 0L, "disable_deblocking_filter_idc" to if (db) 0L else 1L)

    @Test fun recipeIsFixedFullRangeAndDeblockingSelectionDoesNotChangeBitrate() {
        val off = VideoEncodePlan.arguments("input with spaces.mp4", "output.h264.part", false)
        val on = VideoEncodePlan.arguments("input with spaces.mp4", "output.h264.part", true)
        assertEquals("input with spaces.mp4", off[off.indexOf("-i") + 1])
        assertTrue(off.contains("libx264") && off.contains("baseline"))
        assertTrue(off[off.indexOf("-x264-params") + 1].endsWith(":no-deblock=1"))
        assertTrue(on[on.indexOf("-x264-params") + 1].endsWith(":deblock=0,0"))
        assertTrue(off[off.indexOf("-x264-params") + 1].contains("ipratio=1.00:vbv-maxrate=110:vbv-bufsize=32"))
        assertTrue(off.none { it.contains("slice-max") || it.contains("cabac=1") })
        assertFails { VideoEncodePlan.arguments("same", "same", false) }
    }

    @Test fun contrastChangesOnlyTheGrayStepAndDefaultKeepsTheEarlierRecipe() {
        val geometry = VideoFrameGeometry(144,240,4,0,135,240)
        fun args(contrast: VideoContrast?) = if (contrast == null) VideoEncodePlan.arguments("in.mp4","out.h264",false,10,geometry)
            else VideoEncodePlan.arguments("in.mp4","out.h264",false,10,geometry,contrast)
        fun filter(contrast: VideoContrast?) = args(contrast).let { it[it.indexOf("-vf") + 1] }
        val tail = ",setsar=1,pad=144:240:4:0:color=black,format=yuvj420p"
        assertEquals("fps=10,scale=135:240:flags=lanczos:in_range=auto:out_range=full,format=gray$tail", filter(null))
        assertEquals(filter(null), filter(VideoContrast.DEFAULT))
        assertEquals("fps=10,scale=135:240:flags=lanczos:in_range=auto,format=gbrp,extractplanes=g$tail", filter(VideoContrast.MEDIUM))
        // The exact chain checked on PC FFmpeg against the per-pixel version (identical pictures).
        assertEquals("fps=10,scale=135:240:flags=lanczos:in_range=auto,format=gbrp,extractplanes=g," +
            "split[o][s];[s]gblur=sigma=3[bl];[o][bl]lut2=c0='clip(x+0.8*(x-y)*if(gt(x\\,y)\\,min(1\\,(255-x)/64)\\,min(1\\,x/64))\\,0\\,255)'$tail",
            filter(VideoContrast.HIGH))
        assertEquals(filter(VideoContrast.HIGH).replace("gblur=sigma=3", "gblur=sigma=6"), filter(VideoContrast.VERY_HIGH))
        for (contrast in VideoContrast.entries) {
            val base = args(null).toMutableList().apply { removeAt(indexOf("-vf") + 1) }
            assertEquals(base, args(contrast).toMutableList().apply { removeAt(indexOf("-vf") + 1) })
        }
        assertEquals(VideoContrast.entries, listOf("default","medium","high","veryhigh").map(VideoContrast::of))
        assertFails { VideoContrast.of("extra") }
    }

    @Test fun largeKeyframesOnlyWidenTheBufferAndSplitSlices() {
        fun args(keyframes: VideoKeyframes?) = if (keyframes == null) VideoEncodePlan.arguments("in.mp4","out.h264",false,10)
            else VideoEncodePlan.arguments("in.mp4","out.h264",false,10,keyframes = keyframes)
        fun x264(keyframes: VideoKeyframes?) = args(keyframes).let { it[it.indexOf("-x264-params") + 1] }
        assertEquals(x264(null), x264(VideoKeyframes.DEFAULT))
        assertTrue(x264(null).endsWith("ipratio=1.00:vbv-maxrate=110:vbv-bufsize=32:threads=1:range=pc:no-deblock=1"))
        assertEquals(x264(null).replace("vbv-bufsize=32:", "vbv-bufsize=96:slice-max-size=4000:"), x264(VideoKeyframes.LARGE))
        val base = args(null).toMutableList().apply { removeAt(indexOf("-x264-params") + 1) }
        assertEquals(base, args(VideoKeyframes.LARGE).toMutableList().apply { removeAt(indexOf("-x264-params") + 1) })
        assertEquals(VideoKeyframes.entries, listOf("default","large").map(VideoKeyframes::of))
        assertFails { VideoKeyframes.of("huge") }
    }

    @Test fun multiSliceClipsMapEachPictureToItsLastSlice() {
        // IDR in three slices, then a P picture in two.
        val nals = listOf(7, 8, 5, 5, 5, 1, 1).mapIndexed { index, type -> VideoFileReader.Nal(index * 8L + 4, 4, type, "a".repeat(64)) }
        val audit = VideoFileReader.Audit(56, "b".repeat(64), nals)
        val frames = listOf(VideoDecodedPicture(0, 40, true, 320, 192, "yuvj420p", "I", 0, 0),
            VideoDecodedPicture(40, 16, false, 320, 192, "yuvj420p", "P", 0, 0))
        assertEquals(listOf(4, 6), VideoPictureMap.build(audit, frames, multiSlice = true).map { it.nal })
        assertFails { VideoPictureMap.build(audit, frames) }
        val mixed = audit.copy(nals = nals.mapIndexed { i, n -> if (i == 3) n.copy(type = 1) else n })
        assertFails { VideoPictureMap.build(mixed, frames, multiSlice = true) }
    }

    @Test fun headerAuditCountsPicturesNotSlicesForLargeKeyframes() {
        val headers = section("Sequence Parameter Set", sps + ("time_scale" to 20L)) + section("Picture Parameter Set", pps) +
            section("Slice Header", slice(false)) + section("Slice Header", slice(false) + ("first_mb_in_slice" to 13L))
        val audit = VideoHeaderAudit(false, 10, multiSlice = true)
        audit.accept(headers)
        audit.finish()
        assertEquals(2, audit.slices)
        assertEquals(1, audit.pictures)
        val single = VideoHeaderAudit(false, 10)
        single.accept(headers)
        assertFails { single.finish() }
    }

    @Test fun pictureKeepsItsShapeInsideTheFrameWithUnlitBars() {
        val geometry = VideoFrameGeometry.fit(1920,1080)
        assertEquals(VideoFrameGeometry(320,176,3,0,313,176),geometry)
        val filter = VideoEncodePlan.arguments("in.mp4", "out.h264", false, 10,geometry).let { it[it.indexOf("-vf") + 1] }.split(',')
        assertEquals("fps=10", filter[0])
        assertTrue(filter[1].startsWith("scale=313:176:"))
        assertTrue(filter[1].contains("out_range=full"))
        // Bars are added after the full-range gray conversion, so black is 0 rather than 16.
        assertEquals(listOf("format=gray", "setsar=1", "pad=320:176:3:0:color=black", "format=yuvj420p"), filter.drop(2))
    }

    @Test fun bothLandscapeChoicesDetectPortraitRotationAndSampleAspectAutomatically() {
        for (height in listOf(176,192)) {
            assertEquals(VideoFrameGeometry(144,240,4,0,135,240),VideoFrameGeometry.fit(1080,1920,landscapeHeight=height))
            for (angle in listOf(-270,-90,90,270))
                assertEquals(VideoFrameGeometry.fit(1080,1920),VideoFrameGeometry.fit(1920,1080,rotation=angle,landscapeHeight=height))
            val square = VideoFrameGeometry.fit(720,576,"16:15",landscapeHeight=height)
            assertEquals(height,square.pictureHeight)
            assertEquals(if (height == 176) 235 else 256,square.pictureWidth)
        }
        assertEquals(VideoFrameGeometry(320,192,0,6,320,180),VideoFrameGeometry.fit(1920,1080,landscapeHeight=192))
        assertFails { VideoFrameGeometry.fit(0,1080) }
        assertFails { VideoFrameGeometry.fit(1920,1080,"1:0") }
        assertFails { VideoFrameGeometry.fit(1920,1080,rotation=45) }
        assertFails { VideoFrameGeometry.fit(1920,1080,landscapeHeight=180) }
    }

    @Test fun selectedGeometryAuditsRealMacroblockFieldsAndDecodedFrameDimensions() {
        val nals = listOf(7,8,6,5).mapIndexed { i,t -> VideoFileReader.Nal(i*8L+4,4,t,"a".repeat(64)) }
        val file = VideoFileReader.Audit(32,"b".repeat(64),nals)
        for (g in listOf(VideoFrameGeometry(320,192),VideoFrameGeometry(320,176),VideoFrameGeometry(144,240))) {
            val headers = VideoHeaderAudit(false,15,g)
            headers.accept(section("Sequence Parameter Set",sps+mapOf("pic_width_in_mbs_minus1" to g.width/16L-1,
                "pic_height_in_map_units_minus1" to g.height/16L-1))+section("Picture Parameter Set",pps)+section("Slice Header",slice(false)))
            headers.finish()
            val frame = VideoDecodedPicture(0,32,true,g.width,g.height,"yuvj420p","I",0,0)
            assertEquals(1,VideoPictureMap.build(file,listOf(frame),15,g).size)
            assertFails { VideoPictureMap.build(file,listOf(frame.copy(height=g.height+16)),15,g) }
        }
    }

    @Test fun chunkedFfmpegHeadersAuditAllParameterSetsAndSlices() {
        for (db in listOf(false, true)) {
            val audit = VideoHeaderAudit(db)
            val text = section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps) + section("Slice Header", slice(db))
            text.chunked(13).forEach(audit::accept)
            audit.finish()
            assertEquals(1, audit.slices); assertEquals(2, audit.parameterSets)
            assertFails { audit.finish() }
        }
    }

    @Test fun unsupportedOrUnsignalledFieldsAreRefusedInsteadOfRepaired() {
        val changes = listOf("profile_idc" to 100L, "video_signal_type_present_flag" to 0L,
            "video_full_range_flag" to 0L, "max_num_ref_frames" to 3L, "max_dec_frame_buffering" to 3L,
            "time_scale" to 60L, "frame_cropping_flag" to 1L)
        for ((field, value) in changes) {
            val audit = VideoHeaderAudit(false)
            audit.accept(section("Sequence Parameter Set", sps + (field to value)) +
                section("Picture Parameter Set", pps) + section("Slice Header", slice(false)))
            assertFails { audit.finish() }
        }
        for ((field, value) in listOf("entropy_coding_mode_flag" to 1L, "num_slice_groups_minus1" to 1L, "weighted_pred_flag" to 1L)) {
            val audit = VideoHeaderAudit(false)
            audit.accept(section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps + (field to value)) +
                section("Slice Header", slice(false)))
            assertFails { audit.finish() }
        }
        val mismatch = VideoHeaderAudit(false)
        mismatch.accept(section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps) + section("Slice Header", slice(true)))
        assertFails { mismatch.finish() }
    }

    @Test fun decodedAccessUnitsDeterminePicturesAndPreserveApplicableParameterSets() {
        val nals = listOf(7, 8, 6, 5, 1).mapIndexed { index, type -> VideoFileReader.Nal(index * 8L + 4, 4, type, "a".repeat(64)) }
        val audit = VideoFileReader.Audit(40, "b".repeat(64), nals)
        val frames = listOf(VideoDecodedPicture(0, 32, true, 320, 192, "yuvj420p", "I", 0, 0),
            VideoDecodedPicture(32, 8, false, 320, 192, "yuvj420p", "P", 0, 0))
        val map = VideoPictureMap.build(audit, frames)
        assertEquals(listOf(3, 4), map.map { it.nal })
        assertEquals(listOf(0L, 67L), map.map { it.pts })
        assertTrue(map.all { it.sps == 0 && it.pps == 1 })
        assertFails { VideoPictureMap.build(audit, frames.dropLast(1)) }
        assertFails { VideoPictureMap.build(audit, frames.map { it.copy(kind = "B") }) }
        assertFails { VideoPictureMap.build(audit.copy(nals = nals.mapIndexed { i, n -> if (i == 2) n.copy(type = 1) else n }), frames) }
        assertFails { VideoPictureMap.build(audit, frames.map { it.copy(bytes = 1) }) }
    }

    @Test fun ffmpegEightProbePairsPacketPositionsWithFramesWithoutLegacyPacketFields() {
        val packets = listOf(mapOf("pos" to "0", "size" to "32", "flags" to "K__"),
            mapOf("pos" to "32", "size" to "8", "flags" to "___"))
        val frames = listOf(mapOf("key_frame" to 1, "width" to 320, "height" to 192, "pix_fmt" to "yuvj420p",
            "pict_type" to "I", "interlaced_frame" to 0, "repeat_pict" to 0),
            mapOf("key_frame" to 0, "width" to 320, "height" to 192, "pix_fmt" to "yuvj420p",
                "pict_type" to "P", "interlaced_frame" to 0, "repeat_pict" to 0))
        // FFmpeg 8 provides these in separate probes, not frame pkt_pos/pkt_size.
        fun ffprobe(section: String) = mapOf("packets" to packets, "frames" to frames).getValue(section)
        fun rows(list: List<Map<String, Any>>) = list.joinToString("\n") { row -> row.entries.joinToString("|") { "${it.key}=${it.value}" } }
        fun decode(f: List<Map<String, Any>>, p: List<Map<String, Any>>) =
            videoDecodedPictures(rows(f).reader().buffered(), rows(p).reader().buffered())
        val nals = listOf(7, 8, 6, 5, 1).mapIndexed { index, type -> VideoFileReader.Nal(index * 8L + 4, 4, type, "a".repeat(64)) }
        val audit = VideoFileReader.Audit(40, "b".repeat(64), nals)
        val decoded = decode(ffprobe("frames"), ffprobe("packets"))
        assertEquals(listOf(0L, 32L), decoded.map { it.offset })
        assertEquals(listOf(32L, 8L), decoded.map { it.bytes })
        assertEquals(listOf(3, 4), VideoPictureMap.build(audit, decoded).map { it.nal })
        assertFails { decode(frames, packets.dropLast(1)) }
        assertFails { decode(frames.dropLast(1), packets) }
        assertFails { decode(frames, packets.map { it + ("flags" to "___") }) }
        assertFails { decode(frames, packets.map { it + ("flags" to "K__") }) }
        assertFails { decode(frames.map { it + ("key_frame" to "2") }, packets) }
        assertFails { VideoPictureMap.build(audit, decode(frames.map { it + ("pict_type" to "B") }, packets)) }
        assertFails { VideoPictureMap.build(audit, decode(frames, packets.map { it + ("pos" to "0") })) }
        assertFails { VideoPictureMap.build(audit, decode(frames.reversed(), packets.reversed())) }
    }

    @Test fun compactProbeRowsPairOnePictureAtATimeInFfprobeFieldOrder() {
        // Rows as FFmpeg writes them with -of compact=p=0: its own field order, side data after keyframes.
        val packets = "size=32|pos=0|flags=K__\nsize=8|pos=32|flags=___\n"
        val frames = "key_frame=1|width=320|height=192|pix_fmt=yuvj420p|pict_type=I|interlaced_frame=0|repeat_pict=0|" +
            "side_datum/h_26_45__user_data_unregistered_sei_message:side_data_type=H.26[45] User Data Unregistered SEI message\n" +
            "\nkey_frame=0|width=320|height=192|pix_fmt=yuvj420p|pict_type=P|interlaced_frame=0|repeat_pict=0\n"
        fun decode(f: String, p: String) = videoDecodedPictures(f.reader().buffered(), p.reader().buffered())
        val nals = listOf(7, 8, 6, 5, 1).mapIndexed { index, type -> VideoFileReader.Nal(index * 8L + 4, 4, type, "a".repeat(64)) }
        val audit = VideoFileReader.Audit(40, "b".repeat(64), nals)
        val decoded = decode(frames, packets)
        assertEquals(listOf(0L, 32L), decoded.map { it.offset })
        assertEquals(listOf(32L, 8L), decoded.map { it.bytes })
        assertEquals(listOf(true, false), decoded.map { it.key })
        assertEquals(listOf(3, 4), VideoPictureMap.build(audit, decoded).map { it.nal })
        assertEquals("H.26[45] User Data Unregistered SEI message",
            videoCompactRow(frames.lineSequence().first()).getValue("side_datum/h_26_45__user_data_unregistered_sei_message:side_data_type"))
        assertFails { decode(frames, packets.lines().first()) }
        assertFails { decode(frames.lines().first(), packets) }
        assertFails { decode(frames, packets.replace("flags=K__", "flags=___")) }
        assertFails { decode(frames, packets.replace("pos=32", "position=32")) }
        assertFails { decode(frames.replace("key_frame=0", "key_frame=2"), packets) }
        assertFails { decode(frames, packets.replace("size=8", "size=N/A")) }
        var checks = 0
        assertFails { videoDecodedPictures(frames.reader().buffered(), packets.reader().buffered()) { if (++checks == 2) error("cancelled") } }
    }
}

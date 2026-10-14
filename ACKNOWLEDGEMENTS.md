Acknowledgements
================

Faceclaw is an open source project, at https://github.com/jimrandomh/faceclaw.
Contributors include:
    James Babcock <jimrandomh@gmail.com>
    Kalani Helekunihi <i@am.guru>


Many thanks to g2-kit-unofficial: https://github.com/Commute773/g2-kit-unofficial/,
evenRealities-openCFW https://github.com/kalanihelekunihi/evenRealities-openCFW/,
and others who contributed to documenting the G2's bluetooth protocol and firmware.

G2 microphone LC3 decoding uses Google's liblc3: https://github.com/google/liblc3

The Terminus font is by Dimitar Zhekov's Terminus: https://framagit.org/ohnonot/terv-terc
and is distributed under the SIL Open Font License; see app/fonts/terminus/LICENSE.

The TerminusV proportional font is by ohnonot, derived from Terminus:
https://framagit.org/ohnonot/terv-terc. It is also distributed under the SIL
Open Font License; see app/fonts/terminusv/LICENSE.

The CJK font is Source Han Sans SC Light by Adobe:
https://github.com/adobe-fonts/source-han-sans. It is distributed under the SIL
Open Font License, Version 1.1; see app/fonts/source-han-sans/LICENSE.txt.
Faceclaw includes the G2's serialized 20 px LVGL build of the font so
phone-side rendering matches the glasses.

Video conversion uses the maintained FFmpegKit Min GPL Android artifact
dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7, distributed as GPL-3.0:
https://github.com/ffmpegkit-maintained/ffmpeg
The artifact includes FFmpeg (GPL-enabled build) and VideoLAN's x264
(GPL-2.0-or-later): https://ffmpeg.org and https://www.videolan.org/developers/x264.html
Their original license resources remain bundled in the Android dependency.
Public APK distribution requires matching corresponding source for this
exact artifact and its external libraries; the bundled source notice alone
does not establish that match.

FFmpegKit's exception runtime uses Taner Sener's smart-exception:
com.arthenica:smart-exception-java:0.2.1 and
com.arthenica:smart-exception-common:0.2.1, under BSD-3-Clause.
Source: https://github.com/tanersener/smart-exception/tree/v0.2.1
The unchanged notice is retained in app/licenses/smart-exception-LICENSE.txt
and reproduced below in this file, which is bundled in the APK.
These versions match the maintained FFmpegKit v8.1.7 Android build;
its published Min GPL POM omits these required runtime dependencies.

BSD 3-Clause License

Copyright (c) 2019-2020, Taner Sener
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

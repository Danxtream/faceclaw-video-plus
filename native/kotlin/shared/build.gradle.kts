import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFramework

plugins {
    kotlin("multiplatform")
    id("com.android.kotlin.multiplatform.library")
}
kotlin {
    sourceSets.androidMain.dependencies {
        implementation("dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7")
        implementation("com.arthenica:smart-exception-java:0.2.1")
        implementation("com.arthenica:smart-exception-common:0.2.1")
    }
    android {
        namespace = "com.faceclaw.shared"
        compileSdk = 35
        minSdk = 24
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        withHostTestBuilder {}.configure {}
    }
    val framework = XCFramework("FaceclawKit")
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework {
            baseName = "FaceclawKit"
            isStatic = true
            binaryOption("bundleId", "com.faceclaw.shared")
            framework.add(this)
        }
    }
}

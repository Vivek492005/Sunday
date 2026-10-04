plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.sunday"
version = "0.1.0"

repositories {
    mavenCentral()
}

intellij {
    // IntelliJ IDEA Community 2024.3 — the plugin also loads in PyCharm,
    // WebStorm and other 241+ IDEs (plugin.xml: since-build 241).
    version.set("2024.3")
    type.set("IC")
    plugins.set(listOf())
}

tasks {
    patchPluginXml {
        sinceBuild.set("241")
        untilBuild.set("251.*")
    }

    // Bundle the plugin icon.
    processResources {
        duplicatesStrategy = DuplicatesStrategy.INCLUDE
    }
}

dependencies {
    // Gson is bundled with the IntelliJ Platform; declared here for
    // standalone unit-test compilation.
    testImplementation("com.google.code.gson:gson:2.10.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(17)
}

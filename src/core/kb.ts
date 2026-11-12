/**
 * Knowledge base: what counts as junk, what must never be touched.
 *
 * CleanMyMac 5 ships this as an encrypted `info.cmmkb` plus per-task
 * knowledge-base protocols (CachesKnowledgeBase, LogsKnowledgeBase,
 * ApplicationLanguagesKnowledgeBase, UniversalBinariesKnowledgeBase,
 * MobileBackupsKnowledgeBase, FileIgnoreKnowledgeBase). Ours is plain
 * TypeScript, derived from the scan identifiers and literal paths visible in
 * its SystemJunkScanning / UninstallerScanning / PrivacyScanning frameworks
 * plus documented macOS locations.
 */

/** ~/Library/Caches entries we never remove (system-managed, locked, or costly to rebuild). */
export const PROTECTED_USER_CACHES = new Set<string>([
  "com.apple.bird",            // iCloud Drive
  "CloudKit",
  "com.apple.akd",
  "com.apple.ap.adprivacyd",
  "com.apple.appstore",
  "com.apple.appstoreagent",
  "com.apple.AppStore",
  "com.apple.commerce",
  "com.apple.HomeKit",
  "com.apple.iCloudHelper",
  "com.apple.icloud.fmfd",
  "com.apple.findmy.fmipcore",
  "com.apple.keyboardservicesd",
  "com.apple.nsurlsessiond",   // protected by sandbox, deletion fails noisily
  "com.apple.passd",
  "com.apple.Safari.SafeBrowsing",
  "com.apple.sharedfilelist",
  "com.apple.spotlight",
  "com.apple.Spotlight",
  "com.apple.tiswitcher.cache",
  "com.apple.touristd",
  "com.apple.nbagent",
  "com.apple.parsecd",
  "com.apple.proactive",
  "com.apple.Music",
  "com.apple.amp.itmstransporter",
  "FamilyCircle",
  "GeoServices",
  "com.apple.iTunesCloud",
  "ms-playwright",             // browser binaries for dev tooling: huge, slow to refetch, user chose it
  "Homebrew",                  // listed separately under Developer caches
]);

/** Container bundle ids whose Data/Library/Caches must not be touched. */
export const PROTECTED_CONTAINERS = new Set<string>([
  "com.apple.mail",
  "com.apple.Safari",          // Safari caches are a separate privacy item
  "com.apple.Photos",
  "com.apple.photolibraryd",
  "com.apple.cloudd",
  "com.apple.CloudDocs.MobileDocumentsFileProvider",
  "com.apple.bird",
  "com.apple.Notes",
  "com.apple.news",
  "com.apple.stocks",
  "com.apple.Music",
  "com.apple.TV",
  "com.apple.podcasts",
  "com.apple.Safari.WebApp",
  "com.apple.iBooksX",
]);

/** Electron apps keep Chromium caches here (CMSystemJunkScanIdentifierElectronAppsCache). */
export const ELECTRON_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "blob_storage"];

/** Hard-coded app caches seen verbatim in SystemJunkScanning (CMSystemJunkScanIdentifierHardcodedPathCache & friends). */
export const HARDCODED_CACHES: { path: string; title: string; auto?: boolean }[] = [
  { path: "~/Library/Application Support/Adobe/Common/Media Cache Files", title: "Adobe Media Cache" },
  { path: "~/Library/Application Support/Spotify/PersistentCache/Storage", title: "Spotify cache" },
  { path: "~/Library/Containers/com.apple.Photos/Data/Library/Application Support/Photos Desktop/0", title: "Photos Desktop cache" },
  { path: "~/Library/Containers/com.youku.mac/Data/Documents/YTCORE_PLAYER_CACHE", title: "Youku player cache" },
  { path: "~/Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac/iMusic", title: "QQ Music cache" },
  { path: "~/Library/Containers/com.tencent.tenvideo/Data/Library/Application Support/Download/video", title: "Tencent Video cache" },
  { path: "~/Dropbox/.dropbox.cache", title: "Dropbox cache" },
  { path: "~/Library/Caches/Homebrew", title: "Homebrew downloads", auto: false },
  { path: "~/.npm/_cacache", title: "npm cache", auto: false },
  { path: "~/.yarn/berry/cache", title: "Yarn cache", auto: false },
  { path: "~/Library/Caches/Yarn", title: "Yarn cache (classic)", auto: false },
  { path: "~/Library/pnpm/store", title: "pnpm store", auto: false },
  { path: "~/.gradle/caches", title: "Gradle caches", auto: false },
  { path: "~/.cargo/registry/cache", title: "Cargo registry cache", auto: false },
  { path: "~/Library/Caches/pip", title: "pip cache", auto: false },
  { path: "~/.cache", title: "XDG cache (~/.cache)", auto: false },
  { path: "~/Library/Caches/CocoaPods", title: "CocoaPods cache", auto: false },
  { path: "~/Library/Caches/com.apple.dt.Xcode", title: "Xcode cache" },
  { path: "~/Library/Developer/Xcode/UserData/IB Support", title: "Interface Builder cache" },
];

export const XCODE_JUNK: { rel: string; title: string; auto: boolean; note?: string }[] = [
  { rel: "Library/Developer/Xcode/DerivedData", title: "Derived Data", auto: true },
  { rel: "Library/Developer/Xcode/Archives", title: "Archives", auto: false, note: "Archives hold dSYMs for shipped builds. Review before removing." },
  { rel: "Library/Developer/Xcode/iOS DeviceSupport", title: "iOS Device Support", auto: true, note: "Re-downloaded from the device on next connect." },
  { rel: "Library/Developer/Xcode/macOS DeviceSupport", title: "macOS Device Support", auto: true },
  { rel: "Library/Developer/Xcode/tvOS DeviceSupport", title: "tvOS Device Support", auto: true },
  { rel: "Library/Developer/Xcode/watchOS DeviceSupport", title: "watchOS Device Support", auto: true },
  { rel: "Library/Developer/Xcode/iOS Device Logs", title: "iOS Device Logs", auto: true },
  { rel: "Library/Developer/Xcode/Products", title: "Build Products", auto: true },
  { rel: "Library/Developer/CoreSimulator/Caches", title: "CoreSimulator Caches", auto: true },
  { rel: "Library/Developer/Xcode/DocumentationCache", title: "Documentation Cache", auto: true },
  { rel: "Library/Developer/XCPGDevices", title: "Playground Devices", auto: true },
  { rel: "Library/Developer/XCTestDevices", title: "XCTest Devices", auto: true },
  { rel: "Library/Caches/org.swift.swiftpm", title: "SwiftPM cache", auto: true },
  { rel: "Library/Developer/CoreSimulator/Devices", title: "Simulator Devices", auto: false, note: "Installed simulators and their data. Prefer `xcrun simctl delete unavailable`." },
  { rel: "Library/Developer/CoreSimulator/Images", title: "Downloaded Simulator Runtimes", auto: false, note: "Runtime disk images downloaded by Xcode. Remove via Xcode > Settings > Components." },
  { rel: "Library/org.swift.swiftpm", title: "SwiftPM security/config cache", auto: false },
];

/** Where an app leaves traces. `{id}` = bundle id, `{name}` = app name, `{exe}` = executable name. */
export const LEFTOVER_LOCATIONS: { base: string; patterns: string[]; root?: boolean }[] = [
  { base: "~/Library/Application Support", patterns: ["{id}", "{name}", "{exe}"] },
  { base: "~/Library/Caches", patterns: ["{id}", "{name}", "{exe}"] },
  { base: "~/Library/Preferences", patterns: ["{id}.plist", "{id}.*.plist"] },
  { base: "~/Library/Preferences/ByHost", patterns: ["{id}.*.plist"] },
  { base: "~/Library/Logs", patterns: ["{id}", "{name}", "{exe}"] },
  { base: "~/Library/Saved Application State", patterns: ["{id}.savedState"] },
  { base: "~/Library/HTTPStorages", patterns: ["{id}", "{id}.binarycookies"] },
  { base: "~/Library/Cookies", patterns: ["{id}.binarycookies"] },
  { base: "~/Library/WebKit", patterns: ["{id}"] },
  { base: "~/Library/Containers", patterns: ["{id}", "{id}.*"] },
  { base: "~/Library/Group Containers", patterns: ["*.{id}", "group.{id}", "group.{id}.*"] },
  { base: "~/Library/Application Scripts", patterns: ["{id}", "{id}.*"] },
  { base: "~/Library/LaunchAgents", patterns: ["{id}.plist", "{id}.*.plist"] },
  { base: "~/Library/Application Support/CrashReporter", patterns: ["{name}_*.plist", "{exe}_*.plist"] },
  { base: "~/Library/Logs/DiagnosticReports", patterns: ["{name}_*", "{exe}_*", "{name}-*", "{exe}-*"] },
  { base: "~/Library/Preferences/SDMHelpData/Other", patterns: ["{id}*"] },
  { base: "/Library/Application Support", patterns: ["{id}", "{name}", "{exe}"], root: true },
  { base: "/Library/Caches", patterns: ["{id}", "{name}"], root: true },
  { base: "/Library/Preferences", patterns: ["{id}.plist", "{id}.*.plist"], root: true },
  { base: "/Library/LaunchAgents", patterns: ["{id}.plist", "{id}.*.plist"], root: true },
  { base: "/Library/LaunchDaemons", patterns: ["{id}.plist", "{id}.*.plist"], root: true },
  { base: "/Library/PrivilegedHelperTools", patterns: ["{id}", "{id}.*"], root: true },
  { base: "/Library/Logs", patterns: ["{id}", "{name}"], root: true },
  { base: "/Library/Documentation/Applications", patterns: ["{name}"], root: true },
  { base: "/Library/PDF Services", patterns: ["{name}*"], root: true },
  { base: "/Library/Application Support/Avid/Audio/Plug-Ins", patterns: ["{name}*"], root: true },
];

export const CRASH_LOG_EXTENSIONS = new Set([".crash", ".diag", ".hang", ".spin", ".ips", ".panic", ".shutdownStall", ".wakeups_resource", ".cpu_resource"]);

/** Recent-item lists the Protection module can clear. */
export const RECENT_ITEM_LISTS: { file: string; title: string }[] = [
  { file: "com.apple.LSSharedFileList.RecentApplications.sfl3", title: "Recently Launched Applications" },
  { file: "com.apple.LSSharedFileList.RecentDocuments.sfl3", title: "Recently Opened Documents" },
  { file: "com.apple.LSSharedFileList.RecentServers.sfl3", title: "Recently Accessed Servers" },
  { file: "com.apple.LSSharedFileList.RecentHosts.sfl3", title: "Recent Hosts" },
  { file: "com.apple.LSSharedFileList.RecentApplications.sfl2", title: "Recently Launched Applications (legacy)" },
  { file: "com.apple.LSSharedFileList.RecentDocuments.sfl2", title: "Recently Opened Documents (legacy)" },
  { file: "com.apple.LSSharedFileList.RecentServers.sfl2", title: "Recently Accessed Servers (legacy)" },
];

/** TCC service names shown as "Application Permissions" in CleanMyMac's Protection module. */
export const TCC_SERVICES: Record<string, string> = {
  kTCCServiceAccessibility: "Accessibility",
  kTCCServiceAppleEvents: "Automation",
  kTCCServiceCalendar: "Calendar",
  kTCCServiceCamera: "Camera",
  kTCCServiceAddressBook: "Contacts",
  kTCCServiceSystemPolicyDesktopFolder: "Desktop Folder",
  kTCCServiceSystemPolicyDocumentsFolder: "Documents Folder",
  kTCCServiceSystemPolicyDownloadsFolder: "Downloads Folder",
  kTCCServiceSystemPolicyAllFiles: "Full Disk Access",
  kTCCServiceListenEvent: "Input Monitoring",
  kTCCServiceMicrophone: "Microphone",
  kTCCServiceSystemPolicyNetworkVolumes: "Network Volumes",
  kTCCServicePhotos: "Photos",
  kTCCServiceReminders: "Reminders",
  kTCCServiceSystemPolicyRemovableVolumes: "Removable Volumes",
  kTCCServiceScreenCapture: "Screen Recording",
  kTCCServiceSpeechRecognition: "Speech Recognition",
  kTCCServiceLocation: "Location",
  kTCCServiceBluetoothAlways: "Bluetooth",
  kTCCServiceMediaLibrary: "Media Library",
  kTCCServiceDeveloperTool: "Developer Tools",
};

/** Thresholds. */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;
export const OLD_FILE_DAYS = 180;
export const UNUSED_APP_DAYS = 180;
export const OLD_LOG_DAYS = 7;

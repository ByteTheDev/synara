// Disposable hosted-runner observation. No TCC, accessibility or permission changes.
import AppKit
import CoreGraphics
import Foundation

enum ProbeError: Error { case failed(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeError.failed(message) }
}
let arguments = CommandLine.arguments
try require(arguments.count == 3, "Expected mode and owned configuration path")
let mode = arguments[1]
let configurationURL = URL(fileURLWithPath: arguments[2]).standardizedFileURL
let configurationData = try Data(contentsOf: configurationURL)
let configuration = try JSONSerialization.jsonObject(with: configurationData) as! [String: Any]
let evidence = URL(fileURLWithPath: configuration["evidence"] as! String).standardizedFileURL
let ownedRoot = URL(fileURLWithPath: configuration["ownedRoot"] as! String).standardizedFileURL
let appURL = URL(fileURLWithPath: configuration["appPath"] as! String).standardizedFileURL
let startupLog = configuration["startupLog"] as! String
let expectedBundleID = "com.emanueledipietro.synara"
try require(appURL.path.hasPrefix(ownedRoot.path + "/"), "Application must be in the owned tree")
try require(configurationURL.path.hasPrefix(ownedRoot.path + "/"), "Configuration must be owned")
try require(["preflight", "configure", "capture", "cleanup", "restore"].contains(mode), "Unknown mode")
NSApplication.shared.setActivationPolicy(.prohibited)

func save(_ name: String, _ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: evidence.appendingPathComponent(name), options: .atomic)
}
func pause(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}
func awaitCondition(_ seconds: TimeInterval, _ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if predicate() { return true }
        pause(0.1)
    }
    return predicate()
}
func command(_ executable: String, _ args: [String], _ logName: String) throws {
    let log = evidence.appendingPathComponent(logName)
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let output = try FileHandle(forWritingTo: log)
    defer { try? output.close() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    process.standardOutput = output
    process.standardError = output
    try process.run()
    if !awaitCondition(15, { !process.isRunning }) {
        process.terminate()
        throw ProbeError.failed("Tool deadline: \(executable)")
    }
    try require(process.terminationStatus == 0, "Tool failed: \(executable), exit \(process.terminationStatus)")
}
func capture(_ name: String) throws {
    try command("/usr/sbin/screencapture", ["-x", "-t", "png", "-T", "1", evidence.appendingPathComponent(name + ".png").path], name + ".log")
}
func ownedApplications() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath()
    }
}
func stopOwnedApplications() throws {
    var outcomes: [[String: Any]] = []
    for application in ownedApplications() {
        let requested = application.terminate()
        var forced = false
        if !awaitCondition(10, { application.isTerminated }) {
            forced = true
            _ = application.forceTerminate()
        }
        let stopped = awaitCondition(5, { application.isTerminated })
        outcomes.append(["pid": application.processIdentifier, "normalRequest": requested, "forced": forced, "stopped": stopped])
        try require(stopped, "Owned application did not terminate")
    }
    try save("cleanup-applications.json", ["appPath": appURL.path, "outcomes": outcomes])
}
let dockDomain = "com.apple.dock"
let dockKeys = ["persistent-apps", "show-recents", "autohide", "tilesize", "magnification", "orientation"]
let snapshotURL = ownedRoot.appendingPathComponent("dock-preferences-before.plist")
let defaults = UserDefaults.standard
func dockSnapshot() -> [String: Any] {
    let domain = defaults.persistentDomain(forName: dockDomain) ?? [:]
    return domain.filter { dockKeys.contains($0.key) }
}
func setDockValues(_ values: [String: Any]) {
    var domain = defaults.persistentDomain(forName: dockDomain) ?? [:]
    for key in dockKeys { domain[key] = values[key] }
    defaults.setPersistentDomain(domain, forName: dockDomain)
    defaults.synchronize()
}
func reloadDock(_ log: String) throws {
    try command("/usr/bin/killall", ["Dock"], log)
    pause(3)
}

do {
    if mode == "preflight" {
        var displayCount: UInt32 = 0
        let status = CGGetActiveDisplayList(0, nil, &displayCount)
        let permitted = CGPreflightScreenCaptureAccess()
        try save("display-preflight.json", ["activeDisplays": displayCount, "status": status.rawValue, "screenCapturePreflight": permitted])
        try require(status == .success && displayCount > 0 && permitted, "Existing display access is unavailable")
        try capture("display-before-experiment")
    } else if mode == "configure" {
        try require(!FileManager.default.fileExists(atPath: snapshotURL.path), "Refuse to overwrite original Dock state")
        let snapshot = dockSnapshot()
        let data = try PropertyListSerialization.data(fromPropertyList: snapshot, format: .xml, options: 0)
        try data.write(to: snapshotURL, options: .atomic)
        setDockValues([
            "persistent-apps": [["tile-type": "file-tile", "tile-data": ["file-label": "Synara", "file-data": ["_CFURLString": appURL.absoluteString, "_CFURLStringType": 15]]]],
            "show-recents": false, "autohide": false, "tilesize": 96,
            "magnification": false, "orientation": "bottom"
        ])
        try reloadDock("dock-configure.log")
        try save("dock-configuration.json", ["ownedAppURL": appURL.absoluteString, "changedKeys": dockKeys, "tileSize": 96, "qualification": "Controlled disposable-runner Dock layout for legibility; actual application artwork remains unchanged."])
    } else if mode == "restore" {
        if FileManager.default.fileExists(atPath: snapshotURL.path) {
            let saved = try PropertyListSerialization.propertyList(from: Data(contentsOf: snapshotURL), options: [], format: nil) as! [String: Any]
            setDockValues(saved)
            let equal = NSDictionary(dictionary: saved).isEqual(to: dockSnapshot())
            try save("dock-restore.json", ["restoredKeys": dockKeys, "matchedBeforeReload": equal])
            try require(equal, "Dock preference restoration did not match saved keys")
            try reloadDock("dock-restore.log")
        } else {
            try save("dock-restore.json", ["configured": false, "reason": "No original-state snapshot exists; no Dock values changed"])
        }
    } else if mode == "cleanup" {
        try stopOwnedApplications()
    } else {
        try require(FileManager.default.fileExists(atPath: appURL.path), "Packaged application is absent")
        try require(ownedApplications().isEmpty, "Owned application was already running")
        try require(NSWorkspace.shared.runningApplications.allSatisfy { $0.bundleIdentifier != expectedBundleID }, "Another Synara instance is running")
        try capture("current-main-closed-before-launch")
        let openConfiguration = NSWorkspace.OpenConfiguration()
        openConfiguration.environment = configuration["environment"] as! [String: String]
        // Ephemeral loopback Chromium endpoint in this fresh owned profile lets
        // the controller click the actual renderer's normal Quit confirmation.
        openConfiguration.arguments = ["--remote-debugging-port=0"]
        openConfiguration.createsNewApplicationInstance = true
        openConfiguration.allowsRunningApplicationSubstitution = false
        openConfiguration.promptsUserIfNeeded = false
        openConfiguration.addsToRecentItems = false
        openConfiguration.activates = true
        var launched: NSRunningApplication?
        var launchError: Error?
        var completed = false
        NSWorkspace.shared.openApplication(at: appURL, configuration: openConfiguration) { application, error in
            launched = application; launchError = error; completed = true
        }
        try require(awaitCondition(30, { completed }), "NSWorkspace launch deadline")
        if let launchError { throw launchError }
        try require(launched != nil, "NSWorkspace did not return an application")
        let application = launched!
        try require(application.bundleURL?.standardizedFileURL == appURL, "Launch returned a different bundle URL")
        try require(application.bundleIdentifier == expectedBundleID, "Unexpected launched bundle identifier")
        let ready = awaitCondition(90) {
            guard !application.isTerminated, let log = try? String(contentsOfFile: startupLog, encoding: .utf8) else { return false }
            return log.contains("app ready") && log.contains("bootstrap main window created") && log.contains("bootstrap backend ready source=")
        }
        try save("application-startup.json", ["pid": application.processIdentifier, "bundleURL": appURL.absoluteString, "bundleID": application.bundleIdentifier ?? "", "canonicalLogProofs": ready, "terminated": application.isTerminated])
        try require(ready && !application.isTerminated, "Actual isolated app did not establish all canonical startup proofs")
        _ = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        pause(3)
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == application.processIdentifier
        }
        let visible = windows.contains { window in
            guard let bounds = window[kCGWindowBounds as String] as? [String: Any], let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber else { return false }
            return width.doubleValue >= 600 && height.doubleValue >= 400
        }
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier
        try save("visible-owned-windows.json", ["windows": windows, "largeApplicationWindow": visible, "frontmost": frontmost])
        try capture("current-main-running")
        try require(visible && frontmost, "Actual main window is not visible and foreground")
        try save("normal-quit-request.json", ["pid": application.processIdentifier, "appPath": appURL.path, "requestedAt": Date().timeIntervalSince1970])
        let requested = application.terminate()
        let exited = awaitCondition(45, { application.isTerminated })
        try save("normal-quit.json", ["pid": application.processIdentifier, "normalRequest": requested, "terminated": exited, "forceUsed": false])
        if !exited { try capture("quit-did-not-complete") }
        try require(requested && exited, "Normal application quit did not complete")
        pause(3)
        try capture("current-main-closed-after-quit")
        try save("lifecycle-result.json", ["appPath": appURL.path, "runningCapture": true, "normalQuit": true, "closedCapture": true, "qualification": "Actual current-main packaged application and controlled Dock layout; no claim that the original author app was built or rendered, no signed-install or cache-upgrade claim."])
    }
} catch {
    try? save(mode + "-failure.json", ["message": String(describing: error)])
    if mode == "capture" && CGPreflightScreenCaptureAccess() {
        try? capture("lifecycle-failure-screen")
    }
    fputs("\(error)\n", stderr)
    exit(1)
}

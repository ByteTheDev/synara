// Real hosted macOS screen observation; no permission request or TCC changes.
import AppKit
import CoreGraphics
import Foundation

enum ObservationError: Error { case failed(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ObservationError.failed(message) }
}
let args = CommandLine.arguments
try require(args.count == 4 || args.count == 5, "Expected mode, owned configuration, label, and optional stacking expectation")
let mode = args[1]
let configURL = URL(fileURLWithPath: args[2]).standardizedFileURL
let label = args[3]
try require(label.range(of: "^[a-z0-9-]+$", options: .regularExpression) != nil, "Invalid evidence label")
try require(["preflight", "capture", "reference", "cleanup"].contains(mode), "Unknown observation mode")
let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: Any]
let root = URL(fileURLWithPath: configuration["ownedRoot"] as! String).standardizedFileURL
let appURL = URL(fileURLWithPath: configuration["appPath"] as! String).standardizedFileURL
let evidence = URL(fileURLWithPath: configuration["evidence"] as! String).standardizedFileURL
try require(configURL.path.hasPrefix(root.path + "/") && appURL.path.hasPrefix(root.path + "/"), "Paths must belong to the owned experiment")
NSApplication.shared.setActivationPolicy(mode == "reference" ? .regular : .prohibited)

func save(_ name: String, _ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: evidence.appendingPathComponent(name), options: .atomic)
}
func pause(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
func wait(_ seconds: TimeInterval, _ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { if predicate() { return true }; pause(0.1) }
    return predicate()
}
func capture() throws {
    try require(CGPreflightScreenCaptureAccess(), "Existing screen capture access is unavailable")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "png", "-T", "1", evidence.appendingPathComponent(label + ".png").path]
    try process.run()
    if !wait(15, { !process.isRunning }) { process.terminate(); throw ObservationError.failed("Screen capture deadline") }
    try require(process.terminationStatus == 0, "Screen capture command failed")
}
func rect(_ window: [String: Any]) -> CGRect? {
    guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? NSNumber, let y = bounds["Y"] as? NSNumber,
          let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber else { return nil }
    return CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
}
func allWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}
func owner(_ window: [String: Any]) -> Int32 { (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1 }
func ownedApplication() throws -> NSRunningApplication {
    let pid = (configuration["pid"] as! NSNumber).int32Value
    guard let application = NSRunningApplication(processIdentifier: pid) else { throw ObservationError.failed("Observed application no longer exists") }
    try require(application.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath(), "PID does not belong to the exact owned app URL")
    try require(application.bundleIdentifier == "com.emanueledipietro.synara", "Unexpected application identity")
    return application
}
func mainWindowIndex(_ windows: [[String: Any]], _ pid: Int32) -> Int? {
    windows.firstIndex { window in
        guard owner(window) == pid, let bounds = rect(window) else { return false }
        return bounds.width >= 600 && bounds.height >= 400
    }
}

do {
    if mode == "cleanup" {
        let applications = NSWorkspace.shared.runningApplications.filter {
            $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath()
        }
        var outcomes: [[String: Any]] = []
        for application in applications {
            let requested = application.terminate()
            var forced = false
            if !wait(10, { application.isTerminated }) { forced = true; _ = application.forceTerminate() }
            let stopped = wait(5, { application.isTerminated })
            outcomes.append(["pid": application.processIdentifier, "normalRequest": requested, "forced": forced, "stopped": stopped])
            try require(stopped, "Owned application did not stop")
        }
        try save("native-cleanup.json", ["appPath": appURL.path, "outcomes": outcomes])
    } else if mode == "preflight" {
        var count: UInt32 = 0
        let status = CGGetActiveDisplayList(0, nil, &count)
        try save("display-preflight.json", ["displayCount": count, "status": status.rawValue, "screenAccess": CGPreflightScreenCaptureAccess()])
        try require(status == .success && count > 0, "No active display")
        try require(NSWorkspace.shared.runningApplications.allSatisfy { $0.bundleIdentifier != "com.emanueledipietro.synara" }, "An existing Synara instance is running")
        try capture()
    } else {
        let application = try ownedApplication()
        if mode == "reference" {
            try require(args.count == 5 && ["above", "below"].contains(args[4]), "Invalid stacking expectation")
            guard let screen = NSScreen.main else { throw ObservationError.failed("No main screen") }
            let frame = screen.visibleFrame
            let reference = NSWindow(contentRect: CGRect(x: frame.midX - 280, y: frame.midY - 180, width: 560, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            reference.title = "Controlled reference window — verification only"
            reference.level = .normal
            reference.isReleasedWhenClosed = false
            let text = NSTextField(wrappingLabelWithString: "Native stacking reference\n\nThis temporary window is a verification fixture.\nSynara's actual window should stay above it only when Always on Top is enabled.")
            text.frame = CGRect(x: 36, y: 60, width: 488, height: 230)
            text.font = NSFont.systemFont(ofSize: 22)
            reference.contentView?.addSubview(text)
            reference.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            defer { reference.close() }
            pause(2)
            let windows = allWindows()
            let appIndex = mainWindowIndex(windows, application.processIdentifier)
            let referenceIndex = windows.firstIndex { owner($0) == ProcessInfo.processInfo.processIdentifier && (rect($0)?.width ?? 0) >= 550 }
            let focusedReference = NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
            try save(label + ".json", ["applicationPid": application.processIdentifier, "referencePid": ProcessInfo.processInfo.processIdentifier, "applicationIndex": appIndex ?? -1, "referenceIndex": referenceIndex ?? -1, "referenceIsForeground": focusedReference, "expected": args[4], "windows": windows.filter { [application.processIdentifier, ProcessInfo.processInfo.processIdentifier].contains(owner($0)) }])
            try capture()
            try require(focusedReference && appIndex != nil && referenceIndex != nil, "Missing visible app/reference window or native reference focus")
            let overlap = rect(windows[appIndex!])!.intersection(rect(windows[referenceIndex!])!)
            try require(!overlap.isNull && overlap.width * overlap.height >= 10000, "Reference does not overlap Synara")
            try require(args[4] == "above" ? appIndex! < referenceIndex! : appIndex! > referenceIndex!, "Actual native stacking order disagrees with the expected state")
        } else {
            let windows = allWindows()
            let appIndex = mainWindowIndex(windows, application.processIdentifier)
            let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier
            try save(label + ".json", ["applicationPid": application.processIdentifier, "largeWindowPresent": appIndex != nil, "applicationIsForeground": foreground, "windows": windows.filter { owner($0) == application.processIdentifier }])
            try capture()
            try require(appIndex != nil && foreground, "Synara's actual main window must be visible and foreground")
        }
    }
} catch {
    try? save("native-" + mode + "-failure.json", ["label": label, "message": String(describing: error)])
    fputs(String(describing: error) + "\n", stderr)
    exit(1)
}

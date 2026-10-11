import AppKit
import Foundation

func writeJSON(_ value: [String: Any], _ path: String) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try bytes.write(to: URL(fileURLWithPath: path), options: .atomic)
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : ""
if mode == "preflight" && args.count == 3 {
    let running = NSWorkspace.shared.runningApplications.compactMap { application -> [String: Any]? in
        let identifier = application.bundleIdentifier ?? ""
        let name = application.localizedName ?? ""
        guard identifier.hasPrefix("com.emanueledipietro.synara") || name.hasPrefix("Synara") else { return nil }
        return ["bundleId": identifier, "name": name, "pid": application.processIdentifier,
                "bundle": application.bundleURL?.path ?? ""]
    }
    let locations = ["/Applications", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
    let installed = try locations.flatMap { directory -> [String] in
        guard FileManager.default.fileExists(atPath: directory) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: directory)
            .filter { $0.hasPrefix("Synara") && $0.hasSuffix(".app") }
            .map { URL(fileURLWithPath: directory).appendingPathComponent($0).path }
    }
    try writeJSON(["running": running, "installed": installed, "noLaunchPerformed": true], args[2])
    guard running.isEmpty && installed.isEmpty else { throw NSError(domain: "SourceIconEvidence", code: 2) }
} else if mode == "render" && args.count == 5 {
    let bundlePath = args[2]
    guard bundlePath.hasSuffix("/apps/desktop/.electron-runtime/Synara Beta.app"),
          FileManager.default.fileExists(atPath: bundlePath) else {
        throw NSError(domain: "SourceIconEvidence", code: 3)
    }
    NSApplication.shared.appearance = NSAppearance(named: .aqua)
    let icon = NSWorkspace.shared.icon(forFile: bundlePath)
    let size = NSSize(width: 1024, height: 1024)
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "SourceIconEvidence", code: 4)
    }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    icon.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]), let pixels = bitmap.bitmapData else {
        throw NSError(domain: "SourceIconEvidence", code: 5)
    }
    var visiblePixels = 0
    for y in 0..<1024 {
        for x in 0..<1024 where pixels[y * bitmap.bytesPerRow + x * 4 + 3] > 0 { visiblePixels += 1 }
    }
    try data.write(to: URL(fileURLWithPath: args[3]), options: .atomic)
    try writeJSON(["bundle": bundlePath, "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh,
                   "visiblePixels": visiblePixels, "pngBytes": data.count, "appearance": "aqua",
                   "api": "NSWorkspace.icon(forFile:)", "applicationLaunched": false,
                   "qualification": "Actual AppKit bundle-icon render, not a running or closed Dock screenshot."], args[4])
} else {
    throw NSError(domain: "SourceIconEvidence", code: 1)
}

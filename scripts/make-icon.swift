// Renders the app icon (a tilted broom-stroke on a gradient squircle) at the
// sizes iconutil needs. Usage: swift make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> NSImage {
    let s = CGFloat(px)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    let r = NSRect(x: s * 0.06, y: s * 0.06, width: s * 0.88, height: s * 0.88)
    let path = NSBezierPath(roundedRect: r, xRadius: s * 0.2, yRadius: s * 0.2)
    path.addClip()
    let grad = NSGradient(colors: [NSColor(calibratedRed: 0.20, green: 0.46, blue: 0.98, alpha: 1), NSColor(calibratedRed: 0.10, green: 0.78, blue: 0.70, alpha: 1)])!
    grad.draw(in: r, angle: -60)
    // Sparkle arc
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.92).cgColor)
    ctx.setLineWidth(s * 0.085)
    ctx.setLineCap(.round)
    ctx.addArc(center: CGPoint(x: s * 0.5, y: s * 0.5), radius: s * 0.27, startAngle: .pi * 0.15, endAngle: .pi * 1.55, clockwise: false)
    ctx.strokePath()
    // Check mark
    ctx.beginPath()
    ctx.move(to: CGPoint(x: s * 0.36, y: s * 0.50))
    ctx.addLine(to: CGPoint(x: s * 0.47, y: s * 0.38))
    ctx.addLine(to: CGPoint(x: s * 0.68, y: s * 0.63))
    ctx.strokePath()
    // Dots
    ctx.setFillColor(NSColor.white.cgColor)
    for (x, y, d) in [(0.76, 0.72, 0.06), (0.83, 0.60, 0.04), (0.70, 0.82, 0.035)] {
        ctx.fillEllipse(in: CGRect(x: s * x, y: s * y, width: s * d, height: s * d))
    }
    img.unlockFocus()
    return img
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    let img = draw(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("icon_\(name).png"))
}

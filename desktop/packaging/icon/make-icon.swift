// Draws the app icon and packs it into AppIcon.icns.
//
//   swift desktop/packaging/icon/make-icon.swift desktop/packaging/AppIcon.icns
//
// A dark rounded square with a pulse line (the menu bar item's mark) ending
// in a status dot. Drawn in code so it can be changed and redrawn; the .icns
// it writes is committed, so builds don't need to run this.

import AppKit
import Foundation

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

/// The icon at `px` pixels square, drawn on a 1024 grid.
func draw(_ px: Int) -> CGImage {
    let ctx = CGContext(
        data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)

    // The macOS icon grid: an 824 square, inset 100, with a soft shadow below.
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: rgb(0x000000, 0.35))
    ctx.addPath(shape)
    ctx.setFillColor(rgb(0x161b22))
    ctx.fillPath()
    ctx.restoreGState()

    // Background: top a little lighter than the bottom.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let bg = CGGradient(
        colorsSpace: nil, colors: [rgb(0x2a3340), rgb(0x12161c)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    ctx.restoreGState()

    // The pulse: flat, a small bump, a sharp spike, a dip, flat to the dot.
    let pulse = CGMutablePath()
    pulse.move(to: CGPoint(x: 200, y: 500))
    pulse.addLine(to: CGPoint(x: 330, y: 500))
    pulse.addLine(to: CGPoint(x: 375, y: 560))
    pulse.addLine(to: CGPoint(x: 420, y: 500))
    pulse.addLine(to: CGPoint(x: 460, y: 500))
    pulse.addLine(to: CGPoint(x: 530, y: 760))
    pulse.addLine(to: CGPoint(x: 610, y: 290))
    pulse.addLine(to: CGPoint(x: 665, y: 500))
    pulse.addLine(to: CGPoint(x: 700, y: 500))
    ctx.saveGState()
    ctx.addPath(pulse)
    ctx.setLineWidth(52)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setStrokeColor(rgb(0xf0f3f6))
    ctx.strokePath()
    ctx.restoreGState()

    // The status dot, with a soft glow.
    let dot = CGRect(x: 760, y: 450, width: 100, height: 100)
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 40, color: rgb(0x3fd07f, 0.6))
    ctx.setFillColor(rgb(0x3fd07f))
    ctx.fillEllipse(in: dot)
    ctx.restoreGState()

    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, _ path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(path)") }
}

let iconset = NSTemporaryDirectory() + "AppIcon-\(getpid()).iconset"
try FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    writePNG(draw(base), "\(iconset)/icon_\(base)x\(base).png")
    writePNG(draw(base * 2), "\(iconset)/icon_\(base)x\(base)@2x.png")
}
if CommandLine.arguments.count > 2 { writePNG(draw(1024), CommandLine.arguments[2]) }

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset, "-o", out]
try p.run()
p.waitUntilExit()
try? FileManager.default.removeItem(atPath: iconset)
guard p.terminationStatus == 0 else { fatalError("iconutil failed") }
print(out)

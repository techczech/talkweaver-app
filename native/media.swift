// Native media helper for TalkWeaver (ADR-0028). Two subcommands, no third-party deps:
//   media convert-gif <in.gif> <out.mp4>   — animated GIF → silent H.264 MP4, preserving per-frame timing
//   media poster <in.{mp4,mov,m4v,gif}> <out.jpg>  — grab a poster frame
// Built at package time (swiftc) and shipped in the app bundle; macOS-only (AVFoundation + ImageIO).
// Prints one JSON line on success: {"ok":true,"w":W,"h":H,"durationMs":D}; on failure {"ok":false,"error":"…"}.
import Foundation
import AVFoundation
import ImageIO
import CoreVideo
import AppKit
import UniformTypeIdentifiers

func fail(_ msg: String) -> Never {
  let obj: [String: Any] = ["ok": false, "error": msg]
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { print(s) }
  exit(1)
}
func ok(_ extra: [String: Any]) -> Never {
  var obj: [String: Any] = ["ok": true]
  for (k, v) in extra { obj[k] = v }
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { print(s) }
  exit(0)
}

// Per-frame delay (seconds) for GIF frame i, honoring the unclamped delay and the 0.1s browser floor.
func gifFrameDelay(_ src: CGImageSource, _ i: Int) -> Double {
  guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any],
        let gif = props[kCGImagePropertyGIFDictionary] as? [CFString: Any] else { return 0.1 }
  let unclamped = gif[kCGImagePropertyGIFUnclampedDelayTime] as? Double
  let clamped = gif[kCGImagePropertyGIFDelayTime] as? Double
  var d = unclamped ?? clamped ?? 0.1
  if d <= 0.011 { d = 0.1 } // browsers treat <=10ms as 100ms
  return d
}

// Build a 32ARGB CVPixelBuffer from a CGImage, scaled/letterbox-free into w×h.
func pixelBuffer(from cg: CGImage, width w: Int, height h: Int) -> CVPixelBuffer? {
  let attrs: [CFString: Any] = [
    kCVPixelBufferCGImageCompatibilityKey: true,
    kCVPixelBufferCGBitmapContextCompatibilityKey: true
  ]
  var pb: CVPixelBuffer?
  let status = CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32ARGB, attrs as CFDictionary, &pb)
  guard status == kCVReturnSuccess, let buffer = pb else { return nil }
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
  let cs = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(
    data: base, width: w, height: h, bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: cs,
    bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
  ) else { return nil }
  ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  return buffer
}

func convertGif(_ inPath: String, _ outPath: String) -> Never {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: inPath) as CFURL, nil) else { fail("cannot open gif") }
  let count = CGImageSourceGetCount(src)
  if count == 0 { fail("gif has no frames") }
  // A single-frame GIF is just a static image — don't make a frozen one-frame video. Tell the
  // caller to keep it as an image; do not write an MP4.
  if count == 1 { ok(["frames": 1, "static": true]) }
  guard let first = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read frame 0") }
  // H.264 requires even dimensions.
  let w = first.width - (first.width % 2)
  let h = first.height - (first.height % 2)
  if w < 2 || h < 2 { fail("gif too small") }

  try? FileManager.default.removeItem(atPath: outPath)
  guard let writer = try? AVAssetWriter(outputURL: URL(fileURLWithPath: outPath), fileType: .mp4) else { fail("cannot create writer") }
  let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: w,
    AVVideoHeightKey: h,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(w * h * 4, 400_000)]
  ]
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32ARGB),
      kCVPixelBufferWidthKey as String: w,
      kCVPixelBufferHeightKey as String: h
    ]
  )
  guard writer.canAdd(input) else { fail("cannot add input") }
  writer.add(input)
  // faststart-equivalent: moov is written at the end; .mp4 with AVAssetWriter is fine for <video>.
  guard writer.startWriting() else { fail("startWriting failed: \(writer.error?.localizedDescription ?? "?")") }
  writer.startSession(atSourceTime: .zero)

  let scale: CMTimeScale = 600
  var current = CMTime.zero
  var i = 0
  while i < count {
    while !input.isReadyForMoreMediaData { usleep(500) }
    if let cg = CGImageSourceCreateImageAtIndex(src, i, nil), let buf = pixelBuffer(from: cg, width: w, height: h) {
      if !adaptor.append(buf, withPresentationTime: current) { fail("append failed at \(i): \(writer.error?.localizedDescription ?? "?")") }
      current = CMTimeAdd(current, CMTime(seconds: gifFrameDelay(src, i), preferredTimescale: scale))
    }
    i += 1
  }
  input.markAsFinished()
  writer.endSession(atSourceTime: current)
  let sem = DispatchSemaphore(value: 0)
  writer.finishWriting { sem.signal() }
  sem.wait()
  if writer.status != .completed { fail("finish failed: \(writer.error?.localizedDescription ?? "?")") }
  ok(["w": w, "h": h, "durationMs": Int(CMTimeGetSeconds(current) * 1000), "frames": count, "static": false])
}

func writePoster(_ inPath: String, _ outPath: String) -> Never {
  let asset = AVURLAsset(url: URL(fileURLWithPath: inPath))
  let gen = AVAssetImageGenerator(asset: asset)
  gen.appliesPreferredTrackTransform = true
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
  let dur = CMTimeGetSeconds(asset.duration)
  let at = CMTime(seconds: dur.isFinite && dur > 0.2 ? min(0.1, dur / 2) : 0, preferredTimescale: 600)
  guard let cg = try? gen.copyCGImage(at: at, actualTime: nil) else { fail("cannot grab poster frame") }
  let rep = NSBitmapImageRep(cgImage: cg)
  guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else { fail("cannot encode jpeg") }
  do { try data.write(to: URL(fileURLWithPath: outPath)) } catch { fail("cannot write poster: \(error.localizedDescription)") }
  ok(["w": cg.width, "h": cg.height])
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 3 else { fail("usage: media <convert-gif|poster> <in> <out>") }
switch args[0] {
case "convert-gif": convertGif(args[1], args[2])
case "poster": writePoster(args[1], args[2])
default: fail("unknown subcommand: \(args[0])")
}

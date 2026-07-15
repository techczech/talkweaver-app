// Batch OCR helper using macOS Vision (VNRecognizeTextRequest). Reads image file paths from argv
// (one per arg) and prints one JSON line per image: {"p":"<path>","t":"<recognised text>"}.
// Built at package time (swiftc) and shipped in the app bundle; TalkWeaver spawns it to index
// slide-image text for search. macOS-only, native, no third-party deps.
import Foundation
import Vision
import AppKit

func ocr(_ path: String) -> String {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "" }
  var text = ""
  let req = VNRecognizeTextRequest { r, _ in
    let obs = (r.results as? [VNRecognizedTextObservation]) ?? []
    text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  }
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:]).perform([req])
  // the URL handler is the reliable path; fall back to the cgImage if it produced nothing.
  if text.isEmpty {
    let req2 = VNRecognizeTextRequest { r, _ in
      let obs = (r.results as? [VNRecognizedTextObservation]) ?? []
      text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
    req2.recognitionLevel = .accurate
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req2])
  }
  return text
}

let paths = Array(CommandLine.arguments.dropFirst())
for p in paths {
  let t = ocr(p)
  let obj: [String: String] = ["p": p, "t": t]
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

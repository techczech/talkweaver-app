import Foundation
import Speech
import AVFoundation
import NaturalLanguage

struct Word: Codable { let text: String; let startMs: Double; let endMs: Double }
struct Silence: Codable { let start: Double; let end: Double }
struct Segment: Codable { let text: String; let startMs: Double; let endMs: Double; let isFinal: Bool }
struct Output: Codable { let engine: String; let engineVersion: String; let locale: String; let elapsedSeconds: Double; let words: [Word]; let segments: [Segment]; let sentenceEnds: [Int]; let silence: [Silence] }
func json<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(value), as: UTF8.self))
}
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
func ms(_ time: CMTime) -> Double { time.seconds * 1000 }

@main struct TranscriptionHelper {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            if args.first == "--annotate", args.count == 4 {
                let words = try JSONDecoder().decode([Word].self, from: Data(contentsOf: URL(fileURLWithPath: args[3])))
                struct Annotation: Codable { let sentenceEnds: [Int]; let silence: [Silence] }
                try json(Annotation(sentenceEnds: sentenceEnds(words, Locale(identifier: args[2])), silence: try silence(URL(fileURLWithPath: args[1])))); return
            }
            if args.first == "--route", args.count == 2 {
                if #available(macOS 26, *) {
                    let requested = Locale(identifier: args[1])
                    if let locale = await speechLocale(requested) { try json(["engine":"apple-speech-transcriber","locale":locale.identifier]); return }
                    if let locale = await dictationLocale(requested) { try json(["engine":"apple-dictation","locale":locale.identifier]); return }
                    fail("This language is unavailable on this Mac.")
                } else { fail("Built-in words require macOS 26.") }
            }
            if args == ["--inventory"] {
                var inventory: [String: Any] = [:]
                if #available(macOS 26, *) {
                    inventory["transcriberAvailable"] = SpeechTranscriber.isAvailable
                    inventory["supported"] = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted()
                    inventory["installed"] = await SpeechTranscriber.installedLocales.map(\.identifier).sorted()
                    inventory["dictationSupported"] = await DictationTranscriber.supportedLocales.map(\.identifier).sorted()
                    inventory["dictationAssetsPresent"] = await DictationTranscriber.installedLocales.map(\.identifier).sorted()
                    var ready: [String] = []; var states: [String: String] = [:]
                    for locale in await DictationTranscriber.supportedLocales {
                        let module = DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)
                        let state = await AssetInventory.status(forModules: [module])
                        states[locale.identifier] = String(describing: state)
                        if state == .installed { ready.append(locale.identifier) }
                    }
                    inventory["dictationInstalled"] = ready.sorted()
                    inventory["dictationStates"] = states
                    inventory["reservedLocales"] = await AssetInventory.reservedLocales.map(\.identifier).sorted()
                }
                else { inventory["unavailableReason"] = "Built-in words require macOS 26. Choose an installed better model." }
                print(String(decoding: try JSONSerialization.data(withJSONObject: inventory, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)); return
            }
            if args.first == "--install-model", args.count >= 2 {
                if #available(macOS 26, *) {
                    let requested = Locale(identifier: args[1])
                    let module: any SpeechModule
                    if args.contains("--dictation") {
                        guard let locale = await dictationLocale(requested) else { fail("Unsupported DictationTranscriber locale") }
                        module = DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)
                    } else {
                        guard let locale = await speechLocale(requested) else { fail("Unsupported SpeechTranscriber locale") }
                        module = SpeechTranscriber(locale: locale, preset: .timeIndexedTranscriptionWithAlternatives)
                    }
                    try await prepare(module, requested)
                    try json(["status": String(describing: await AssetInventory.status(forModules: [module]))]); return
                } else { fail("Requires macOS 26") }
            }
            guard args.count >= 2 else { fail("Usage: transcription FILE LOCALE | --inventory | --install-model LOCALE [--dictation]. Built-in recognition stays on this Mac; Apple may download a model once.") }
            let url = URL(fileURLWithPath: args[0]); let locale = Locale(identifier: args[1])
            if #available(macOS 26, *) { if await speechLocale(locale) == nil { try await dictation(url, locale) } else { try await modern(url, locale) } }
            else { fail("This Mac needs macOS 26 for built-in words. Choose an installed better model.") }
        } catch { fail(String(describing: error)) }
    }
    // On macOS 26.5 equivalentTo(cs-CZ) returns cs_CZ for SpeechTranscriber even
    // though its supported list excludes Czech and its module status is unsupported.
    // Equivalence normalises a locale; the inventory decides engine coverage.
    static func listed(_ candidate: Locale?, _ requested: Locale, _ supported: [Locale]) -> Locale? {
        guard let candidate, candidate.language.languageCode == requested.language.languageCode else { return nil }
        let key = candidate.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        return supported.contains { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == key } ? candidate : nil
    }
    @available(macOS 26, *) static func speechLocale(_ requested: Locale) async -> Locale? {
        guard SpeechTranscriber.isAvailable else { return nil }
        return listed(await SpeechTranscriber.supportedLocale(equivalentTo: requested), requested, await SpeechTranscriber.supportedLocales)
    }
    @available(macOS 26, *) static func dictationLocale(_ requested: Locale) async -> Locale? {
        return listed(await DictationTranscriber.supportedLocale(equivalentTo: requested), requested, await DictationTranscriber.supportedLocales)
    }
    @available(macOS 26, *) static func prepare(_ module: any SpeechModule, _ locale: Locale) async throws {
        try await AssetInventory.reserve(locale: locale)
        if await AssetInventory.status(forModules: [module]) == .installed { return }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            let progress = Task {
                while !Task.isCancelled {
                    FileHandle.standardError.write(Data("Preparing this Mac's speech model: \(Int(request.progress.fractionCompleted * 100))%\n".utf8))
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
            defer { progress.cancel() }
            do { try await request.downloadAndInstall() }
            catch { FileHandle.standardError.write(Data("Apple model preparation: \((error as NSError).domain) \((error as NSError).code): \((error as NSError).localizedDescription)\n".utf8)); fail("Speech model unavailable. Connect once to prepare this language, then Retry. No audio was sent to a server.") }
        }
    }
    static func sentenceEnds(_ words: [Word], _ locale: Locale) -> [Int] {
        let text = words.map(\.text).joined(separator: " ")
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        tokenizer.setLanguage(NLLanguage(rawValue: locale.language.languageCode?.identifier ?? "en"))
        var ends: [Int] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            var upper = range.upperBound
            while upper > range.lowerBound && text[text.index(before: upper)].isWhitespace { upper = text.index(before: upper) }
            let offset = text.distance(from: text.startIndex, to: upper)
            var cursor = 0
            for (i, word) in words.enumerated() {
                cursor += word.text.count + (i == 0 ? 0 : 1)
                if cursor >= offset { ends.append(i); break }
            }
            return true
        }
        return ends
    }
    // Bounded-memory PCM scan: 10 ms RMS, -40 dB attack / -46 dB release.
    // This measures quiet sound, not semantic voice activity; music/noise needs review.
    static func silence(_ url: URL) throws -> [Silence] {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let size = AVAudioFrameCount(max(1, Int(format.sampleRate / 100)))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: size) else { return [] }
        var result: [Silence] = []; var quietStart: Double? = 0; var time = 0.0; var speaking = false
        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: size)
            guard buffer.frameLength > 0, let samples = buffer.floatChannelData else { break }
            var energy = 0.0
            for channel in 0..<Int(format.channelCount) {
                for i in 0..<Int(buffer.frameLength) { energy += Double(samples[channel][i] * samples[channel][i]) }
            }
            let rms = sqrt(energy / Double(Int(buffer.frameLength) * Int(format.channelCount)))
            let nextSpeaking = rms >= (speaking ? 0.005 : 0.01)
            if nextSpeaking && !speaking, let start = quietStart { if time > start { result.append(Silence(start: start, end: time)) }; quietStart = nil }
            if !nextSpeaking && speaking { quietStart = time }
            speaking = nextSpeaking
            time += Double(buffer.frameLength) / format.sampleRate * 1000
        }
        if let start = quietStart, time > start { result.append(Silence(start: start, end: time)) }
        return result
    }
    @available(macOS 26, *) static func modern(_ url: URL, _ requested: Locale) async throws {
        guard SpeechTranscriber.isAvailable else { fail("SpeechTranscriber unavailable on this hardware") }
        guard let locale = await speechLocale(requested) else { fail("Unsupported SpeechTranscriber locale: \(requested.identifier)") }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        try await prepare(transcriber, locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let started = Date()
        let collector = Task { () throws -> ([Word], [Segment]) in
            var words: [Word] = []; var segments: [Segment] = []
            for try await result in transcriber.results {
                segments.append(Segment(text: String(result.text.characters), startMs: ms(result.range.start), endMs: ms(result.range.end), isFinal: result.isFinal))
                for run in result.text.runs {
                    if let range = run.audioTimeRange {
                        words.append(Word(text: String(result.text[run.range].characters), startMs: ms(range.start), endMs: ms(range.end)))
                    }
                }
                FileHandle.standardError.write(Data("Writing out your words: \(Int(ms(result.resultsFinalizationTime) / 1000)) seconds processed\n".utf8))
            }
            return (words, segments)
        }
        do {
            let file = try AVAudioFile(forReading: url)
            let end = try await analyzer.analyzeSequence(from: file)
            if let end { try await analyzer.finalizeAndFinish(through: end) }
            else { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            let (words, segments) = try await collector.value
            try json(Output(engine: "apple-speech-transcriber", engineVersion: ProcessInfo.processInfo.operatingSystemVersionString, locale: locale.identifier, elapsedSeconds: Date().timeIntervalSince(started), words: words, segments: segments, sentenceEnds: sentenceEnds(words, locale), silence: try silence(url)))
        } catch { collector.cancel(); await analyzer.cancelAndFinishNow(); throw error }
    }
    @available(macOS 26, *) static func dictation(_ url: URL, _ requested: Locale) async throws {
        guard let locale = await dictationLocale(requested) else { fail("Unsupported DictationTranscriber locale: \(requested.identifier)") }
        let transcriber = DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)
        try await prepare(transcriber, locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let started = Date()
        let collector = Task { () throws -> ([Word], [Segment]) in
            var words: [Word] = []; var segments: [Segment] = []
            for try await result in transcriber.results {
                segments.append(Segment(text: String(result.text.characters), startMs: ms(result.range.start), endMs: ms(result.range.end), isFinal: result.isFinal))
                for run in result.text.runs {
                    if let range = run.audioTimeRange {
                        words.append(Word(text: String(result.text[run.range].characters), startMs: ms(range.start), endMs: ms(range.end)))
                    }
                }
                FileHandle.standardError.write(Data("Writing out your words: \(Int(ms(result.resultsFinalizationTime) / 1000)) seconds processed\n".utf8))
            }
            return (words, segments)
        }
        do {
            let file = try AVAudioFile(forReading: url)
            let end = try await analyzer.analyzeSequence(from: file)
            if let end { try await analyzer.finalizeAndFinish(through: end) }
            else { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            let (words, segments) = try await collector.value
            try json(Output(engine: "apple-dictation", engineVersion: ProcessInfo.processInfo.operatingSystemVersionString, locale: locale.identifier, elapsedSeconds: Date().timeIntervalSince(started), words: words, segments: segments, sentenceEnds: sentenceEnds(words, locale), silence: try silence(url)))
        } catch { collector.cancel(); await analyzer.cancelAndFinishNow(); throw error }
    }
}

// pdftext: print a PDF's page count and per-page text using macOS PDFKit (no Homebrew).
// Output: JSON {"pages": N, "text": ["page 1 text", ...]}
// Usage: swift tools/grantlint/pdftext.swift file.pdf
import Foundation
import PDFKit

guard CommandLine.arguments.count == 2, let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("usage: pdftext.swift file.pdf (file must be a readable PDF)\n".data(using: .utf8)!)
    exit(2)
}
var pages: [String] = []
for i in 0..<doc.pageCount {
    pages.append(doc.page(at: i)?.string ?? "")
}
let out: [String: Any] = ["pages": doc.pageCount, "text": pages]
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)

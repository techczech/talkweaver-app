import Foundation
import Darwin

// Read-only metadata protocol. Each process owns one bounded request and one pinned root.
struct Refusal: Error { let message: String }
func refuse(_ text: String) throws -> Never { throw Refusal(message: text) }
func identity(_ s: stat) -> String { "\(s.st_dev):\(s.st_ino)" }
func info(_ fd: Int32) throws -> stat {
 var s = stat(); guard fstat(fd, &s) == 0 else { try refuse("Metadata unavailable") }; return s
}
let rootPath = CommandLine.arguments[1]
let expected = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
var root: Int32 = -1
var pinned = ""
var observed = [String:String]()
var iterators = [String:(UnsafeMutablePointer<DIR>, String)]()
func checkMarker() throws {
 if CommandLine.arguments.count > 4, access(CommandLine.arguments[4], F_OK) != 0 { try refuse("Read request cancelled") }
}
func checkRoot() throws -> String {
 try checkMarker()
 let fd = open(rootPath, O_RDONLY | O_DIRECTORY | 0x20000000)
 guard fd >= 0 else { try refuse("stale") }; defer { close(fd) }
 let value = identity(try info(fd))
 guard (expected.isEmpty || value == expected), (pinned.isEmpty || pinned == value) else { try refuse("stale") }
 if root < 0 { root = dup(fd); pinned = value }
 return rootPath + ":" + value
}
func parts(_ path: String) throws -> [String] {
 if path.isEmpty { return [] }
 let p = path.components(separatedBy: "/")
 guard !p.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.contains("\0") }) else { try refuse("Invalid relative path") }; return p
}
func directory(_ names: [String]) throws -> Int32 {
 var fd = dup(root); var prefix = [String]()
 do {
  for name in names {
   try checkMarker()
   let next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
   guard next >= 0 else { try refuse("Directory acquisition refused") }
   close(fd); fd = next; prefix.append(name)
   let key = prefix.joined(separator: "/"), value = identity(try info(fd))
   if let known = observed[key], known != value { try refuse("Path changed") }
   observed[key] = value
  }
  return fd
 } catch { close(fd); throw error }
}
func metadata(_ path: String) throws -> [String:Any] {
 let names = try parts(path), parent = try directory(Array(names.dropLast())); defer { close(parent) }
 var s = stat()
 if let name = names.last { guard fstatat(parent, name, &s, AT_SYMLINK_NOFOLLOW) == 0 else { try refuse("Metadata unavailable") } } else { s = try info(parent) }
 let value = identity(s)
 if let known = observed[path], known != value { try refuse("Path changed") }; observed[path] = value
 let kind = s.st_mode & S_IFMT
 if kind == S_IFLNK { return ["kind":"link", "reason":"Target excluded; allocation unknown"] }
 if kind == S_IFDIR {
  let fd = try directory(names); defer { close(fd) }
  guard identity(try info(fd)) == value else { try refuse("Path changed") }
  let name = names.last?.lowercased() ?? ""
  return ["kind":name == "research" ? "research" : ["assets","_assets"].contains(name) ? "assets" : name.hasPrefix(".") ? "system" : "folder"]
 }
 guard kind == S_IFREG, let name = names.last else { return ["kind":"other", "reason":"Special entry excluded"] }
 try checkMarker()
 let fd = openat(parent, name, O_EVTONLY | O_NOFOLLOW | O_NONBLOCK)
 guard fd >= 0 else { try refuse("File acquisition refused") }; defer { close(fd) }
 let actual = try info(fd)
 guard identity(actual) == value, actual.st_mode & S_IFMT == S_IFREG else { try refuse("Path changed") }
 var finder = [UInt8](repeating:0,count:32)
 let count = fgetxattr(fd,"com.apple.FinderInfo",&finder,32,0,0)
 if count >= 10 && finder[8] & 0x80 != 0 { return ["kind":"alias", "reason":"Finder alias target excluded; allocation unknown"] }
 if count < 0 && errno != ENOATTR { return ["kind":"other", "reason":"Finder metadata unavailable"] }
 var attrs = [CChar](repeating:0,count:4096)
 let n = flistxattr(fd,&attrs,attrs.count,0)
 let namesText = n > 0 ? String(decoding:attrs.prefix(n).map { UInt8(bitPattern:$0) },as:UTF8.self) : ""
 let cloud = n < 0 || actual.st_flags & (0x10000000 | 0x40000000) != 0 || ["com.apple.fileprovider","com.apple.ubiquity","com.apple.CloudDocs"].contains(where:namesText.contains)
 return ["kind":"file", "logical":actual.st_size,"allocated":cloud ? NSNull() : NSNumber(value:actual.st_blocks * 512),"reason":cloud ? "Cloud allocation unknown" : "Filesystem st_blocks in POSIX 512-byte units"]
}
func readSource(_ path: String) throws -> [String:Any] {
 let names = try parts(path)
 guard let name = names.last else { try refuse("Missing source") }
 let parent = try directory(Array(names.dropLast())); defer { close(parent) }
 var observedStat = stat()
 guard fstatat(parent,name,&observedStat,AT_SYMLINK_NOFOLLOW) == 0, observedStat.st_mode & S_IFMT == S_IFREG else { try refuse("Source acquisition refused") }
 try checkMarker()
 let fd = openat(parent,name,O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
 guard fd >= 0 else { try refuse("Source acquisition refused") }; defer { close(fd) }
 let before = try info(fd)
 guard identity(before) == identity(observedStat), before.st_mode & S_IFMT == S_IFREG, before.st_size <= 16 * 1024 * 1024 else { try refuse("Source identity or bound refused") }
 var bytes = [UInt8](repeating:0,count:Int(before.st_size)); var offset = 0
 while offset < bytes.count {
  try checkMarker()
  let remaining = bytes.count-offset
  let n = bytes.withUnsafeMutableBytes { read(fd,$0.baseAddress!.advanced(by:offset),remaining) }
  guard n > 0 else { try refuse("Source read failed") }; offset += n
 }
 let after = try info(fd)
 guard before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec, before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { try refuse("Source changed") }
 _ = try checkRoot()
 return ["data":Data(bytes).base64EncodedString(),"text":String(decoding:bytes,as:UTF8.self),"dev":after.st_dev,"ino":after.st_ino,"size":after.st_size,"mtimeMs":Double(after.st_mtimespec.tv_sec)*1000 + Double(after.st_mtimespec.tv_nsec)/1000000,"ctimeMs":Double(after.st_ctimespec.tv_sec)*1000 + Double(after.st_ctimespec.tv_nsec)/1000000]
}
func dispatch(_ cmd: [String:Any]) throws -> Any {
 let op = cmd["op"] as? String ?? ""
 let rootIdentity = try checkRoot()
 if op == "identity" { return rootIdentity }
 let path = cmd["path"] as? String ?? ""
 if op == "source" && CommandLine.arguments.contains("--source") { return try readSource(path) }
 if op == "metadata" { return try metadata(path) }
 if op == "list" {
  guard iterators.count < 65 else { try refuse("Directory limit reached") }
  let fd = try directory(parts(path))
  guard let dir = fdopendir(fd) else { close(fd); try refuse("Directory unavailable") }
  let key = String(describing:cmd["id"]!)
  iterators[key] = (dir,path); return key
 }
 let key = cmd["key"] as? String ?? ""
 if op == "end" { if let (dir,_) = iterators.removeValue(forKey:key) { closedir(dir) }; return NSNull() }
 if op == "next", let (dir,path) = iterators[key] {
  var batch = [String](); var done = false
  while batch.count < 32 {
   errno = 0
   guard let entry = readdir(dir) else { if errno != 0 { try refuse("Directory read failed") }; done = true; break }
   let name = withUnsafePointer(to:&entry.pointee.d_name) { $0.withMemoryRebound(to:CChar.self,capacity:1024) { String(cString:$0) } }
   if name == "." || name == ".." { continue }
   batch.append(path.isEmpty ? name : path + "/" + name)
  }
  if done { closedir(dir); iterators.removeValue(forKey:key) }
  return ["batch":batch,"done":done]
 }
 try refuse("Unknown metadata operation")
}
while let line = readLine() {
 if line.utf8.count > 65536 { break }
 guard let data = line.data(using:.utf8), let cmd = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { break }
 var answer: [String:Any] = ["id":cmd["id"] ?? NSNull()]
 do { answer["value"] = try dispatch(cmd) } catch { answer["error"] = (error as? Refusal)?.message ?? "Metadata operation refused" }
 if let data = try? JSONSerialization.data(withJSONObject:answer,options:[.sortedKeys]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
for (dir,_) in iterators.values { closedir(dir) }; if root >= 0 { close(root) }

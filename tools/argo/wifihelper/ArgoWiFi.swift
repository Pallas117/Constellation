// ArgoWiFi: scan-only Wi-Fi helper for Argo (GAU-234).
//
// macOS hides network names (SSIDs) from processes without Location Services, so Argo can't see which
// networks are in range. This helper is an app bundle so macOS can ask once for Location access; then
// it scans with CoreWLAN and writes the networks in range as JSON. It never joins a network and never
// reads a password: Argo decides and joins with networksetup.
//
//   ArgoWiFi scan --out <file>    write [{ssid,bssid,rssi,noise,channel,band,security}] to <file>
//
// Argo runs it with `open -W -g -a ArgoWiFi.app --args scan --out <file>` so Location Services sees
// the bundle. Exit 0 = scanned, 2 = usage, 3 = Location access denied (SSIDs would be empty), 4 = no Wi-Fi.
import CoreLocation
import CoreWLAN
import Foundation

struct Net: Codable {
    let ssid: String
    let bssid: String
    let rssi: Int
    let noise: Int
    let channel: Int
    let band: String
    let security: String
}

func band(_ c: CWChannel?) -> String {
    switch c?.channelBand {
    case .band2GHz: return "2.4"
    case .band5GHz: return "5"
    case .band6GHz: return "6"
    default: return ""
    }
}

func security(_ n: CWNetwork) -> String {
    // Strongest first, so a mixed WPA2/WPA3 network reads as WPA3.
    let order: [(CWSecurity, String)] = [
        (.wpa3Personal, "WPA3"), (.wpa3Transition, "WPA2/WPA3"), (.wpa3Enterprise, "WPA3-Enterprise"),
        (.wpa2Personal, "WPA2"), (.wpa2Enterprise, "WPA2-Enterprise"), (.wpaPersonal, "WPA"),
        (.wpaEnterprise, "WPA-Enterprise"), (.dynamicWEP, "WEP"), (.WEP, "WEP"), (.OWE, "OWE"), (.none, "NONE"),
    ]
    for (s, name) in order where n.supportsSecurity(s) { return name }
    return "UNKNOWN"
}

final class Locator: NSObject, CLLocationManagerDelegate {
    let m = CLLocationManager()
    var done = false
    func ask() {
        m.delegate = self
        if m.authorizationStatus == .notDetermined { m.requestWhenInUseAuthorization() } else { done = true }
        let until = Date().addingTimeInterval(60) // the prompt waits for Josh at most a minute
        while !done && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
    }
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if m.authorizationStatus != .notDetermined { done = true }
    }
    var allowed: Bool { [.authorizedAlways, .authorized].contains(m.authorizationStatus) }
}

let args = CommandLine.arguments
guard args.count >= 4, args[1] == "scan", args[2] == "--out" else {
    FileHandle.standardError.write("usage: ArgoWiFi scan --out <file>\n".data(using: .utf8)!)
    exit(2)
}
let out = URL(fileURLWithPath: args[3])
let loc = Locator()
loc.ask()
guard let iface = CWWiFiClient.shared().interface() else { exit(4) }
var nets: [Net] = []
if let found = try? iface.scanForNetworks(withSSID: nil) {
    for n in found {
        nets.append(Net(ssid: n.ssid ?? "", bssid: n.bssid ?? "", rssi: n.rssiValue, noise: n.noiseMeasurement,
                        channel: n.wlanChannel?.channelNumber ?? 0, band: band(n.wlanChannel), security: security(n)))
    }
}
nets.sort { $0.rssi > $1.rssi }
let data = (try? JSONEncoder().encode(nets)) ?? Data("[]".utf8)
// 0600: SSIDs say where Josh is; they stay on this Mac.
FileManager.default.createFile(atPath: out.path, contents: data, attributes: [.posixPermissions: 0o600])
exit(loc.allowed ? 0 : 3)

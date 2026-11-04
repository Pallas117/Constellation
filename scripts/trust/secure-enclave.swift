// Secure Enclave helper for Gauss signing keys (GAU-67, backend/trust/touch-id-lock.ts), built on
// first use with the Command Line Tools' swiftc:
//   secure-enclave create   -> {"key": <enclave key blob, base64>, "publicKey": <P-256 X9.63, base64>}
//   secure-enclave derive   <- {"key", "peer", "reason"} on stdin; -> ECDH shared secret, base64, after Touch ID
// The private key never leaves the Secure Enclave. Its blob only works on this Mac, and only after
// a fingerprint that was enrolled when it was made ([.privateKeyUsage, .biometryCurrentSet]):
// adding or removing a fingerprint retires it for good.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct Created: Encodable {
  let key: String
  let publicKey: String
}

struct DeriveRequest: Decodable {
  let key: String
  let peer: String
  let reason: String
}

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

guard SecureEnclave.isAvailable else { fail("this Mac has no Secure Enclave", 2) }

switch CommandLine.arguments.dropFirst().first {
case "create":
  var error: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error) else {
    fail("could not set Touch ID access: \(String(describing: error))")
  }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    let created = Created(key: key.dataRepresentation.base64EncodedString(), publicKey: key.publicKey.x963Representation.base64EncodedString())
    FileHandle.standardOutput.write(try JSONEncoder().encode(created))
  } catch {
    fail("could not make a Secure Enclave key: \(error)")
  }
case "derive":
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let request = try? JSONDecoder().decode(DeriveRequest.self, from: input),
    let blob = Data(base64Encoded: request.key),
    let peer = Data(base64Encoded: request.peer)
  else { fail("bad request", 2) }
  let context = LAContext()
  context.localizedReason = request.reason
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
    let secret = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
    FileHandle.standardOutput.write(Data(secret.withUnsafeBytes { Data($0) }.base64EncodedString().utf8))
  } catch {
    fail("not unlocked: \(error.localizedDescription)")
  }
default:
  fail("usage: secure-enclave create | derive < request.json", 2)
}

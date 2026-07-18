import { registerEphemeralTestTrustAnchor, signDocument } from "../lib/trust.mjs";

// RFC 8032 vector material. It is intentionally public, test-only and never
// part of the production trust store.
const x = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64url");
const d = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64url");

export const TEST_TRUST_ANCHOR = registerEphemeralTestTrustAnchor({
  keyId: "test-capacity-root-v1",
  algorithm: "Ed25519",
  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x },
  status: "active"
});

export const TEST_PRIVATE_JWK = Object.freeze({ kty: "OKP", crv: "Ed25519", x, d });
export const TEST_SIGNER = Object.freeze({ keyId: TEST_TRUST_ANCHOR.keyId, privateKeyJwk: TEST_PRIVATE_JWK });

export function signTestDocument(unsignedDocument, purpose) {
  return signDocument(unsignedDocument, {
    purpose,
    keyId: TEST_TRUST_ANCHOR.keyId,
    privateKeyJwk: TEST_PRIVATE_JWK
  });
}

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};

#[test]
fn signed_installer_matches_embedded_key_and_version() {
    let Some(path) = std::env::var_os("SHIXU_UPDATE_ARTIFACT") else {
        return;
    };
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(config["plugins"]["updater"]["requireSignedVersion"], true);
    let release: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.release.conf.json")).unwrap();
    let version = release["version"].as_str().unwrap();
    let encoded_key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let public_key =
        PublicKey::decode(&String::from_utf8(STANDARD.decode(encoded_key).unwrap()).unwrap())
            .unwrap();
    let signature_path = format!("{}.sig", std::path::Path::new(&path).display());
    let signature_base64 = std::fs::read_to_string(signature_path).unwrap();
    let signature = Signature::decode(
        &String::from_utf8(STANDARD.decode(signature_base64.trim()).unwrap()).unwrap(),
    )
    .unwrap();
    let mut installer = std::fs::read(path).unwrap();
    public_key.verify(&installer, &signature, true).unwrap();
    installer[0] ^= 1;
    assert!(public_key.verify(&installer, &signature, true).is_err());
    assert!(
        signature
            .trusted_comment()
            .split('\t')
            .any(|field| field == format!("version:{version}")),
        "installer signature must bind the release version"
    );
}

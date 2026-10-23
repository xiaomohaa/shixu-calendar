use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::PCWSTR;
use zeroize::Zeroizing;

fn dpapi(input: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let blob = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| "凭据过长")?,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // Windows allocates output.pbData. It must be released with LocalFree.
    let result = unsafe {
        if protect {
            CryptProtectData(
                &blob,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &blob,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    result.map_err(|_| "Windows 用户凭据保护不可用")?;
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let copy = Zeroizing::new(bytes.to_vec());
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(copy)
}

pub fn seal(password: &str) -> Result<String, String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("密码长度无效".into());
    }
    let encrypted = dpapi(password.as_bytes(), true)?;
    Ok(format!("dpapi:v1:{}", STANDARD.encode(&*encrypted)))
}

pub fn open(ciphertext: &str) -> Result<Zeroizing<String>, String> {
    let encoded = ciphertext
        .strip_prefix("dpapi:v1:")
        .ok_or("凭据格式不受支持")?;
    let blob = STANDARD.decode(encoded).map_err(|_| "凭据格式无效")?;
    let plaintext = dpapi(&blob, false)?;
    let text = String::from_utf8(plaintext.to_vec()).map_err(|_| "凭据文本无效")?;
    Ok(Zeroizing::new(text))
}

/// Electron 45 / Chromium v10: Local State contains a DPAPI-wrapped AES key.
/// This is only called for an explicit same-user migration from an old data copy.
pub fn open_electron(
    local_state: &Path,
    encoded_password: &str,
) -> Result<Zeroizing<String>, String> {
    let state = std::fs::read_to_string(local_state).map_err(|_| "找不到旧版密钥文件")?;
    let state: serde_json::Value = serde_json::from_str(&state).map_err(|_| "旧版密钥文件无效")?;
    let wrapped = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(|v| v.as_str())
        .ok_or("旧版密钥不存在")?;
    let wrapped = STANDARD.decode(wrapped).map_err(|_| "旧版密钥格式无效")?;
    let wrapped = wrapped
        .strip_prefix(b"DPAPI")
        .ok_or("旧版密钥格式不受支持")?;
    let key = dpapi(wrapped, false)?;
    if key.len() != 32 {
        return Err("旧版密钥长度无效".into());
    }
    let blob = STANDARD
        .decode(encoded_password)
        .map_err(|_| "旧版凭据格式无效")?;
    if blob.len() < 3 + 12 + 16 || !blob.starts_with(b"v10") {
        return Err("旧版凭据版本不受支持".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "旧版密钥无效")?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(aes_gcm::Nonce::from_slice(&blob[3..15]), &blob[15..])
            .map_err(|_| "无法解密旧版凭据，请重新输入密码")?,
    );
    let text = String::from_utf8(plaintext.to_vec()).map_err(|_| "旧版凭据文本无效")?;
    Ok(Zeroizing::new(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_dpapi_roundtrip_and_tamper_rejection() {
        let sealed = seal("synthetic-only-password").unwrap();
        assert!(sealed.starts_with("dpapi:v1:"));
        assert_eq!(&*open(&sealed).unwrap(), "synthetic-only-password");
        assert!(open("dpapi:v1:AAAA").is_err());
    }

    #[test]
    fn electron_45_smoke_fixture_when_available() {
        let Ok(dir) = std::env::var("SHIXU_LEGACY_FIXTURE_DIR") else {
            return;
        };
        let dir = Path::new(&dir);
        let db = rusqlite::Connection::open_with_flags(
            dir.join("calendar.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let ciphertext: String = db
            .query_row("SELECT password FROM accounts LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            &*open_electron(&dir.join("Local State"), &ciphertext).unwrap(),
            "fixture-only-secret"
        );
    }
}

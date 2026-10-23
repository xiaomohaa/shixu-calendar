use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedInput {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub allow_http: bool,
}

impl FeedInput {
    pub fn validate(&mut self) -> Result<(), String> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.len() > 100 || self.url.len() > 2048 {
            return Err("请输入日历名称和有效的 ICS 链接".into());
        }
        if self.url.starts_with("webcal://") {
            self.url = self.url.replacen("webcal://", "https://", 1);
        }
        self.url = crate::dav::normalize_url(self.url.trim(), self.allow_http)?.to_string();
        Ok(())
    }
}

pub async fn fetch(url: &str, allow_http: bool) -> Result<String, String> {
    let target = crate::dav::normalize_url(url, allow_http)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .https_only(!allow_http)
        .user_agent("Shixu-Calendar/2 ICS")
        .build()
        .map_err(|_| "无法创建日历下载连接")?;
    let mut response = client
        .get(target)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| "无法下载 ICS 日历，请检查链接和网络")?;
    if !response.status().is_success() {
        return Err(format!(
            "ICS 日历下载失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "ICS 日历下载中断")? {
        if data.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("ICS 日历超过 32 MB 大小限制".into());
        }
        data.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(data).map_err(|_| "ICS 日历不是有效的 UTF-8 文件")?;
    let text = text.trim_start_matches('\u{feff}').trim();
    if !text.starts_with("BEGIN:VCALENDAR") || !text.ends_with("END:VCALENDAR") {
        return Err("该链接没有返回有效的 ICS 日历文件".into());
    }
    Ok(text.to_owned())
}

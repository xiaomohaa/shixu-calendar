use reqwest::{Client, Method, Url, header};
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;
use zeroize::Zeroizing;

const LIMIT: usize = 32 * 1024 * 1024;
const PROPERTIES: &str = "<d:displayname/><d:resourcetype/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/><d:supported-report-set/><d:sync-token/>";
const NS: &str = "xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:a=\"http://apple.com/ns/ical/\"";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: Option<String>,
    #[serde(default)]
    pub allow_http: bool,
    #[serde(default)]
    pub paused: bool,
}

impl AccountInput {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 200)
            || self.name.trim().is_empty()
            || self.name.len() > 100
            || self.url.is_empty()
            || self.url.len() > 2048
            || self.username.is_empty()
            || self.username.len() > 500
            || self
                .password
                .as_ref()
                .is_some_and(|password| password.len() > 4096)
        {
            return Err("账户参数无效".into());
        }
        normalize_url(&self.url, self.allow_http)?;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub account_id: String,
    pub url: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub read_only: bool,
}

pub struct RemoteObject {
    pub url: String,
    pub etag: Option<String>,
    pub ics: Option<String>,
    pub deleted: bool,
}
pub struct Pull {
    pub objects: Vec<RemoteObject>,
    pub token: Option<String>,
    pub full: bool,
}
pub struct RemoteGet {
    pub ics: String,
    pub etag: Option<String>,
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Default)]
struct Entry {
    href: String,
    status: u16,
    etag: Option<String>,
    ics: Option<String>,
    calendar: bool,
    vevent: bool,
    display_name: String,
    color: String,
    home: Option<String>,
    principal: Option<String>,
    read_only: bool,
}

struct DavResult {
    entries: Vec<Entry>,
    token: Option<String>,
}

fn child<'a>(node: Node<'a, 'a>, name: &str) -> Option<Node<'a, 'a>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}
fn text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter_map(|n| n.text().filter(|_| n.is_text()))
        .collect::<String>()
        .trim()
        .to_string()
}
fn href(node: Node<'_, '_>) -> Option<String> {
    child(node, "href").map(text).filter(|s| !s.is_empty())
}
fn status(node: Node<'_, '_>) -> u16 {
    child(node, "status")
        .map(text)
        .and_then(|s| s.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
        .unwrap_or(200)
}

fn parse_dav(xml: &str) -> Result<DavResult, String> {
    if xml.len() > LIMIT || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err("服务器返回的 DAV XML 无效".into());
    }
    let document = Document::parse(xml).map_err(|_| "服务器返回的 DAV XML 无效")?;
    if document.root_element().tag_name().name() != "multistatus" {
        return Err("服务器未返回 DAV multistatus，请检查服务地址".into());
    }
    let mut entries = Vec::new();
    let token = child(document.root_element(), "sync-token")
        .map(text)
        .filter(|value| !value.is_empty());
    for response in document
        .root_element()
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "response")
    {
        let mut entry = Entry {
            href: href(response).unwrap_or_default(),
            status: status(response),
            vevent: true,
            ..Entry::default()
        };
        for propstat in response.children().filter(|n| {
            n.is_element() && n.tag_name().name() == "propstat" && (200..300).contains(&status(*n))
        }) {
            let Some(prop) = child(propstat, "prop") else {
                continue;
            };
            for item in prop.children().filter(|n| n.is_element()) {
                match item.tag_name().name() {
                    "displayname" => entry.display_name = text(item),
                    "calendar-color" => entry.color = text(item),
                    "getetag" => entry.etag = Some(text(item)).filter(|value| !value.is_empty()),
                    "calendar-data" => {
                        entry.ics = Some(text(item)).filter(|value| !value.is_empty())
                    }
                    "calendar-home-set" => entry.home = href(item),
                    "current-user-principal" => entry.principal = href(item),
                    "resourcetype" => entry.calendar = child(item, "calendar").is_some(),
                    "supported-calendar-component-set" => {
                        let comps: Vec<_> = item
                            .children()
                            .filter(|n| n.is_element() && n.tag_name().name() == "comp")
                            .collect();
                        entry.vevent = comps.is_empty()
                            || comps.iter().any(|n| {
                                n.attribute("name")
                                    .is_some_and(|v| v.eq_ignore_ascii_case("VEVENT"))
                            });
                    }
                    "current-user-privilege-set" => {
                        let privileges: Vec<_> = item
                            .descendants()
                            .filter(|n| {
                                n.is_element()
                                    && matches!(
                                        n.tag_name().name(),
                                        "all" | "write" | "write-content"
                                    )
                            })
                            .collect();
                        entry.read_only = privileges.is_empty()
                            && item
                                .descendants()
                                .any(|n| n.is_element() && n.tag_name().name() == "privilege");
                    }
                    _ => {}
                }
            }
        }
        entries.push(entry);
    }
    Ok(DavResult { entries, token })
}

pub fn normalize_url(raw: &str, allow_http: bool) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "请输入完整 HTTPS 地址")?;
    if !(url.scheme() == "https" || (allow_http && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "请输入完整 HTTPS 地址，不含密码、查询参数或片段；HTTP 需要明确勾选允许".into(),
        );
    }
    Ok(url)
}

pub struct DavClient {
    client: Client,
    base: Url,
    username: String,
    password: Zeroizing<String>,
}

impl DavClient {
    pub fn new(input: &AccountInput, password: Zeroizing<String>) -> Result<Self, String> {
        let base = normalize_url(&input.url, input.allow_http)?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|_| "无法建立网络连接")?;
        Ok(Self {
            client,
            base,
            username: input.username.clone(),
            password,
        })
    }

    fn resolve(&self, href: &str, base: &Url) -> Result<Url, String> {
        let url = base.join(href).map_err(|_| "服务器返回无效日历地址")?;
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "服务器指向另一个站点。为保护凭据，请使用该站点的具体 CalDAV 地址添加账户".into(),
            );
        }
        Ok(url)
    }

    async fn xml_request(
        &self,
        method: Method,
        url: Url,
        depth: &str,
        body: String,
    ) -> Result<(DavResult, Url), String> {
        let mut current = url;
        for _ in 0..6 {
            let mut response = self
                .client
                .request(method.clone(), current.clone())
                .basic_auth(&self.username, Some(self.password.as_str()))
                .header("Depth", depth)
                .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                .body(body.clone())
                .send()
                .await
                .map_err(|_| "无法连接 CalDAV 服务器")?;
            if matches!(response.status().as_u16(), 301 | 302 | 307 | 308) {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("服务器重定向地址无效")?;
                current = self.resolve(location, &current)?;
                continue;
            }
            if !response.status().is_success() {
                return Err(format!(
                    "CalDAV 服务器返回 HTTP {}",
                    response.status().as_u16()
                ));
            }
            if response.content_length().is_some_and(|n| n > LIMIT as u64) {
                return Err("服务器单次响应超过 32MB".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "读取 CalDAV 响应失败")?
            {
                if bytes.len() + chunk.len() > LIMIT {
                    return Err("服务器响应过大，已停止读取".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let xml = std::str::from_utf8(&bytes).map_err(|_| "服务器返回的 DAV XML 无效")?;
            return Ok((parse_dav(xml)?, current));
        }
        Err("服务器重定向次数过多，请填写最终服务地址".into())
    }

    async fn propfind(&self, url: Url, depth: &str) -> Result<(Vec<Entry>, Url), String> {
        let body = format!("<d:propfind {NS}><d:prop>{PROPERTIES}</d:prop></d:propfind>");
        let (result, url) = self
            .xml_request(Method::from_bytes(b"PROPFIND").unwrap(), url, depth, body)
            .await?;
        Ok((result.entries, url))
    }

    fn calendars(
        &self,
        entries: Vec<Entry>,
        base: &Url,
        account_id: &str,
    ) -> Result<Vec<Calendar>, String> {
        entries
            .into_iter()
            .filter(|e| e.calendar && e.vevent)
            .map(|e| {
                let url = self.resolve(&e.href, base)?.to_string();
                let color = e.color.chars().take(7).collect::<String>();
                Ok(Calendar {
                    id: Uuid::new_v4().to_string(),
                    account_id: account_id.into(),
                    url,
                    name: if e.display_name.is_empty() {
                        "未命名日历".into()
                    } else {
                        e.display_name
                    },
                    color: if color.len() == 7
                        && color.starts_with('#')
                        && color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                    {
                        color
                    } else {
                        "#d65c4f".into()
                    },
                    visible: true,
                    read_only: e.read_only,
                })
            })
            .collect()
    }

    pub async fn discover(&self, account_id: &str) -> Result<Vec<Calendar>, String> {
        let origin = self
            .base
            .join("/.well-known/caldav")
            .map_err(|_| "CalDAV 地址无效")?;
        for candidate in [self.base.clone(), origin] {
            let (first, first_url) = match self.propfind(candidate, "0").await {
                Ok(found) => found,
                Err(error)
                    if ["HTTP 401", "HTTP 403", "HTTP 429"]
                        .iter()
                        .any(|code| error.ends_with(code)) =>
                {
                    return Err(error);
                }
                Err(_) => continue,
            };
            let direct = self.calendars(first.clone(), &first_url, account_id)?;
            if !direct.is_empty() {
                return Ok(direct);
            }
            let mut home = first.iter().find_map(|e| e.home.clone());
            let mut home_base = first_url.clone();
            if home.is_none() {
                if let Some(principal) = first.iter().find_map(|e| e.principal.clone()) {
                    let principal = self.resolve(&principal, &first_url)?;
                    if let Ok((found, url)) = self.propfind(principal, "0").await {
                        home = found.iter().find_map(|e| e.home.clone());
                        home_base = url;
                    }
                }
            }
            let listing_url = match home {
                Some(href) => self.resolve(&href, &home_base)?,
                None => first_url,
            };
            if let Ok((listing, url)) = self.propfind(listing_url, "1").await {
                let calendars = self.calendars(listing, &url, account_id)?;
                if !calendars.is_empty() {
                    let mut seen = std::collections::HashSet::new();
                    return Ok(calendars
                        .into_iter()
                        .filter(|c| seen.insert(c.url.clone()))
                        .collect());
                }
            }
        }
        Err("未发现日历，请填写更具体的服务或日历地址".into())
    }

    async fn materialize(
        &self,
        entries: Vec<Entry>,
        base: &Url,
    ) -> Result<Vec<RemoteObject>, String> {
        let mut output = Vec::new();
        let mut missing = Vec::new();
        for entry in entries {
            if entry.href.is_empty() {
                continue;
            }
            let url = self.resolve(&entry.href, base)?;
            if url.path().trim_end_matches('/') == base.path().trim_end_matches('/') {
                continue;
            }
            if matches!(entry.status, 404 | 410) {
                output.push(RemoteObject {
                    url: url.to_string(),
                    etag: None,
                    ics: None,
                    deleted: true,
                });
            } else if !(200..300).contains(&entry.status) {
                return Err(format!("CalDAV 服务器返回 HTTP {}", entry.status));
            } else if let Some(ics) = entry.ics {
                output.push(RemoteObject {
                    url: url.to_string(),
                    etag: entry.etag,
                    ics: Some(ics),
                    deleted: false,
                });
            } else {
                missing.push(url);
            }
        }
        let report = Method::from_bytes(b"REPORT").unwrap();
        for chunk in missing.chunks(80) {
            let hrefs = chunk
                .iter()
                .map(|url| format!("<d:href>{}</d:href>", escape_xml(url.path())))
                .collect::<String>();
            let body = format!(
                "<c:calendar-multiget {NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>{hrefs}</c:calendar-multiget>"
            );
            let (result, _) = self
                .xml_request(report.clone(), base.clone(), "1", body)
                .await?;
            let mut mapped = std::collections::HashMap::new();
            for entry in result.entries {
                mapped.insert(self.resolve(&entry.href, base)?.to_string(), entry);
            }
            for url in chunk {
                let entry = mapped
                    .remove(url.as_str())
                    .ok_or("服务器遗漏 calendar-multiget 资源，已保留原缓存和同步令牌")?;
                if matches!(entry.status, 404 | 410) {
                    output.push(RemoteObject {
                        url: url.to_string(),
                        etag: None,
                        ics: None,
                        deleted: true,
                    });
                } else if (200..300).contains(&entry.status) {
                    let ics = entry
                        .ics
                        .ok_or("服务器返回不完整日程数据，已停止本轮同步")?;
                    output.push(RemoteObject {
                        url: url.to_string(),
                        etag: entry.etag,
                        ics: Some(ics),
                        deleted: false,
                    });
                } else {
                    return Err("服务器返回不完整日程数据，已停止本轮同步".into());
                }
            }
        }
        Ok(output)
    }

    pub async fn pull(&self, calendar: &Calendar, token: Option<&str>) -> Result<Pull, String> {
        let url = self.resolve(&calendar.url, &self.base)?;
        let report = Method::from_bytes(b"REPORT").unwrap();
        let sync_body = format!(
            "<d:sync-collection {NS}><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>",
            escape_xml(token.unwrap_or(""))
        );
        match self
            .xml_request(report.clone(), url.clone(), "1", sync_body)
            .await
        {
            Ok((result, _)) if result.token.is_some() => {
                return Ok(Pull {
                    objects: self.materialize(result.entries, &url).await?,
                    token: result.token,
                    full: token.is_none(),
                });
            }
            Ok(_) => {}
            Err(error)
                if [400, 403, 404, 405, 409, 410, 501, 507]
                    .iter()
                    .any(|status| error.ends_with(&format!("HTTP {status}"))) => {}
            Err(error) => return Err(error),
        }
        let query = format!(
            "<c:calendar-query {NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\"/></c:comp-filter></c:filter></c:calendar-query>"
        );
        let (result, _) = self.xml_request(report, url.clone(), "1", query).await?;
        Ok(Pull {
            objects: self.materialize(result.entries, &url).await?,
            token: None,
            full: true,
        })
    }

    async fn request_raw(
        &self,
        method: Method,
        url: Url,
        headers: header::HeaderMap,
        body: Option<String>,
    ) -> Result<(reqwest::StatusCode, header::HeaderMap, Vec<u8>), String> {
        let mut current = self.resolve(url.as_str(), &self.base)?;
        for _ in 0..6 {
            let mut request = self
                .client
                .request(method.clone(), current.clone())
                .basic_auth(&self.username, Some(self.password.as_str()))
                .headers(headers.clone());
            if let Some(body) = &body {
                request = request.body(body.clone());
            }
            let mut response = request.send().await.map_err(|_| "无法连接 CalDAV 服务器")?;
            if matches!(response.status().as_u16(), 301 | 302 | 307 | 308) {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("服务器重定向地址无效")?;
                current = self.resolve(location, &current)?;
                continue;
            }
            if response.content_length().is_some_and(|n| n > LIMIT as u64) {
                return Err("服务器单次响应超过 32MB".into());
            }
            let status = response.status();
            let headers = response.headers().clone();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "读取 CalDAV 响应失败")?
            {
                if bytes.len() + chunk.len() > LIMIT {
                    return Err("服务器响应过大，已停止读取".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok((status, headers, bytes));
        }
        Err("服务器重定向次数过多，请填写最终服务地址".into())
    }

    pub async fn get(&self, url: &str) -> Result<Option<RemoteGet>, String> {
        let url = self.resolve(url, &self.base)?;
        let (status, headers, bytes) = self
            .request_raw(Method::GET, url, header::HeaderMap::new(), None)
            .await?;
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("CalDAV 服务器返回 HTTP {}", status.as_u16()));
        }
        let ics = String::from_utf8(bytes).map_err(|_| "服务器返回的日程文本无效")?;
        let etag = headers
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        Ok(Some(RemoteGet { ics, etag }))
    }

    pub async fn put(
        &self,
        url: &str,
        ics: &str,
        etag: Option<&str>,
    ) -> Result<Option<String>, String> {
        if ics.len() > LIMIT {
            return Err("日程资源超过 32MB".into());
        }
        let url = self.resolve(url, &self.base)?;
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("text/calendar; charset=utf-8"),
        );
        if let Some(etag) = etag {
            headers.insert(
                header::IF_MATCH,
                header::HeaderValue::from_str(etag).map_err(|_| "ETag 无效")?,
            );
        } else {
            headers.insert(header::IF_NONE_MATCH, header::HeaderValue::from_static("*"));
        }
        let (status, headers, _) = self
            .request_raw(Method::PUT, url, headers, Some(ics.to_owned()))
            .await?;
        if !status.is_success() {
            return Err(format!("CalDAV 服务器返回 HTTP {}", status.as_u16()));
        }
        Ok(headers
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned))
    }

    pub async fn delete(&self, url: &str, etag: &str) -> Result<(), String> {
        let url = self.resolve(url, &self.base)?;
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::IF_MATCH,
            header::HeaderValue::from_str(etag).map_err(|_| "ETag 无效")?,
        );
        let (status, _, _) = self.request_raw(Method::DELETE, url, headers, None).await?;
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(format!("CalDAV 服务器返回 HTTP {}", status.as_u16()))
        }
    }
}

impl Clone for Entry {
    fn clone(&self) -> Self {
        Self {
            href: self.href.clone(),
            status: self.status,
            etag: self.etag.clone(),
            ics: self.ics.clone(),
            calendar: self.calendar,
            vevent: self.vevent,
            display_name: self.display_name.clone(),
            color: self.color.clone(),
            home: self.home.clone(),
            principal: self.principal.clone(),
            read_only: self.read_only,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn rejects_unsafe_urls_and_non_success_propstat() {
        assert!(normalize_url("https://user:pass@example.test/cal", false).is_err());
        assert!(normalize_url("http://example.test/cal", false).is_err());
        assert!(normalize_url("https://example.test/cal?token=x", false).is_err());
        let xml = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>"#;
        assert!(!parse_dav(xml).unwrap().entries[0].calendar);
        assert!(parse_dav("<!DOCTYPE evil><d:multistatus/>").is_err());
    }

    #[test]
    fn discovers_direct_calendar_over_local_dav() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0u8; 8192];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("PROPFIND /cal/"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: basic dtpw")
            );
            let xml = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:displayname>测试日历</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
            let response = format!(
                "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                xml.len(),
                xml
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let input = AccountInput {
            id: None,
            name: "测试".into(),
            url: format!("http://127.0.0.1:{port}/cal/"),
            username: "u".into(),
            password: None,
            allow_http: true,
            paused: false,
        };
        let client = DavClient::new(&input, Zeroizing::new("p".into())).unwrap();
        let calendars = tauri::async_runtime::block_on(client.discover("a")).unwrap();
        thread.join().unwrap();
        assert_eq!(calendars.len(), 1);
        assert_eq!(calendars[0].account_id, "a");
        assert_eq!(calendars[0].name, "测试日历");
        assert_eq!(calendars[0].color, "#d65c4f");
    }

    #[test]
    fn pull_materializes_sync_collection_with_multiget() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let thread = std::thread::spawn(move || {
            for step in 0..2 {
                let (mut stream, _) = server.accept().unwrap();
                let mut request = [0u8; 8192];
                let size = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..size]).starts_with("REPORT /cal/"));
                let xml = if step == 0 {
                    "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/cal/one.ics</d:href><d:propstat><d:prop><d:getetag>\"v1\"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:sync-token>token-1</d:sync-token></d:multistatus>"
                } else {
                    "<d:multistatus xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:response><d:href>/cal/one.ics</d:href><d:propstat><d:prop><d:getetag>\"v1\"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nEND:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"
                };
                let response = format!(
                    "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    xml.len(),
                    xml
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let base = format!("http://127.0.0.1:{port}/cal/");
        let input = AccountInput {
            id: None,
            name: "测试".into(),
            url: base.clone(),
            username: "u".into(),
            password: None,
            allow_http: true,
            paused: false,
        };
        let client = DavClient::new(&input, Zeroizing::new("p".into())).unwrap();
        let calendar = Calendar {
            id: "c".into(),
            account_id: "a".into(),
            url: base,
            name: "日历".into(),
            color: "#123456".into(),
            visible: true,
            read_only: false,
        };
        let result = tauri::async_runtime::block_on(client.pull(&calendar, None)).unwrap();
        thread.join().unwrap();
        assert!(result.full);
        assert_eq!(result.token.as_deref(), Some("token-1"));
        assert_eq!(result.objects.len(), 1);
        assert!(
            result.objects[0]
                .ics
                .as_deref()
                .unwrap()
                .contains("BEGIN:VCALENDAR")
        );
        assert_eq!(result.objects[0].etag.as_deref(), Some("\"v1\""));
    }
}

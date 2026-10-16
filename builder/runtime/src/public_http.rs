//! Anonymous public HTTP with validated DNS answers, pinned sockets and bounded bodies.
use futures::StreamExt;
use reqwest::{Url, header::HeaderMap};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct Failure {
    pub class: &'static str,
    pub message: String,
}
impl Failure {
    fn new(class: &'static str, message: impl Into<String>) -> Self {
        Self {
            class,
            message: message.into(),
        }
    }
    fn unsafe_url(message: impl Into<String>) -> Self {
        Self::new("UnsafeURLError", message)
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}
type Result<T> = std::result::Result<T, Failure>;

struct Prefix {
    address: u128,
    mask: u128,
}
impl Prefix {
    fn new(value: &str) -> Self {
        let (address, length) = value.split_once('/').unwrap();
        let address: IpAddr = address.parse().unwrap();
        let (address, bits) = match address {
            IpAddr::V4(address) => (u128::from(u32::from(address)), 32),
            IpAddr::V6(address) => (u128::from(address), 128),
        };
        let length: u32 = length.parse().unwrap();
        Self {
            address,
            mask: u128::MAX.checked_shl(bits - length).unwrap_or(0),
        }
    }
    fn contains(&self, address: u128) -> bool {
        address & self.mask == self.address
    }
}
struct Rules {
    private: Vec<Prefix>,
    exceptions: Vec<Prefix>,
    denied: Vec<Prefix>,
}
impl Rules {
    fn new(value: &Value) -> Self {
        let prefixes = |key: &str| {
            value[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| Prefix::new(value.as_str().unwrap()))
                .collect()
        };
        Self {
            private: prefixes("private"),
            exceptions: prefixes("exceptions"),
            denied: prefixes("denied"),
        }
    }
    fn public(&self, address: u128) -> bool {
        !self.denied.iter().any(|prefix| prefix.contains(address))
            && (!self.private.iter().any(|prefix| prefix.contains(address))
                || self
                    .exceptions
                    .iter()
                    .any(|prefix| prefix.contains(address)))
    }
}
pub(crate) fn parse_ip(value: &str) -> Option<IpAddr> {
    if let Some((address, scope)) = value.split_once('%') {
        if scope.is_empty() || scope.contains('%') {
            return None;
        }
        address.parse::<std::net::Ipv6Addr>().ok().map(IpAddr::V6)
    } else {
        value.parse().ok()
    }
}
pub(crate) fn ip_is_public(value: &str) -> bool {
    static RULES: LazyLock<[Rules; 2]> = LazyLock::new(|| {
        let resource: Value =
            serde_json::from_str(include_str!("../resources/public-http.json")).unwrap();
        [
            Rules::new(&resource["address_policy"]["4"]),
            Rules::new(&resource["address_policy"]["6"]),
        ]
    });
    match parse_ip(value) {
        Some(IpAddr::V4(address)) => RULES[0].public(u32::from(address).into()),
        Some(IpAddr::V6(address)) => RULES[1].public(address.into()),
        None => false,
    }
}

async fn resolve(host: &str) -> Result<Vec<SocketAddr>> {
    if let Some(address) = parse_ip(host) {
        if !ip_is_public(host) {
            return Err(Failure::unsafe_url(format!(
                "URL host '{host}' is a non-public address."
            )));
        }
        return Ok(vec![SocketAddr::new(address, 0)]);
    }
    let owned = host.to_owned();
    let addresses = tokio::task::spawn_blocking(move || {
        (owned.as_str(), 0)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| Failure::unsafe_url(format!("Could not resolve host '{host}'")))?
    .map_err(|_| Failure::unsafe_url(format!("Could not resolve host '{host}'")))?;
    if addresses.is_empty() {
        return Err(Failure::unsafe_url(format!(
            "Host '{host}' did not resolve to any address."
        )));
    }
    for address in &addresses {
        if !ip_is_public(&address.ip().to_string()) {
            return Err(Failure::unsafe_url(format!(
                "URL host '{host}' resolves to a non-public address ({}).",
                address.ip()
            )));
        }
    }
    Ok(addresses)
}
struct PublicResolver;
impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addresses = resolve(name.as_str()).await?;
            // Only the first address is handed to the connector, after validating
            // the whole answer set. TLS continues to use the URL's hostname.
            let addresses: reqwest::dns::Addrs = Box::new(addresses.into_iter().take(1));
            Ok(addresses)
        })
    }
}

/// HTTPX decodes the complete header collection using ASCII, UTF-8, then Latin-1.
pub fn headers_json(headers: &HeaderMap) -> Value {
    let utf8 = headers
        .values()
        .all(|value| std::str::from_utf8(value.as_bytes()).is_ok());
    let mut result = json!({});
    for key in headers.keys() {
        let values: Vec<_> = headers
            .get_all(key)
            .iter()
            .map(|value| {
                if utf8 {
                    std::str::from_utf8(value.as_bytes()).unwrap().to_owned()
                } else {
                    value
                        .as_bytes()
                        .iter()
                        .map(|byte| char::from(*byte))
                        .collect()
                }
            })
            .collect();
        result[key.as_str()] = json!(values.join(", "));
    }
    result
}
fn check_size(headers: &Value, limit: usize) -> Result<()> {
    let encoding =
        crate::memory_tools::trim(headers["content-encoding"].as_str().unwrap_or("identity"))
            .to_lowercase();
    if !matches!(encoding.as_str(), "" | "identity") {
        return Err(Failure::new(
            "ResponseSizeError",
            "Public fetch requires identity content encoding.",
        ));
    }
    if let Some(length) = headers["content-length"].as_str()
        && !length.is_empty()
        && length.bytes().all(|byte| byte.is_ascii_digit())
        && length
            .parse::<u128>()
            .ok()
            .is_none_or(|length| length > limit as u128)
    {
        return Err(size_error(limit));
    }
    Ok(())
}
fn size_error(limit: usize) -> Failure {
    Failure::new(
        "ResponseSizeError",
        format!("Public response exceeds {limit} byte limit."),
    )
}
fn redirect_location_error(status: u16, headers: &Value) -> Option<Failure> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let location = headers["location"].as_str()?;
    let (scheme, rest) = location.split_once(':')?;
    if scheme
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+-.".contains(&byte))
        && !rest.is_empty()
        && !rest.starts_with(['/', '?', '#'])
    {
        // Even with redirects disabled, HTTPX constructs response.next_request.
        // Filling its missing host fails for a scheme with a relative path.
        Some(Failure::new(
            "InvalidURL",
            "An absolute redirect URL requires an absolute path",
        ))
    } else {
        None
    }
}
fn http_error(error: reqwest::Error) -> Failure {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(current) = source {
        if let Some(failure) = current.downcast_ref::<Failure>() {
            return failure.clone();
        }
        source = current.source();
    }
    let class = if error.is_timeout() {
        if error.is_connect() {
            "ConnectTimeout"
        } else {
            "ReadTimeout"
        }
    } else if error.is_connect() {
        "ConnectError"
    } else if error.is_builder() {
        "LocalProtocolError"
    } else {
        "RemoteProtocolError"
    };
    Failure::new(class, format!("Public HTTP request failed ({class})"))
}

/// The image-owned certifi bundle shared by public and default private HTTP clients.
pub(crate) fn pinned_certificates() -> Result<Vec<reqwest::Certificate>> {
    // Use the same pinned certifi roots as trust_env=False. Deployment CA and
    // proxy environment variables must not expand the public-fetch boundary.
    // The image owns this file beside the executable, like Python's certifi.
    let path = std::env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.join("runtime-public-ca.pem"))
    });
    let roots = match path.map(std::fs::read) {
        Some(Ok(bytes)) => bytes,
        None => include_bytes!("../resources/public-ca.pem").to_vec(),
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            include_bytes!("../resources/public-ca.pem").to_vec()
        }
        Some(Err(_)) => {
            return Err(Failure::new("OSError", "Could not read public trust roots"));
        }
    };
    let certificates = reqwest::Certificate::from_pem_bundle(&roots)
        .map_err(|_| Failure::new("SSLError", "Invalid public trust roots"))?;
    if certificates.is_empty() {
        return Err(Failure::new("SSLError", "Empty public trust roots"));
    }
    Ok(certificates)
}

pub struct Response {
    pub status: u16,
    pub headers: Value,
    pub body: Vec<u8>,
}
pub struct Client {
    pool: Mutex<Pool>,
    configuration: Configuration,
    permits: Arc<tokio::sync::Semaphore>,
    timeout: Option<Duration>,
    limit: usize,
}
struct Pool {
    generation: u64,
    http: Option<reqwest::Client>,
}
struct Configuration {
    certificates: Vec<reqwest::Certificate>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
}
impl Configuration {
    fn build(&self) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .http1_only()
            .no_proxy()
            .cookie_store(false)
            .tls_certs_only(self.certificates.clone())
            .tls_sslkeylogfile(false)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .dns_resolver(PublicResolver)
            .default_headers(self.headers.clone())
            .pool_max_idle_per_host(20)
            .pool_idle_timeout(Duration::from_secs(5));
        if let Some(timeout) = self.connect_timeout {
            builder = builder.connect_timeout(timeout);
        }
        if let Some(timeout) = self.timeout {
            builder = builder.read_timeout(timeout);
        }
        builder.build().map_err(http_error)
    }
}
impl Client {
    pub fn anonymous(
        timeout: f64,
        connect_timeout: f64,
        limit: usize,
        headers: HeaderMap,
    ) -> Result<Self> {
        let duration = |seconds| {
            Duration::try_from_secs_f64(seconds)
                .map(Some)
                .map_err(|_| Failure::new("ValueError", "Invalid public HTTP timeout"))
        };
        Self::with_timeouts(
            duration(timeout)?,
            duration(connect_timeout)?,
            limit,
            headers,
        )
    }

    pub(crate) fn with_timeouts(
        timeout: Option<Duration>,
        connect_timeout: Option<Duration>,
        limit: usize,
        mut headers: HeaderMap,
    ) -> Result<Self> {
        if limit == 0 {
            return Err(Failure::new(
                "ValueError",
                "max_response_bytes must be positive",
            ));
        }
        headers.remove("cookie");
        headers.remove("authorization");
        headers.insert("accept-encoding", "identity".parse().unwrap());
        headers.entry("accept").or_insert("*/*".parse().unwrap());
        let certificates = pinned_certificates()?;
        let configuration = Configuration {
            certificates,
            headers,
            timeout,
            connect_timeout,
        };
        let http = configuration.build()?;
        Ok(Self {
            pool: Mutex::new(Pool {
                generation: 0,
                http: Some(http),
            }),
            configuration,
            permits: Arc::new(tokio::sync::Semaphore::new(100)),
            timeout,
            limit,
        })
    }

    fn connection_pool(&self) -> Result<(reqwest::Client, u64)> {
        let mut pool = self.pool.lock().unwrap();
        if pool.http.is_none() {
            pool.http = Some(self.configuration.build()?);
        }
        Ok((pool.http.as_ref().unwrap().clone(), pool.generation))
    }
    fn reject_response(&self, generation: u64) {
        let mut pool = self.pool.lock().unwrap();
        if pool.generation == generation {
            // Hyper can finish buffering a small body before the caller checks
            // its encoding. Discard the pool so the rejected response's socket
            // cannot be reused by a later call. Existing requests may finish.
            pool.http = None;
            pool.generation = pool.generation.wrapping_add(1);
        }
    }

    /// One GET only. Callers apply their own origin and redirect policy per hop.
    pub async fn get(&self, raw: &str, schemes: &[&str]) -> Result<Response> {
        let url = Url::parse(crate::memory_tools::trim(raw))
            .map_err(|_| Failure::unsafe_url("Invalid public URL"))?;
        if !schemes.contains(&url.scheme()) {
            return Err(Failure::unsafe_url(format!(
                "URL scheme '{}' is not allowed.",
                url.scheme()
            )));
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || raw.split_once("://").is_some_and(|(_, authority)| {
                authority
                    .split(['/', '?', '#'])
                    .next()
                    .unwrap_or("")
                    .contains('@')
            })
        {
            return Err(Failure::unsafe_url(
                "Public URLs must not contain credentials",
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| Failure::unsafe_url("URL is missing a host."))?
            .trim_matches(['[', ']']);
        // Preflight also checks literal IPs (which reqwest never sends through
        // its resolver), plus each request that reuses a pooled connection.
        resolve(host).await?;
        let permit = match self.timeout {
            Some(timeout) => tokio::time::timeout(timeout, self.permits.acquire())
                .await
                .map_err(|_| Failure::new("PoolTimeout", "Public HTTP pool timed out"))?,
            None => self.permits.acquire().await,
        };
        let _permit = permit.map_err(|_| Failure::new("PoolTimeout", "Public HTTP pool closed"))?;
        let (http, generation) = self.connection_pool()?;
        let response = http.get(url).send().await.map_err(http_error)?;
        let status = response.status().as_u16();
        let headers = headers_json(response.headers());
        if let Err(error) = check_size(&headers, self.limit) {
            self.reject_response(generation);
            return Err(error);
        }
        if let Some(error) = redirect_location_error(status, &headers) {
            self.reject_response(generation);
            return Err(error);
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(http_error)?;
            if chunk.len() > self.limit.saturating_sub(body.len()) {
                self.reject_response(generation);
                return Err(size_error(self.limit));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_addresses_and_headers() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/public-http.json")).unwrap();
        for case in fixture["addresses"].as_array().unwrap() {
            assert_eq!(
                ip_is_public(case["ip"].as_str().unwrap()),
                case["public"].as_bool().unwrap(),
                "{}",
                case["ip"]
            );
        }
        for case in fixture["headers"].as_array().unwrap() {
            let actual =
                match check_size(&case["headers"], case["limit"].as_u64().unwrap() as usize) {
                    Ok(()) => json!({"ok":true}),
                    Err(error) => json!({"error":error.class,"message":error.message}),
                };
            assert_eq!(actual, case["expected"], "{case}");
        }
    }

    #[tokio::test]
    #[ignore = "requires the disposable real DNS/TLS fixture"]
    async fn actual_public_http() {
        use base64::Engine;
        let input = std::fs::read(std::env::var("DAEDALUS_PUBLIC_HTTP_CASE").unwrap()).unwrap();
        let case: Value = serde_json::from_slice(&input).unwrap();
        let mut headers = HeaderMap::new();
        for (key, value) in case["headers"].as_object().unwrap() {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                value.as_str().unwrap().parse().unwrap(),
            );
        }
        let client = Client::anonymous(
            case["timeout"].as_f64().unwrap_or(1.),
            1.,
            case["limit"].as_u64().unwrap_or(1024) as usize,
            headers,
        )
        .unwrap();
        let mut results = Vec::new();
        for url in case["urls"].as_array().unwrap() {
            let result = match client.get(url.as_str().unwrap(), &["http", "https"]).await {
                Ok(response) => {
                    json!({"ok": {"status":response.status,"headers":response.headers,"body":base64::engine::general_purpose::STANDARD.encode(response.body)}})
                }
                Err(error) => json!({"error":error.class}),
            };
            results.push(result);
        }
        std::fs::write(
            std::env::var("DAEDALUS_PUBLIC_HTTP_OUTPUT").unwrap(),
            serde_json::to_vec(&results).unwrap(),
        )
        .unwrap();
    }
}

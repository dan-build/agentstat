//! A minimal HTTP/1.1 GET for the command line to talk to the local service
//! (no client library: one request to 127.0.0.1, one short response).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// GET `path` from the service on `port`; the response body on 200.
pub fn get(port: u16, path: &str) -> std::io::Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let ok = head.lines().next().is_some_and(|l| l.split_whitespace().nth(1) == Some("200"));
    if !ok {
        return Err(std::io::Error::other(format!("unexpected response: {}", head.lines().next().unwrap_or(""))));
    }
    // Chunked bodies (axum's JSON responses carry a length, but be safe).
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return Ok(dechunk(body));
    }
    Ok(body.to_string())
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.trim(), 16) else { break };
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest[n..].trim_start_matches("\r\n");
    }
    out
}

/// Whether an AgentStat service answers on `port`.
pub fn is_up(port: u16) -> bool {
    get(port, "/healthz").is_ok_and(|b| b.trim() == "ok")
}

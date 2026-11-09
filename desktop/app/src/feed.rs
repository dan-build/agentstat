//! The service's live stream, read on a background thread: Server-Sent Events
//! from `GET /v1/stream`, resumed after a drop from the last id, with the
//! service started if it isn't running.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use agentstat_core::Event;
use futures::channel::mpsc::UnboundedSender;
use serde::Deserialize;

/// What the app hears from the feed.
#[derive(Debug)]
pub enum Feed {
    /// Connected to a service (a new `instance` means everything before is gone).
    Connected {
        instance: String,
    },
    /// Lost the service; reconnecting.
    Disconnected,
    /// No `agentstat` binary to start the service with.
    NoService,
    Message(Message),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
    Event { id: String, event: Event },
    Agent { id: String, name: Option<String>, color: Option<String>, config: Option<Config> },
    Remove { id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub expected_tokens_per_sec: Option<(f64, f64)>,
}

#[derive(Deserialize)]
struct Wire {
    m: Message,
}

/// The `agentstat` command: next to this app, else on PATH.
fn agentstat_binary() -> Option<PathBuf> {
    let sibling = std::env::current_exe().ok()?.with_file_name("agentstat");
    if sibling.is_file() {
        return Some(sibling);
    }
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .chain(std::iter::once(concat!(env!("HOME"), "/.cargo/bin")))
        .map(|d| PathBuf::from(d).join("agentstat"))
        .find(|p| p.is_file())
}

fn is_up(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Start `agentstat serve` detached, if it isn't running. Returns false when
/// there's no binary to start.
fn ensure_service(port: u16) -> bool {
    if is_up(port) {
        return true;
    }
    let Some(bin) = agentstat_binary() else { return false };
    let mut cmd = Command::new(bin);
    cmd.args(["serve", "--port", &port.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Its own session, so it outlives the app (agents keep reporting).
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let Ok(mut child) = cmd.spawn() else { return false };
    // Reap it if it ever exits while the app runs (no zombie).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    for _ in 0..60 {
        if is_up(port) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// The body of a `Transfer-Encoding: chunked` response, de-chunked.
struct Chunked<R> {
    inner: R,
    /// Bytes left in the current chunk.
    left: usize,
    done: bool,
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut size = String::new();
            // Skip the CRLF that ends the previous chunk.
            while size.trim().is_empty() {
                size.clear();
                if self.inner.read_line(&mut size)? == 0 {
                    self.done = true;
                    return Ok(0);
                }
            }
            let hex = size.trim().split(';').next().unwrap_or("");
            self.left = usize::from_str_radix(hex, 16)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk size"))?;
            if self.left == 0 {
                self.done = true;
                return Ok(0);
            }
        }
        let n = buf.len().min(self.left);
        let n = self.inner.read(&mut buf[..n])?;
        if n == 0 {
            self.done = true;
        }
        self.left -= n;
        Ok(n)
    }
}

/// Read one connection until it drops. Updates `last_id`.
fn read_stream(port: u16, last_id: &mut Option<String>, instance: &mut Option<String>, tx: &UnboundedSender<Feed>) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return };
    // The service sends a keep-alive every 15 s; silence for longer is a dead link.
    let _ = s.set_read_timeout(Some(Duration::from_secs(40)));
    let resume = last_id.as_ref().map(|id| format!("Last-Event-ID: {id}\r\n")).unwrap_or_default();
    if write!(s, "GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n{resume}\r\n")
        .is_err()
    {
        return;
    }
    let mut r = BufReader::new(s);
    let mut line = String::new();
    // Status line and headers.
    let (mut ok, mut chunked, mut run) = (false, false, None);
    loop {
        line.clear();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("http/") {
            ok = lower.split_whitespace().nth(1) == Some("200");
        } else if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        } else if let Some(v) = lower.strip_prefix("x-agentstat-instance:") {
            run = Some(v.trim().to_string());
        }
        if line.trim().is_empty() {
            break;
        }
    }
    if !ok {
        return;
    }
    // Connected, even before any message: a different run means everything we had is gone.
    if let Some(run) = run {
        if instance.as_deref() != Some(run.as_str()) {
            *last_id = None;
        }
        *instance = Some(run.clone());
        if tx.unbounded_send(Feed::Connected { instance: run }).is_err() {
            return;
        }
    }
    let mut body: Box<dyn BufRead> =
        if chunked { Box::new(BufReader::new(Chunked { inner: r, left: 0, done: false })) } else { Box::new(r) };
    let mut id = None;
    let mut data = String::new();
    loop {
        line.clear();
        if body.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if let Some(v) = l.strip_prefix("id: ") {
            id = Some(v.to_string());
        } else if let Some(v) = l.strip_prefix("data: ") {
            data.push_str(v);
        } else if l.is_empty() && !data.is_empty() {
            // Resume only after a message that was understood.
            if let Ok(w) = serde_json::from_str::<Wire>(&data) {
                if let Some(i) = id.take() {
                    *last_id = Some(i);
                }
                if tx.unbounded_send(Feed::Message(w.m)).is_err() {
                    return;
                }
            }
            id = None;
            data.clear();
        }
    }
}

/// Run the feed until the app goes away.
pub fn spawn(port: u16, tx: UnboundedSender<Feed>) {
    std::thread::spawn(move || {
        let mut last_id = None;
        let mut instance = None;
        loop {
            if !ensure_service(port) {
                let _ = tx.unbounded_send(Feed::NoService);
            } else {
                read_stream(port, &mut last_id, &mut instance, &tx);
                if tx.unbounded_send(Feed::Disconnected).is_err() {
                    return;
                }
            }
            if tx.is_closed() {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

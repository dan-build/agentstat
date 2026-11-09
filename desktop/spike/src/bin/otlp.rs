//! Spike: does an agent CLI's OpenTelemetry reach a local receiver, and what does it send?
//!
//! Listens on 127.0.0.1:4318 (OTLP/HTTP, JSON encoding) and prints, per request, the signal
//! and the metric or event names with their key attributes. Ctrl-C to stop.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
};

use serde_json::Value;

fn attrs(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let key = a["key"].as_str()?.to_string();
            let val = &a["value"];
            let s = val
                .get("stringValue")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| val.get("intValue").map(|i| i.to_string().trim_matches('"').to_string()))
                .or_else(|| val.get("doubleValue").map(|d| d.to_string()))
                .or_else(|| val.get("boolValue").map(|b| b.to_string()))
                .unwrap_or_else(|| val.to_string());
            Some((key, s))
        })
        .collect()
}

fn show(path: &str, body: &Value) {
    let pick = |a: &[(String, String)], keys: &[&str]| {
        a.iter()
            .filter(|(k, _)| keys.contains(&k.as_str()))
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let keys = ["session.id", "type", "model", "tool_name", "decision", "success", "duration_ms", "event.name", "input_tokens", "output_tokens", "cost_usd"];
    match path {
        "/v1/metrics" => {
            for rm in body["resourceMetrics"].as_array().into_iter().flatten() {
                for sm in rm["scopeMetrics"].as_array().into_iter().flatten() {
                    for m in sm["metrics"].as_array().into_iter().flatten() {
                        let name = m["name"].as_str().unwrap_or("?");
                        let points = m["sum"]["dataPoints"].as_array().or(m["gauge"]["dataPoints"].as_array());
                        for p in points.into_iter().flatten() {
                            let value = p.get("asDouble").or(p.get("asInt")).map(|v| v.to_string()).unwrap_or_default();
                            println!("  metric {name} = {value}  {}", pick(&attrs(&p["attributes"]), &keys));
                        }
                    }
                }
            }
        }
        "/v1/logs" => {
            for rl in body["resourceLogs"].as_array().into_iter().flatten() {
                for sl in rl["scopeLogs"].as_array().into_iter().flatten() {
                    for r in sl["logRecords"].as_array().into_iter().flatten() {
                        let name = r["body"]["stringValue"].as_str().unwrap_or("?");
                        println!("  event {name}  {}", pick(&attrs(&r["attributes"]), &keys));
                    }
                }
            }
        }
        _ => println!("  {} bytes of {path}", body.to_string().len()),
    }
}

fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:4318")?;
    println!("listening on http://127.0.0.1:4318 (OTLP/HTTP JSON)");
    for stream in listener.incoming() {
        let mut stream = stream?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
        let mut len = 0usize;
        let mut ctype = String::new();
        loop {
            let mut h = String::new();
            reader.read_line(&mut h)?;
            if h.trim().is_empty() {
                break;
            }
            let lower = h.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("content-length:") {
                len = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = lower.strip_prefix("content-type:") {
                ctype = v.trim().to_string();
            }
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body)?;
        println!("{path} ({ctype}, {len} bytes)");
        if let Ok(dir) = std::env::var("DUMP_DIR") {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let _ = std::fs::write(format!("{dir}/{n:03}{}.json", path.replace('/', "-")), &body);
        }
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => show(&path, &v),
            Err(_) => println!("  not JSON (set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)"),
        }
        stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")?;
    }
    Ok(())
}

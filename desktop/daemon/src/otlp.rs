//! OpenTelemetry log records from an OTLP/HTTP JSON request, flattened.

use std::collections::HashMap;

use serde_json::Value;

/// One log record with its resource's attributes.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// Unix ms (the record's time, else when it was observed).
    pub time: f64,
    /// The body's string (Claude Code puts the event name there).
    pub name: String,
    pub attrs: HashMap<String, Value>,
    pub resource: HashMap<String, Value>,
}

impl Record {
    pub fn str(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).and_then(Value::as_str)
    }

    /// A number, whether sent as a number or a numeric string (OTLP JSON
    /// encodes 64-bit integers as strings).
    pub fn num(&self, key: &str) -> Option<f64> {
        match self.attrs.get(key)? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
        .filter(|x: &f64| x.is_finite())
    }
}

/// An OTLP `AnyValue` as plain JSON (`{"stringValue":"x"}` → `"x"`).
fn any_value(v: &Value) -> Value {
    let Some(obj) = v.as_object() else { return Value::Null };
    if let Some(s) = obj.get("stringValue") {
        return s.clone();
    }
    if let Some(i) = obj.get("intValue") {
        return i.clone();
    }
    if let Some(d) = obj.get("doubleValue") {
        return d.clone();
    }
    if let Some(b) = obj.get("boolValue") {
        return b.clone();
    }
    if let Some(a) = obj.get("arrayValue") {
        return Value::Array(a["values"].as_array().into_iter().flatten().map(any_value).collect());
    }
    Value::Null
}

fn attributes(v: &Value) -> HashMap<String, Value> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|kv| Some((kv["key"].as_str()?.to_string(), any_value(&kv["value"]))))
        .collect()
}

fn nanos_to_ms(v: &Value) -> Option<f64> {
    let n = match v {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (n > 0.0).then_some(n / 1e6)
}

/// Every log record in an `ExportLogsServiceRequest`, oldest first.
pub fn log_records(body: &Value) -> Vec<Record> {
    let mut out = Vec::new();
    for rl in body["resourceLogs"].as_array().into_iter().flatten() {
        let resource = attributes(&rl["resource"]["attributes"]);
        for sl in rl["scopeLogs"].as_array().into_iter().flatten() {
            for r in sl["logRecords"].as_array().into_iter().flatten() {
                let Some(time) = nanos_to_ms(&r["timeUnixNano"]).or_else(|| nanos_to_ms(&r["observedTimeUnixNano"]))
                else {
                    continue;
                };
                out.push(Record {
                    time,
                    name: any_value(&r["body"]).as_str().unwrap_or_default().to_string(),
                    attrs: attributes(&r["attributes"]),
                    resource: resource.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_records_and_values() {
        let body: Value = serde_json::from_str(
            r#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},
            "scopeLogs":[{"logRecords":[
              {"timeUnixNano":"2000000000","body":{"stringValue":"b"},"attributes":[{"key":"duration_ms","value":{"intValue":"1974"}}]},
              {"timeUnixNano":"1000000000","body":{"stringValue":"a"},"attributes":[{"key":"output_tokens","value":{"intValue":19}},{"key":"success","value":{"stringValue":"true"}}]}
            ]}]}]}"#,
        )
        .unwrap();
        let rs = log_records(&body);
        assert_eq!(rs.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(rs[0].time, 1000.0);
        assert_eq!(rs[0].num("output_tokens"), Some(19.0));
        assert_eq!(rs[1].num("duration_ms"), Some(1974.0));
        assert_eq!(rs[0].str("success"), Some("true"));
        assert_eq!(rs[0].resource["service.name"], "claude-code");
    }
}

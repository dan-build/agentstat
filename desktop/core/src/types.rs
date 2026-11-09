//! Public data types (mirrors `src/types.ts`).

use serde::{Deserialize, Serialize};

/// What an agent is doing.
///
/// - `Active`: producing output.
/// - `Thinking`: working without output (reasoning, reading a tool result).
/// - `Waiting`: blocked on something outside the model (a tool call, subagents, a
///   person). Quiet output is expected; only a very long wait counts as a stall.
/// - `Stuck`, `Hallucinating`: problems the caller detected.
/// - `Complete`: done, or idle between jobs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Stuck,
    Thinking,
    Waiting,
    Complete,
    Hallucinating,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Stuck => "stuck",
            Status::Thinking => "thinking",
            Status::Waiting => "waiting",
            Status::Complete => "complete",
            Status::Hallucinating => "hallucinating",
        }
    }
}

/// Field parsers that, like the TypeScript library, drop a bad field instead
/// of the whole event or sample.
mod lenient {
    use serde::{Deserialize, Deserializer, de::IgnoredAny};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Maybe<T> {
        Value(T),
        Other(IgnoredAny),
    }

    /// The value if it has the expected type, otherwise None.
    pub fn opt<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
        Ok(match Option::<Maybe<T>>::deserialize(d)? {
            Some(Maybe::Value(v)) => Some(v),
            _ => None,
        })
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Js {
        Bool(bool),
        Num(f64),
        Str(String),
        Other(IgnoredAny),
    }

    /// JavaScript truthiness (null/absent is false; objects are true).
    pub fn truthy<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
        Ok(Option::<Js>::deserialize(d)?.map(|v| match v {
            Js::Bool(b) => b,
            Js::Num(n) => n != 0.0 && !n.is_nan(),
            Js::Str(s) => !s.is_empty(),
            Js::Other(_) => true,
        }))
    }
}

/// A raw stream event. The store derives token rate, time to first token,
/// inter-token latency and status from these. `time` is in the store's clock
/// (default: now); a future time is treated as now, and one earlier than
/// anything recorded for the agent as that time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    /// A model request was sent. Status → thinking; starts the TTFT clock.
    Start {
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
    /// Output arrived: `count` tokens in this chunk, or a running `total`. With
    /// `since`, output produced over [since, time] reported as one block.
    Tokens {
        #[serde(default, deserialize_with = "lenient::opt")]
        count: Option<f64>,
        #[serde(default, deserialize_with = "lenient::opt")]
        total: Option<f64>,
        #[serde(default, deserialize_with = "lenient::opt")]
        since: Option<f64>,
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
    /// A tool call began (nest freely). Status → waiting while any is open.
    ToolStart {
        #[serde(default, deserialize_with = "lenient::opt")]
        name: Option<String>,
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
    /// A tool call returned; a truthy `error` also counts an error.
    ToolEnd {
        #[serde(default, deserialize_with = "lenient::opt")]
        name: Option<String>,
        #[serde(default, deserialize_with = "lenient::truthy")]
        error: Option<bool>,
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
    /// Something failed. Increments the error count.
    Error {
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
    /// The run finished. Status → complete; open tool calls are closed.
    Finish {
        #[serde(default, deserialize_with = "lenient::opt")]
        time: Option<f64>,
    },
}

impl Event {
    pub fn time(&self) -> Option<f64> {
        match self {
            Event::Start { time }
            | Event::Tokens { time, .. }
            | Event::ToolStart { time, .. }
            | Event::ToolEnd { time, .. }
            | Event::Error { time }
            | Event::Finish { time } => *time,
        }
    }
}

/// A partial telemetry update; omitted fields keep their previous value. A
/// field of the wrong type (or an unknown status) is ignored on its own.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    #[serde(default, deserialize_with = "lenient::opt")]
    pub tokens_rate: Option<f64>,
    /// 0–100.
    #[serde(default, deserialize_with = "lenient::opt")]
    pub progress: Option<f64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub status: Option<Status>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub latency_ms: Option<f64>,
    /// The caller's own 0–1 quality signal.
    #[serde(default, deserialize_with = "lenient::opt")]
    pub confidence_score: Option<f64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub error_count: Option<f64>,
}

/// An agent's latest values.
#[derive(Clone, Debug, PartialEq)]
pub struct Current {
    pub tokens_rate: f64,
    pub progress: f64,
    pub status: Status,
    pub latency_ms: Option<f64>,
    pub confidence_score: Option<f64>,
    pub error_count: Option<f64>,
}

/// An agent on the roster.
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// Expected token-rate band, for health scoring (default 5–25 t/s).
    pub expected_tokens_per_sec: Option<(f64, f64)>,
    pub current: Current,
}

impl Agent {
    /// An idle agent known only by its id (how stream-added agents start).
    pub fn idle(id: &str) -> Self {
        Agent {
            id: id.to_string(),
            name: id.to_string(),
            color: None,
            expected_tokens_per_sec: None,
            current: Current {
                tokens_rate: 0.0,
                progress: 0.0,
                status: Status::Complete,
                latency_ms: None,
                confidence_score: None,
                error_count: None,
            },
        }
    }
}

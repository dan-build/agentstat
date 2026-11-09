//! The event stream (mirrors `src/stream-core.ts`): every message gets a
//! sequence number, recent history is kept so a client that connects or
//! reconnects later sees it with the original times, and agent descriptions
//! outlive the history they came with.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use agentstat_core::Event;
use serde::Serialize;
use tokio::sync::broadcast;

/// History kept for clients that connect later.
const KEEP_MS: f64 = 300_000.0;
const KEEP_MAX: usize = 20_000;
/// Live messages a client may fall behind by before it is dropped (it then
/// reconnects and resumes from its last id).
/// (Large enough for a history replay to a slow client without dropping it.)
const LIVE_CAPACITY: usize = 4_096;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_tokens_per_sec: Option<(f64, f64)>,
}

/// What a message carries; serialized as the TypeScript `AgentStreamMessage`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Body {
    Event {
        id: String,
        event: Event,
    },
    Agent {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        config: Option<AgentConfig>,
    },
    Remove {
        id: String,
    },
}

impl Body {
    pub fn id(&self) -> &str {
        match self {
            Body::Event { id, .. } | Body::Agent { id, .. } | Body::Remove { id } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Message {
    pub seq: u64,
    #[serde(flatten)]
    pub body: Body,
}

/// A client's view at subscription: history to replay, then live messages.
pub struct Subscription {
    pub replay: Vec<Arc<Message>>,
    pub live: broadcast::Receiver<Arc<Message>>,
}

pub struct EventLog {
    log: VecDeque<(Arc<Message>, f64)>,
    seq: u64,
    /// Latest description of each agent, replayed even after its history aged out.
    info: HashMap<String, Arc<Message>>,
    live: broadcast::Sender<Arc<Message>>,
}

impl Default for EventLog {
    fn default() -> Self {
        EventLog { log: VecDeque::new(), seq: 0, info: HashMap::new(), live: broadcast::channel(LIVE_CAPACITY).0 }
    }
}

impl EventLog {
    fn trim(&mut self, now: f64) {
        while self.log.front().is_some_and(|(_, at)| self.log.len() > KEEP_MAX || *at < now - KEEP_MS) {
            self.log.pop_front();
        }
    }

    fn emit(&mut self, body: Body, now: f64) -> Arc<Message> {
        self.seq += 1;
        let m = Arc::new(Message { seq: self.seq, body });
        self.log.push_back((m.clone(), now));
        self.trim(now);
        // No receivers is fine: nobody is connected.
        let _ = self.live.send(m.clone());
        m
    }

    /// Report an event; its time defaults to now and is never in the future.
    pub fn push(&mut self, id: &str, mut event: Event, now: f64) -> Arc<Message> {
        let t = event.time().filter(|t| t.is_finite()).unwrap_or(now).min(now);
        set_time(&mut event, t);
        self.emit(Body::Event { id: id.to_string(), event }, now)
    }

    /// Name, color or band for an agent; unset fields keep their last value.
    pub fn describe(
        &mut self,
        id: &str,
        name: Option<String>,
        color: Option<String>,
        config: Option<AgentConfig>,
        now: f64,
    ) -> Arc<Message> {
        let prev = self.info.get(id).map(|m| m.body.clone());
        let (pn, pc, pcfg) = match prev {
            Some(Body::Agent { name, color, config, .. }) => (name, color, config),
            _ => (None, None, None),
        };
        let body = Body::Agent { id: id.to_string(), name: name.or(pn), color: color.or(pc), config: config.or(pcfg) };
        let m = self.emit(body, now);
        self.info.insert(id.to_string(), m.clone());
        m
    }

    /// Remove an agent, with its history, from clients.
    pub fn remove(&mut self, id: &str, now: f64) -> Arc<Message> {
        self.info.remove(id);
        self.log.retain(|(m, _)| m.body.id() != id);
        self.emit(Body::Remove { id: id.to_string() }, now)
    }

    /// Kept messages after `after`, then everything new. Descriptions whose
    /// history aged out come first (they are older than anything kept).
    pub fn subscribe(&mut self, after: u64, now: f64) -> Subscription {
        self.trim(now);
        let live = self.live.subscribe();
        let first = self.log.front().map_or(self.seq + 1, |(m, _)| m.seq);
        let kept: std::collections::HashSet<&str> = self.log.iter().map(|(m, _)| m.body.id()).collect();
        // An agent with nothing kept beyond its description is long gone.
        let gone: Vec<String> = self
            .info
            .iter()
            .filter(|(id, m)| m.seq < first && !kept.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            self.info.remove(&id);
        }
        let mut aged: Vec<Arc<Message>> =
            self.info.values().filter(|m| m.seq > after && m.seq < first).cloned().collect();
        aged.sort_by_key(|m| m.seq);
        aged.extend(self.log.iter().filter(|(m, _)| m.seq > after).map(|(m, _)| m.clone()));
        Subscription { replay: aged, live }
    }
}

fn set_time(e: &mut Event, t: f64) {
    match e {
        Event::Start { time }
        | Event::Tokens { time, .. }
        | Event::ToolStart { time, .. }
        | Event::ToolEnd { time, .. }
        | Event::Error { time }
        | Event::Finish { time } => *time = Some(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(n: f64) -> Event {
        Event::Tokens { count: Some(n), total: None, since: None, time: None }
    }

    #[test]
    fn replays_after_a_sequence_number_then_goes_live() {
        let mut log = EventLog::default();
        log.describe("a", Some("Agent A".into()), None, None, 0.0);
        log.push("a", tokens(5.0), 10.0);
        log.push("a", tokens(6.0), 20.0);
        let sub = log.subscribe(2, 30.0);
        assert_eq!(sub.replay.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![3]);
        let mut live = sub.live;
        log.push("a", tokens(7.0), 40.0);
        assert_eq!(live.try_recv().unwrap().seq, 4);
    }

    #[test]
    fn descriptions_outlive_their_history_and_removal_drops_it() {
        let mut log = EventLog::default();
        log.describe("a", Some("Agent A".into()), None, None, 0.0);
        log.push("a", tokens(5.0), 1.0);
        log.push("b", tokens(5.0), 400_000.0); // ages out everything of a
        assert!(log.subscribe(0, 400_000.0).replay.iter().all(|m| m.body.id() == "b"));
        log.describe("c", Some("C".into()), None, None, 400_001.0);
        log.push("c", tokens(1.0), 800_000.0); // c's description aged out, its event kept
        let replay = log.subscribe(0, 800_000.0).replay;
        assert_eq!(replay.len(), 2);
        assert!(matches!(&replay[0].body, Body::Agent { id, .. } if id == "c"));
        log.remove("c", 800_001.0);
        let replay = log.subscribe(0, 800_002.0).replay;
        assert!(replay.iter().all(|m| !matches!(&m.body, Body::Event { id, .. } if id == "c")));
    }

    #[test]
    fn serializes_like_the_typescript_message() {
        let mut log = EventLog::default();
        let m = log.push("a", tokens(5.0), 12.0);
        assert_eq!(
            serde_json::to_string(&*m).unwrap(),
            r#"{"seq":1,"type":"event","id":"a","event":{"type":"tokens","count":5.0,"time":12.0}}"#
        );
    }
}

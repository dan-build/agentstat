//! Bad fields are dropped one at a time, as in the TypeScript library.

use agentstat_core::{Event, Sample, Status};

#[test]
fn a_bad_field_does_not_drop_the_sample() {
    let s: Sample = serde_json::from_str(r#"{"tokensRate":12,"status":"busy","progress":"half"}"#).unwrap();
    assert_eq!(s.tokens_rate, Some(12.0));
    assert_eq!(s.status, None);
    assert_eq!(s.progress, None);
    let s: Sample = serde_json::from_str(r#"{"status":"waiting"}"#).unwrap();
    assert_eq!(s.status, Some(Status::Waiting));
}

#[test]
fn event_fields_are_lenient() {
    let e: Event = serde_json::from_str(r#"{"type":"tool-end","name":7,"error":"timeout"}"#).unwrap();
    assert_eq!(e, Event::ToolEnd { name: None, error: Some(true), time: None });
    let e: Event = serde_json::from_str(r#"{"type":"tool-end","error":0}"#).unwrap();
    assert_eq!(e, Event::ToolEnd { name: None, error: Some(false), time: None });
    let e: Event = serde_json::from_str(r#"{"type":"tokens","count":"5","total":40,"time":null}"#).unwrap();
    assert_eq!(e, Event::Tokens { count: None, total: Some(40.0), since: None, time: None });
    assert!(serde_json::from_str::<Event>(r#"{"type":"teleport"}"#).is_err());
}

#[test]
fn absent_fields_stay_absent_when_serialized() {
    // The TypeScript side reads `typeof time === 'number'`: a null would mean "now".
    let e = Event::Tokens { count: Some(5.0), total: None, since: None, time: Some(12.5) };
    assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"tokens","count":5.0,"time":12.5}"#);
    let e = Event::ToolEnd { name: Some("bash".into()), error: None, time: None };
    assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"tool-end","name":"bash"}"#);
}

#[test]
fn cost_adds_up_and_changes_nothing_else() {
    use agentstat_core::store::{Store, StoreOptions};
    let e: Event = serde_json::from_str(r#"{"type":"cost","usd":0.25}"#).unwrap();
    assert_eq!(e, Event::Cost { usd: Some(0.25), time: None });
    let mut store = Store::new(vec![], StoreOptions { window_seconds: None, max_history_points: 1_000 }, 0.0);
    store.ensure("a", 0.0, 0.0);
    store.push("a", &Event::Start { time: Some(10.0) }, 10.0);
    store.push("a", &Event::Finish { time: Some(20.0) }, 20.0);
    let before = store.stats("a", 30.0).unwrap();
    store.push("a", &e, 30.0);
    store.push("a", &Event::Cost { usd: Some(f64::NAN), time: None }, 31.0);
    store.push("a", &Event::Cost { usd: Some(0.5), time: None }, 32.0);
    let after = store.stats("a", 30.0).unwrap();
    assert_eq!(after.cost_usd, 0.75);
    // Still complete, and complete since the same time.
    assert_eq!(after.status_ms, before.status_ms);
    assert_eq!(store.agent("a").unwrap().current.status, Status::Complete);
}

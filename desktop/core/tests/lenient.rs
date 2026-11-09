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

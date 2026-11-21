//! macOS notifications: an agent needs you, finished a long turn, failed,
//! stalled or ran away. Clicking one brings forward the app the session runs
//! in (Terminal, iTerm, VS Code, …) when the plugin reported it.
//!
//! Uses `NSUserNotificationCenter`: deprecated, but it needs no permission
//! prompt or signing identity, which an ad-hoc signed app can't rely on with
//! the newer framework. Kept in this one file so it can be swapped.
// The Objective-C macros check a cfg this crate doesn't declare.
#![allow(unexpected_cfgs)]

use std::ffi::{CStr, CString};
use std::sync::Once;

use objc::declare::ClassDecl;
use objc::runtime::{BOOL, Class, Object, Sel, YES};
use objc::{class, msg_send, sel, sel_impl};

/// The user-info key holding the bundle id to bring forward.
const APP_KEY: &CStr = c"app";

unsafe fn ns_string(s: &str) -> *mut Object {
    let c = CString::new(s.replace('\0', "")).unwrap_or_default();
    unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
}

unsafe fn rust_string(ns: *mut Object) -> Option<String> {
    if ns.is_null() {
        return None;
    }
    let p: *const std::os::raw::c_char = unsafe { msg_send![ns, UTF8String] };
    (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

/// Clicked: bring the session's app forward.
extern "C" fn did_activate(_this: &Object, _sel: Sel, _center: *mut Object, note: *mut Object) {
    unsafe {
        let info: *mut Object = msg_send![note, userInfo];
        if info.is_null() {
            return;
        }
        let key = ns_string(APP_KEY.to_str().unwrap_or("app"));
        let app: *mut Object = msg_send![info, objectForKey: key];
        if let Some(id) = rust_string(app)
            && !id.is_empty()
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            let _ = std::process::Command::new("/usr/bin/open").args(["-b", &id]).spawn();
        }
    }
}

/// Shown even while AgentStat is the frontmost app.
extern "C" fn should_present(_this: &Object, _sel: Sel, _center: *mut Object, _note: *mut Object) -> BOOL {
    YES
}

fn delegate_class() -> &'static Class {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        let mut decl =
            ClassDecl::new("AgentStatNotificationDelegate", class!(NSObject)).expect("class registered once");
        unsafe {
            decl.add_method(
                sel!(userNotificationCenter:didActivateNotification:),
                did_activate as extern "C" fn(&Object, Sel, *mut Object, *mut Object),
            );
            decl.add_method(
                sel!(userNotificationCenter:shouldPresentNotification:),
                should_present as extern "C" fn(&Object, Sel, *mut Object, *mut Object) -> BOOL,
            );
        }
        decl.register();
    });
    Class::get("AgentStatNotificationDelegate").expect("registered above")
}

/// The notification center, or None outside an app bundle (e.g. `cargo run`).
fn center() -> Option<*mut Object> {
    unsafe {
        let c: *mut Object = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
        if c.is_null() {
            return None;
        }
        static DELEGATE: Once = Once::new();
        DELEGATE.call_once(|| {
            let d: *mut Object = msg_send![delegate_class(), new];
            // Kept for the app's lifetime (the center holds it weakly).
            let _: () = msg_send![c, setDelegate: d];
        });
        Some(c)
    }
}

/// Connect to the notification center at launch, and clear what an earlier
/// run left in Notification Center. The first notification on a fresh
/// connection is shown as an update (no banner), so it shouldn't be a real one.
pub fn prepare() {
    if let Some(c) = center() {
        unsafe {
            let _: () = msg_send![c, removeAllDeliveredNotifications];
        }
    }
}

/// Post a notification. `key` identifies it: without a distinct identifier
/// macOS treats a new notification as an update of the last one and shows
/// no banner. `app` is the bundle id to bring forward on click.
pub fn post(key: &str, title: &str, body: &str, app: Option<&str>) -> bool {
    let debug = std::env::var_os("AGENTSTAT_DEBUG").is_some();
    let Some(c) = center() else {
        if debug {
            eprintln!("notify: no notification center (not running from an app bundle?)");
        }
        return false;
    };
    if debug {
        eprintln!("notify: posting {title:?} / {body:?} (app {app:?})");
    }
    unsafe {
        let n: *mut Object = msg_send![class!(NSUserNotification), new];
        let _: () = msg_send![n, setIdentifier: ns_string(key)];
        let _: () = msg_send![n, setTitle: ns_string(title)];
        let _: () = msg_send![n, setInformativeText: ns_string(body)];
        if let Some(a) = app {
            let info: *mut Object = msg_send![class!(NSDictionary),
                dictionaryWithObject: ns_string(a)
                forKey: ns_string(APP_KEY.to_str().unwrap_or("app"))];
            let _: () = msg_send![n, setUserInfo: info];
        }
        let _: () = msg_send![c, deliverNotification: n];
        let _: () = msg_send![n, release];
    }
    true
}

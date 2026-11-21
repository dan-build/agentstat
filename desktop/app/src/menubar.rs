//! The menu bar item: how many agents are working and how many need you, with
//! a menu listing them. Choosing an agent that needs you brings forward the
//! app it runs in; anything else opens AgentStat.
// The Objective-C macros check a cfg this crate doesn't declare.
#![allow(unexpected_cfgs)]

use std::ffi::{CStr, CString};
use std::sync::Once;

use objc::declare::ClassDecl;
use objc::runtime::{Class, NO, Object, Sel, YES};
use objc::{class, msg_send, sel, sel_impl};

/// One line of the menu.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub text: String,
    /// The bundle id to bring forward (an agent waiting on you), else AgentStat.
    pub app: Option<String>,
    /// Shown first and marked: it needs you.
    pub needs_you: bool,
}

/// What the item shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub working: usize,
    pub needs_you: usize,
    pub lines: Vec<Line>,
}

impl State {
    /// The text next to the icon, kept short (a crowded menu bar hides items):
    /// "1 needs you", else how many are working ("2"), else nothing.
    pub fn title(&self) -> String {
        match (self.needs_you, self.working) {
            (0, 0) => String::new(),
            (0, w) => w.to_string(),
            (n, _) => format!("{n} needs you"),
        }
    }
}

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

/// Bring AgentStat's window forward (it may be hidden after a close).
pub fn show_app() {
    unsafe {
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, unhide: std::ptr::null::<Object>()];
        let _: () = msg_send![app, activateIgnoringOtherApps: YES];
        let windows: *mut Object = msg_send![app, windows];
        let first: *mut Object = msg_send![windows, firstObject];
        if !first.is_null() {
            let _: () = msg_send![first, makeKeyAndOrderFront: std::ptr::null::<Object>()];
        }
    }
}

/// Hide AgentStat (its window's close button): it keeps running in the menu bar.
pub fn hide_app() {
    unsafe {
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, hide: std::ptr::null::<Object>()];
    }
}

extern "C" fn open_app(_this: &Object, _sel: Sel, _sender: *mut Object) {
    show_app();
}

extern "C" fn open_line(_this: &Object, _sel: Sel, sender: *mut Object) {
    let id = unsafe {
        let o: *mut Object = msg_send![sender, representedObject];
        rust_string(o)
    };
    match id {
        Some(id) if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') => {
            let _ = std::process::Command::new("/usr/bin/open").args(["-b", &id]).spawn();
        }
        _ => show_app(),
    }
}

extern "C" fn quit(_this: &Object, _sel: Sel, _sender: *mut Object) {
    unsafe {
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, terminate: std::ptr::null::<Object>()];
    }
}

fn target_class() -> &'static Class {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        let mut decl = ClassDecl::new("AgentStatMenuTarget", class!(NSObject)).expect("class registered once");
        unsafe {
            decl.add_method(sel!(openApp:), open_app as extern "C" fn(&Object, Sel, *mut Object));
            decl.add_method(sel!(openLine:), open_line as extern "C" fn(&Object, Sel, *mut Object));
            decl.add_method(sel!(quit:), quit as extern "C" fn(&Object, Sel, *mut Object));
        }
        decl.register();
    });
    Class::get("AgentStatMenuTarget").expect("registered above")
}

/// The menu bar item. Lives as long as the app.
pub struct MenuBar {
    item: *mut Object,
    target: *mut Object,
    shown: Option<State>,
}

impl MenuBar {
    pub fn new() -> Self {
        unsafe {
            let bar: *mut Object = msg_send![class!(NSStatusBar), systemStatusBar];
            // NSVariableStatusItemLength
            let item: *mut Object = msg_send![bar, statusItemWithLength: -1.0f64];
            let _: () = msg_send![item, retain];
            // Where the person drags it (Cmd-drag) is remembered across launches.
            let _: () = msg_send![item, setAutosaveName: ns_string("AgentStat")];
            let button: *mut Object = msg_send![item, button];
            if !button.is_null() {
                let image: *mut Object = msg_send![class!(NSImage),
                    imageWithSystemSymbolName: ns_string("waveform.path.ecg")
                    accessibilityDescription: ns_string("AgentStat")];
                if !image.is_null() {
                    let _: () = msg_send![image, setTemplate: YES];
                    let _: () = msg_send![button, setImage: image];
                    // NSImageLeading
                    let _: () = msg_send![button, setImagePosition: 7i64];
                } else {
                    let _: () = msg_send![button, setTitle: ns_string("AgentStat")];
                }
            }
            let target: *mut Object = msg_send![target_class(), new];
            if std::env::var_os("AGENTSTAT_DEBUG").is_some() {
                let visible: objc::runtime::BOOL = if item.is_null() { NO } else { msg_send![item, isVisible] };
                eprintln!("menubar: item {item:?}, button {button:?}, visible {}", visible != NO);
            }
            MenuBar { item, target, shown: None }
        }
    }

    /// Show `state`; does nothing when it hasn't changed.
    pub fn update(&mut self, state: &State) {
        if self.shown.as_ref() == Some(state) {
            return;
        }
        unsafe {
            let button: *mut Object = msg_send![self.item, button];
            if !button.is_null() {
                let title = state.title();
                let _: () =
                    msg_send![button, setTitle: ns_string(&if title.is_empty() { title } else { format!(" {title}") })];
            }
            let menu: *mut Object = msg_send![class!(NSMenu), new];
            let _: () = msg_send![menu, setAutoenablesItems: NO];
            let add = |title: &str, action: Sel, enabled: bool| -> *mut Object {
                let it: *mut Object = msg_send![class!(NSMenuItem), alloc];
                let it: *mut Object =
                    msg_send![it, initWithTitle: ns_string(title) action: action keyEquivalent: ns_string("")];
                let _: () = msg_send![it, setTarget: self.target];
                let _: () = msg_send![it, setEnabled: if enabled { YES } else { NO }];
                let _: () = msg_send![menu, addItem: it];
                let _: () = msg_send![it, release];
                it
            };
            if state.lines.is_empty() {
                add("No agents right now", sel!(openApp:), false);
            }
            for l in &state.lines {
                let it = add(&l.text, sel!(openLine:), true);
                if let Some(app) = &l.app {
                    let _: () = msg_send![it, setRepresentedObject: ns_string(app)];
                }
                // NSControlStateValueOn: a check mark flags who needs you.
                if l.needs_you {
                    let _: () = msg_send![it, setState: 1i64];
                }
            }
            let sep: *mut Object = msg_send![class!(NSMenuItem), separatorItem];
            let _: () = msg_send![menu, addItem: sep];
            add("Open AgentStat", sel!(openApp:), true);
            add("Quit AgentStat", sel!(quit:), true);
            let _: () = msg_send![self.item, setMenu: menu];
            let _: () = msg_send![menu, release];
        }
        self.shown = Some(state.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_says_who_needs_you_first() {
        let s = |needs_you, working| State { needs_you, working, lines: vec![] }.title();
        assert_eq!(s(0, 0), "");
        assert_eq!(s(0, 2), "2");
        assert_eq!(s(1, 0), "1 needs you");
        assert_eq!(s(1, 3), "1 needs you");
    }
}

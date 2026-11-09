//! Colors: the npm library's tokens (`src/theme.ts`), light and dark. Every
//! text color clears 4.5:1 on its background; status is never color alone
//! (a word goes with it).

use agentstat_core::Status;
use gpui::{Hsla, Rgba, rgb};

#[derive(Clone, Copy)]
pub struct Theme {
    pub bg: Rgba,
    /// The panel behind the fleet list.
    pub sidebar: Rgba,
    pub border: Rgba,
    /// Selected row.
    pub selected: Rgba,
    pub text: Rgba,
    pub text_secondary: Rgba,
    pub text_tertiary: Rgba,
    pub grid: Rgba,
    pub warning: Rgba,
    pub critical: Rgba,
    pub palette: [u32; 8],
    pub dark: bool,
}

pub const LIGHT: Theme = Theme {
    bg: Rgba { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
    sidebar: Rgba { r: 0.980, g: 0.980, b: 0.976, a: 1.0 },
    border: Rgba { r: 0.094, g: 0.094, b: 0.106, a: 0.08 },
    selected: Rgba { r: 0.094, g: 0.094, b: 0.106, a: 0.05 },
    text: Rgba { r: 0.094, g: 0.094, b: 0.106, a: 1.0 },
    text_secondary: Rgba { r: 0.322, g: 0.322, b: 0.357, a: 1.0 },
    text_tertiary: Rgba { r: 0.420, g: 0.420, b: 0.451, a: 1.0 },
    grid: Rgba { r: 0.094, g: 0.094, b: 0.106, a: 0.06 },
    warning: Rgba { r: 0.706, g: 0.325, b: 0.035, a: 1.0 },
    critical: Rgba { r: 0.863, g: 0.149, b: 0.149, a: 1.0 },
    palette: [0x2563eb, 0xd9480f, 0x0f8a5f, 0xc2255c, 0x7048e8, 0x0b7285, 0xa16207, 0x3f3f46],
    dark: false,
};

pub const DARK: Theme = Theme {
    bg: Rgba { r: 0.043, g: 0.043, b: 0.051, a: 1.0 },
    sidebar: Rgba { r: 0.067, g: 0.067, b: 0.075, a: 1.0 },
    border: Rgba { r: 1.0, g: 1.0, b: 1.0, a: 0.08 },
    selected: Rgba { r: 1.0, g: 1.0, b: 1.0, a: 0.06 },
    text: Rgba { r: 0.957, g: 0.957, b: 0.961, a: 1.0 },
    text_secondary: Rgba { r: 0.631, g: 0.631, b: 0.667, a: 1.0 },
    text_tertiary: Rgba { r: 0.545, g: 0.545, b: 0.580, a: 1.0 },
    grid: Rgba { r: 1.0, g: 1.0, b: 1.0, a: 0.06 },
    warning: Rgba { r: 0.961, g: 0.620, b: 0.043, a: 1.0 },
    critical: Rgba { r: 0.973, g: 0.443, b: 0.443, a: 1.0 },
    palette: [0x60a5fa, 0xff8a4c, 0x34d399, 0xf472b6, 0xa78bfa, 0x22d3ee, 0xfacc15, 0xd4d4d8],
    dark: true,
};

impl Theme {
    /// The series color for the agent at `index` on the roster.
    pub fn series(&self, index: usize) -> Hsla {
        rgb(self.palette[index % self.palette.len()]).into()
    }

    /// The dot beside a status word: green working, blue thinking, amber
    /// waiting, quiet when done, red for problems.
    pub fn status(&self, s: Status) -> Hsla {
        let c = match (s, self.dark) {
            (Status::Active, false) => rgb(0x0f8a5f),
            (Status::Active, true) => rgb(0x34d399),
            (Status::Thinking, false) => rgb(0x2563eb),
            (Status::Thinking, true) => rgb(0x60a5fa),
            (Status::Waiting, _) => self.warning,
            (Status::Complete, _) => self.text_tertiary,
            (Status::Stuck | Status::Hallucinating, _) => self.critical,
        };
        c.into()
    }
}

/// A color with its alpha scaled.
pub fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla { a: c.a * a, ..c }
}

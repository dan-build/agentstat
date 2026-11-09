//! Colors: the npm library's tokens (`src/theme.ts`), light and dark. One
//! color, one meaning: an agent is identified by its series color; its status
//! is a word, colored only when something is wrong.

use agentstat_core::Status;
use gpui::{Hsla, Rgba, rgb};

#[derive(Clone, Copy)]
pub struct Theme {
    pub bg: Rgba,
    /// The panel behind the fleet list.
    pub sidebar: Rgba,
    /// Tooltips and other raised surfaces.
    pub surface: Rgba,
    pub border: Rgba,
    /// Selected row.
    pub selected: Rgba,
    pub text: Rgba,
    pub text_secondary: Rgba,
    pub text_tertiary: Rgba,
    pub grid: Rgba,
    /// The hover hairline on the chart.
    pub cursor: Rgba,
    /// Keyboard focus ring (3:1 against what it crosses).
    pub focus: Rgba,
    /// The connection indicator when live.
    pub ok: Rgba,
    pub warning: Rgba,
    pub critical: Rgba,
    pub palette: [u32; 8],
    pub dark: bool,
}

const fn c(r: f32, g: f32, b: f32, a: f32) -> Rgba {
    Rgba { r, g, b, a }
}

pub const LIGHT: Theme = Theme {
    bg: c(1.0, 1.0, 1.0, 1.0),
    sidebar: c(0.980, 0.980, 0.976, 1.0),
    surface: c(1.0, 1.0, 1.0, 1.0),
    border: c(0.094, 0.094, 0.106, 0.08),
    selected: c(0.094, 0.094, 0.106, 0.06),
    text: c(0.094, 0.094, 0.106, 1.0),
    text_secondary: c(0.322, 0.322, 0.357, 1.0),
    // Darker than the library's tertiary: it must clear 4.5:1 on the selected row too.
    text_tertiary: c(0.400, 0.400, 0.431, 1.0),
    grid: c(0.094, 0.094, 0.106, 0.06),
    cursor: c(0.094, 0.094, 0.106, 0.22),
    focus: c(0.145, 0.388, 0.922, 1.0),
    ok: c(0.059, 0.541, 0.373, 1.0),
    // Measured ≥ 4.9:1 on the background, the sidebar and the selected row.
    warning: c(0.640, 0.290, 0.030, 1.0),
    critical: c(0.780, 0.110, 0.110, 1.0),
    palette: [0x2563eb, 0xd9480f, 0x0f8a5f, 0xc2255c, 0x7048e8, 0x0b7285, 0xa16207, 0x3f3f46],
    dark: false,
};

pub const DARK: Theme = Theme {
    bg: c(0.043, 0.043, 0.051, 1.0),
    sidebar: c(0.067, 0.067, 0.075, 1.0),
    surface: c(0.110, 0.110, 0.122, 1.0),
    border: c(1.0, 1.0, 1.0, 0.08),
    selected: c(1.0, 1.0, 1.0, 0.07),
    text: c(0.957, 0.957, 0.961, 1.0),
    text_secondary: c(0.631, 0.631, 0.667, 1.0),
    text_tertiary: c(0.545, 0.545, 0.580, 1.0),
    grid: c(1.0, 1.0, 1.0, 0.06),
    cursor: c(1.0, 1.0, 1.0, 0.24),
    focus: c(0.376, 0.647, 0.980, 1.0),
    ok: c(0.204, 0.827, 0.600, 1.0),
    warning: c(0.961, 0.620, 0.043, 1.0),
    critical: c(0.973, 0.443, 0.443, 1.0),
    palette: [0x60a5fa, 0xff8a4c, 0x34d399, 0xf472b6, 0xa78bfa, 0x22d3ee, 0xfacc15, 0xd4d4d8],
    dark: true,
};

impl Theme {
    /// The series color for the agent at `index` on the roster.
    pub fn series(&self, index: usize) -> Hsla {
        rgb(self.palette[index % self.palette.len()]).into()
    }

    /// A status word's color: quiet unless something is wrong.
    pub fn status_text(&self, s: Status, quiet: Rgba) -> Rgba {
        match s {
            Status::Stuck | Status::Hallucinating => self.critical,
            _ => quiet,
        }
    }
}

/// A color with its alpha scaled.
pub fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla { a: c.a * a, ..c }
}

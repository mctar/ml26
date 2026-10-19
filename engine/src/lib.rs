//! Moonlander in a browser: the recovery's translation of Burness's 1973
//! program, with the GT40 model it runs on, compiled to WebAssembly.
//!
//! Nothing of the program or the machine changes here. What this crate
//! adds is a boundary. The translation runs as the original did, one
//! nested routine inside another, and at least once per millisecond of
//! machine time it calls out through [`tend`] with the picture the beam
//! has drawn, the state of the game read from the original's variables,
//! and a place for the host to put the light pen. The host (JavaScript)
//! paces the machine against the wall clock and, when the machine has run
//! far enough ahead, pauses it until the next frame. The pause is the one
//! trick: the WebAssembly is instrumented by Binaryen's Asyncify pass so
//! that `tend` can unwind the call stack and rewind it later, which is how
//! a program that never returns shares a thread with a browser.
//!
//! The interface is a plain C ABI with no generated glue: a few exported
//! functions and two imported ones, with structs at fixed addresses in
//! linear memory that the host reads and writes directly.

use gt40::terminal::Terminal;
use gt40::vt11::{Beam, LightPen};
use moonlander::generated::symbols::*;
use moonlander::pilot::{Pilot, Plan, Spot, PEN_RADIUS};
use moonlander::{Escape, Moonlander};

/// What the host wants the machine to see, written by the host before
/// each `tend` returns. Everything is a 32-bit field so the host can use
/// plain typed-array views.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct Input {
    /// The pen held on the face at (x, y) raster units while `pen_down`.
    pub pen_x: f32,
    pub pen_y: f32,
    pub pen_down: i32,
    /// Throttle wanted, in percent, or -1 for no request. A hand moves the
    /// pen on the bar until the program's reading shows it.
    pub throttle: i32,
    /// A turning arrow held: -2 fast left, -1 left, 0 none, 1 right, 2 fast
    /// right.
    pub turning: i32,
    /// One-shot: point at readout choice 0-11, or -1. Cleared when taken.
    pub choice: i32,
    /// One-shot: point at readout slot 0-3, or -1. Cleared when taken.
    pub slot: i32,
    /// Fly by the autopilot with this plan (see `plan`), or -1 for a person.
    pub pilot: i32,
    /// Stop the machine at the next opportunity.
    pub stop: i32,
}

/// The game as the original's variables have it, read at every `tend`.
/// Units are the program's: feet, tenths of feet per second, tenths of
/// pounds, degrees, raster units. See the data area comments in the
/// reconstruction. Fields are i32 for the host's convenience.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct State {
    /// Machine time, microseconds.
    pub t: f64,
    /// Blocks of the original executed so far.
    pub ticks: f64,
    pub angle: i32,
    pub turn: i32,
    pub horvel: i32,
    pub vervel: i32,
    pub hordis: i32,
    pub verdis: i32,
    pub horacc: i32,
    pub veracc: i32,
    pub accel: i32,
    pub percnt: i32,
    pub thrust: i32,
    pub fuel: i32,
    pub weight: i32,
    pub time: i32,
    pub bigxct: i32,
    pub radary: i32,
    pub avery: i32,
    pub avert: i32,
    pub leftd: i32,
    pub lefeet: i32,
    pub indexl: i32,
    /// Which picture is up: 0 the whole moon, then the closer views.
    pub dnum: i32,
    /// Address of the message on the screen, 0 for none.
    pub sysmes: i32,
    /// Explosion radius while a crash is being drawn.
    pub radius: i32,
    pub manx: i32,
    pub many: i32,
    pub flagx: i32,
    pub flagy: i32,
    pub hitcnt: i32,
    pub lpflg1: i32,
    /// Low fuel message on (LPSW not a display stop).
    pub fuel_low: i32,
    /// The ship is being displayed (SHIPDP points at its buffer); cleared
    /// when it is destroyed.
    pub shipdp: i32,
    /// The flame is being drawn (FSUBC) and dust is on (DUSTON).
    pub flame: i32,
    pub dust: i32,
    /// The diner still stands (MACTHR), and is drawn (MACON).
    pub diner: i32,
    /// Bells rung so far.
    pub bells: i32,
    /// Where the light pen is now, if on the face.
    pub pen_on: i32,
    pub pen_x: f32,
    pub pen_y: f32,
}

/// One beam event flattened for the host: 8 floats.
pub const BEAM_WORDS: usize = 8;

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host, called at least once per millisecond of machine time and
    /// at every WAIT. `t` is machine time; the beams since the last call are
    /// at `beams` (`n` of them, `BEAM_WORDS` floats each, times relative to
    /// `t`); the state and input structs are where they always are. Returns
    /// a bit set: 1 stop, 2 the beams were taken (clear them).
    fn tend(t: f64, beams: *const f32, n: u32, state: *const State, input: *mut Input) -> u32;
    /// A line of diagnostics.
    fn ml_log(ptr: *const u8, len: usize);
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    //! Stubs so the crate builds and tests on the host too.
    #[no_mangle]
    pub extern "C" fn tend(_t: f64, _b: *const f32, _n: u32, _s: *const super::State, _i: *mut super::Input) -> u32 {
        0
    }
    #[no_mangle]
    pub extern "C" fn ml_log(ptr: *const u8, len: usize) {
        let s = unsafe { std::slice::from_raw_parts(ptr, len) };
        eprintln!("{}", String::from_utf8_lossy(s));
    }
}

fn say(s: &str) {
    unsafe { ml_log(s.as_ptr(), s.len()) }
}

fn word(bus: &Terminal, a: u16) -> i32 {
    bus.mem[(a >> 1) as usize] as i16 as i32
}

fn uword(bus: &Terminal, a: u16) -> i32 {
    bus.mem[(a >> 1) as usize] as i32
}

// ---- the hand ---------------------------------------------------------------

/// A hand moving the light pen on the host's behalf. The program reads
/// nothing but the pen, so a throttle setting or a turn becomes the pen
/// held on the control a player would have pointed at, until the program
/// has acted. Ported from the desktop front end's keyboard, which does the
/// same for keys; the throttle here is asked for as a percentage rather
/// than a step.
#[derive(Default)]
struct Hand {
    turning: Option<(i8, bool)>,
    throttle: Option<Throttle>,
    /// How far from the setting wanted the pen has to be put for the
    /// reading to show it, in percent: learned by watching the reading.
    offset: i16,
    touch: Option<(Spot, u16, f64)>,
}

#[derive(Clone, Copy, Debug)]
struct Throttle {
    want: u16,
    since: f64,
    look: f64,
}

const THROTTLE_HOLD: f64 = 1_500_000.0;
const THROTTLE_SETTLE: f64 = 60_000.0;
const THROTTLE_LOOK: f64 = 40_000.0;
const BAR_TOP: i16 = 119;
const TOUCH_HOLD: f64 = 1_500_000.0;
const TOUCH_EMPTY: f64 = 400_000.0;

impl Hand {
    fn throttle_to(&mut self, pct: i32, bus: &Terminal) {
        let want = pct.clamp(MINTRS as i32, 100) as u16;
        match self.throttle {
            Some(t) if t.want == want => {}
            _ => self.throttle = Some(Throttle { want, since: bus.t, look: bus.t + THROTTLE_LOOK }),
        }
    }

    fn choose(&mut self, c: u8, bus: &Terminal) {
        self.touch = Some((Spot::Item(c), uword(bus, LPFLG1) as u16, bus.t + TOUCH_HOLD));
    }

    fn slot(&mut self, s: u8, bus: &Terminal) {
        let blinking = uword(bus, LPFLG1) as u16;
        let hold = if blinking != 0 { TOUCH_HOLD } else { TOUCH_EMPTY };
        self.touch = Some((Spot::Slot(s), blinking, bus.t + hold));
    }

    fn pen(&mut self, bus: &Terminal) -> Option<LightPen> {
        if let Some((spot, blinking, until)) = self.touch {
            if bus.t < until && uword(bus, LPFLG1) as u16 == blinking {
                return spot.pen();
            }
            self.touch = None;
        }
        if let Some((dir, fast)) = self.turning {
            let rate = if fast { 100 } else { 15 };
            return Spot::Turn(dir as i16 * rate).pen();
        }
        if let Some(mut th) = self.throttle {
            let held = bus.t - th.since;
            let now = uword(bus, PERCNT) as u16;
            if (now == th.want && held >= THROTTLE_SETTLE) || held >= THROTTLE_HOLD {
                self.throttle = None;
                return None;
            }
            if bus.t >= th.look {
                self.offset = (self.offset + (th.want as i16 - now as i16).signum()).clamp(-10, 10);
                th.look = bus.t + THROTTLE_LOOK;
                self.throttle = Some(th);
            }
            let aim = (th.want as i16 + self.offset).clamp(0, BAR_TOP);
            return Spot::Throttle(aim as u16).pen();
        }
        None
    }
}

// ---- the host side of the terminal -------------------------------------------

/// Everything the pacer keeps between calls. Boxed, so the struct addresses
/// the host is given stay put.
struct Side {
    input: Box<Input>,
    state: Box<State>,
    beams: Vec<f32>,
    hand: Hand,
    pilot: Option<(i32, Pilot)>,
    pen: Option<LightPen>,
    bells: i32,
}

/// The autopilot's plans, by the number the host gives in `Input::pilot`.
fn plan(n: i32) -> Option<Plan> {
    Some(match n {
        0 => Plan::Land,
        1 => Plan::McDonalds,
        2 => Plan::Flag,
        3 => Plan::Hard { fps: 20 },
        4 => Plan::Hard { fps: 60 },
        5 => Plan::Tilted { degrees: 40 },
        6 => Plan::Sliding { fps: 40 },
        7 => Plan::Climb,
        8 => Plan::Drift { fps: 60 },
        9 => Plan::Bumpy,
        10 => Plan::IntoMcDonalds,
        11 => Plan::Spin,
        12 => Plan::Brake,
        // 1000 and up: come down at terrain index n - 1000, whatever is there.
        n if (1000..1000 + 911).contains(&n) => Plan::LandAt { index: (n - 1000) as i16 },
        _ => return None,
    })
}

impl Side {
    fn new() -> Side {
        Side {
            input: Box::new(Input { throttle: -1, choice: -1, slot: -1, pilot: -1, ..Default::default() }),
            state: Box::new(State::default()),
            beams: Vec::with_capacity(4096),
            hand: Hand::default(),
            pilot: None,
            pen: None,
            bells: 0,
        }
    }

    fn flatten(&mut self, out: &[Beam], t: f64) {
        // If the host is not taking the picture (a hidden tab), drop the
        // oldest: the phosphor would have faded by now anyway.
        if self.beams.len() > (1 << 20) * BEAM_WORDS {
            self.beams.clear();
        }
        for b in out {
            match *b {
                Beam::Line { x0, y0, x1, y1, t0, t1, level } => {
                    self.beams.extend_from_slice(&[0.0, x0, y0, x1, y1, (t0 - t) as f32, (t1 - t) as f32, level as f32]);
                }
                Beam::Dot { x, y, t: td, level } => {
                    self.beams.extend_from_slice(&[1.0, x, y, x, y, (td - t) as f32, (td - t) as f32, level as f32]);
                }
            }
        }
    }

    fn read_state(&mut self, bus: &Terminal, ticks: f64) {
        let s = &mut *self.state;
        s.t = bus.t;
        s.ticks = ticks;
        s.angle = word(bus, ANGLE);
        s.turn = word(bus, TURN);
        s.horvel = word(bus, HORVEL);
        s.vervel = word(bus, VERVEL);
        s.hordis = word(bus, HORDIS);
        s.verdis = word(bus, VERDIS);
        s.horacc = word(bus, HORACC);
        s.veracc = word(bus, VERACC);
        s.accel = word(bus, ACCEL);
        s.percnt = word(bus, PERCNT);
        s.thrust = word(bus, THRUST);
        s.fuel = word(bus, FUEL);
        s.weight = word(bus, WEIGHT);
        s.time = word(bus, TIME);
        s.bigxct = word(bus, BIGXCT);
        s.radary = word(bus, RADARY);
        s.avery = word(bus, AVERY);
        s.avert = word(bus, AVERT);
        s.leftd = word(bus, LEFTED);
        s.lefeet = word(bus, LEFEET);
        s.indexl = word(bus, INDEXL);
        s.dnum = word(bus, DNUM);
        s.sysmes = uword(bus, SYSMES);
        s.radius = word(bus, RADIUS);
        s.manx = word(bus, MANX);
        s.many = word(bus, MANY);
        s.flagx = word(bus, FLAGX);
        s.flagy = word(bus, FLAGY);
        s.hitcnt = word(bus, HITCNT);
        s.lpflg1 = uword(bus, LPFLG1);
        s.fuel_low = (uword(bus, LPSW) != DISTOP as i32) as i32;
        s.shipdp = uword(bus, SHIPDP);
        s.flame = uword(bus, FSUBC);
        s.dust = uword(bus, DUSTON);
        s.diner = (uword(bus, MACTHR) != 0) as i32 | ((uword(bus, MACON) != 0) as i32) << 1;
        s.bells = self.bells;
        s.pen_on = self.pen.is_some() as i32;
        if let Some(p) = self.pen {
            s.pen_x = p.x;
            s.pen_y = p.y;
        }
    }

    /// The pacer: called by the translation at least once a millisecond of
    /// machine time. Returns false to stop the machine.
    fn tend(&mut self, bus: &mut Terminal, ticks: f64) -> bool {
        let t = bus.t;
        let out = std::mem::take(&mut bus.vt11.out);
        self.flatten(&out, t);
        bus.vt11.out = out;
        bus.vt11.out.clear();
        self.bells += bus.bells.len() as i32;
        bus.bells.clear();
        self.read_state(bus, ticks);

        let n = (self.beams.len() / BEAM_WORDS) as u32;
        let r = unsafe { tend(t, self.beams.as_ptr(), n, &*self.state, &mut *self.input) };
        if r & 2 != 0 {
            self.beams.clear();
        }
        if r & 1 != 0 || self.input.stop != 0 {
            return false;
        }

        // The pen: the autopilot's, the host's own, or the hand's.
        let input = *self.input;
        if input.pilot >= 0 {
            match &mut self.pilot {
                Some((n, p)) if *n == input.pilot => p.fly(bus),
                _ => {
                    if let Some(plan) = plan(input.pilot) {
                        let mut p = Pilot::new(plan);
                        p.fly(bus);
                        self.pilot = Some((input.pilot, p));
                    }
                }
            }
            self.pen = bus.vt11.pen_moves.back().map(|m| m.1).unwrap_or(bus.vt11.pen);
            return true;
        }
        self.pilot = None;
        if input.choice >= 0 {
            self.hand.choose(input.choice as u8 % 12, bus);
            self.input.choice = -1;
        }
        if input.slot >= 0 {
            self.hand.slot(input.slot as u8 % 4, bus);
            self.input.slot = -1;
        }
        if input.throttle >= 0 {
            self.hand.throttle_to(input.throttle, bus);
            self.input.throttle = -1;
        }
        self.hand.turning = match input.turning {
            0 => None,
            d => Some((d.signum() as i8, d.abs() >= 2)),
        };
        let pen = if input.pen_down != 0 {
            Some(LightPen { x: input.pen_x, y: input.pen_y, radius: PEN_RADIUS })
        } else {
            self.hand.pen(bus)
        };
        if pen != self.pen {
            bus.move_pen(bus.t, pen);
            self.pen = pen;
        }
        true
    }
}

// ---- the game ------------------------------------------------------------------

pub struct Game {
    m: Moonlander,
}

/// Mains frequency the GT40 is synchronised to: the line clock and the
/// display's sync. Burness's machine in Maynard ran on 60 Hz.
pub const LINE_HZ: f64 = 60.0;

impl Game {
    pub fn new() -> Game {
        let mut m = Moonlander::new(LINE_HZ);
        let mut side = Side::new();
        let mut ticks = 0u64;
        m.pacer = Some(Box::new(move |bus| {
            ticks += 1;
            side.tend(bus, ticks as f64)
        }));
        Game { m }
    }

    /// Run until the host stops the machine or the program stops itself.
    pub fn run(&mut self) -> Escape {
        self.m.run()
    }
}

impl Default for Game {
    fn default() -> Self {
        Game::new()
    }
}

// ---- the C ABI -----------------------------------------------------------------

/// Bytes for the host: an Asyncify save area, scratch.
#[no_mangle]
pub extern "C" fn ml_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn ml_free(p: *mut u8, n: usize) {
    unsafe { drop(Vec::from_raw_parts(p, 0, n)) }
}

/// A fresh GT40 with the program loaded, stopped at its start address.
#[no_mangle]
pub extern "C" fn ml_new() -> *mut Game {
    std::panic::set_hook(Box::new(|info| {
        say(&format!("panic: {info}"));
    }));
    Box::into_raw(Box::new(Game::new()))
}

/// Run the program. Returns only when the host has stopped it through
/// `tend`, or the program has halted: 0 stopped by the host, 1 halted,
/// 2 bus error, 3 control left the program.
#[no_mangle]
pub extern "C" fn ml_run(g: *mut Game) -> i32 {
    let g = unsafe { &mut *g };
    match g.run() {
        Escape::Stop => 0,
        Escape::Restart => 3,
        Escape::Halt(a) => {
            say(&format!("HALT AT {a:06o}"));
            1
        }
        Escape::BusError(a) => {
            say(&format!("BUS ERROR AT {a:06o}"));
            2
        }
        Escape::Wild(a) => {
            say(&format!("CONTROL WENT TO {a:06o}"));
            3
        }
    }
}

#[no_mangle]
pub extern "C" fn ml_destroy(g: *mut Game) {
    unsafe { drop(Box::from_raw(g)) }
}

/// A word of the original's memory. For the host between frames.
#[no_mangle]
pub extern "C" fn ml_peek(g: *const Game, addr: u32) -> u32 {
    let g = unsafe { &*g };
    g.m.bus.mem.get((addr >> 1) as usize).copied().unwrap_or(0) as u32
}

/// Machine time, microseconds.
#[no_mangle]
pub extern "C" fn ml_time(g: *const Game) -> f64 {
    unsafe { (*g).m.bus.t }
}

/// The addresses the host needs, as "NAME=decimal" lines. Written at `out`
/// (up to `cap` bytes); returns the length needed.
#[no_mangle]
pub extern "C" fn ml_symbols(out: *mut u8, cap: usize) -> usize {
    let s = symbols();
    let n = s.len().min(cap);
    unsafe { std::ptr::copy_nonoverlapping(s.as_ptr(), out, n) };
    s.len()
}

fn symbols() -> String {
    let mut s = String::new();
    macro_rules! sym {
        ($($n:ident),*) => { $( s.push_str(&format!("{}={}\n", stringify!($n), $n)); )* };
    }
    sym!(
        N2FAST, GREATM, GOODM, ROUGHM, CRIPM, DEADM, ANGLEM, ANGLEJ, SIDEM, BUMPYM, ROCKMS, OLDMS, FLAGMS, OLDTLT,
        MACDED, ORDER, MANMSG, LFTMSG, RGTMSG, TOPMSG, VFAST, FAST, TERAIN, FEATUR, MOONST, MOONEN, MINTRS, MAXTRS,
        YTHRST, G1, G2, DISTOP, ITEMY1, ITEMY2, DX1, DY1, MAN, MACX, MACY
    );
    s.push_str(&format!("LINE_HZ={LINE_HZ}\nBEAM_WORDS={BEAM_WORDS}\n"));
    s.push_str(&format!("STATE_SIZE={}\nINPUT_SIZE={}\n", std::mem::size_of::<State>(), std::mem::size_of::<Input>()));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_game_runs_through_the_greeting() {
        let mut g = Game::new();
        g.m.limit = 32e6;
        assert_eq!(g.run(), Escape::Stop);
        assert!(g.m.bus.t >= 32e6);
        // The game has started: the ship is in the air with fuel.
        assert!(word(&g.m.bus, FUEL) > 0);
        assert!(word(&g.m.bus, VERDIS) > 0);
    }

    #[test]
    fn symbols_list_the_messages() {
        let s = symbols();
        assert!(s.contains("GREATM="));
        assert!(s.contains("STATE_SIZE="));
    }
}

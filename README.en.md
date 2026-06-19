# Barcoder — Striped Bass

**Languages:** [简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

Web simulation of a photodiode **barcode bass** in the [ELECTRONICOS FANTASTICOS!](https://www.electronicosfantasticos.com/en/) style, using the Processing **Barcoder** scan model: laser sweeps black-and-white stripes → photodiode sampling → mirror swing (forward + reverse audio) → real-time sound.

**Author:** by [極東踊羊Meier](https://search.bilibili.com/all?keyword=%E6%A5%B5%E6%9D%B1%E8%B8%8A%E7%BE%8AMeier) (bilibili)

The UI is available in **简体中文 / 繁體中文 / English / Español / 日本語** (language bar in the header).

---

## Run locally

| Method | Notes |
|--------|-------|
| Open directly | Double-click `index.html` (works with `file://`) |
| Windows | Double-click `start.bat` → opens `http://localhost:3456` |
| CLI | `npx --yes serve .` |

On first use, click **Click to play** to unlock the browser audio engine.

---

## Project layout

| Path | Description |
|------|-------------|
| `index.html` | Page entry |
| `js/app.js` | App logic (single file: scan engine + score editor) |
| `js/i18n.js` | UI strings |
| `css/style.css` | Styles |
| `start.bat` | Windows local server shortcut |

---

## Two play modes

### Barcode play

**Hold** the mouse on the canvas and scan along the stripes; use the **wheel** to adjust **Scan line width**.

| Barcode type | Description |
|--------------|-------------|
| Eight vertical stripes | Per-bar density; classic bass practice |
| Box glissando barcode | Horizontal period gradient; vertical glissando |
| Box radial stripes | Rays from center; 2D pitch |
| Upload image | PNG/JPG, etc.; long strips scroll with wheel |
| Audio → barcode | Waveform → horizontal bars (**test**; see below) |

**Audio → barcode (test):** Choose WAV/MP3 (≤10 s), set **Sample density** (cols/s) and **Column width** (px/col), then **Generate barcode** / **Export PNG**. Preview works in the browser, but barcodes **cannot be scanned in the browser** (see the test banner). Wider columns are easier to sweep at steady speed when printed.

### Score editor

Compose **row by row**; each row is one barcode. **Frame rate & line width** lock for pitch (`f ≈ rate × width / period`); **scan direction** stays adjustable.

- **Vertical stripes / Glissando stripes** — top matches vertical density; smooth fan below (not pasted)
- **Chord (test)** — interleaved bars; **Weave count** (e.g. 2 notes ×2 → ABAB)
- **Paste note names** — e.g. `G4 G4 A4 …` → **Generate score**; live preview syncs with the score; **X** pinned rows highlight in red
- **Edit selected row** — point at a row, press **X** to pin; change pitch or switch **Vertical stripes** ↔ **Glissando stripes**
- **MIDI input** — **Connect MIDI device**; release all keys to add one row (chord if multiple keys)
- **Export PNG** — **With note names** / **Barcode only**; **Long strip** or **A4 pages (print)**
- **Load demo: Happy Birthday**

**Wheel** scrolls the score; **Delete** removes the pointed/pinned row; hover shows **Live pitch** without clicking.

---

## Mirror / scan

| Control | Default | Notes |
|---------|---------|-------|
| Frame rate (mirror) | 22 Hz | **0** → drag to scan manually |
| Scan line width | 200 px | **0** → point laser (sample along path) |
| Laser width (moving avg.) | 2 | Moving average along scan line |
| Smooth Lerp | 0.5 | Scan direction smoothing |
| Mirror swing (forward + reverse audio) | on | Barcoder-style ping-pong waveform |
| Barcoder window | on | Edge fade on each segment |

**Pitch (footer formula):** `f ≈ frame rate × width / stripe period` (Processing Barcoder)

Score **Vertical stripes** use fractional periods for accurate pitch; **Barcode play** modes use integer-pixel stripes for crisp rendering.

---

## Quick reference

- **Scan & play:** hold mouse on stripes (red scan line when width > 0)
- **Line width:** wheel (in **Score editor**, wheel scrolls the score)
- **Scan direction:** Follow mouse (⊥ motion) / Lock horizontal / Lock vertical
- **Pin row:** **X** (again to unpin)
- **Delete row:** **Delete**
- **Long image strip:** wheel or ↑↓

---

## Credits

Inspired by **ELECTRONICOS FANTASTICOS!** Barcoder / barcode bass work. This page is an independent web recreation for learning; not affiliated with the official project.

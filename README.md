# export-from-Photos

Exports photos from the macOS **Photos** app to a structured folder on an
external drive, preserving the original file alongside a full XMP metadata
sidecar extracted from the rendered (processed) copy.

Written as a **JXA (JavaScript for Automation)** script, run via `osascript`.

---

## How it works

### Concept

The script drives the macOS Photos app over Apple Events (JXA) to export each
photo twice:

1. **Original** — the untouched RAW / HEIC / JPEG exactly as imported.
2. **Rendered** — the Photos-processed version (colour corrections, crops, etc.).

It then uses [ExifTool](https://exiftool.org) to extract every metadata tag
from the rendered copy into a `.xmp` sidecar file, discards the rendered copy,
and moves the original + sidecar into a final destination folder.

This gives you:
- Lossless originals (no re-encoding).
- Full metadata (capture date, GPS, ratings, edits recorded as XMP) without
  embedding anything into the image file itself.
- `FileModifyDate` on disk corrected to the original capture date.

---

### Album convention

The script only processes photos that are members of one specific album
(configured as `ALBUM_NAME = "SYS-NotExported"`).

Each photo must also have a keyword of the form `a:<folder>` to specify which
sub-folder inside the export root it should land in:

| Keyword | Destination |
|---|---|
| `a:Holidays` | `…/exported/Holidays/` |
| `a:Family/2025` | `…/exported/Family/2025/` |

Photos without an `a:` keyword are skipped (logged as a warning).

---

### Per-photo pipeline

```
Photos album "SYS-NotExported"
        │
        ▼ for each photo
┌─────────────────────────────────────────────────────┐
│ 1. doExport()                                       │
│    ├─ export original   → tmp_orig/                 │
│    └─ export rendered   → tmp_processed/            │
│                                                     │
│ 2. getProcessedFilename()                           │
│    └─ locate the rendered file (HEIC→JPEG aware)    │
│                                                     │
│ 3. takeXmp()                                        │
│    ├─ exiftool: extract all tags → origname.xmp     │
│    └─ delete the rendered copy                      │
│                                                     │
│ 4. finalize()                                       │
│    ├─ mkdir -p exported/<album>/                    │
│    ├─ move originals  → exported/<album>/<epoch>_*  │
│    ├─ move XMP sidecar→ exported/<album>/<epoch>_*.xmp│
│    └─ exiftool: set FileModifyDate from XMP date    │
│                                                     │
│ 5. setExported()                                    │
│    └─ add keyword "exportedT" in Photos             │
│                                                     │
│ 6. Verify temp folders are empty                    │
└─────────────────────────────────────────────────────┘
```

On **any error** in steps 1–6:

- The keyword `exportFailed` is added to the photo in Photos.
- Left-over files in both temp folders are moved into timestamped
  `error_tmp_orig_<epoch>/` and `error_tmp_processed_<epoch>/` directories
  inside the export root so they can be inspected later.
- The script continues with the next photo.
- If the archive step itself fails, the script halts immediately to prevent
  further data corruption.

---

### Output structure

```
/Volumes/S3 1TB/exported/
├── tmp_orig/               ← working area (must be empty before each run)
├── tmp_processed/          ← working area (must be empty before each run)
│
├── Holidays/
│   ├── 1745000000_IMG_1234.HEIC
│   ├── 1745000000_IMG_1234.HEIC.xmp
│   ├── 1745000001_IMG_5678.JPG
│   └── 1745000001_IMG_5678.JPG.xmp
│
├── Family/2025/
│   └── …
│
├── error_tmp_orig_<epoch>/       ← created only when a photo fails
└── error_tmp_processed_<epoch>/ ← created only when a photo fails
```

Files are prefixed with a Unix epoch timestamp so they sort chronologically by
export order and never collide across runs.

---

## Files

| File | Purpose |
|---|---|
| `export-script.js` | JXA automation script — all logic lives here |
| `run.sh` | Shell launcher with colour output, logging, and timeout |
| `logs/` | Auto-created by `run.sh`; one `.log` file per run |

---

## Photos setup

Before running the script, you need to configure the following inside the
macOS **Photos** app.

### 1. Smart album — `SYS-NotExported`

Create a **Smart Album** at the **root level** of your Photos library (not
inside any folder) with the following rule:

> **Keyword** — **does not include** — `exportedT`

This album automatically contains every photo that has not yet been exported.
The script reads from this album (configurable via `ALBUM_NAME`) to know what
to process next.

After a photo is exported successfully, the script adds the `exportedT` keyword
(configurable via `KEYWORD_EXPORTED`) to it, which removes it from this smart
album automatically. If you change `KEYWORD_EXPORTED` in `.env`, update the
smart album rule to use the new keyword.

### 2. Destination keyword — `a:<folder>`

Each photo you want to export **must have a keyword** that specifies which
sub-folder it should be placed in on the external drive. The keyword format is:

```
a:<folder-name>
```

Examples:

| Keyword on the photo | Exported to |
|---|---|
| `a:Holidays` | `…/exported/Holidays/` |
| `a:Family` | `…/exported/Family/` |
| `a:Family/2025` | `…/exported/Family/2025/` |

Photos without an `a:` keyword are **skipped** (logged as a warning) and left
in the `SYS-NotExported` album for the next run.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS | JXA (`osascript`) is macOS-only |
| ExifTool | `brew install exiftool` — expected at `/opt/homebrew/bin/exiftool` |
| Photos library | Must be the active library in the Photos app |
| External volume | `S3 1TB` must be mounted at `/Volumes/S3 1TB` |
| `tmp_orig` / `tmp_processed` | Must exist and be **empty** before each run |

---

## Configuration

Copy `.env.template` to `.env` and edit it to match your setup:

```bash
cp .env.template .env
```

| Variable | Default | Description |
|---|---|---|
| `DIR_TMP_ORIG` | `/Volumes/S3 1TB/exported/tmp_orig` | Temp folder for original exports |
| `DIR_TMP_PROCESSED` | `/Volumes/S3 1TB/exported/tmp_processed` | Temp folder for rendered exports |
| `DIR_EXPORT` | `/Volumes/S3 1TB/exported` | Final export root |
| `ALBUM_NAME` | `SYS-NotExported` | Smart album to read photos from |
| `EXIFTOOL` | `/opt/homebrew/bin/exiftool` | Path to ExifTool binary |
| `KEYWORD_EXPORTED` | `exportedT` | Keyword added to a photo after successful export |
| `KEYWORD_FAILED` | `exportFailed` | Keyword added to a photo when export fails |
| `TIMEOUT_SECS` | `21600` | Wall-clock timeout in seconds (`0` = no limit); overridden by `--timeout N` |

> **Note:** if you change `KEYWORD_EXPORTED`, update the Smart Album rule in Photos to match.

---

## Running

```bash
# Normal run (timeout from TIMEOUT_SECS in .env, default 6 hours; log saved to logs/)
./run.sh

# No log file written
./run.sh --no-log

# Override timeout for this run only (0 = no limit)
./run.sh --timeout 3600

# Run without going through run.sh (raw osascript output, no timeout)
osascript -l JavaScript export-script.js
```

---

## Output / logging

`run.sh` colourises the output from the JXA script in real time:

| Colour | Marker | Meaning |
|---|---|---|
| Cyan | `i` | Informational — start, album, progress |
| Green | `v` | Success — photo exported OK |
| Yellow | `!` | Warning — photo skipped or archiving temp folders |
| Red | `x` | Error — photo failed, or abort condition |
| Gray | *(plain)* | Item header / separator lines |

Each line is prefixed with an ISO-8601 timestamp (`YYYY-MM-DD HH:MM:SS`).

Example terminal output:

```
[2026-04-21 10:00:00]  ───────────────────────────────────────────────────────
[2026-04-21 10:00:00]  i  Photos export starting
[2026-04-21 10:00:00]  i  Album  : SYS-NotExported
[2026-04-21 10:00:00]  i  Output : /Volumes/S3 1TB/exported
[2026-04-21 10:00:00]  ───────────────────────────────────────────────────────
[2026-04-21 10:00:00]  i  Found 42 item(s) in album "SYS-NotExported"
[2026-04-21 10:00:00]     [1/42] IMG_1234.HEIC
[2026-04-21 10:00:00]  i  [1/42] IMG_1234.HEIC  →  album: Holidays
[2026-04-21 10:00:00]  i  [1/42] IMG_1234.HEIC  →  exporting from Photos…
[2026-04-21 10:00:05]  i  [1/42] IMG_1234.HEIC  →  extracting XMP from IMG_1234.JPG…
[2026-04-21 10:00:06]  i  [1/42] IMG_1234.HEIC  →  moving to export directory…
[2026-04-21 10:00:06]  v  [1/42] IMG_1234.HEIC  →  done in 6.1s
[2026-04-21 10:00:06]  ───────────────────────────────────────────────────────
```

A plain-text copy (no escape codes) is saved to `logs/export_YYYYMMDD_HHMMSS.log`.

---

## Keywords used in Photos

| Keyword | Set by | Configurable via | Meaning |
|---|---|---|---|
| `a:<name>` | You | — | Destination sub-folder for this photo |
| `exportedT` | Script | `KEYWORD_EXPORTED` in `.env` | Photo was successfully exported |
| `exportFailed` | Script | `KEYWORD_FAILED` in `.env` | Export failed; see error archive for leftover files |

---

## Timeout behaviour

JXA has no equivalent of AppleScript's `with timeout` block. The `app.export()`
call sends an Apple Event to Photos and will block indefinitely if Photos
stalls or hangs.

`run.sh` mitigates this with a wall-clock timeout (default **6 hours**):

- macOS Ventura+ ships `timeout`; it is used automatically.
- If you have Homebrew coreutils installed, `gtimeout` is preferred.
- If neither is available, the script runs without a timeout and a warning is printed.

If the timeout fires, `run.sh` exits with code **124** and prints a prominent
message. The temp folders may contain partial files — inspect and clean them
before the next run.

---

## Error recovery

1. **Photo marked `exportFailed`** — find it in Photos via the `exportFailed`
   keyword smart album. Fix the underlying issue, remove the keyword, re-add
   the photo to `SYS-NotExported`, and run again.

2. **Error archive folders** — every failure creates
   `error_tmp_orig_<epoch>/` and `error_tmp_processed_<epoch>/` in the export
   root. Inspect these to understand what was partially exported before the
   failure.

3. **Temp folders not empty on startup** — the script refuses to run if either
   temp folder contains files. This prevents mixing files from a previous
   failed run with a new batch. Clean or archive those folders manually first.

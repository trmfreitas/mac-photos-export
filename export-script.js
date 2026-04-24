// --------------------------------------------------
// CONFIG  — values loaded from environment (.env via run.sh)
// --------------------------------------------------
ObjC.import("stdlib");

function env(name) {
  try { return $.getenv(name); } catch (_) { return ""; }
}

const DIR_TMP_ORIG      = env("DIR_TMP_ORIG")      || "/Volumes/S3 1TB/exported/tmp_orig";
const DIR_TMP_PROCESSED = env("DIR_TMP_PROCESSED") || "/Volumes/S3 1TB/exported/tmp_processed";
const DIR_EXPORT        = env("DIR_EXPORT")        || "/Volumes/S3 1TB/exported";
const ALBUM_NAME        = env("ALBUM_NAME")        || "SYS-NotExported";
const EXIFTOOL          = env("EXIFTOOL")          || "/opt/homebrew/bin/exiftool";
const KEYWORD_EXPORTED  = env("KEYWORD_EXPORTED")  || "exportedT";
const KEYWORD_FAILED    = env("KEYWORD_FAILED")    || "exportFailed";
const KEYWORD_SKIP      = env("KEYWORD_SKIP")      || "skipExport";
// When enabled ("true"), photos without an a: keyword are exported to year/month folders
const EXPORT_USING_DATE_AS_FOLDER_IF_KEYWORD_NOT_AVAILABLE =
  (env("EXPORT_USING_DATE_AS_FOLDER_IF_KEYWORD_NOT_AVAILABLE") || "false").toLowerCase() === "true";
// Comma-separated list of extensions that can only be exported as originals
// (no rendered file will be produced). E.g. ".ARW,.RAF"
const ORIGINALS_ONLY_EXTS = (env("ORIGINALS_ONLY_EXTS") || ".ARW")
  .split(",")
  .map(e => e.trim().toUpperCase());

// --------------------------------------------------
// BOOTSTRAP
// --------------------------------------------------
const app = Application("Photos");
const sys = Application.currentApplication();
sys.includeStandardAdditions = true;

// --------------------------------------------------
// LOGGINGs
// --------------------------------------------------
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg)  { console.log(`[${ts()}]     ${msg}`); }
function info(msg) { console.log(`[${ts()}]  i  ${msg}`); }
function ok(msg)   { console.log(`[${ts()}]  v  ${msg}`); }
function warn(msg) { console.log(`[${ts()}]  !  ${msg}`); }
function fail(msg) { console.log(`[${ts()}]  x  ${msg}`); }
function sep()     { console.log(`[${ts()}]  ${"─".repeat(55)}`); }

function formatEta(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

// --------------------------------------------------
// SHELL HELPER
// --------------------------------------------------

/**
 * Wraps a POSIX path in single quotes, escaping any internal single quotes.
 * Safe for paths that contain spaces or special characters.
 */
function q(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Executes a shell command via osascript's StandardAdditions.
 * Throws on non-zero exit (JXA surfaces this automatically as an Error).
 *
 * NOTE — AppleEvent timeouts: doExport() uses AppleScript with a 3600s
 * timeout block, so export operations won't hit the 2-minute JXA default.
 * Other AppleEvent calls (keywords, etc.) still use the system default.
 */
function shell(cmd) {
  return sys.doShellScript(cmd);
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function isFolderEmpty(dir) {
  shell(`rm -f ${q(dir)}/.DS_Store ${q(dir)}/._* 2>/dev/null || true`);
  const result = shell(
    `find ${q(dir)} -mindepth 1 ! -name '.DS_Store' ! -name '._*' -print -quit`
  );
  return result === "";
}

function cleanTempJunkFiles() {
  shell(`rm -f ${q(DIR_TMP_ORIG)}/.DS_Store ${q(DIR_TMP_ORIG)}/._* 2>/dev/null || true`);
  shell(`rm -f ${q(DIR_TMP_PROCESSED)}/.DS_Store ${q(DIR_TMP_PROCESSED)}/._* 2>/dev/null || true`);
}

/**
 * Returns keywords as a plain JS array of strings.
 * Photos/JXA may return an ObjC collection instead of a native JS array.
 */
function getKeywordsArray(photo) {
  let kws;
  try {
    kws = photo.keywords();
  } catch (_) {
    return [];
  }

  if (!kws) return [];
  if (Array.isArray(kws)) return kws.map(k => String(k));

  try {
    const unwrapped = ObjC.deepUnwrap(kws);
    if (Array.isArray(unwrapped)) return unwrapped.map(k => String(k));
  } catch (_) {
    // Fall through to manual conversion paths below.
  }

  if (typeof kws.count === "function" && typeof kws.objectAtIndex === "function") {
    const out = [];
    const n = Number(kws.count());
    for (let i = 0; i < n; i++) out.push(String(kws.objectAtIndex(i)));
    return out;
  }

  if (typeof kws.length === "number") {
    const out = [];
    for (let i = 0; i < kws.length; i++) out.push(String(kws[i]));
    return out;
  }

  return [];
}

/**
 * Adds the "exportedT" keyword to a photo if not already present.
 */
function setExported(photo) {
  const kws = getKeywordsArray(photo);
  if (!kws.includes(KEYWORD_EXPORTED)) {
    photo.keywords = kws.concat([KEYWORD_EXPORTED]);
  }
}

/**
 * Adds the "exportFailed" keyword to a photo if not already present.
 */
function markFailed(photo) {
  const kws = getKeywordsArray(photo);
  if (!kws.includes(KEYWORD_FAILED)) {
    photo.keywords = kws.concat([KEYWORD_FAILED]);
  }
}

/**
 * Returns the destination album name from an "a:<name>" keyword,
 * or an empty string if no such keyword exists.
 */
function getAlbumForPhoto(photo) {
  const kws = getKeywordsArray(photo);
  if (!kws || kws.length === 0) return "";
  for (const k of kws) {
    if (k.startsWith("a:")) return k.slice(2);
  }
  return "";
}

/**
 * Returns a "YYYY/MM" folder string derived from the photo's date property.
 * Falls back to unknown folder if photo has no date or an invalid date.
 */
function getDateFolder(photo) {
  let d;
  try { d = photo.date(); } catch (_) { d = null; }
  if (!(d instanceof Date) || isNaN(d.getTime())) d = null;
  if (d === null) return "unknown";

  const year  = d.getFullYear().toString();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${year}/${month}`;
}

/**
 * Returns true if the filename's extension is in ORIGINALS_ONLY_EXTS.
 */
function isOriginalsOnly(filename) {
  const dot = filename.lastIndexOf(".");
  const ext = dot !== -1 ? filename.slice(dot).toUpperCase() : "";
  return ORIGINALS_ONLY_EXTS.includes(ext);
}

/**
 * Finds the rendered output file inside DIR_TMP_PROCESSED.
 *   - HEIC originals → look for the converted .jpg/.jpeg
 *   - All others     → any non-.xmp file
 * Returns just the basename, or "" if nothing is found.
 */
function getProcessedFilename(origFilename) {
  const qDir = q(DIR_TMP_PROCESSED);
  let cmd;
  if (origFilename.toUpperCase().endsWith(".HEIC")) {
    cmd = `find ${qDir} -maxdepth 1 -type f ! -name '.DS_Store' ! -name '._*' \\( -iname '*.jpg' -o -iname '*.jpeg' \\) -print -quit`;
  } else {
    cmd = `find ${qDir} -maxdepth 1 -type f ! -name '.DS_Store' ! -name '._*' ! -iname '*.xmp' -print -quit`;
  }
  const resultPath = shell(cmd);
  return resultPath !== "" ? shell(`basename ${q(resultPath)}`) : "";
}

/**
 * Extracts all EXIF/XMP metadata from the rendered file into a .xmp sidecar,
 * then deletes the rendered file (the original copy in tmp_orig is kept).
 */
function takeXmp(origFilename, processedFilename) {
  const src    = q(`${DIR_TMP_PROCESSED}/${processedFilename}`);
  const outXmp = q(`${DIR_TMP_PROCESSED}/${origFilename}.xmp`);
  shell(`${EXIFTOOL} -o ${outXmp} -all:all -tagsfromfile ${src}`);
  shell(`rm -f ${src}`);
}

/**
 * Like finalize() but for originals-only files: no XMP sidecar is produced.
 * Moves the original file(s) to the export directory and restores
 * FileModifyDate directly from the file's own metadata.
 */
function finalizeOriginalsOnly(photo, albumName, filename) {
  const epoch  = shell("date +%s");
  const outDir = `${DIR_EXPORT}/${albumName}`;

  shell(`mkdir -p ${q(outDir)}`);

  // Move originals with timestamp prefix
  shell(
    `for f in ${q(DIR_TMP_ORIG)}/*; do ` +
    `[ -f "$f" ] && [ "$(basename \"$f\")" != ".DS_Store" ] && ` +
    `mv -- "$f" ${q(outDir)}/${epoch}_"$(basename \"$f\")"; ` +
    `done`
  );

  // Ensure tmp_processed is clean (may be empty, but be safe)
  shell(`find ${q(DIR_TMP_PROCESSED)} -maxdepth 1 -type f ! -name '.DS_Store' -delete 2>/dev/null || true`);

  // Restore FileModifyDate from the original file's own capture date
  const outOrig = q(`${outDir}/${epoch}_${filename}`);
  shell(`${EXIFTOOL} '-FileModifyDate<DateTimeOriginal' ${outOrig} 2>/dev/null || true`);
}

/**
 * Moves originals and the XMP sidecar from temp folders into the final export
 * directory, prefixing every file with the current Unix timestamp.
 * Then back-fills FileModifyDate from XMP:DateTimeOriginal.
 *
 * Uses find+exec instead of glob expansion so filenames with spaces are safe.
 */
function finalize(photo, albumName, filename) {
  const epoch   = shell("date +%s");
  const outDir  = `${DIR_EXPORT}/${albumName}`;
  const outXmp  = q(`${outDir}/${epoch}_${filename}.xmp`);
  const outOrig = q(`${outDir}/${epoch}_${filename}`);
  const srcXmp  = q(`${DIR_TMP_PROCESSED}/${filename}.xmp`);

  // Ensure destination album directory exists
  shell(`mkdir -p ${q(outDir)}`);

  // Rename-and-move each original: prepend epoch timestamp.
  // Use a for-loop rather than find+exec sh -c so that single-quoted paths
  // (from q()) are never nested inside another sh -c single-quote context,
  // which would break on any path containing spaces or special characters.
  shell(
    `for f in ${q(DIR_TMP_ORIG)}/*; do ` +
    `[ -f "$f" ] && [ "$(basename "$f")" != ".DS_Store" ] && ` +
    `mv -- "$f" ${q(outDir)}/${epoch}_"$(basename "$f")"; ` +
    `done`
  );

  // Move the XMP sidecar to final location with timestamp prefix
  shell(`mv ${srcXmp} ${outXmp}`);

  // Restore FileModifyDate from original capture date in XMP
  shell(`${EXIFTOOL} -TagsFromFile ${outXmp} '-FileModifyDate<XMP:DateTimeOriginal' ${outOrig}`);
}

/**
 * Exports one photo twice via AppleScript with a 1-hour timeout.
 * Passes the photo id from JXA; AppleScript looks it up and exports.
 *   1. Original file  → DIR_TMP_ORIG
 *   2. Rendered JPEG  → DIR_TMP_PROCESSED
 */
function doExport(photo) {
  const photoId = photo.id();
  const script = [
    'on run argv',
    '  set photoId to item 1 of argv',
    '  with timeout of 3600 seconds',
    '    tell application "Photos"',
    '      try',
    '        set p to first media item whose id is photoId',
    '        set step to "export originals"',
    `        export {p} to ("${DIR_TMP_ORIG}" as POSIX file) with using originals`,
    '        set step to "export rendered"',
    `        export {p} to ("${DIR_TMP_PROCESSED}" as POSIX file) without using originals`,
    '      on error errMsg',
    '        error "doExport [" & step & "]: " & errMsg',
    '      end try',
    '    end tell',
    '  end timeout',
    'end run',
  ].join('\n');
  shell(`osascript -l AppleScript -e ${q(script)} ${q(photoId)}`);
}

/**
 * Moves leftover files from the temp folders into timestamped error-archive
 * directories so the next run starts clean and failures are inspectable.
 * Uses find+exec to avoid embedding already-quoted strings inside sh -c.
 */
function archiveTempFolders() {
  const epoch   = shell("date +%s");
  const errOrig = `${DIR_EXPORT}/error_tmp_orig_${epoch}`;
  const errProc = `${DIR_EXPORT}/error_tmp_processed_${epoch}`;

  shell(`mkdir -p ${q(errOrig)} ${q(errProc)}`);

  shell(
    `find ${q(DIR_TMP_ORIG)} -maxdepth 1 -type f ! -name '.DS_Store' ` +
    `-exec mv -f {} ${q(errOrig)}/ \\; 2>/dev/null || true`
  );
  shell(
    `find ${q(DIR_TMP_PROCESSED)} -maxdepth 1 -type f ! -name '.DS_Store' ` +
    `-exec mv -f {} ${q(errProc)}/ \\; 2>/dev/null || true`
  );
}

/**
 * Resolves an album by path, supporting folder traversal.
 * A plain name like "SYS-NotExported" searches all albums.
 * A path like "Smart/SYS-NotExported" navigates the folder hierarchy first.
 */
function findAlbum(albumPath) {
  const parts      = albumPath.split("/");
  const albumName  = parts[parts.length - 1];
  const folderPath = parts.slice(0, -1);

  if (folderPath.length === 0) {
    const results = app.albums.whose({ name: albumName });
    return results.length > 0 ? results[0] : null;
  }

  let container = app;
  for (const folderName of folderPath) {
    const folders = container.folders.whose({ name: folderName });
    if (!folders || folders.length === 0) return null;
    container = folders[0];
  }

  const results = container.albums.whose({ name: albumName });
  return results.length > 0 ? results[0] : null;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

sep();
info(`Photos export starting`);
info(`Album  : ${ALBUM_NAME}`);
info(`Output : ${DIR_EXPORT}`);
sep();

// Guard: both temp folders must be empty before we begin
if (!isFolderEmpty(DIR_TMP_ORIG) || !isFolderEmpty(DIR_TMP_PROCESSED)) {
  fail("Temp folders are not empty — aborting to avoid mixing files.");
  fail(`  ${DIR_TMP_ORIG}`);
  fail(`  ${DIR_TMP_PROCESSED}`);
  fail("Clean them manually or inspect a previous error archive, then retry.");
} else {
  const theAlbum = findAlbum(ALBUM_NAME);
  if (!theAlbum) {
    fail(`Album not found: "${ALBUM_NAME}"`);
  } else {
    const mediaItems = theAlbum.mediaItems();
    const total = mediaItems.length;
    info(`Found ${total} item(s) in album "${ALBUM_NAME}"`);
    sep();

    let processed = 0;
    let skipped   = 0;
    let failed    = 0;
    let step      = "";

    // Helper to detect AppleEvent timeout errors
    function isAppleEventTimeout(e) {
      const msg = (e.message || String(e)).toLowerCase();
      return msg.includes("appleevent timed out") || msg.includes("timeout");
    }

    // Main loop with global retry per photo.
    // Iterates over a snapshot of media items taken at the start so that
    // album membership changes (setExported / markFailed causing items to
    // leave the smart album) cannot push the index out of bounds.
    const runStartMs = Date.now();
    for (let i = 0; i < total; i++) {
      const photo    = mediaItems[i];
      const filename = photo.filename();
      const prefix   = `[${i + 1 - skipped}/${total - skipped}] ${filename}`;
      const kws      = getKeywordsArray(photo);

      log(prefix);

      // Skip photos tagged with KEYWORD_SKIP
      if (kws.includes(KEYWORD_SKIP)) {
        warn(`${prefix}  →  has "${KEYWORD_SKIP}" tag, skipping`);
        skipped++;
        sep();
        continue;
      }

      // Skip photos already exported in previous runs
      if (kws.includes(KEYWORD_EXPORTED)) {
        info(`${prefix}  →  already marked "${KEYWORD_EXPORTED}", skipping`);
        skipped++;
        sep();
        continue;
      }

      let retryAttempt = 0;
      let success = false;

      while (retryAttempt < 3 && !success) {
        try {
          const startMs   = Date.now();
          let albumName = getAlbumForPhoto(photo);

          if (albumName === "") {
            if (EXPORT_USING_DATE_AS_FOLDER_IF_KEYWORD_NOT_AVAILABLE) {
              albumName = getDateFolder(photo);
            } else {
              warn(`${prefix}  →  no album keyword (a:...), skipping`);
              skipped++;
              success = true; // Exit retry loop, move to next photo
              break;
            }
          } else if (retryAttempt === 0) {
            info(`${prefix}  →  album: ${albumName}`);
          }

          step = "export originals + rendered";
          if (retryAttempt === 0) {
            info(`${prefix}  →  exporting from Photos…`);
          } else {
            warn(`${prefix}  →  retry ${retryAttempt}/3 — exporting from Photos…`);
          }
          doExport(photo);

          // Finder/network volumes can drop .DS_Store / AppleDouble files in
          // temp directories; remove them before locating rendered output.
          cleanTempJunkFiles();

          step = "detect processed file";
          const processedFilename = getProcessedFilename(filename);

          // Check whether the rendered file is non-empty (Photos sometimes
          // produces a zero-byte file for formats it cannot transcode, e.g. .mpg).
          const renderedIsEmpty = processedFilename !== "" &&
            shell(`stat -f%z ${q(DIR_TMP_PROCESSED + "/" + processedFilename)}`).trim() === "0";

          if (renderedIsEmpty) {
            info(`${prefix}  →  rendered file is empty (untranscodable format), falling back to original…`);
            shell(`rm -f ${q(DIR_TMP_PROCESSED + "/" + processedFilename)}`);
          }

          if (processedFilename === "" || renderedIsEmpty) {
            if (processedFilename === "" && !isOriginalsOnly(filename)) {
              throw new Error("No rendered file found in tmp_processed after export");
            }
            step = "move original to export directory";
            info(`${prefix}  →  originals-only file (${filename.split(".").pop().toUpperCase()}), keeping original…`);
            finalizeOriginalsOnly(photo, albumName, filename);
          } else {
            step = "extract XMP sidecar";
            info(`${prefix}  →  extracting XMP from ${processedFilename}…`);
            takeXmp(filename, processedFilename);

            step = "move to export directory";
            info(`${prefix}  →  moving to export directory…`);
            finalize(photo, albumName, filename);
          }

          step = "mark exported";
          setExported(photo);

          step = "verify temp folders empty";
          if (!isFolderEmpty(DIR_TMP_ORIG) || !isFolderEmpty(DIR_TMP_PROCESSED)) {
            throw new Error("Temp folders still contain files after finalize — possible leftover");
          }

          const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
          const spentAllSec = (Date.now() - runStartMs) / 1000;
          const photosSeen = i + 1 - skipped;
          const photosLeft = total - photosSeen - skipped;
          const avgPerPhoto = spentAllSec / photosSeen;
          const etaSec = avgPerPhoto * photosLeft;
          ok(`${prefix}  →  done in ${elapsed}s  |  ETA ${formatEta(etaSec)}`);
          processed++;
          success = true; // Exit retry loop

        } catch (e) {
          const errorMsg = e.message || String(e);
          const isTimeout = isAppleEventTimeout(e);

          if (isTimeout && retryAttempt < 2) {
            fail(`${prefix}  →  FAILED at [${step}]: ${errorMsg}`);
            warn(`${prefix}  →  AppleEvent timeout — cleaning temp folders and retrying (${retryAttempt + 1}/3)…`);
            
            try {
              // Clean temp folders for next attempt
              shell(`find ${q(DIR_TMP_ORIG)} -maxdepth 1 -type f ! -name '.DS_Store' -delete 2>/dev/null || true`);
              shell(`find ${q(DIR_TMP_PROCESSED)} -maxdepth 1 -type f ! -name '.DS_Store' -delete 2>/dev/null || true`);
              shell("sleep 3"); // Wait before retry
            } catch (cleanErr) {
              fail(`${prefix}  →  error cleaning temp folders: ${cleanErr.message}`);
              fail("Halting to prevent further data corruption.");
              success = true; // Force exit retry loop
              break;
            }

            retryAttempt++;
          } else {
            // Either not a timeout, or exhausted retries
            if (isTimeout && retryAttempt >= 2) {
              fail(`${prefix}  →  FAILED at [${step}]: ${errorMsg} (after 3 attempts)`);
            } else {
              fail(`${prefix}  →  FAILED at [${step}]: ${errorMsg}`);
            }

            try {
              markFailed(photo);
              warn(`${prefix}  →  archiving temp folders for inspection…`);
              archiveTempFolders();
            } catch (archiveErr) {
              fail(`Could not archive temp folders: ${archiveErr.message}`);
              fail("Halting to prevent further data corruption.");
              break;
            }

            failed++;
            success = true; // Exit retry loop, move to next photo
          }
        }
      }

      sep();
    }

    // Summary
    sep();
    info(`Export finished.`);
    info(`  Processed : ${processed}`);
    info(`  Skipped   : ${skipped}`);
    info(`  Failed    : ${failed}`);
    sep();
  }
}

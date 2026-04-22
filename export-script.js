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
 * NOTE — JXA timeouts: Unlike AppleScript there is no `with timeout` block
 * in JXA. app.export() sends an Apple Event to Photos and can block the
 * interpreter indefinitely if Photos stalls. The shell launcher (run.sh)
 * wraps this script with a wall-clock `timeout` as the only safety net.
 */
function shell(cmd) {
  return sys.doShellScript(cmd);
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function isFolderEmpty(dir) {
  shell(`rm -f ${q(dir)}/.DS_Store`);
  const result = shell(
    `find ${q(dir)} -mindepth 1 ! -name '.DS_Store' -print -quit`
  );
  return result === "";
}

/**
 * Adds the "exportedT" keyword to a photo if not already present.
 */
function setExported(photo) {
  const kws = photo.keywords();
  if (!kws.includes(KEYWORD_EXPORTED)) {
    photo.keywords = kws.concat([KEYWORD_EXPORTED]);
  }
}

/**
 * Adds the "exportFailed" keyword to a photo if not already present.
 */
function markFailed(photo) {
  const kws = photo.keywords();
  if (!kws.includes(KEYWORD_FAILED)) {
    photo.keywords = kws.concat([KEYWORD_FAILED]);
  }
}

/**
 * Returns the destination album name from an "a:<name>" keyword,
 * or an empty string if no such keyword exists.
 */
function getAlbumForPhoto(photo) {
  const kws = photo.keywords();
  if (!kws || kws.length === 0) return "";
  for (const k of kws) {
    if (k.startsWith("a:")) return k.slice(2);
  }
  return "";
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
    cmd = `find ${qDir} -maxdepth 1 -type f \\( -iname '*.jpg' -o -iname '*.jpeg' \\) -print -quit`;
  } else {
    cmd = `find ${qDir} -maxdepth 1 -type f ! -iname '*.xmp' -print -quit`;
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
 * Exports one photo twice via the Photos app:
 *   1. Original file  → DIR_TMP_ORIG
 *   2. Rendered JPEG  → DIR_TMP_PROCESSED
 *
 * See the JXA timeout note on shell() above.
 */
function doExport(photo) {
  app.export([photo], { to: Path(DIR_TMP_ORIG),      usingOriginals: true  });
  app.export([photo], { to: Path(DIR_TMP_PROCESSED), usingOriginals: false });
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
  const albums = app.albums.whose({ name: ALBUM_NAME });
  if (!albums || albums.length === 0) {
    fail(`Album not found: "${ALBUM_NAME}"`);
  } else {
    const theAlbum = albums[0];
    const photos   = theAlbum.mediaItems();
    const total    = photos.length;
    info(`Found ${total} item(s) in album "${ALBUM_NAME}"`);
    sep();

    let processed = 0;
    let skipped   = 0;
    let failed    = 0;
    let step      = "";

    for (let i = 0; i < total; i++) {
      const photo    = photos[i];
      const filename = photo.filename();
      const prefix   = `[${i + 1}/${total}] ${filename}`;

      log(prefix);

      try {
        const startMs   = Date.now();
        const albumName = getAlbumForPhoto(photo);

        if (albumName === "") {
          warn(`${prefix}  →  no album keyword (a:...), skipping`);
          skipped++;
          sep();
          continue;
        }

        info(`${prefix}  →  album: ${albumName}`);

        step = "export originals + rendered";
        info(`${prefix}  →  exporting from Photos…`);
        doExport(photo);

        step = "detect processed file";
        const processedFilename = getProcessedFilename(filename);
        if (processedFilename === "") {
          throw new Error("No rendered file found in tmp_processed after export");
        }

        step = "extract XMP sidecar";
        info(`${prefix}  →  extracting XMP from ${processedFilename}…`);
        takeXmp(filename, processedFilename);

        step = "move to export directory";
        info(`${prefix}  →  moving to export directory…`);
        finalize(photo, albumName, filename);

        step = "mark exported";
        setExported(photo);

        step = "verify temp folders empty";
        if (!isFolderEmpty(DIR_TMP_ORIG) || !isFolderEmpty(DIR_TMP_PROCESSED)) {
          throw new Error("Temp folders still contain files after finalize — possible leftover");
        }

        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        ok(`${prefix}  →  done in ${elapsed}s`);
        processed++;

      } catch (e) {
        fail(`${prefix}  →  FAILED at [${step}]: ${e.message}`);
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

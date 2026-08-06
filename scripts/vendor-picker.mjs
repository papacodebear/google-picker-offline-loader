#!/usr/bin/env node
// Vendors Google's Picker widget JS locally instead of loading it live from
// apis.google.com at runtime — see this package's README for the full
// motivation. Manually invoked (`npm run vendor:picker`), not run
// automatically on every build or install — re-run before each release,
// with the result committed so a `git diff` shows exactly when and what
// changed, rather than every consumer's build silently pulling whatever
// Google is currently serving.
//
// Mechanism: gapi.load('picker', callback) isn't just an entry point that
// then runs code already present in api.js — it's a lazy module loader.
// Calling it makes api.js dynamically inject a *second* <script> tag,
// fetching the actual Picker module code from a versioned, Google-internal
// URL, separate from and after the initial api.js load. So "vendor the
// Picker" means capturing both requests, not just the first one.
//
// Uses jsdom (pure JS, no browser binary) rather than a real browser
// (Playwright/Puppeteer) — a headless-browser engine was the first thing
// tried, but jsdom turns out to be entirely sufficient: it can execute
// api.js's DOM-script-injection code (document.createElement('script') +
// .src + appendChild) and intercept the resulting requests via its
// requestInterceptor API, without needing to actually render anything. Note
// this is a *different* mechanism from src/index.ts's own runtime
// interceptor (which patches document.createElement/setAttribute directly,
// validated only against a real browser) — this script only needs to prove
// the captured bytes are sufficient, not exercise that specific technique.
//
// Every run validates the fresh capture by replaying it with network access
// fully cut off (a second jsdom instance, interceptor returns a canned
// "blocked" response for anything not in the freshly-captured set) — if
// gapi.load('picker', ...) and a full PickerBuilder chain don't succeed from
// the vendored files alone, this script exits non-zero and leaves the
// previously-committed vendor/ files untouched, rather than ever committing
// a capture that doesn't actually work.

import jsdomPkg from 'jsdom';
const { JSDOM, requestInterceptor } = jsdomPkg;
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');

const API_JS_URL = 'https://apis.google.com/js/api.js';

// The harness page: loads api.js, calls gapi.load('picker', ...), and (once
// that succeeds) exercises a full PickerBuilder chain with dummy
// credentials — enough to prove the module system and API surface both work
// without needing real OAuth/Picker-key values, which setVisible(true)
// would need but this harness deliberately never calls.
function harnessHtml() {
    return `<!doctype html>
<html><head></head><body>
<script src="${API_JS_URL}"></script>
<script>
  window.pickerLoadResult = 'pending';
  window.onGapiLoaded = function () {
    gapi.load('picker', {
      callback: function () {
        window.pickerLoadResult = 'success';
        window.pickerApiAvailable = typeof window.google !== 'undefined' && typeof window.google.picker !== 'undefined';
        try {
          var view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
          var b = new google.picker.PickerBuilder().addView(view).setOAuthToken('dummy').setDeveloperKey('dummy').setCallback(function () {}).build();
          window.builderConstructed = !!b && typeof b.setVisible === 'function';
        } catch (e) {
          window.builderConstructed = false;
          window.builderError = String((e && e.stack) || e);
        }
      },
      onerror: function (e) {
        window.pickerLoadResult = 'error: ' + JSON.stringify(e);
      }
    });
  };
  window.addEventListener('load', function () {
    if (window.gapi) { window.onGapiLoaded(); }
    else {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (window.gapi) { clearInterval(iv); window.onGapiLoaded(); }
        else if (tries > 150) { clearInterval(iv); window.pickerLoadResult = 'error: gapi never appeared'; }
      }, 100);
    }
  });
</script>
</body></html>`;
}

async function runHarness({ interceptor }) {
    const dom = new JSDOM(harnessHtml(), {
        url: 'https://example-extension.invalid/',
        runScripts: 'dangerously',
        resources: { interceptors: [requestInterceptor(interceptor)] },
        pretendToBeVisual: true
    });
    const errors = [];
    dom.window.addEventListener('error', (e) => {
        errors.push(e.message + (e.error?.stack ? `\n${e.error.stack}` : ''));
    });
    const start = Date.now();
    while (dom.window.pickerLoadResult === undefined || dom.window.pickerLoadResult === 'pending') {
        if (Date.now() - start > 25000) {
            errors.push('timed out waiting for pickerLoadResult');
            break;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    const result = {
        result: dom.window.pickerLoadResult,
        pickerApiAvailable: dom.window.pickerApiAvailable,
        builderConstructed: dom.window.builderConstructed,
        builderError: dom.window.builderError,
        windowErrors: errors
    };
    dom.window.close();
    return result;
}

async function capture() {
    const captured = []; // { url, buffer, contentType }
    const result = await runHarness({
        interceptor: async (request) => {
            const response = await fetch(request.url, { method: request.method, headers: request.headers });
            const buffer = Buffer.from(await response.arrayBuffer());
            captured.push({ url: request.url, buffer, contentType: response.headers.get('content-type') ?? 'application/javascript' });
            return new Response(buffer, { status: response.status, headers: response.headers });
        }
    });
    return { result, captured };
}

async function validate(captured) {
    const byUrl = new Map(captured.map((c) => [c.url, c]));
    const uncapturedRequests = [];
    const result = await runHarness({
        interceptor: async (request) => {
            const entry = byUrl.get(request.url);
            if (entry) {
                return new Response(entry.buffer, { status: 200, headers: { 'content-type': entry.contentType } });
            }
            uncapturedRequests.push(request.url);
            // Actively fail anything not captured, rather than letting it
            // through to the real network — a pass here must mean "the
            // captured set alone is sufficient," not "the network happened
            // to still be available."
            return new Response('', { status: 599 });
        }
    });
    return { result, uncapturedRequests };
}

function isSuccessful(result) {
    return (
        result.result === 'success' &&
        result.pickerApiAvailable === true &&
        result.builderConstructed === true &&
        result.windowErrors.length === 0
    );
}

console.log('Capturing live traffic from a real gapi.load("picker", ...) run...\n');
const { result: liveResult, captured } = await capture();
console.log('Live capture result:', JSON.stringify(liveResult, null, 2));
console.log(`Captured ${captured.length} file(s): ${captured.map((c) => c.url).join(', ')}\n`);

if (!isSuccessful(liveResult)) {
    console.error("Live capture did not succeed — aborting without touching vendor/. Google's Picker API may have changed.");
    process.exit(1);
}

console.log('Validating the capture replays correctly with zero network access...\n');
const { result: replayResult, uncapturedRequests } = await validate(captured);
console.log('Replay result:', JSON.stringify(replayResult, null, 2));

if (uncapturedRequests.length > 0) {
    console.error(`\nReplay needed ${uncapturedRequests.length} request(s) not in the captured set — aborting without touching vendor/:`);
    for (const url of uncapturedRequests) console.error(`  ${url}`);
    process.exit(1);
}
if (!isSuccessful(replayResult)) {
    console.error('\nReplay from the captured files did not succeed — aborting without touching vendor/.');
    process.exit(1);
}

console.log('\nValidation passed. Writing vendor/...');
await mkdir(VENDOR_DIR, { recursive: true });

const apiJs = captured.find((c) => c.url === API_JS_URL);
const pickerModule = captured.find((c) => c.url !== API_JS_URL);
if (!apiJs || !pickerModule) {
    console.error('Expected exactly one api.js response and one dynamically-loaded module response — got something else, aborting.');
    process.exit(1);
}

await writeFile(path.join(VENDOR_DIR, 'api.js'), apiJs.buffer);
await writeFile(path.join(VENDOR_DIR, 'picker-module.js'), pickerModule.buffer);

const manifest = {
    capturedAt: new Date().toISOString(),
    files: [
        { name: 'api.js', sourceUrl: apiJs.url, sha256: crypto.createHash('sha256').update(apiJs.buffer).digest('hex'), size: apiJs.buffer.length },
        {
            name: 'picker-module.js',
            sourceUrl: pickerModule.url,
            sha256: crypto.createHash('sha256').update(pickerModule.buffer).digest('hex'),
            size: pickerModule.buffer.length
        }
    ]
};
await writeFile(path.join(VENDOR_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Wrote ${manifest.files.map((f) => f.name).join(', ')} to ${path.relative(process.cwd(), VENDOR_DIR)}/`);
console.log("Review the diff (especially manifest.json's sha256/size) before committing.");

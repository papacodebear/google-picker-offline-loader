// Loads Google's Picker widget from locally vendored files instead of live
// from apis.google.com. Google's Picker has no installable/vendorable npm
// package of its own — even API-surface wrappers still fetch
// apis.google.com/js/api.js (and the module gapi.load('picker', ...)
// dynamically fetches on top of that) live at runtime. That's a hard block
// for any environment that forbids remote script loading outright, such as
// a Firefox add-on submitted to AMO (Mozilla's Add-on Policies flag this as
// REMOTE_SCRIPT, a categorical prohibition, not a CSP-syntax difference to
// work around) — and the whole reason this package exists.
//
// See scripts/vendor-picker.mjs for how vendor/api.js and the dynamically-
// loaded module files (vendor/picker-module.js, vendor/gapi-iframes-
// module.js) are captured and validated; see this file's own
// installUrlInterceptor for how each dynamically-fetched module gets
// redirected to its vendored copy instead of the live one.

export const VENDORED_API_JS_FILE = 'api.js';
export const VENDORED_PICKER_MODULE_FILE = 'picker-module.js';
// gapi.load('picker', ...) doesn't just load the "picker" module — calling
// setVisible(true) to actually render the dialog lazily pulls in a further
// "gapi_iframes" submodule too (found only by exercising that call live;
// scripts/vendor-picker.mjs didn't originally go that far). See
// DYNAMIC_MODULES_BY_NAME below for how each m=<name> URL segment maps to
// its vendored file.
export const VENDORED_GAPI_IFRAMES_MODULE_FILE = 'gapi-iframes-module.js';

export type VendoredAssetFile =
    | typeof VENDORED_API_JS_FILE
    | typeof VENDORED_PICKER_MODULE_FILE
    | typeof VENDORED_GAPI_IFRAMES_MODULE_FILE;

export interface LoadGooglePickerOptions {
    /**
     * Resolves one of this package's vendored asset files (shipped under
     * this package's own `vendor/` directory — see the README for how to
     * copy them into your own build output) to a URL your document can
     * actually load. In a browser extension this is typically
     * `chrome.runtime.getURL(...)` / `browser.runtime.getURL(...)` against
     * wherever you copied `vendor/api.js` and `vendor/picker-module.js`; in
     * a plain web app it might just be a same-origin path under `/public`.
     */
    resolveAssetUrl: (file: VendoredAssetFile) => string;
    /** Defaults to `window.document`. Override only for non-standard hosts (e.g. a custom iframe). */
    document?: Document;
}

// m=<name> path segment (from a dynamically-constructed gapi module URL) ->
// which vendored file serves it. gapi.load('picker', ...) doesn't just load
// "picker" — actually rendering the dialog (setVisible(true)) lazily pulls
// in "gapi_iframes" too, found only by exercising that call for real.
// Extend this (and re-run scripts/vendor-picker.mjs) if Picker ever needs a
// further submodule beyond these two — nothing documents the full set
// anywhere, this is only what's been observed live.
const DYNAMIC_MODULES_BY_NAME: Record<string, VendoredAssetFile> = {
    picker: VENDORED_PICKER_MODULE_FILE,
    gapi_iframes: VENDORED_GAPI_IFRAMES_MODULE_FILE
};

let interceptorInstalled = false;
const bakedInCallbackPromises = new Map<VendoredAssetFile, Promise<string>>();

/**
 * Each vendored dynamic module is a frozen capture whose entire content is
 * a single JSONP-style call — `<name>(function(_){...})` — where `<name>`
 * is whatever api.js's internal load counter happened to assign that
 * specific module at capture time (e.g. picker-module.js starts with
 * literal text `gapi.loaded_0(`, gapi-iframes-module.js starts with
 * `gapi.loaded_1(` in the capture this shipped with — not the same name,
 * and not necessarily what a future re-vendor produces, since a module
 * loaded later in a session gets a higher number). Discovered here from
 * each file's own actual content rather than hardcoded, so this stays
 * correct across re-vendoring without needing to keep a second, easy-to-
 * forget constant in sync with whatever scripts/vendor-picker.mjs captures.
 */
function loadBakedInCallbackName(file: VendoredAssetFile, resolveAssetUrl: LoadGooglePickerOptions['resolveAssetUrl']): Promise<string> {
    let promise = bakedInCallbackPromises.get(file);
    if (!promise) {
        promise = fetch(resolveAssetUrl(file)).then(async (response) => {
            if (!response.ok) {
                throw new Error(`failed to fetch vendored module ${file} to determine its callback name: ${response.status}`);
            }
            const match = (await response.text()).match(/^(gapi\.[a-zA-Z0-9_]+)\(/);
            if (!match) {
                throw new Error(`vendored module ${file} doesn't start with the expected gapi.loaded_N( JSONP wrapper`);
            }
            return match[1];
        });
        bakedInCallbackPromises.set(file, promise);
    }
    return promise;
}

/**
 * gapi.load('picker', ...) dynamically constructs module URLs containing a
 * `cb=gapi.loaded_N` path segment (e.g. `.../cb=gapi.loaded_1?le=...` — a
 * path segment, not a query parameter, easy to get wrong once: an earlier
 * version of this fix used `URL().searchParams`, which silently found
 * nothing there at all) — a JSONP-style callback name that api.js itself
 * defines on `window.gapi` immediately before injecting the script, and
 * deletes once called. N is api.js's own internal load counter, not a
 * fixed value: confirmed live that a real embedding page can request a
 * callback name other than `loaded_0` even on its very first Picker
 * module load, unlike this package's own capture/validation harness
 * (scripts/vendor-picker.mjs), which starts counting fresh each run.
 *
 * Serving a vendored module unmodified only works when the requested name
 * happens to match the one baked into that specific file; otherwise api.js
 * has defined a *different* global and never defined the vendored file's
 * own hardcoded name at all, so calling it throws e.g. `TypeError:
 * gapi.loaded_0 is not a function` — a real bug this package shipped with
 * initially, not a hypothetical.
 *
 * Fixed not by rewriting the file's bytes (tried first — requires serving
 * the patched content via a blob: URL, which this extension's own CSP
 * blocks: `script-src 'self'` doesn't permit blob: sources, and adding it
 * would be exactly the kind of CSP loosening vendoring this package in the
 * first place was meant to avoid), but by leaving the *file* untouched and
 * aliasing the name instead: `gapi[<this file's own baked-in name>] =
 * gapi[<whatever api.js actually asked for this time>]`, set before the
 * unmodified, same-origin file loads normally. When that file runs and
 * calls its own hardcoded callback, it transparently invokes whichever
 * real callback api.js set up — the file's bytes, and the request that
 * fetches them, never change at all.
 */
function installUrlInterceptor(doc: Document, resolveAssetUrl: LoadGooglePickerOptions['resolveAssetUrl']): void {
    if (interceptorInstalled) {
        return;
    }
    interceptorInstalled = true;

    const nativeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const nativeSetAttribute = Element.prototype.setAttribute;
    if (!nativeSrcDescriptor?.get || !nativeSrcDescriptor.set) {
        throw new Error('cannot install Picker URL interceptor: HTMLScriptElement.src is not accessible here');
    }

    // Async by necessity (aliasing needs each vendored file's own baked-in
    // name, discovered via loadBakedInCallbackName's fetch) — safe as a
    // fire-and-forget side effect of the src/setAttribute setters below
    // rather than something they await directly: a <script> element
    // doesn't actually start loading until the browser gets around to it
    // (and not at all until it's inserted into the document), so assigning
    // the *real* native src a microtask later than usual doesn't lose
    // anything api.js was relying on synchronously. No CSP concern here
    // unlike the earlier blob: attempt — the value assigned is always a
    // real chrome.runtime.getURL()/browser.runtime.getURL()-style same-
    // origin URL, api.js's own static load included.
    const remapAsync = async (rawValue: string): Promise<string> => {
        // Coerced here (not just at the setAttribute call site) so both
        // interception paths funnel through one guaranteed-string value —
        // see this function's doc comment, finding #2 below.
        const value = String(rawValue);
        const moduleName = value.match(/\/m=([^/]+)/)?.[1];
        const vendoredFile = moduleName ? DYNAMIC_MODULES_BY_NAME[moduleName] : undefined;
        if (!vendoredFile) {
            return value;
        }
        const expectedCallback = value.match(/\/cb=(gapi\.[^/?]+)/)?.[1];
        if (expectedCallback) {
            const bakedInName = await loadBakedInCallbackName(vendoredFile, resolveAssetUrl);
            const gapi = (globalThis as unknown as { gapi?: Record<string, unknown> }).gapi;
            const realPropertyName = expectedCallback.slice('gapi.'.length);
            const bakedInPropertyName = bakedInName.slice('gapi.'.length);
            // api.js itself must already have defined the real callback by
            // the time it constructs and assigns this URL (standard JSONP
            // ordering: register the callback, then inject the script that
            // will call it), so this alias is safe to set here.
            if (gapi && realPropertyName in gapi) {
                gapi[bakedInPropertyName] = gapi[realPropertyName];
            }
        }
        return resolveAssetUrl(vendoredFile);
    };

    const applyRemap = (element: HTMLScriptElement, value: string): void => {
        void remapAsync(value).then((resolved) => {
            nativeSrcDescriptor.set!.call(element, resolved);
        });
    };

    const originalCreateElement = doc.createElement.bind(doc);
    doc.createElement = ((tagName: string, options?: ElementCreationOptions): HTMLElement => {
        const element = originalCreateElement(tagName, options);
        if (tagName.toLowerCase() !== 'script') {
            return element;
        }
        Object.defineProperty(element, 'src', {
            configurable: true,
            get(): string {
                return nativeSrcDescriptor.get!.call(element);
            },
            set(value: string): void {
                applyRemap(element as HTMLScriptElement, value);
            }
        });
        element.setAttribute = function (this: Element, name: string, value: string): void {
            if (name.toLowerCase() === 'src') {
                applyRemap(this as HTMLScriptElement, value);
                return;
            }
            nativeSetAttribute.call(this, name, value);
        };
        return element;
    }) as typeof doc.createElement;
}

const apiJsPromises = new WeakMap<Document, Promise<void>>();

function loadApiJs(doc: Document, resolveAssetUrl: LoadGooglePickerOptions['resolveAssetUrl']): Promise<void> {
    let promise = apiJsPromises.get(doc);
    if (!promise) {
        promise = new Promise((resolve, reject) => {
            installUrlInterceptor(doc, resolveAssetUrl);
            const script = doc.createElement('script');
            script.src = resolveAssetUrl(VENDORED_API_JS_FILE);
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('failed to load the vendored Google API script (api.js)'));
            doc.head.appendChild(script);
        });
        apiJsPromises.set(doc, promise);
    }
    return promise;
}

function loadPickerModule(win: GapiWindow): Promise<void> {
    return new Promise((resolve, reject) => {
        win.gapi.load('picker', {
            callback: () => resolve(),
            onerror: (e: unknown) => reject(new Error(`failed to load the Google Picker module: ${JSON.stringify(e)}`))
        });
    });
}

/**
 * Loads Google's Picker widget entirely from your own vendored copies of its
 * JS (see `resolveAssetUrl`), never contacting apis.google.com at runtime,
 * and resolves with the `google.picker` namespace once it's ready to use —
 * build your own `PickerBuilder` chain from there (view type, OAuth token,
 * developer key, callback — all application-specific, so this package
 * doesn't guess at them).
 *
 * Safe to call more than once (including concurrently); the underlying
 * scripts are only ever loaded once per document.
 */
export async function loadGooglePicker(options: LoadGooglePickerOptions): Promise<PickerNamespace> {
    const doc = options.document ?? document;
    await loadApiJs(doc, options.resolveAssetUrl);
    const win = window as unknown as GapiWindow;
    await loadPickerModule(win);
    return (window as unknown as { google: { picker: PickerNamespace } }).google.picker;
}

// Minimal ambient shape for exactly what this package touches — the Picker
// API has no official first-party TypeScript types, and this is
// intentionally not a full re-declaration of it.
export interface GapiNamespace {
    load(api: string, config: { callback: () => void; onerror: (e: unknown) => void }): void;
}

interface GapiWindow {
    gapi: GapiNamespace;
}

export interface PickerDocsView {
    setIncludeFolders(include: boolean): PickerDocsView;
    setSelectFolderEnabled(enabled: boolean): PickerDocsView;
}

export interface PickerCallbackData {
    action: string;
    docs?: { id: string; name: string }[];
}

export interface PickerInstance {
    setVisible(visible: boolean): void;
}

export interface PickerBuilder {
    addView(view: PickerDocsView): PickerBuilder;
    setOAuthToken(token: string): PickerBuilder;
    setDeveloperKey(key: string): PickerBuilder;
    setCallback(callback: (data: PickerCallbackData) => void): PickerBuilder;
    build(): PickerInstance;
}

export interface PickerNamespace {
    DocsView: new (viewId: string) => PickerDocsView;
    ViewId: { DOCS: string };
    PickerBuilder: new () => PickerBuilder;
    Action: { PICKED: string; CANCEL: string };
}

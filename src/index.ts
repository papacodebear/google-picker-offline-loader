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
// See scripts/vendor-picker.mjs for how vendor/api.js and
// vendor/picker-module.js are captured and validated; see this file's own
// installUrlInterceptor for how the dynamically-fetched second file gets
// redirected to the vendored copy instead of the live one.

export const VENDORED_API_JS_FILE = 'api.js';
export const VENDORED_PICKER_MODULE_FILE = 'picker-module.js';

export type VendoredAssetFile = typeof VENDORED_API_JS_FILE | typeof VENDORED_PICKER_MODULE_FILE;

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

let interceptorInstalled = false;

/**
 * gapi.load('picker', ...) dynamically constructs a module URL containing a
 * `cb=gapi.loaded_N` path segment (e.g. `.../cb=gapi.loaded_1?le=...` — a
 * path segment, not a query parameter, easy to get wrong once: an earlier
 * version of this fix used `URL().searchParams`, which silently found
 * nothing there at all) — a JSONP-style callback name that api.js itself
 * defines on `window.gapi` immediately before injecting the script, and
 * deletes once called. N is api.js's own internal load counter, not a
 * fixed value: confirmed live (2026-08-06) that a real embedding page can
 * request a callback name other than `loaded_0` on its very first Picker
 * load, unlike this package's own capture/validation harness (scripts/
 * vendor-picker.mjs), which only ever exercises a single, isolated
 * gapi.load() call and so only ever observes N=0.
 *
 * The vendored picker-module.js is a frozen capture whose entire content is
 * one such JSONP call — confirmed by inspection, the whole ~235KB file is
 * `gapi.loaded_0(function(_){...})`, that exact string appearing exactly
 * once, at position 0. Serving it unmodified only works when N happens to
 * be 0; otherwise api.js has defined a *different* global (e.g.
 * `gapi.loaded_1`) and never defined `gapi.loaded_0` at all, so calling it
 * throws `TypeError: gapi.loaded_0 is not a function` — a real bug this
 * package shipped with initially, not a hypothetical.
 *
 * Fixed not by rewriting the file's bytes (tried first — requires serving
 * the patched content via a blob: URL, which this extension's own CSP
 * blocks: `script-src 'self'` doesn't permit blob: sources, and adding it
 * would be exactly the kind of CSP loosening vendoring this package in the
 * first place was meant to avoid), but by leaving the *file* untouched and
 * aliasing the name instead: `gapi.loaded_0 = gapi[<whatever api.js
 * actually asked for this time>]`, defined synchronously before the
 * unmodified, same-origin file loads normally. When that file runs and
 * calls its own hardcoded `gapi.loaded_0(...)`, it transparently invokes
 * whichever real callback api.js set up — the file's bytes, and the
 * request that fetches them, never change at all.
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

    const remap = (rawValue: string): string => {
        // Coerced here (not just at the setAttribute call site) so both
        // interception paths funnel through one guaranteed-string value —
        // see this function's doc comment, finding #2 below.
        const value = String(rawValue);
        if (!value.includes('m=picker')) {
            return value;
        }
        const expectedCallback = value.match(/\/cb=(gapi\.[^/?]+)/)?.[1];
        if (expectedCallback) {
            // Defined *before* the (unmodified, real, CSP-compliant)
            // vendored file gets a chance to load — api.js itself must
            // already have defined this name by the time it constructs
            // and assigns this URL (standard JSONP ordering: register the
            // callback, then inject the script that will call it), so
            // this alias is safe to set synchronously, right here.
            const propertyName = expectedCallback.slice('gapi.'.length);
            const gapi = (globalThis as unknown as { gapi?: Record<string, unknown> }).gapi;
            if (gapi && propertyName in gapi) {
                gapi.loaded_0 = gapi[propertyName];
            }
        }
        return resolveAssetUrl(VENDORED_PICKER_MODULE_FILE);
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
                nativeSrcDescriptor.set!.call(element, remap(value));
            }
        });
        element.setAttribute = function (this: Element, name: string, value: string): void {
            if (name.toLowerCase() === 'src') {
                nativeSetAttribute.call(this, name, remap(value));
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

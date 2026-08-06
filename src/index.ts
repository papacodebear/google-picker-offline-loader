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
 * Patches document.createElement so any <script> element whose `src` gets
 * set to Google's dynamically-resolved Picker module URL (recognized by the
 * `m=picker` path segment gapi.load's own module-loading scheme embeds) is
 * silently redirected to the vendored local copy instead. Everything else
 * passes through untouched.
 *
 * DOM-level interception rather than patching api.js's own minified source
 * directly — robust to Google changing their internal implementation, since
 * it only depends on the browser-standard createElement('script') +
 * src-assignment pattern, not anything specific to how api.js is written.
 *
 * Two things confirmed only by running this against a real browser (this
 * package's own vendor-picker.mjs validates the *capture* using jsdom's
 * request-interception API instead, which doesn't exercise this DOM-patching
 * code path at all):
 *   1. Both `.src =` and `.setAttribute('src', ...)` need patching — api.js
 *      uses `.src =` for the initial static load but `setAttribute` for the
 *      dynamically-constructed module URL, a different internal code path.
 *   2. The value passed to setAttribute isn't a plain string — some internal
 *      URL-builder object — so it must be coerced with String() before
 *      pattern-matching, or matching silently throws and api.js's own
 *      error-recovery path kicks in and retries rather than surfacing the bug.
 */
function installUrlInterceptor(doc: Document, resolveAssetUrl: LoadGooglePickerOptions['resolveAssetUrl']): void {
    if (interceptorInstalled) {
        return;
    }
    interceptorInstalled = true;

    const remap = (value: string): string => (value.includes('m=picker') ? resolveAssetUrl(VENDORED_PICKER_MODULE_FILE) : value);

    const nativeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const nativeSetAttribute = Element.prototype.setAttribute;
    if (!nativeSrcDescriptor?.get || !nativeSrcDescriptor.set) {
        throw new Error('cannot install Picker URL interceptor: HTMLScriptElement.src is not accessible here');
    }

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
                nativeSetAttribute.call(this, name, remap(String(value)));
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

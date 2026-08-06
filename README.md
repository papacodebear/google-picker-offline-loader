# google-picker-offline-loader

Load Google's [Picker](https://developers.google.com/workspace/drive/picker/guides/overview) widget from **locally vendored files** instead of fetching it live from `apis.google.com` at runtime.

## Why

Google's Picker has no installable/vendorable npm package of its own — even wrappers that look installable (`@googleworkspace/drive-picker-element`, the official Node.js Drive API client) either don't ship a browser-usable Picker at all, or still fetch `apis.google.com/js/api.js` live at runtime internally. That's a hard blocker for any environment that forbids remote code execution outright, most notably a **Firefox add-on submitted to AMO**: Mozilla's Add-on Policies flag any remote script load as `REMOTE_SCRIPT` (checkable with [`web-ext lint`](https://github.com/mozilla/web-ext)) — a categorical prohibition, not a CSP-syntax difference to work around.

It also matters if you want to keep Google Drive's narrow `drive.file` OAuth scope, which requires the Picker for reaching any pre-existing file the app didn't create itself — the alternative, broader `drive` scope, triggers Google's [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) (a recurring, paid, third-party security assessment).

This package captures Google's actual Picker JS ahead of time, validates the capture works with zero live network access, and ships the result so you can load it same-origin from your own bundle — no remote script requests at all.

## Install

```sh
npm install google-picker-offline-loader
```

## Usage

Copy this package's vendored files into your own build output (plain static assets — copy verbatim, and make sure your build tool doesn't re-minify them, see below):

```js
// webpack example
new CopyWebpackPlugin({
  patterns: [
    { from: 'node_modules/google-picker-offline-loader/vendor/*.js', to: 'vendor/google-picker/[name][ext]' }
  ]
})
```

(A glob rather than three separate entries — the exact set of vendored files can grow if a future Picker version needs another dynamically-loaded module; see [How it works](#how-it-works).)

Then load the Picker and build your own `PickerBuilder` chain — this package only handles getting the Picker namespace loaded safely; view type, OAuth token, developer key, and callback are all yours to configure:

```ts
import { loadGooglePicker } from 'google-picker-offline-loader';

const pickerApi = await loadGooglePicker({
  resolveAssetUrl: (file) => chrome.runtime.getURL(`vendor/google-picker/${file}`)
  // Plain web app: resolveAssetUrl: (file) => `/vendor/google-picker/${file}`
});

const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
  .setIncludeFolders(false)
  .setSelectFolderEnabled(false);

const picker = new pickerApi.PickerBuilder()
  .addView(view)
  .setOAuthToken(accessToken)
  .setDeveloperKey(developerKey)
  .setCallback((data) => {
    if (data.action === pickerApi.Action.PICKED) {
      console.log(data.docs?.[0]);
    }
  })
  .build();

picker.setVisible(true);
```

### Don't let your bundler re-minify the vendored files

Most bundlers' default production minifier (e.g. webpack's `TerserPlugin`) minifies every emitted `.js` file by extension, including ones a copy plugin brought in verbatim. That silently ships different bytes than the ones this package validated, defeating the point. Exclude them explicitly:

```js
// webpack example
optimization: {
  minimizer: [new TerserPlugin({ exclude: /vendor[\\/]google-picker/ })]
}
```

## How it works

`gapi.load('picker', ...)` is a lazy module loader, not just an entry point into `api.js` — calling it makes `api.js` dynamically inject a `<script>` tag fetching the real Picker module from a separate, versioned URL. Actually rendering the dialog (`setVisible(true)`) lazily pulls in a *further* module too — `gapi_iframes`, Google's shared iframe-embedding helper, only requested once you're actually opening the widget, not when it's first built. Vendoring "the Picker" means capturing and redirecting every module it turns out to need, not a fixed count assumed up front — the exact set has changed once already just from testing this package's own render path for the first time, and could again.

This package's runtime does that by patching `document.createElement` so any `<script>` whose `src` matches one of these dynamic module URLs gets silently redirected to the matching vendored copy. (Two non-obvious details, found only by testing against a real browser with all external network blocked: `api.js` uses `setAttribute('src', ...)` for these dynamic loads, not `.src =`; and the value passed isn't a plain string, so it needs `String()` coercion before matching.)

Each redirected module's content is a single JSONP-style call — `gapi.loaded_0(function(_){ ...the actual module... })` — where the callback name is whatever `api.js`'s internal load counter assigned that *specific* module at capture time (the `picker` module happened to get `gapi.loaded_0`, `gapi_iframes` got `gapi.loaded_1` — different modules get different, unpredictable names, and a real embedding page can also just request a different name than capture time saw even for the same module). Serving a vendored file unmodified only works when the requested name happens to match the one baked into it; otherwise `api.js` never defined the name that file's own code calls, throwing `TypeError: gapi.loaded_0 is not a function` (or similar) instead.

Fixed not by rewriting each vendored file's bytes — the first attempt at this did exactly that (fetch the file, string-replace the callback name, serve the patched result via a `blob:` URL), but a `blob:` script source is blocked by a typical extension's `script-src 'self'` CSP, and relaxing that would undo the whole point of vendoring. Instead: read whatever callback name `api.js` actually requested out of the URL it constructed (`.../cb=gapi.loaded_1?le=...` — a **path segment**, not a query parameter, so `URL().searchParams` won't find it), separately discover the *target* file's own baked-in name by fetching and inspecting its own leading bytes, and alias the two — `gapi[<file's own name>] = gapi[<name api.js actually asked for>]` — set before the unmodified file loads. When that file runs its own hardcoded callback, it transparently invokes the real one. No file's bytes, or the request that fetches them, ever change.

**One thing this package deliberately does not vendor, and cannot:** actually opening the dialog also loads `docs.google.com/picker?...` — the Picker's real, live UI content, rendered in an iframe. Unlike the JS modules above, this isn't a static asset; its URL carries session-unique RPC tokens for a live two-way channel between your page and Google's iframe (confirmed: the exact same code path produces different token values every time), so there is no "capture once, serve forever" for it, and freezing a response would break the very mechanism the dialog uses to report back which file got picked. This doesn't undercut the motivation above — Mozilla's `REMOTE_SCRIPT` policy is about loading remote *executable code* into your own extension's context, not embedding a live cross-origin `<iframe>` (the same pattern any Google Sign-In button or Stripe payment form uses). Showing the user their actual, live Drive contents was always going to need live contact with Google at the moment the dialog opens — vendoring gets you out of shipping Google's *loader code* as a live download, not out of Picker being a live service.

## Notes

- This package doesn't build your `PickerBuilder` chain or manage OAuth tokens — bring your own.
- Opening the dialog (`setVisible(true)`) still makes one live request to `docs.google.com` — see [How it works](#how-it-works) for why that's expected, not a bug. Everything up to that point (loading Picker's own JS) makes zero live requests.
- `vendor/` is a committed, periodically-refreshed capture (`npm run vendor:picker`, validated before it overwrites anything) rather than something fetched live — pin/bump this package's version the way you would any other dependency to pick up a refresh. The exact set of files under `vendor/` isn't fixed at three — a future Google change could add another dynamically-loaded module, which a re-vendor would pick up automatically.
- Versions are dated (`YYYY.M.D`, e.g. `2026.8.6`), not semver — most releases are a re-validated capture, not a feature/breaking change, so the version tells you when it was last checked against Google's live Picker at a glance.

## License

MIT

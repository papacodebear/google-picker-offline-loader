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
    { from: 'node_modules/google-picker-offline-loader/vendor/api.js', to: 'vendor/google-picker/api.js' },
    { from: 'node_modules/google-picker-offline-loader/vendor/picker-module.js', to: 'vendor/google-picker/picker-module.js' }
  ]
})
```

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

`gapi.load('picker', ...)` is a lazy module loader, not just an entry point into `api.js` — calling it makes `api.js` dynamically inject a *second* `<script>` tag, fetching the real Picker module from a separate, versioned URL. Vendoring "the Picker" means capturing and redirecting both requests, including the one your code never explicitly makes.

This package's runtime does that by patching `document.createElement` so any `<script>` whose `src` matches Picker's module-loading URL pattern gets silently redirected to your vendored copy. (Two non-obvious details, found only by testing against a real browser with all external network blocked: `api.js` uses `setAttribute('src', ...)` for the dynamic load, not `.src =`; and the value passed isn't a plain string, so it needs `String()` coercion before matching.)

## Notes

- This package doesn't build your `PickerBuilder` chain or manage OAuth tokens — bring your own.
- `vendor/` is a committed, periodically-refreshed capture (`npm run vendor:picker`, validated before it overwrites anything) rather than something fetched live — pin/bump this package's version the way you would any other dependency to pick up a refresh.

## License

MIT

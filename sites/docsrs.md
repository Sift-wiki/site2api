These public reads use the moving latest docs.rs release. For registry search, licenses and other
crate metadata, see the `crates` site.

- Root and item reads assume the package name and rustdoc crate identifier are identical. Packages
  with a different library name, including many hyphenated package names, may not work.
- Root results include re-exports. `kind` is rustdoc's link class, such as `mod` or `fn`;
  summaries can be absent.
- Item paths are relative to the rustdoc crate root, for example `runtime/struct.Runtime.html`.
  The declaration may contain HTML markup. Methods include trait and blanket implementations and
  may be repeated; required trait methods are not necessarily included. Large results may truncate.
- The release title includes the version. Repository and documentation links can be absent.
  Platforms reflect the initially rendered menu, not necessarily all supported targets.
  Build status and license are not extracted.

## Maintainer notes

Verified 2026-11-01, logged out, with public GETs to docs.rs. One Chrome ran at a time.
The final spec passed `verify docsrs`: 7 pass, 0 fail, 0 inconclusive, all tier 1.
A first call from an empty home and subsequent calls to the other operations also used tier 1.

| Operation | Frontend request | Evidence |
|---|---|---|
| `getCrateRoot` | GET `/<crate>/latest/<crate>/` | Learned with serde and tokio. Held-out rand matched the page's `distr`, `Rng` and `random` entries. A missing crate is an input check. |
| `getItem` | GET `/<crate>/latest/<crate>/<path>` | Learned with tokio `runtime/struct.Runtime.html` and rand `trait.Rng.html`. Held-out serde `de/trait.Deserialize.html` matched its declaration and summary. The path slot encodes the slash, which docs.rs served. |
| `getCrateInfo` | GET `/crate/<crate>/latest` | Learned with serde and tokio. Held-out rand matched its 0.10.3 title, documentation and repository links. |

The item extractor exposes markup inside `pre` and includes implementation methods rather than
only the item's own declarations. The release overview does not reliably expose all requested
metadata in the initially rendered menu. Crate search was not learned; rustdoc's in-crate search
is client-side and was not attempted. No login or writes were attempted.

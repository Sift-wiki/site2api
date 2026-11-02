No account is needed. This is the English-language edition of Wiktionary, which has entries in
many languages.

- `searchWords` returns prefix suggestions, not a full-text search. Its `key` is an entry title
  suitable for the other operations.
- `define` returns all available language-code groups; use `en` for English. It does not accept a
  language filter. Definitions and examples contain HTML, not plain text. The endpoint can omit
  senses and parts of speech on the entry page, and can return blank definitions. For example,
  the `bank` response omitted English senses and parts of speech visible on the page. Check the
  entry itself when completeness matters. Large responses can be truncated.
- `getPronunciation` collects IPA-marked text throughout the English section, not just complete
  pronunciations: accent explanations and rhymes may appear, and duplicates can occur. It does
  not return audio filenames or accent labels. An entry without English IPA may give an empty
  result or an input error.
- Wiktionary content is generally available under CC BY-SA; check attribution and licensing
  requirements before reuse.

## Maintainer notes

Verified 2026-11-01, logged out. Captured the server-rendered `serendipity` and `ephemeral`
entries, and compared held-out `bank` against its captured entry. Two different examples were used
for each operation. No login or writes were used.

| Operation | Request and observation | Held-out verification |
|---|---|---|
| `searchWords` | Typing into the main page search box fired `GET /w/rest.php/v1/search/title?q=...&limit=10`. | `bank` returned the existing `bank` entry first. |
| `define` | Direct navigation captured `GET /api/rest_v1/page/definition/<word>` as JSON. The captured entry page did not request this endpoint; it is a same-host Wikimedia REST definition endpoint, like Wikipedia's directly triggered summary endpoint. | `bank` returned the financial-institution sense visible on the entry, but missed other English senses and parts of speech. |
| `getPronunciation` | `GET /wiki/<word>` is the server-rendered entry. The recipe selects IPA elements between the English heading and the next language heading. | `bank` matched the captured English section's IPA elements, including `/ˈbæŋk/`. |

The search page attempted a Wikimedia analytics POST, which the read-only capture stopped; no
write was performed. The definition endpoint's incomplete `bank` result makes it unsuitable for
exhaustive definitions. Etymology and translations were not included: a reliable section-scoped
recipe was not established. Audio was not included.

Final exported spec verification in a fresh home passed 9 cases, with no failures or inconclusive
cases. Separate fresh-home calls for all three operations and later calls answered at tier 1.

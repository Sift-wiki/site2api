No account is needed. NPR content is copyrighted: link to the original and use summaries as
appropriate rather than republishing full articles.

- `topStories` and `getSection` return links to the text site. The final path component is the
  story ID. Section IDs include `1001` (news, the default), `1003` (national), `1004` (world),
  `1014` (politics), `1006` (business), `1019` (technology), `1007` (science), and `1128`
  (health). A section's selection can overlap with other sections.
- `getStory` accepts the ID from a story link, including IDs such as `nx-s1-6020993` and
  older numeric IDs. Paragraphs are the text site's direct paragraph elements, not a transcript
  of audio or a reproduction of images and embedded material. Some articles include promotional
  text among them. Metadata may be absent or differently arranged on some pages.

## Maintainer notes

Verified 2026-11-01, logged out, using an isolated home. All requests are GETs to
`text.npr.org`, and use the server-rendered document, not an authenticated API.

| op | examples used to learn | held-out check | request and recipe |
|---|---|---|---|
| `topStories` | no arguments | live front page | `/`, `.topic-container li` |
| `getSection` | `1001`, `1004` | `1014`, compared with the politics page | `/{sectionId}`, `.topic-container li` |
| `getStory` | `nx-s1-6020993`, `705224359` | `nx-s1-6025502`, compared with the article | `/{storyId}`, `.story-container` and direct paragraph elements |

The list recipe derives `storyId` from each absolute link. `verify npr` passed all six cases
at tier 1. The older numeric story is also a persistent result check. The text site capture
observed only the document request. Attempts to fetch the main site's Fresh Air and Planet Money
pages timed out; no episode operation was added.

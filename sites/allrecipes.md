No account is needed.

- `searchRecipes` returns the first page only (about 24 results). Results that are articles,
  galleries or category pages have no `recipeId` or `slug`; skip them to get recipes. A query
  nothing matches answers `input` (the site answers 404).
- `getRecipe` needs both parts of the recipe URL, `/recipe/<recipeId>/<slug>/`: a wrong slug is a
  404 (`input`).
- `getRecipe` reads the recipe's schema.org data, so quantities are decimals
  (`"0.33333334326744 cup"` is 1/3 cup), times are ISO 8601 durations (`"PT1H10M"`), and
  `description` can hold HTML entities (`&#39;`). `servings` is a string or a list
  (`["8", "8 servings"]`). Nutrition fields are per serving and can be missing.
- `getNutrition` and `getReviews` take the same recipe ID and slug as `getRecipe`.
  Nutrition values include units and may be missing. Reviews are the page's embedded subset,
  not necessarily its first page or all reviews; dates can be absent, text can be empty,
  and text can contain HTML entities.

## Maintainer notes

Learned 2026-10-31 with `api-anything capture` and `add`, logged out, from the server-rendered
pages: `/search?q=` with an explicit `--html` recipe over the Dotdash Meredith card classes, and
`/recipe/<id>/<slug>/` with an `--embedded` regex on the `allrecipes-schema` JSON-LD block.

| op | args | returns | tier |
|---|---|---|---|
| `searchRecipes` | `query` (example `chicken curry`) | about 24 results: `title`, `recipeId`, `slug`, `url`, `ratings`, `tag` | 1 |
| `getRecipe` | `recipeId`, `slug` (example `15156`, `easy-chicken-curry`) | `name`, `author`, `description`, `rating`, `ratingCount`, times, `servings`, `cuisine`, `category`, `ingredients`, `instructions`, `calories`, `protein`, `carbs`, `fat` | 1 |

Checked with inputs that were not examples: `searchRecipes query="vegan lasagna"`, then
`getRecipe recipeId=14069 slug=vegan-lasagna-i` (17 ingredients, 195 ratings, the same count
search showed). `api-anything verify
allrecipes` passed 3 of 3 (2 examples and the no-results check) in the learning home and from an
empty `API_ANYTHING_HOME`, all at tier 1 (under 3 s).

- Learning tripped the live-credential guard on two ad cookies whose values are page text, not
  credentials: LiveIntent's `_li_dcdm_c` (`.allrecipes.com`, in every URL) and `lb_ld`
  (`search`, the search path). `add` refused the page until they were removed from the two
  captures' cookie lists, then learned from the captures (`--from`/`--from2`). Plain HTTP calls never
  set them, but a heal or re-learn in a browser picks them up again and will be refused the same
  way; a `liveIn` exception for cookie values that equal a host suffix or a path segment would fix
  it in `src/secrets.ts`.
- `/recipe/<id>/` without the slug redirects and answers 404, hence the two params.

### 2026-11-01, logged out

- Captured easy chicken curry and Alysia's basic meat lasagna, then learned nutrition and reviews
  from the recipe document's JSON-LD. The page itself also made advertising and analytics requests,
  and a same-page POST loaded dynamic review content; no write operation was learned or called.
- On held-out vegan lasagna, nutrition matched the live panel (511 kcal, 16 g fat, 2 g saturated
  fat, 70 g carbs, 11 g fiber, 12 g sugar, 33 g protein and 1074 mg sodium); cholesterol was
  absent in both. Its embedded review data returned, but the live review section failed to load
  in the page rendering used for comparison, so first-page equivalence was not established.
- Category cards mixed recipes, articles and collections, and did not expose a text rating in the
  tested selector. Category browsing and search paging were not added without sufficient proof.
- Export initially refused a guest `lb_ld` cookie matching ordinary text in the existing spec.
  Clearing this task's temporary guest session allowed export without `--force`.

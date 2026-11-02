No account is needed. Reads public repositories only.

- `searchModels` and `searchDatasets` match words in the repository id (`owner/name`), not in the
  model card, sorted by trending by default, first page (30) only. `searchModels` also accepts
  `sort=likes`, `downloads`, `created` or `modified`.
- `getModel` takes the id split in two: `openai/whisper-large-v3` is `author=openai`,
  `name=whisper-large-v3` (both come back from `searchModels`). The case of the id matters
  (`Qwen`, not `qwen`).
- A model id that doesn't exist, or a private one, answers `class: "auth"` (Hugging Face sends
  HTTP 401 rather than 404 for both). Check the id with `searchModels` before anything else: a
  login does not help with a public model.
- `gated` is `false`, `"auto"` or `"manual"`: a gated model's record is public, but its files need
  an account that accepted its terms.
- `task` (the pipeline tag), `license`, `library` and `parameters` are missing when the repository
  doesn't declare them; `parameters` is counted only from safetensors weights.
- In `searchDatasets`, `rows` and `modalities` come from the dataset viewer and are missing for a
  dataset it can't read.
- `getDataset` and `getSpace` also take case-sensitive `author` and `name` parts of a repository
  id. Dataset card fields can be absent; the description is a shortened card summary and
  `license` can be a string or a list.
- `searchSpaces` returns the first page, including Spaces that are not running. A Space's linked
  models or datasets, runtime hardware, SDK, title and emoji may be absent when not declared.
  Runtime status can change independently of the repository's last modification time.
- `getModelFiles` lists the root of the `main` revision, not subdirectories or other revisions.
  It returns the first page only, with sizes in bytes; a directory's size may be zero. It does not
  download file contents.

## Maintainer notes

Verified 2026-10-31, logged out, from a clean `API_ANYTHING_HOME`: `api-anything verify
huggingface` passed 5 of 5 cases (each op's example, plus an `empty` check for each search).
Every call answered at tier 1 (plain HTTP).

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `searchModels` | typing into "Filter by name" on `/models` fires `GET /models-json?sort=trending&search=...&withCount=true` | `q=qwen` (Qwen models); `q=zzqqxxwvnothingmatch` gives `[]` | 1, about 0.3-0.8 s |
| `getModel` | `GET /api/models/<author>/<name>`, the Hub's public JSON; the trigger opens it directly | `author=Qwen name=Qwen3.8-27B` | 1, about 0.6 s |
| `searchDatasets` | the same filter box on `/datasets` fires `GET /datasets-json?...` | `q=gsm8k` (`openai/gsm8k` first) | 1, about 0.5 s |

- The search triggers wait 3 s before filling the box: filled any earlier, before the page's
  script is ready, the box fires no request.
- `add` flagged `x-request-id` (a per-request trace id) as changing between runs, then found the
  template replays fine. The header was removed from both search requests before `verify` and in
  this file; the calls work without it.
- Loading `/models?search=...` directly renders the list into the HTML (inside a `data-props`
  attribute) and fires no JSON request, so the trigger loads `/models` and types instead.
- `getModel` was not given an `input` check, because a missing id answers 401 (`class: "auth"`).
- The pages also load an AWS WAF script (`edge.sdk.awswaf.com`); its beacons are stopped during
  learning, and plain HTTP calls were never challenged.

### 2026-11-01, logged out

- `getDataset` uses the public `GET /api/datasets/<owner>/<name>` JSON, opened directly, as
  `getModel` already does. The dataset page itself was server-rendered and did not request that
  endpoint in the capture. Learned with `openai/gsm8k` and `stanfordnlp/imdb`; held out
  `rajpurkar/squad`, whose card summary identifies SQuAD.
- `searchSpaces` uses the page's `GET /spaces-json` after filling Filter by name. Learned with
  `gradio` and `whisper`; held out `diffusion`. The result included
  `kadirnar/Video-Diffusion-WebUI`, with the same title, SDK, likes and modification time as
  `getSpace`.
- `getSpace` uses the public `GET /api/spaces/<owner>/<name>` JSON, opened directly; the captured
  Space page itself was server-rendered and did not request that endpoint. Learned with
  `gradio/hello_world` and `mediasynthesismuseum/stable-video-diffusion`; held out
  `kadirnar/Video-Diffusion-WebUI`. No Space action was submitted.
- A first Space example, `huggingface/HuggingChat`, did not produce a matching usable response;
  it was replaced with a public example. Dataset and Space metadata requests were opened directly,
  not claimed to be requests made by their respective detail pages.
- The dated papers and paper-detail captures were server-rendered with no suitable JSON request
  found; no paper operation was added. Sort/filter and model-file operations were not attempted.
- Pages sent AWS WAF and Stripe requests on their own; `add` stopped non-read beacons. The
  per-request `x-request-id` was removed from the Spaces search template.

### 2026-11-01, logged out: model sort and files

- `searchModels` was relearned with `bert`/`likes` and `whisper`/`downloads`. Held out
  `qwen`/`modified` matched the order on the models page. Omitting `sort` uses `trending`.
  Its rotating `x-request-id` was removed before verification. The result check establishes a
  nonempty response, not an assertion about the ordering.
- The `google-bert/bert-base-uncased` files tab was server-rendered and did not capture a tree
  JSON request. `getModelFiles` instead opens the public tree API directly, as the existing
  metadata ops do. Learned with `google-bert/bert-base-uncased` and `openai/whisper-large-v3`;
  held out `Qwen/Qwen3.8-27B`, whose file names and sizes matched its files page.
- Paper detail capture was server-rendered. Its outline did not identify an embedded JSON recipe;
  an initial HTML recipe found the title but not a reliable author list or all requested counts.
  No paper operation was added. Additional model filters and daily papers were not attempted.
- The pages sent AWS WAF and Stripe beacons on their own; `add` stopped non-read beacons.

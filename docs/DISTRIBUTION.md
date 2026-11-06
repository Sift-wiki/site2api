# Distribution

Where API Anything is listed, which file in this repository each listing reads, and what a
maintainer does by hand. Checked in October 2026.

| channel | file | how it updates |
|---|---|---|
| npm | `package.json` | `release.yml` on a `v*` tag (trusted publishing) |
| PyPI (`api-anything`, the Python client) | `python/pyproject.toml` | `release-python.yml` on a `py-v*` tag (trusted publishing); see [PyPI](#pypi) |
| Official MCP Registry | `server.json`, `package.json` `mcpName` | `release.yml`, job `mcp-registry`, after npm |
| Claude Code plugin marketplace | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `skills/api-anything/SKILL.md` | read from the default branch when a user adds or updates the marketplace |
| Glama | `glama.json` | Glama crawls the repository |
| Other directories | none | by hand; see [launch/directories.md](launch/directories.md) |

Every release bumps the version in `package.json`, `server.json` (both `version` fields) and
`.claude-plugin/plugin.json`. `test/distribution.test.ts` fails until they agree, and the release
workflow refuses a tag whose version differs from `server.json`.

## PyPI

The Python client in `python/` ([PYTHON.md](PYTHON.md)) is the PyPI project `api-anything`. It has a
version of its own, in `python/pyproject.toml` and `python/src/api_anything/_version.py` (a test holds
them equal), and its own tags, `py-v<version>`, so it can be released without an npm release.
`MIN_SERVER_VERSION` in `_version.py` is the oldest npm release the client starts; raise it when the
client needs a newer route of `api-anything serve`.

### Automatic, on a tag

`.github/workflows/release-python.yml` runs on a `py-v*` tag. It refuses a tag that differs from
`python/pyproject.toml`'s version, builds the sdist and wheel, runs the unit tests against the wheel,
and uploads with PyPI trusted publishing (`pypa/gh-action-pypi-publish`, `id-token: write`,
environment `pypi`). No token is stored. A manual run of the workflow builds and tests and publishes
nothing.

```sh
# bump python/pyproject.toml and python/src/api_anything/_version.py, merge, then:
git tag py-v0.4.0 && git push origin py-v0.4.0
```

Setup, once:

1. On pypi.org, add a trusted publisher for `api-anything` (Account settings, Publishing; a "pending
   publisher" before the first upload): owner `goodnight000`, repository `api-anything`, workflow
   `release-python.yml`, environment `pypi`.
2. On GitHub, create the environment `pypi` (Settings, Environments). Add required reviewers there if
   a person should approve each upload.

### From a local machine

The fallback when the workflow cannot run. It needs a PyPI API token scoped to the project
(pypi.org, Account settings, API tokens), passed through the environment, never written to a file in
the repository:

```sh
cd python
rm -rf dist && uv build
PYTHONPATH=src python -m unittest discover -s tests -t .
UV_PUBLISH_TOKEN=pypi-... uv publish        # or: uv publish --token "$PYPI_TOKEN"
```

`uv publish --publish-url https://test.pypi.org/legacy/` with a TestPyPI token tries it first. A
version can be uploaded once; to fix a release, bump the version.

## Official MCP Registry

The registry at `registry.modelcontextprotocol.io` lists metadata only; the package stays on npm.
Directories such as PulseMCP and the GitHub MCP Registry read from it, and so do clients that let
users browse servers.

- `server.json` names the server `io.github.goodnight000/api-anything`, the npm package
  `api-anything`, and the arguments the client passes (`npx -y api-anything mcp`, over stdio).
- `package.json` `mcpName` holds the same name. The registry fetches the npm version that
  `server.json` names and refuses it unless its `mcpName` matches. 0.3.2 and earlier have no
  `mcpName`; 0.4.0 is the first release the registry can list.
- GitHub sign-in grants the `io.github.goodnight000/` namespace. No DNS record or secret is needed.

### Automatic, on each release

After `npm publish`, the `mcp-registry` job in `.github/workflows/release.yml` waits until npm
serves the new version with its `mcpName`, downloads `mcp-publisher` (pinned, and checked against
its Sigstore signature), signs in with the workflow's OIDC token (`id-token: write`, already granted)
and publishes `server.json`. If that job fails, re-run it alone from the workflow run's page; it
does not publish to npm again. A manual run of the workflow is a dry run and skips this job.

### By hand

Use this for the first listing if you would rather not wait for a release, or to fix a failed one.
It works only once npm serves the version in `server.json` with the matching `mcpName`.

```sh
brew install mcp-publisher        # or download it from github.com/modelcontextprotocol/registry/releases
mcp-publisher validate            # schema and registry rules, from the repository root
mcp-publisher login github        # device flow; sign in as goodnight000
mcp-publisher publish
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.goodnight000/api-anything"
```

A version can be published once. To change the description or arguments, release a new version.
`mcp-publisher status` marks a version deprecated or deleted.

## Claude Code plugin

The repository is its own plugin marketplace. A user installs the plugin with:

```text
/plugin marketplace add goodnight000/api-anything
/plugin install api-anything@api-anything
```

On Claude Code 2.1.275 or later, one line does both:

```text
/plugin install api-anything --marketplace goodnight000/api-anything
```

The plugin adds the MCP server (`npx -y api-anything mcp`, reads only) and the skill in
`skills/api-anything/`. It does not run `setup`, so nothing is shared until the user answers the
question `learn_site` asks the first time it learns something it could share.

- `plugin.json` `version` decides when users get an update. Leaving it unchanged keeps installed
  copies on the old skill, so it moves with each release.
- The marketplace entry's `source` is `./`, so Claude Code copies the whole repository into its
  plugin cache. The MCP server still comes from npm through `npx`, not from that copy.
- Check both files with `claude plugin validate .` from the repository root.

Listing it in Anthropic's own directory is a separate submission, from
`claude.ai/directory/manage` (a paid Claude plan is required). The validator's one warning is the
missing icon: the directory wants a square PNG of 512 to 2048 px at `.claude-plugin/icon.png`, and
it keeps the first icon it sees, so add the icon before submitting.

## Glama

Glama already lists the repository at `https://glama.ai/mcp/servers/goodnight000/api-anything`,
under the old name site2api, marked "cannot be deployed". `glama.json` names `goodnight000` as the
maintainer, which lets that GitHub account claim the listing. After claiming it, from the listing's
Admin page: rename it API Anything, and add the build settings Glama asks for so it can start the
server and grade its tools. The awesome-mcp-servers list asks for a Glama listing before a pull
request.

## Smithery

Smithery no longer reads a `smithery.yaml` for a local server, so this repository has none. A local
stdio server is published to Smithery as an MCPB bundle:

```sh
npx -y @anthropic-ai/mcpb init                 # in a directory holding the built package: writes manifest.json
npx -y @anthropic-ai/mcpb pack . server.mcpb
npx -y @smithery/cli mcp publish ./server.mcpb -n goodnight000/api-anything
```

See Anthropic's MCPB guide (`claude.com/docs/connectors/building/mcpb`) for the manifest. The same
bundle installs into Claude Desktop with a double click.

A bundle carries its own copy of the package and has to be rebuilt for each release, so it is not
part of the release workflow yet.

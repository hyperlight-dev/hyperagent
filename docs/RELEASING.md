# Releasing Hyperagent

## Version Format

Versions are derived automatically from git tags using MinVer-style calculation:

| Git State | Version |
|-----------|---------|
| On tag `v0.1.0` | `0.1.0` |
| 5 commits after `v0.1.0` | `0.1.1-alpha.5+abc1234` |
| No tags exist | `0.0.0-alpha.N+abc1234` |
| Dirty working tree | `0.1.1-alpha.5+abc1234.dirty` |

The version is calculated from `git describe --tags --long --always --dirty`:
- If exactly on a tag: use the tag version
- If N commits after a tag: bump patch, add `-alpha.N+commit`
- If no tags exist: `0.0.0-alpha.N+commit` where N is total commit count

## Creating a Release

### 1. Ensure main is ready

```bash
git checkout main
git pull
npm test
```

### 2. Create and push a tag

```bash
# For a new release
git tag v0.1.0
git push origin v0.1.0

# Or for a patch release
git tag v0.1.1
git push origin v0.1.1
```

### 3. Create GitHub Release

1. Go to GitHub → Releases → "Create a new release"
2. Select the tag you just pushed
3. Add release notes (consider using "Generate release notes")
4. Publish

### 4. Automated Publishing

The [publish workflow](../.github/workflows/publish.yml) automatically:

1. Runs tests on all hypervisors (KVM, MSHV, WHP)
2. Publishes npm package to [npmjs.org](https://www.npmjs.com/package/@hyperlight-dev/hyperagent) with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing
3. Publishes Docker image to GitHub Container Registry (`ghcr.io/hyperlight-dev/hyperagent`)

#### npm Trusted Publishing

Release-triggered publishes use **OIDC trusted publishing** instead of an `NPM_TOKEN` secret:

- The workflow requests an OIDC `id-token` from GitHub Actions and exchanges it with npmjs.org
- npm attaches a **provenance attestation** (`--provenance`) linking the published package to its source commit and build
- No long-lived npm API key is required for release publishes

**Prerequisites** (one-time setup on npmjs.com):

1. Go to the [@hyperlight-dev/hyperagent](https://www.npmjs.com/package/@hyperlight-dev/hyperagent) package settings
2. Under "Publishing access", add a GitHub Actions trusted publisher:
   - **Organization**: `hyperlight-dev`
   - **Repository**: `hyperagent`
   - **Workflow**: `publish.yml`

## Manual Release (workflow_dispatch)

For testing or hotfixes without creating a git tag:

1. Go to Actions → Publish → Run workflow
2. Enter version (e.g., `0.1.1-beta.1`)
3. Click "Run workflow"

> **Note**: Manual dispatches fall back to the `NPM_TOKEN` repository secret (no provenance attestation). This is the emergency path only — prefer tagged releases for production.

## Verifying a Release

### npm package

```bash
# Install specific version
npm install @hyperlight-dev/hyperagent@0.1.0

# Check version
npx @hyperlight-dev/hyperagent --version
```

### Docker image

```bash
# Pull specific version
docker pull ghcr.io/hyperlight-dev/hyperagent:0.1.0

# Check version
docker run --rm ghcr.io/hyperlight-dev/hyperagent:0.1.0 --version

# Run interactively (requires KVM)
docker run -it --rm --device=/dev/kvm \
  --group-add $(stat -c '%g' /dev/kvm) \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/hyperagent \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -v "$HOME/.hyperagent:/home/hyperagent/.hyperagent" \
  -v "$HOME/.hyperagent/tmp:/tmp" \
  -v "$(pwd)":/workspace -w /workspace \
  ghcr.io/hyperlight-dev/hyperagent:0.1.0
```

## Version in Code

The version is displayed:
- Via `--version` / `-v` flag
- In the startup banner

The version is injected at build time via esbuild's `--define` flag. In development mode (running via `tsx`), it's calculated from git at runtime.

## Troubleshooting

### "0.0.0-dev" version

This means git describe failed. Check:
- Are you in a git repository?
- Is git installed?
- For Docker: is `.git` being copied into the build context?

### Version not updating after tag

The build caches aggressively. Try:
```bash
# Clean build
rm -rf dist/
node scripts/build-binary.js --release
```

For Docker:
```bash
docker build --no-cache -t hyperagent .
```

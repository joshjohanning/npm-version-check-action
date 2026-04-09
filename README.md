# npm-version-check-action

[![GitHub release](https://img.shields.io/github/release/joshjohanning/npm-version-check-action.svg?labelColor=333)](https://github.com/joshjohanning/npm-version-check-action/releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-npm--version--check--action-blue?logo=github)](https://github.com/marketplace/actions/npm-version-check-action)
[![CI](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

🔍 **GitHub Action that validates npm package version increments in pull requests to ensure proper semantic versioning**

This action prevents developers from forgetting to bump package.json version before merging PRs that contain code changes, which would cause publishing issues later.

## What's new

Please refer to the [release page](https://github.com/joshjohanning/npm-version-check-action/releases) for the latest release notes.

## ✨ Features

- 🎯 **Smart file detection** - Only runs when JavaScript/TypeScript/package files are modified
- 🧠 **Intelligent dependency checking** - Distinguishes between actual dependency changes vs metadata-only changes in package.json and package-lock.json
- 🔒 **Version consistency check** - Validates that package.json and package-lock.json have matching versions
- 🔧 **Configurable devDependencies handling** - Choose whether devDependency changes should trigger version bumps
- ⏭️ **Per-commit skip support** - Use `[skip version]` in commit messages to exclude specific commits from version checking
- 📊 **Semantic versioning validation** - Ensures new version is higher than previous release
- 🏷️ **Git tag comparison** - Compares against the latest version tag via GitHub API
- 🚀 **No git CLI dependency** - Uses GitHub API exclusively, works with any checkout configuration including `persist-credentials: false`
- 🎉 **First release support** - Gracefully handles repositories with no previous tags
- 🚀 **JavaScript action** - Fast execution with Node.js runtime
- 🔄 **Node.js Actions runtime change detection** - Requires a major version bump when `action.yml` changes its Node.js Actions runtime (e.g., `node20` to `node24`)
- 📝 **Clear messaging** - Provides detailed success/error messages with emojis
- ⚙️ **Configurable** - Supports custom package.json paths, tag prefixes, and dependency policies

## 📋 Requirements

- Node.js project with `package.json`
- Git tags following semantic versioning (e.g., `v1.0.0`, `v2.1.3`)
- Used in pull request workflows
- **Permissions**: `contents: read` and `pull-requests: read` (the action uses the Pulls API to analyze commits)

## 🚀 Usage

### Basic Usage

Add this step to your workflow file (e.g., `.github/workflows/ci.yml`):

```yaml
name: CI
on:
  pull_request:
    branches: [main]

jobs:
  version-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v6

      - uses: joshjohanning/npm-version-check-action@v2
```

> **Note:** The `pull-requests: read` permission is required because the action
> uses the GitHub Pulls API to retrieve commits from the pull request for
> per-commit file analysis and `[skip version]` keyword support.

### Advanced Configuration

```yaml
jobs:
  version-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v6

      - uses: joshjohanning/npm-version-check-action@v2
        with:
          package-path: 'packages/core/package.json' # Custom package.json path
          tag-prefix: 'v' # Tag prefix (default: 'v')
          skip-files-check: 'false' # Always run, don't check files
          include-dev-dependencies: 'true' # Require version bump for devDependencies
```

### Complete Workflow Example

```yaml
name: CI
on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Check version increment
        uses: joshjohanning/npm-version-check-action@v2
        with:
          package-path: 'package.json'
          tag-prefix: 'v'

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test
```

## 📥 Inputs

| Input                                  | Description                                                                                             | Required | Default               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `package-path`                         | Path to package.json file (relative to repository root)                                                 | No       | `package.json`        |
| `tag-prefix`                           | Prefix for version tags (e.g., "v" for v1.0.0)                                                          | No       | `v`                   |
| `skip-files-check`                     | Skip checking if JS/package files changed (always run version check)                                    | No       | `false`               |
| `include-dev-dependencies`             | Whether devDependency changes should trigger version bump requirement                                   | No       | `false`               |
| `skip-version-keyword`                 | Keyword in commit messages to skip version check for that commit's files. Set to `''` to disable        | No       | `[skip version]`      |
| `skip-version-consistency-check`       | Skip the check that validates package.json and package-lock.json have matching versions                 | No       | `false`               |
| `skip-major-on-actions-runtime-change` | Skip the check that requires a major version bump when `action.yml` changes its Node.js Actions runtime | No       | `false`               |
| `skip-sequential-version-check`        | Skip the check that validates version increments are sequential (e.g., 4.0.0 to 4.1.0 not 4.2.0)        | No       | `false`               |
| `token`                                | GitHub token for API access (required). Used for fetching PR diff, repository tags, and commit analysis | Yes      | `${{ github.token }}` |

## 📤 Outputs

| Output                   | Description                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `version-changed`        | Whether the version was changed (`true`/`false`)                                                 |
| `current-version`        | Current version from package.json                                                                |
| `previous-version`       | Previous version from latest git tag                                                             |
| `runtime-changed`        | Whether the Node.js Actions runtime version in action.yml changed (`true`/`false`)               |
| `version-increment-type` | The type of version increment detected: `major`, `minor`, or `patch` (empty when not applicable) |

### Using Outputs

```yaml
- name: Check version
  id: version-check
  uses: joshjohanning/npm-version-check-action@v2

- name: Print version info
  run: |
    echo "Version changed: ${{ steps.version-check.outputs.version-changed }}"
    echo "Current version: ${{ steps.version-check.outputs.current-version }}"
    echo "Previous version: ${{ steps.version-check.outputs.previous-version }}"
    echo "Increment type: ${{ steps.version-check.outputs.version-increment-type }}"
```

## 🎯 How It Works

1. **Smart File Change Detection**: Analyzes which files were modified in the PR
   - JavaScript/TypeScript files trigger version checks
   - Package files (`package.json`, `package-lock.json`) undergo intelligent dependency analysis
2. **Intelligent Dependency Analysis**: For package files, distinguishes between:
   - **Functional changes**: Actual dependency additions, updates, or removals that affect functionality
   - **Metadata changes**: Version bumps, description updates, scripts changes, or devDependency changes that don't affect runtime
3. **Version Consistency Check**: Validates that `package.json` and `package-lock.json` have matching versions
   - Prevents issues where one file is updated but the other is not (e.g., after rebasing or manual edits)
   - Fails the build with a clear error message if versions don't match
4. **Version Extraction**: Reads the current version from `package.json`
5. **Tag Comparison**: Fetches the latest git tag and compares versions
6. **Semantic Validation**: Ensures the new version is higher than the previous release
7. **Sequential Version Check**: Validates that the version increment is exactly +1 for the changed component (e.g., `4.0.0 → 4.1.0` is valid, `4.0.0 → 4.2.0` is not). Disable with `skip-sequential-version-check: true`
8. **Runtime Change Detection**: Checks if `action.yml` changed its Node.js Actions runtime and requires a major version bump
9. **Clear Feedback**: Provides success or error messages with actionable hints

### Smart File Detection

The action intelligently handles different types of file changes:

#### JavaScript/TypeScript Files (Always Trigger Version Check)

- `.js` - JavaScript files
- `.ts` - TypeScript files
- `.jsx` - React JavaScript files
- `.tsx` - React TypeScript files

#### Package Files (Smart Dependency Analysis)

- `package.json` - Only triggers version check for **dependency changes**, not metadata
  - ✅ **Triggers check**: Changes to `dependencies`, `peerDependencies`, `optionalDependencies`, `bundleDependencies`
  - ✅ **Triggers check (configurable)**: Changes to `devDependencies` when `include-dev-dependencies: true`
  - ❌ **Skips check**: Changes to `version`, `description`, `scripts`, `author`, etc.
- `package-lock.json` - **Smart handling with dependency tree analysis**
  - ✅ **Always triggers check**: Production dependency changes (new packages, version updates, integrity changes)
  - 🔄 **Configurable behavior**: When only devDependencies changed in package.json:
    - ❌ **Skips check** if `include-dev-dependencies: false` (default) - lockfile changes caused by devDependency updates (including shared transitive dependency reshuffling) are correctly identified and ignored
    - ✅ **Triggers check** if `include-dev-dependencies: true` - package-lock.json changes are analyzed
  - ❌ **Skips check**: Pure metadata changes (version bumps, format updates)

#### 🎯 Key Improvement: Dependency Tree Walking for Lockfile Analysis

When `include-dev-dependencies: false` (default) and only devDependencies change in package.json:

- The action walks the dependency tree from each changed devDependency to identify which lockfile changes are attributable to the devDep update
- Shared transitive dependencies (packages used by both production and dev trees) that get reshuffled by npm are correctly treated as dev-only changes, even when npm nests them under production dependency paths (e.g., `node_modules/cliui/node_modules/ansi-regex`), but only when corroborated by a confirmed dev-attributable change of the same package name at another path
- Lockfile changes to packages whose **name** does not appear in any confirmed dev-attributable changed entry are still flagged as production changes (e.g., intentional transitive bumps for security fixes)

This intelligent approach prevents unnecessary version bumps when only non-functional changes are made.

## 📋 Version Increment Examples

| Previous | Current | Result           |
| -------- | ------- | ---------------- |
| `1.0.0`  | `1.0.1` | ✅ Valid (patch) |
| `1.0.0`  | `1.1.0` | ✅ Valid (minor) |
| `1.0.0`  | `2.0.0` | ✅ Valid (major) |
| `1.0.0`  | `1.0.0` | ❌ Same version  |
| `1.1.0`  | `1.0.5` | ❌ Lower version |

## 🛠️ Common Use Cases

### Monorepo Support

For monorepos with multiple packages:

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    package-path: 'packages/frontend/package.json'

- uses: joshjohanning/npm-version-check-action@v2
  with:
    package-path: 'packages/backend/package.json'
```

### Custom Tag Format

If your tags don't use the `v` prefix:

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    tag-prefix: 'release-' # For tags like 'release-1.0.0'
```

### Always Run (Skip File Check)

To always validate version regardless of changed files:

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    skip-files-check: 'true'
```

### DevDependencies Configuration

By default, `devDependencies` changes don't trigger version bump requirements since they typically don't affect production functionality. The action uses **smart logic** to handle this configuration:

#### Default Behavior (Ignore DevDependencies) - Recommended

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    include-dev-dependencies: 'false' # Default - devDeps don't require version bump
```

**What happens with this setting:**

- 🎯 **package.json**: Only production dependencies (`dependencies`, `peerDependencies`, etc.) trigger version checks
- 🚫 **package-lock.json**: When only devDependencies changed in package.json, lock file changes are **completely ignored**
- ✅ **Result**: No false positives from massive lock file changes due to dev dependency updates

#### Strict Mode (Include DevDependencies)

For libraries where build tools/devDependencies can affect the published package:

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    include-dev-dependencies: 'true' # devDeps changes require version bump
```

**What happens with this setting:**

- ✅ **package.json**: Both production AND development dependencies trigger version checks
- ✅ **package-lock.json**: All dependency changes are analyzed, including dev dependency effects

#### Use Cases for Including DevDependencies

- **Library packages**: Where build tools, bundlers, or transpilers can affect the final output
- **Strict versioning policies**: Teams that want every dependency change tracked
- **CI/CD sensitive packages**: Where test runners or build scripts changes impact deliverables

### Skip Version Check for Specific Commits

Sometimes you need to make changes that shouldn't require a version bump - like fixing a typo in a comment, updating JSDoc, or fixing linting issues. You can use the `[skip version]` keyword in your commit message to exclude that commit's files from version checking:

```bash
# This commit's files will be excluded from version check
git commit -m "docs: fix typo in JSDoc comment [skip version]"

# This commit's files will still be checked
git commit -m "feat: add new feature"
```

#### How It Works

The action analyzes each commit in the PR individually:

1. Commits **with** `[skip version]` in the message → files are **excluded** from version check
2. Commits **without** the keyword → files are **included** in version check
3. If a file is changed in **both** skipped and non-skipped commits → file is **included** (requires version bump)

#### Example Scenario

```
PR with 3 commits:
├── Commit A: "docs: fix typos [skip version]" → changes src/index.js
├── Commit B: "feat: add feature" → changes src/utils.js
└── Commit C: "fix: typo" → changes src/index.js (same file as A)

Result: src/index.js and src/utils.js both require version check
        (index.js because it's changed in non-skipped Commit C)
```

#### Custom Skip Keyword

You can customize the skip keyword or disable this feature entirely:

```yaml
# Use a custom keyword
- uses: joshjohanning/npm-version-check-action@v2
  with:
    skip-version-keyword: '[no bump]'

# Disable skip functionality entirely
- uses: joshjohanning/npm-version-check-action@v2
  with:
    skip-version-keyword: ''
```

## 🔍 Troubleshooting

### "No previous version tag found"

This is normal for the first release. The action will pass and allow the PR to proceed.

### "Could not extract version from package.json"

Ensure your `package.json` has a valid `version` field:

```json
{
  "name": "my-package",
  "version": "1.0.0"
}
```

### Node.js Actions Runtime Change Detection

When `skip-major-on-actions-runtime-change` is `false` (default), the action compares the `runs.using` field in `action.yml` between the base and head of the PR. If the Node.js Actions runtime version changes (e.g., `node20` to `node24`), a **major** version bump is required.

This follows the convention used by popular GitHub Actions (like `actions/checkout`, `actions/setup-node`, etc.) where runtime upgrades are treated as breaking changes since they may affect consumers who pin to specific major versions.

```yaml
# action.yml before:
runs:
  using: 'node20'

# action.yml after:
runs:
  using: 'node24'

# Requires: v1.x.x -> v2.0.0 (major version bump)
# Would fail: v1.x.x -> v1.x.x (minor/patch bump)
```

To disable this check:

```yaml
- uses: joshjohanning/npm-version-check-action@v2
  with:
    skip-major-on-actions-runtime-change: 'true'
```

### "Version check passed but I expected it to fail"

If you made changes to `devDependencies` and expected a version bump requirement:

1. **Check the default behavior**: By default, `devDependencies` changes don't require version bumps
2. **Configure if needed**: Set `include-dev-dependencies: 'true'` to require version bumps for devDependency changes
3. **Review smart detection**: The action distinguishes between functional dependency changes and metadata-only changes

### "I updated devDependencies and package-lock.json changed massively, but no version bump required?"

This is the **expected behavior** with the default configuration! 🎉

- ✅ **Working as designed**: When `include-dev-dependencies: false` (default), massive package-lock.json changes from dev dependency updates are intentionally ignored
- 🚫 **No false positives**: The action completely skips package-lock.json analysis when only devDependencies changed
- 🎯 **Smart logic**: This prevents the _"I'm only updating devDependencies :("_ problem
- ⚙️ **Configurable**: Set `include-dev-dependencies: true` if you want dev dependency changes to require version bumps

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📞 Support

If you have any questions or run into issues, please [open an issue](https://github.com/joshjohanning/npm-version-check-action/issues) on GitHub.

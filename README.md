# npm-version-check-action

[![GitHub release](https://img.shields.io/github/release/joshjohanning/npm-version-check-action.svg)](https://github.com/joshjohanning/npm-version-check-action/releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-npm--version--check--action-blue?logo=github)](https://github.com/marketplace/actions/npm-version-check-action)
[![CI](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/npm-version-check-action/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

🔍 **GitHub Action that validates npm package version increments in pull requests to ensure proper semantic versioning**

This action prevents developers from forgetting to bump package.json version before merging PRs that contain code changes, which would cause publishing issues later.

## ✨ Features

- 🎯 **Smart file detection** - Only runs when JavaScript/TypeScript/package files are modified
- 🧠 **Intelligent dependency checking** - Distinguishes between actual dependency changes vs metadata-only changes in package.json and package-lock.json
- 🔧 **Configurable devDependencies handling** - Choose whether devDependency changes should trigger version bumps
- 📊 **Semantic versioning validation** - Ensures new version is higher than previous release
- 🏷️ **Git tag comparison** - Compares against the latest git tag
- 🚀 **Shallow clone compatible** - Automatically fetches tags, works with default checkout
- 🎉 **First release support** - Gracefully handles repositories with no previous tags
- 🚀 **JavaScript action** - Fast execution with Node.js runtime
- 📝 **Clear messaging** - Provides detailed success/error messages with emojis
- ⚙️ **Configurable** - Supports custom package.json paths, tag prefixes, and dependency policies

## 📋 Requirements

- Node.js project with `package.json`
- Git tags following semantic versioning (e.g., `v1.0.0`, `v2.1.3`)
- Used in pull request workflows

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
    steps:
      - uses: actions/checkout@v5

      - uses: joshjohanning/npm-version-check-action@v1
```

### Advanced Configuration

```yaml
- uses: joshjohanning/npm-version-check-action@v1
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
        uses: actions/checkout@v5

      - name: Check version increment
        uses: joshjohanning/npm-version-check-action@v1
        with:
          package-path: 'package.json'
          tag-prefix: 'v'

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test
```

## 📥 Inputs

| Input                      | Description                                                           | Required | Default        |
| -------------------------- | --------------------------------------------------------------------- | -------- | -------------- |
| `package-path`             | Path to package.json file (relative to repository root)               | No       | `package.json` |
| `tag-prefix`               | Prefix for version tags (e.g., "v" for v1.0.0)                        | No       | `v`            |
| `skip-files-check`         | Skip checking if JS/package files changed (always run version check)  | No       | `false`        |
| `include-dev-dependencies` | Whether devDependency changes should trigger version bump requirement | No       | `false`        |

## 📤 Outputs

| Output             | Description                                      |
| ------------------ | ------------------------------------------------ |
| `version-changed`  | Whether the version was changed (`true`/`false`) |
| `current-version`  | Current version from package.json                |
| `previous-version` | Previous version from latest git tag             |

### Using Outputs

```yaml
- name: Check version
  id: version-check
  uses: joshjohanning/npm-version-check-action@v1

- name: Print version info
  run: |
    echo "Version changed: ${{ steps.version-check.outputs.version-changed }}"
    echo "Current version: ${{ steps.version-check.outputs.current-version }}"
    echo "Previous version: ${{ steps.version-check.outputs.previous-version }}"
```

## 🎯 How It Works

1. **Smart File Change Detection**: Analyzes which files were modified in the PR
   - JavaScript/TypeScript files trigger version checks
   - Package files (`package.json`, `package-lock.json`) undergo intelligent dependency analysis
2. **Intelligent Dependency Analysis**: For package files, distinguishes between:
   - **Functional changes**: Actual dependency additions, updates, or removals that affect functionality
   - **Metadata changes**: Version bumps, description updates, scripts changes, or devDependency changes that don't affect runtime
3. **Version Extraction**: Reads the current version from `package.json`
4. **Tag Comparison**: Fetches the latest git tag and compares versions
5. **Semantic Validation**: Ensures the new version is higher than the previous release
6. **Clear Feedback**: Provides success or error messages with actionable hints

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
- `package-lock.json` - Only triggers version check for **production dependency changes**
  - ✅ **Triggers check**: New packages, changed package URLs/integrity, production dependency tree changes
  - ❌ **Skips check**: Version metadata updates, lockfile format changes, devDependency changes

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
- uses: joshjohanning/npm-version-check-action@v1
  with:
    package-path: 'packages/frontend/package.json'

- uses: joshjohanning/npm-version-check-action@v1
  with:
    package-path: 'packages/backend/package.json'
```

### Custom Tag Format

If your tags don't use the `v` prefix:

```yaml
- uses: joshjohanning/npm-version-check-action@v1
  with:
    tag-prefix: 'release-' # For tags like 'release-1.0.0'
```

### Always Run (Skip File Check)

To always validate version regardless of changed files:

```yaml
- uses: joshjohanning/npm-version-check-action@v1
  with:
    skip-files-check: 'true'
```

### DevDependencies Configuration

By default, `devDependencies` changes don't trigger version bump requirements since they typically don't affect production functionality. However, you can configure this behavior:

#### Default Behavior (Ignore DevDependencies)

```yaml
- uses: joshjohanning/npm-version-check-action@v1
  with:
    include-dev-dependencies: 'false' # Default - devDeps don't require version bump
```

#### Strict Mode (Include DevDependencies)

For libraries where build tools/devDependencies can affect the published package:

```yaml
- uses: joshjohanning/npm-version-check-action@v1
  with:
    include-dev-dependencies: 'true' # devDeps changes require version bump
```

#### Use Cases for Including DevDependencies

- **Library packages**: Where build tools, bundlers, or transpilers can affect the final output
- **Strict versioning policies**: Teams that want every dependency change tracked
- **CI/CD sensitive packages**: Where test runners or build scripts changes impact deliverables

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

### "Warning: Could not fetch git tags"

The action automatically fetches git tags to work with shallow clones. If this warning appears, it means there was an issue fetching tags, but the action will continue with limited functionality. This is rare and usually indicates network or permission issues.

### "Version check passed but I expected it to fail"

If you made changes to `devDependencies` and expected a version bump requirement:

1. **Check the default behavior**: By default, `devDependencies` changes don't require version bumps
2. **Configure if needed**: Set `include-dev-dependencies: 'true'` to require version bumps for devDependency changes
3. **Review smart detection**: The action distinguishes between functional dependency changes and metadata-only changes

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📞 Support

If you have any questions or run into issues, please [open an issue](https://github.com/joshjohanning/npm-version-check-action/issues) on GitHub.

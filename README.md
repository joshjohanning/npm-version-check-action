# npm-version-check-action

[![GitHub release](https://img.shields.io/github/release/joshjohanning/npm-version-check-action.svg)](https://github.com/joshjohanning/npm-version-check-action/releases)
[![GitHub marketplace](https://img.shields.io/badge/marketplace-npm--version--check--action-blue?logo=github)](https://github.com/marketplace/actions/npm-version-check-action)
[![CI](https://github.com/joshjohanning/npm-version-check-action/workflows/CI/badge.svg)](https://github.com/joshjohanning/npm-version-check-action/actions)

🔍 **GitHub Action that validates npm package version increments in pull requests to ensure proper semantic versioning**

This action prevents developers from forgetting to bump package.json version before merging PRs that contain code changes, which would cause publishing issues later.

## ✨ Features

- 🎯 **Smart file detection** - Only runs when JavaScript/TypeScript/package files are modified
- 📊 **Semantic versioning validation** - Ensures new version is higher than previous release
- 🏷️ **Git tag comparison** - Compares against the latest git tag
- 🚀 **Shallow clone compatible** - Automatically fetches tags, works with default checkout
- 🎉 **First release support** - Gracefully handles repositories with no previous tags
- 🚀 **JavaScript action** - Fast execution with Node.js runtime
- 📝 **Clear messaging** - Provides detailed success/error messages with emojis
- ⚙️ **Configurable** - Supports custom package.json paths and tag prefixes

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

| Input              | Description                                                          | Required | Default        |
| ------------------ | -------------------------------------------------------------------- | -------- | -------------- |
| `package-path`     | Path to package.json file (relative to repository root)              | No       | `package.json` |
| `tag-prefix`       | Prefix for version tags (e.g., "v" for v1.0.0)                       | No       | `v`            |
| `skip-files-check` | Skip checking if JS/package files changed (always run version check) | No       | `false`        |

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

1. **File Change Detection**: Checks if JavaScript, TypeScript, or package files were modified in the PR
2. **Version Extraction**: Reads the current version from `package.json`
3. **Tag Comparison**: Fetches the latest git tag and compares versions
4. **Semantic Validation**: Ensures the new version is higher than the previous release
5. **Clear Feedback**: Provides success or error messages with actionable hints

### Supported File Extensions

The action checks for changes in files with these extensions:

- `.js` - JavaScript files
- `.ts` - TypeScript files
- `.jsx` - React JavaScript files
- `.tsx` - React TypeScript files
- `package*.json` - Package configuration files

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

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📞 Support

If you have any questions or run into issues, please [open an issue](https://github.com/joshjohanning/npm-version-check-action/issues) on GitHub.

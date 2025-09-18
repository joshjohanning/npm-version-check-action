# Contributing to npm-version-check-action

Thank you for your interest in contributing to this project! We welcome contributions from the community.

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/npm-version-check-action.git`
3. Create a new branch: `git checkout -b my-feature-branch`
4. Make your changes
5. Test your changes locally
6. Commit your changes: `git commit -m "Add my new feature"`
7. Push to your fork: `git push origin my-feature-branch`
8. Open a pull request

## 🧪 Testing

Before submitting a pull request, please test your changes:

### Local Testing

You can test the shell script directly:

```bash
# Test with default settings
./version-check.sh

# Test with custom settings
PACKAGE_PATH="custom/package.json" TAG_PREFIX="release-" ./version-check.sh

# Test PR simulation
GITHUB_EVENT_NAME=pull_request SKIP_FILES_CHECK=true ./version-check.sh
```

### Action Testing

Test the action by creating a workflow in your fork and triggering it.

## 📝 Code Style

- Use clear, descriptive variable names
- Add comments for complex logic
- Follow existing code patterns
- Use emoji in output messages consistently
- Ensure proper error handling

### Shell Script Guidelines

- Use `set -e` for fail-fast behavior
- Quote variables properly
- Use `[[ ]]` for conditionals
- Prefer explicit over implicit

## 🐛 Bug Reports

When reporting bugs, please include:

1. **Description**: Clear description of the issue
2. **Steps to reproduce**: Detailed steps to reproduce the behavior
3. **Expected behavior**: What you expected to happen
4. **Actual behavior**: What actually happened
5. **Environment**: OS, action version, repository setup
6. **Logs**: Relevant action logs or error messages

## ✨ Feature Requests

When requesting features, please include:

1. **Use case**: Why do you need this feature?
2. **Description**: Detailed description of the proposed feature
3. **Implementation ideas**: Any thoughts on how it could be implemented
4. **Alternatives**: Have you considered any alternatives?

## 📋 Pull Request Guidelines

- **One feature per PR**: Keep pull requests focused on a single feature or bug fix
- **Clear description**: Explain what your PR does and why
- **Test your changes**: Ensure your changes work as expected
- **Update documentation**: Update README.md if your changes affect usage
- **Follow existing patterns**: Keep the code style consistent

### Pull Request Template

Please include the following information in your PR:

```
## Changes
- Brief description of what changed

## Testing
- How did you test these changes?

## Breaking Changes
- Are there any breaking changes? If yes, describe them.

## Related Issues
- Link to any related issues
```

## 🔍 Code Review Process

1. All pull requests require review before merging
2. We may suggest changes or ask questions
3. Once approved, the PR will be merged by a maintainer
4. After merging, the action will be automatically published

## 📦 Release Process

Releases are automated using GitHub Actions:

1. When code is merged to `main`, the publish workflow runs
2. A new release is created with version tags
3. The action becomes available in the GitHub Actions marketplace

## 🤔 Questions?

If you have questions about contributing, please:

1. Check existing issues and discussions
2. Open a new issue with the "question" label
3. Reach out to the maintainers

Thank you for contributing! 🎉
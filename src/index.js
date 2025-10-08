import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import semver from 'semver';

/**
 * Log a message using GitHub Actions core logging
 */
export function logMessage(message, level = 'info') {
  switch (level) {
    case 'error':
      core.error(message);
      break;
    case 'warning':
      core.warning(message);
      break;
    case 'debug':
      core.debug(message);
      break;
    case 'notice':
      core.notice(message);
      break;
    default:
      core.info(message);
  }
}

/**
 * Validate git arguments to prevent command injection
 */
export function validateGitArgs(args) {
  const dangerousPatterns = [
    /--upload-pack/i,
    /--receive-pack/i,
    /--exec/i,
    /[;&|`$()]/ // Shell metacharacters
  ];

  // Known safe git commands and options
  const safeCommands = ['diff', 'fetch', 'tag'];
  const safeOptions = ['--name-only', '--tags', '-l'];
  const shaPattern = /^[a-f0-9]{7,40}$/i; // Git SHA pattern

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (typeof arg !== 'string') {
      throw new Error('Git arguments must be strings');
    }

    // First argument should be a git command
    if (i === 0 && !safeCommands.includes(arg)) {
      throw new Error(`Unsupported git command: ${arg}`);
    }

    // Skip validation for known safe options
    if (safeOptions.includes(arg)) {
      continue;
    }

    // Allow SHA hashes (for baseRef/headRef)
    if (shaPattern.test(arg)) {
      continue;
    }

    // Check for dangerous patterns
    for (const pattern of dangerousPatterns) {
      if (pattern.test(arg)) {
        throw new Error(`Potentially dangerous git argument detected: ${arg}`);
      }
    }

    // Reject arguments that start with dash (except known safe options)
    if (arg.startsWith('-') && !safeOptions.includes(arg)) {
      throw new Error(`Potentially dangerous git option: ${arg}`);
    }
  }
}

/**
 * Execute a git command and return the output
 */
export async function execGit(args) {
  // Validate arguments for security
  validateGitArgs(args);

  let output = '';
  let error = '';

  const options = {
    listeners: {
      stdout: data => {
        output += data.toString();
      },
      stderr: data => {
        error += data.toString();
      }
    },
    silent: true
  };

  try {
    await exec.exec('git', args, options);
    return output.trim();
  } catch (err) {
    if (error) {
      throw new Error(`Git command failed: ${error}`);
    }
    throw err;
  }
}

/**
 * Get files changed in the current PR
 */
export async function getChangedFiles() {
  const context = github.context;

  if (context.eventName !== 'pull_request') {
    return [];
  }

  const baseRef = context.payload.pull_request?.base?.sha;
  const headRef = context.sha;

  if (!baseRef || !headRef) {
    throw new Error('Could not determine base and head refs for PR');
  }

  const output = await execGit(['diff', '--name-only', baseRef, headRef]);
  return output ? output.split('\n') : [];
}

/**
 * Helper function to create directory exclusion patterns
 */
export function createDirectoryPatterns(directories) {
  // Standard regex escaping function
  const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return directories.map(dir => new RegExp(`(^|\\/)${escapeRegExp(dir)}\\/`));
}

/**
 * Check if a single file is relevant for version checking (excluding test files)
 */
export function isRelevantFile(file) {
  const relevantExtensions = /\.(js|ts|jsx|tsx|json)$/;
  // More specific pattern to avoid ReDoS - matches package.json, package-lock.json, etc.
  const packageFiles = /^(?:.*\/)?package(?:-[a-z0-9-]+)?\.json$/;

  // Must have relevant extension
  if (!relevantExtensions.test(file)) {
    return false;
  }

  // Patterns for test files and directories to exclude
  const testPatterns = [
    /(^|\/)tests?\//, // test/ or tests/ directories
    /(^|\/)__tests__\//, // __tests__ directories (Jest convention)
    /\.test\./, // .test.js, .test.ts, etc.
    /\.spec\./, // .spec.js, .spec.ts, etc.
    /(^|\/)test\./, // files starting with test. (root or in any directory)
    /(^|\/)spec\./, // files starting with spec. (root or in any directory)
    /\.config\./, // config files (.eslintrc.js, jest.config.js, etc.)
    ...createDirectoryPatterns([
      '.github',
      'docs?',
      'examples?',
      'scripts?',
      '.vscode',
      'coverage',
      'dist',
      'build',
      'node_modules'
    ])
  ];

  // Exclude test files and other non-production files
  if (testPatterns.some(pattern => pattern.test(file))) {
    return false;
  }

  // Include package.json files
  if (packageFiles.test(file)) {
    return true;
  }

  // Include JavaScript/TypeScript files that aren't excluded above
  return file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.jsx') || file.endsWith('.tsx');
}

/**
 * Check if any JavaScript/TypeScript or package files were changed (excluding test files)
 */
export function hasRelevantFileChanges(changedFiles) {
  return changedFiles.some(file => isRelevantFile(file));
}

/**
 * Read and parse package.json
 */
export function readPackageJson(packagePath) {
  try {
    if (!fs.existsSync(packagePath)) {
      throw new Error(`package.json not found at path: ${packagePath}`);
    }

    const content = fs.readFileSync(packagePath, 'utf8');
    const packageJson = JSON.parse(content);

    if (!packageJson.version) {
      throw new Error(`Could not extract version from ${packagePath}`);
    }

    return packageJson;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${packagePath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get the latest version tag from git
 */
export async function getLatestVersionTag(tagPrefix) {
  try {
    // Fetch all tags
    await execGit(['fetch', '--tags']);

    // Get all tags and filter by prefix
    const tagsOutput = await execGit(['tag', '-l']);
    const tags = tagsOutput ? tagsOutput.split('\n').filter(tag => tag.trim()) : [];

    // Filter tags that match the version pattern
    const versionPattern = new RegExp(`^${tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9]+\\.[0-9]+\\.[0-9]+`);
    const versionTags = tags.filter(tag => versionPattern.test(tag));

    if (versionTags.length === 0) {
      return null;
    }

    // Sort tags by version and get the latest
    const sortedTags = versionTags.sort((a, b) => {
      const versionA = a.replace(tagPrefix, '');
      const versionB = b.replace(tagPrefix, '');
      return semver.compare(versionA, versionB);
    });

    return sortedTags[sortedTags.length - 1];
  } catch (error) {
    throw new Error(`Failed to fetch git tags: ${error.message}`);
  }
}

/**
 * Compare two semantic versions
 */
export function compareVersions(current, previous) {
  const comparison = semver.compare(current, previous);

  if (comparison > 0) {
    return 'higher';
  } else if (comparison < 0) {
    return 'lower';
  } else {
    return 'same';
  }
}

/**
 * Fetch git tags to ensure they're available in shallow clones
 */
export async function fetchTags() {
  try {
    logMessage('🏷️  Fetching git tags...');
    await execGit(['fetch', '--tags']);
    logMessage('✅ Git tags fetched successfully');
  } catch (error) {
    core.warning(`Could not fetch git tags: ${error.message}. Some version comparisons may be limited.`);
    logMessage(`⚠️  Warning: Could not fetch git tags: ${error.message}`, 'warning');
  }
}

/**
 * Main action logic
 */
export async function run() {
  try {
    logMessage('🔍 npm Version Check Action');

    // Get inputs
    const packagePath = core.getInput('package-path') || 'package.json';
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const skipFilesCheck = core.getInput('skip-files-check') === 'true';

    logMessage(`Package path: ${packagePath}`);
    logMessage(`Tag prefix: ${tagPrefix}`);
    logMessage(`Skip files check: ${skipFilesCheck}`);

    // This action only works on pull request events
    if (github.context.eventName !== 'pull_request') {
      logMessage(
        `⏭️  This action is designed for pull_request events. Current event: ${github.context.eventName}. Skipping version check.`
      );
      return;
    }

    // Fetch git tags to ensure they're available for version comparison
    await fetchTags();

    // Initialize outputs
    core.setOutput('version-changed', 'false');
    core.setOutput('current-version', '');
    core.setOutput('previous-version', '');

    // Check if we should run based on file changes
    if (!skipFilesCheck) {
      logMessage('📁 Checking files changed in PR...');

      const changedFiles = await getChangedFiles();
      logMessage(`Files changed: ${changedFiles.join(', ')}`);

      if (!hasRelevantFileChanges(changedFiles)) {
        logMessage('⏭️  No JavaScript/TypeScript or package files changed, skipping version check', 'warning');
        return;
      }

      logMessage('✅ JavaScript/TypeScript or package files changed, proceeding with version check...');
      const relevantFiles = changedFiles.filter(file => isRelevantFile(file));
      logMessage(`Changed files: ${relevantFiles.join(', ')}`);
    }

    // Read package.json
    const packageJson = readPackageJson(packagePath);
    const currentVersion = packageJson.version;

    logMessage(`📦 Current version: ${currentVersion}`);
    core.setOutput('current-version', currentVersion);

    // Get latest tag
    logMessage('🏷️  Fetching git tags...');
    const latestTag = await getLatestVersionTag(tagPrefix);

    if (!latestTag) {
      logMessage('🎉 No previous version tag found, this appears to be the first release.', 'notice');
      logMessage('✅ Version check passed - first release');
      core.setOutput('version-changed', 'true');
      return;
    }

    // Extract version from tag
    const latestVersion = latestTag.replace(tagPrefix, '');
    logMessage(`🔖 Latest released version: ${latestVersion} (tag: ${latestTag})`);
    core.setOutput('previous-version', latestVersion);

    // Compare versions
    logMessage('⚖️  Comparing versions...');
    const comparison = compareVersions(currentVersion, latestVersion);

    switch (comparison) {
      case 'same':
        core.setFailed(
          `❌ ERROR: Package version (${currentVersion}) is the same as the latest release. You need to increment it.`
        );
        logMessage(
          `💡 HINT: Run 'npm version patch', 'npm version minor', or 'npm version major' to increment the version`,
          'notice'
        );
        return;

      case 'lower':
        core.setFailed(
          `❌ ERROR: Package version (${currentVersion}) is lower than the latest release (${latestVersion})`
        );
        logMessage(
          '💡 HINT: Version should be higher than the previous release. Consider using semantic versioning.',
          'notice'
        );
        return;

      case 'higher':
        logMessage(`✅ Version has been properly incremented from ${latestVersion} to ${currentVersion}`);
        logMessage('🎯 Semantic versioning check passed!');
        core.setOutput('version-changed', 'true');
        break;
    }

    logMessage('🏁 Version check completed successfully');
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();

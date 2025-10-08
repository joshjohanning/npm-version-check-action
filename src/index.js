import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import semver from 'semver';

// Shared constants for validation
const SAFE_GIT_COMMANDS = ['diff', 'fetch', 'tag'];
const SAFE_GIT_OPTIONS = ['-l', '--name-only', '--tags'];
const SHA_PATTERN = /^[a-f0-9]{7,40}$/i;
// Pattern to detect shell metacharacters and other dangerous characters for command injection prevention
const SHELL_INJECTION_CHARS = /[;&|`$()'"<>]/;

// File relevance checking constants
const JS_TS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const RELEVANT_EXTENSIONS = [...JS_TS_EXTENSIONS, '.json'];
const EXCLUDED_DIRECTORIES = [
  'test',
  'tests',
  '__tests__',
  'doc',
  'docs',
  'example',
  'examples',
  'script',
  'scripts',
  '.github',
  '.vscode',
  'coverage',
  'dist',
  'build',
  'node_modules'
];
const EXCLUDED_FILE_PATTERNS = ['.test.', '.spec.', '.config.'];
const EXCLUDED_FILE_START_PATTERNS = ['test.', 'spec.'];

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
 * Execute a git command and return the output
 */
export async function execGit(args) {
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
    // Comprehensive validation and sanitization for GHAS compliance
    // This ensures GHAS sees explicit validation before exec
    const sanitizedArgs = args.map((arg, index) => {
      if (typeof arg !== 'string') {
        throw new Error('All git arguments must be strings');
      }

      // First argument must be a whitelisted git command
      if (index === 0 && !SAFE_GIT_COMMANDS.includes(arg)) {
        throw new Error(`Unsupported git command: ${arg}`);
      }

      // Allow known safe options
      if (SAFE_GIT_OPTIONS.includes(arg)) {
        return arg;
      }

      // Allow SHA hashes (for baseRef/headRef) - inline validation for GHAS
      if (SHA_PATTERN.test(arg)) {
        return arg;
      }

      // Reject dangerous git options that could execute commands
      if (arg.includes('--upload-pack') || arg.includes('--receive-pack') || arg.includes('--exec')) {
        throw new Error(`Dangerous git option detected: ${arg}`);
      }

      // Reject any argument that contains shell metacharacters
      if (SHELL_INJECTION_CHARS.test(arg)) {
        throw new Error(`Argument contains shell metacharacters: ${arg}`);
      }

      // Reject any other options that start with dash (not in whitelist)
      if (arg.startsWith('-')) {
        throw new Error(`Potentially dangerous git option: ${arg}`);
      }

      return arg; // Return the clean argument
    });

    await exec.exec('git', sanitizedArgs, options);
    return output.trim();
  } catch (err) {
    if (error) {
      throw new Error(`Git command failed: ${error}`);
    }
    throw err;
  }
}

/**
 * Sanitize and validate SHA values to prevent command injection
 *
 * This function ensures that SHA values used in git commands are safe by:
 * - Validating the input is a non-empty string
 * - Trimming whitespace
 * - Verifying the SHA format (7-40 hexadecimal characters)
 * - Checking for dangerous shell metacharacters
 *
 * @param {string} sha - The SHA value to sanitize and validate
 * @param {string} refName - A descriptive name for the reference (used in error messages)
 * @returns {string} The cleaned and validated SHA value
 * @throws {Error} When sha is null, undefined, or not a string
 * @throws {Error} When sha format is invalid (not 7-40 hex characters)
 * @throws {Error} When sha contains shell metacharacters that could be used for injection
 *
 * @example
 * const cleanSha = sanitizeSHA('a1b2c3d4e5f6', 'baseRef');
 * // Returns: 'a1b2c3d4e5f6'
 *
 * @example
 * sanitizeSHA('invalid; rm -rf /', 'headRef');
 * // Throws: Error: Invalid headRef: contains dangerous characters
 */
export function sanitizeSHA(sha, refName) {
  if (!sha || typeof sha !== 'string') {
    throw new Error(`Invalid ${refName}: must be a non-empty string`);
  }

  // Remove any whitespace
  const cleanSha = sha.trim();

  // Validate SHA format (7-40 hex characters) using shared pattern
  if (!SHA_PATTERN.test(cleanSha)) {
    throw new Error(`Invalid ${refName} format: ${cleanSha}. Must be a valid git SHA (7-40 hex characters)`);
  }

  // Additional safety: ensure no shell metacharacters using shared pattern
  if (SHELL_INJECTION_CHARS.test(cleanSha)) {
    throw new Error(`Invalid ${refName}: contains dangerous characters`);
  }

  return cleanSha;
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

  // Sanitize SHA values to prevent command injection
  const sanitizedBaseRef = sanitizeSHA(baseRef, 'baseRef');
  const sanitizedHeadRef = sanitizeSHA(headRef, 'headRef');

  const output = await execGit(['diff', '--name-only', sanitizedBaseRef, sanitizedHeadRef]);
  return output ? output.split('\n') : [];
}

/**
 * Check if a single file is relevant for version checking (excluding test files)
 */
export function isRelevantFile(file) {
  // Must have relevant extension
  if (!RELEVANT_EXTENSIONS.some(ext => file.endsWith(ext))) {
    return false;
  }

  // Helper function to check if file matches a directory pattern
  const matchesDirectory = dirName => {
    // Split the file path into segments and check for exact directory name match
    const segments = file.split('/');
    // Check if any path segment (excluding the filename) exactly matches the directory name
    const directorySegments = segments.slice(0, -1); // Remove filename
    return directorySegments.includes(dirName);
  };

  // Helper function to check if file matches a file pattern
  const matchesFilePattern = pattern => file.includes(pattern);

  // Helper function to check if filename starts with a pattern
  const filenameStartsWith = pattern => {
    const fileName = file.split('/').pop();
    return fileName.startsWith(pattern);
  };

  // Check if file should be excluded
  const isTestOrNonProdFile =
    EXCLUDED_DIRECTORIES.some(matchesDirectory) ||
    EXCLUDED_FILE_PATTERNS.some(matchesFilePattern) ||
    EXCLUDED_FILE_START_PATTERNS.some(filenameStartsWith);

  // Exclude test files and other non-production files
  if (isTestOrNonProdFile) {
    return false;
  }

  // Helper function to check if file is a package file
  const isPackageFile = filePath => {
    const fileName = filePath.split('/').pop();
    return fileName === 'package.json' || fileName === 'package-lock.json';
  };

  // Include package.json files (package.json, package-lock.json, etc.)
  if (isPackageFile(file)) {
    return true;
  }

  // At this point, include only JavaScript/TypeScript files (package files were already handled above)
  return JS_TS_EXTENSIONS.some(ext => file.endsWith(ext));
}

/**
 * Check if any JavaScript/TypeScript or package files were changed (excluding test files)
 */
export function hasRelevantFileChanges(changedFiles) {
  return changedFiles.some(file => isRelevantFile(file));
}

/**
 * Reads and parses a package.json file from the specified path.
 *
 * @param {string} packagePath - The file system path to the package.json file.
 * @returns {Object} The parsed contents of the package.json file as a JavaScript object.
 * @throws {Error} If the file does not exist, contains invalid JSON, or lacks a version field.
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
 * Retrieves the latest version tag from git that matches the specified prefix.
 *
 * @param {string} tagPrefix - The prefix to filter version tags (e.g., 'v' for tags like 'v1.2.3').
 * @returns {Promise<string|null>} The latest version tag matching the prefix, or null if none found.
 * @throws {Error} If fetching or parsing git tags fails.
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
 * Fetch git tags to ensure they're available in shallow clones.
 *
 * Runs 'git fetch --tags' to retrieve all tags from the remote repository.
 * Logs the process and handles errors by issuing a warning instead of throwing.
 * This function is designed to be non-blocking and will not fail the action if git tags cannot be fetched.
 *
 * @returns {Promise<void>} Resolves when tags have been fetched or a warning has been logged.
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
/**
 * Main entry point for the GitHub Action.
 *
 * This function orchestrates the version check workflow for npm packages in pull request events.
 * It validates the package version, compares it with existing git tags, and ensures versioning best practices.
 * Designed to be invoked automatically by GitHub Actions.
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

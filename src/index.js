import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';

// Shared constants for validation
const SAFE_GIT_COMMANDS = ['diff', 'fetch', 'tag', 'show'];
const SAFE_GIT_OPTIONS = ['-l', '--name-only', '--tags', '--'];

// Default skip keyword for bypassing version check on specific commits
const DEFAULT_SKIP_KEYWORD = '[skip version]';
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
const PACKAGE_JSON_FILENAME = 'package.json';
const PACKAGE_LOCK_JSON_FILENAME = 'package-lock.json';
const PACKAGE_FILENAMES = [PACKAGE_JSON_FILENAME, PACKAGE_LOCK_JSON_FILENAME];

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
    // Ensure args array is not empty before processing
    if (!args || args.length === 0) {
      throw new Error('Git command arguments cannot be empty');
    }

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

  // Remove any whitespace but preserve original case
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
 * Sanitize file path for use in git commands
 * @param {string} filePath - The file path to sanitize
 * @param {string} pathName - Name of the path parameter for error messages
 * @returns {string} Sanitized file path
 * @throws {Error} If file path is invalid or contains dangerous characters
 */
export function sanitizeFilePath(filePath, pathName) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Invalid ${pathName}: must be a non-empty string`);
  }

  const cleanPath = filePath.trim();

  // Check for shell metacharacters that could be used for command injection
  if (SHELL_INJECTION_CHARS.test(cleanPath)) {
    throw new Error(`Invalid ${pathName}: contains dangerous characters`);
  }

  // Check for path traversal attempts
  if (cleanPath.includes('..')) {
    throw new Error(`Invalid ${pathName}: path traversal not allowed`);
  }

  // Check for absolute paths (git show expects relative paths)
  if (cleanPath.startsWith('/')) {
    throw new Error(`Invalid ${pathName}: absolute paths not allowed`);
  }

  // Ensure path doesn't start with dangerous prefixes
  if (cleanPath.startsWith('-')) {
    throw new Error(`Invalid ${pathName}: paths starting with '-' not allowed`);
  }

  return cleanPath;
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
 * Get commits in the current PR with their messages
 * @param {string} token - GitHub token for API access
 * @returns {Promise<Array<{sha: string, message: string}>>} Array of commit objects with SHA and message
 */
export async function getCommitsWithMessages(token) {
  const context = github.context;

  if (context.eventName !== 'pull_request') {
    return [];
  }

  const prNumber = context.payload.pull_request?.number;
  if (!prNumber) {
    logMessage('⚠️  Could not determine PR number', 'warning');
    return [];
  }

  // Use GitHub API to get commits - works with shallow clones
  if (!token) {
    logMessage('⚠️  No token provided, cannot fetch PR commits via API', 'warning');
    return [];
  }

  try {
    const octokit = github.getOctokit(token);
    // Use pagination to handle PRs with more than 100 commits
    const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      per_page: 100
    });

    logMessage(`📋 Found ${commits.length} commits in PR`, 'debug');

    return commits.map(commit => ({
      sha: commit.sha,
      message: commit.commit.message // Full commit message for keyword matching
    }));
  } catch (error) {
    logMessage(`⚠️  Could not fetch PR commits via API: ${error.message}`, 'warning');
    return [];
  }
}

/**
 * Get files changed in a specific commit using GitHub API
 * @param {string} sha - The commit SHA
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<string[]>} Array of file paths changed in the commit
 */
export async function getFilesForCommit(sha, octokit, owner, repo) {
  try {
    const sanitizedSha = sanitizeSHA(sha, 'commitSha');

    const { data: commit } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: sanitizedSha
    });

    return commit.files ? commit.files.map(f => f.filename) : [];
  } catch (error) {
    logMessage(`⚠️  Could not fetch files for commit ${sha.substring(0, 7)}: ${error.message}`, 'warning');
    return [];
  }
}

/**
 * Get files changed in the PR, excluding files from commits that contain the skip keyword
 * @param {string} skipKeyword - The keyword to look for in commit messages
 * @param {string} token - GitHub token for API access
 * @returns {Promise<{files: string[], skippedCommits: number, totalCommits: number}>}
 */
export async function getChangedFilesWithSkipSupport(skipKeyword, token) {
  const context = github.context;
  const octokit = github.getOctokit(token);
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const commits = await getCommitsWithMessages(token);

  if (commits.length === 0) {
    return { files: [], skippedCommits: 0, totalCommits: 0 };
  }

  const filesFromNonSkippedCommits = new Set();
  let skippedCommits = 0;

  // Separate commits into skipped and non-skipped
  const nonSkippedCommits = [];
  for (const commit of commits) {
    const shouldSkip = skipKeyword && commit.message.toLowerCase().includes(skipKeyword.toLowerCase());

    if (shouldSkip) {
      skippedCommits++;
      logMessage(`⏭️  Skipping commit ${commit.sha.substring(0, 7)}: "${commit.message}"`, 'debug');
    } else {
      nonSkippedCommits.push(commit);
    }
  }

  // Fetch files for all non-skipped commits in parallel
  const fileResults = await Promise.all(
    nonSkippedCommits.map(commit => getFilesForCommit(commit.sha, octokit, owner, repo))
  );

  // Collect all unique files
  for (const files of fileResults) {
    for (const f of files) {
      filesFromNonSkippedCommits.add(f);
    }
  }

  return {
    files: [...filesFromNonSkippedCommits],
    skippedCommits,
    totalCommits: commits.length
  };
}

/**
 * Check if a single file is relevant for version checking (excluding test files)
 */
export function isRelevantFile(file) {
  // Extract file extension once for performance
  const fileExtension = path.extname(file);

  // Must have relevant extension
  if (!RELEVANT_EXTENSIONS.includes(fileExtension)) {
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
    const fileName = path.basename(file);
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
    const fileName = path.basename(filePath);
    return PACKAGE_FILENAMES.includes(fileName);
  };

  // Exclude both package.json and package-lock.json from regular file checking
  // They need smart dependency analysis instead of blanket inclusion
  if (isPackageFile(file)) {
    return false;
  }

  // At this point, include only JavaScript/TypeScript files (package files were already handled above)
  return JS_TS_EXTENSIONS.includes(fileExtension);
}

/**
 * Get file content at a specific git ref
 * @param {string} filePath - The file path to retrieve
 * @param {string} ref - The git reference (SHA, branch, etc.)
 * @returns {Promise<string|null>} The file content or null if not found
 */
async function getFileAtRef(filePath, ref) {
  try {
    // Sanitize both parameters to prevent command injection
    const sanitizedRef = sanitizeSHA(ref, 'ref');
    const sanitizedFilePath = sanitizeFilePath(filePath, 'filePath');
    const output = await execGit(['show', `${sanitizedRef}:${sanitizedFilePath}`]);
    return output && output.trim() ? output.trim() : null;
  } catch {
    // File doesn't exist at this ref or other error
    return null;
  }
}

/**
 * Deep equality check for objects (sufficient for dependency trees)
 * @param {any} a - First object to compare
 * @param {any} b - Second object to compare
 * @param {WeakSet} [visited] - Set to track visited object pairs to prevent infinite recursion
 * @returns {boolean} True if objects are deeply equal
 */
function deepEqual(a, b, visited = new WeakSet()) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  // Prevent infinite recursion by tracking visited object pairs
  if (visited.has(a) || visited.has(b)) return a === b;
  visited.add(a);
  visited.add(b);

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], visited)) return false;
  }
  return true;
}

/**
 * Check if a package change is only metadata (peer, dev flags) without actual dependency changes
 * @param {Object} basePackage - Base version of package object
 * @param {Object} headPackage - Head version of package object
 * @returns {boolean} True if only metadata changed
 */
function isOnlyMetadataChange(basePackage, headPackage) {
  // If either package is missing, it means the package was added or removed,
  // which is a significant change and not a metadata-only change.
  if (!basePackage || !headPackage) return false;

  // Properties that matter for actual dependency changes
  const significantProps = ['version', 'resolved', 'integrity', 'dependencies', 'requires'];

  // Check if any significant properties changed
  for (const prop of significantProps) {
    if (!deepEqual(basePackage[prop], headPackage[prop])) {
      return false; // A significant change was found
    }
  }

  // If we get here, only metadata (like peer, dev flags) changed
  return true;
}

/**
 * Get changed package keys from package-lock.json dependencies or packages sections
 * Excludes metadata-only changes (like peer: true flag changes)
 * @param {Object} baseObj - Base version of dependencies/packages object
 * @param {Object} headObj - Head version of dependencies/packages object
 * @returns {Set<string>} Set of package keys that have changed (excluding metadata-only changes)
 */
function getChangedPackageKeys(baseObj, headObj) {
  const changedKeys = new Set();

  // Check all keys from both objects
  const allKeys = new Set([...Object.keys(baseObj || {}), ...Object.keys(headObj || {})]);

  for (const key of allKeys) {
    // Skip the root package entry (empty string key) as it represents the project itself
    if (key === '') continue;

    const basePackage = baseObj?.[key];
    const headPackage = headObj?.[key];

    // Check if packages are different
    if (!deepEqual(basePackage, headPackage)) {
      // If only metadata changed (peer, dev flags), skip it
      if (isOnlyMetadataChange(basePackage, headPackage)) {
        logMessage(`Debug: Skipping metadata-only change for package: ${key}`, 'debug');
        continue;
      }
      changedKeys.add(key);
    }
  }

  return changedKeys;
}

/**
 * Check if all changed packages in package-lock.json are dev dependencies
 * @param {Object} baseLock - Base package-lock.json content
 * @param {Object} headLock - Head package-lock.json content
 * @param {Set<string>} changedKeys - Set of changed package keys
 * @returns {boolean} True if all changes are dev dependencies only
 */
function areAllChangesDevDependencies(baseLock, headLock, changedKeys) {
  // Check packages section (npm v7+ format)
  if (headLock.packages || baseLock.packages) {
    const basePackages = baseLock.packages || {};
    const headPackages = headLock.packages || {};

    for (const key of changedKeys) {
      const basePackage = basePackages[key];
      const headPackage = headPackages[key];

      // If package exists in head and is not marked as dev, it's a production change
      if (headPackage && !headPackage.dev) {
        return false;
      }

      // If package was removed (exists in base but not head) and was not dev, it's a production change
      if (basePackage && !headPackage && !basePackage.dev) {
        return false;
      }
    }
    return true;
  }

  // For older lockfile formats (npm v6 and earlier), we can't reliably determine
  // if changes are dev-only, so conservatively return false
  return false;
}

/**
 * Check if package files have actual dependency changes (not just metadata changes)
 * This covers both package.json and package-lock.json files
 * @param {string[]|null} changedFiles - Optional list of changed files to filter which package files to check.
 *                                        If provided, only checks package files present in this list.
 *                                        If null/undefined, checks all package files that differ between base and head.
 * @returns {Promise<{hasChanges: boolean, onlyDevDependencies: boolean}>} Object indicating if there are changes and if they're dev-only
 */
export async function hasPackageDependencyChanges(changedFiles = null) {
  try {
    const context = github.context;
    if (context.eventName !== 'pull_request') {
      return { hasChanges: false, onlyDevDependencies: false };
    }

    const baseRef = context.payload.pull_request?.base?.sha;
    const headRef = context.sha;

    if (!baseRef || !headRef) {
      return { hasChanges: false, onlyDevDependencies: false };
    }

    const sanitizedBaseRef = sanitizeSHA(baseRef, 'baseRef');
    const sanitizedHeadRef = sanitizeSHA(headRef, 'headRef');

    // Determine which package files to check based on changedFiles filter
    const shouldCheckPackageJson =
      changedFiles === null || changedFiles.some(f => path.basename(f) === PACKAGE_JSON_FILENAME);
    const shouldCheckPackageLock =
      changedFiles === null || changedFiles.some(f => path.basename(f) === PACKAGE_LOCK_JSON_FILENAME);

    if (!shouldCheckPackageJson && !shouldCheckPackageLock) {
      logMessage('Debug: No package files in changed files list, skipping package dependency check', 'debug');
      return { hasChanges: false, onlyDevDependencies: false };
    }

    // Get configuration for dev dependencies
    const includeDevDependencies = core.getBooleanInput('include-dev-dependencies');
    logMessage(`Debug: include-dev-dependencies setting: ${includeDevDependencies}`, 'debug');

    let hasProductionChanges = false;
    let hasAnyDevChanges = false;

    // Check package.json for dependency changes using proper JSON parsing
    if (shouldCheckPackageJson) {
      const basePackageJsonRaw = await getFileAtRef(PACKAGE_JSON_FILENAME, sanitizedBaseRef);
      const headPackageJsonRaw = await getFileAtRef(PACKAGE_JSON_FILENAME, sanitizedHeadRef);

      if (basePackageJsonRaw && headPackageJsonRaw) {
        try {
          const basePackageJson = JSON.parse(basePackageJsonRaw);
          const headPackageJson = JSON.parse(headPackageJsonRaw);

          // Check production dependency sections
          const productionSections = [
            'dependencies',
            'peerDependencies',
            'optionalDependencies',
            'bundleDependencies',
            'bundledDependencies'
          ];

          // Check if any production dependencies changed
          for (const section of productionSections) {
            if (!deepEqual(basePackageJson[section], headPackageJson[section])) {
              logMessage(`Debug: package.json production dependency change detected in section: ${section}`, 'debug');
              hasProductionChanges = true;
              break;
            }
          }

          // Check if devDependencies changed
          if (!deepEqual(basePackageJson.devDependencies, headPackageJson.devDependencies)) {
            hasAnyDevChanges = true;
            if (includeDevDependencies) {
              logMessage(
                'Debug: package.json devDependencies change detected (include-dev-dependencies is true)',
                'debug'
              );
              hasProductionChanges = true;
            } else {
              logMessage('Debug: Only devDependencies changed in package.json', 'debug');
            }
          }
        } catch (error) {
          // If JSON parsing fails, conservatively assume a change
          logMessage(`Warning: Could not parse package.json for comparison: ${error.message}`, 'warning');
          return { hasChanges: true, onlyDevDependencies: false };
        }
      } else if (basePackageJsonRaw !== headPackageJsonRaw) {
        // One exists and the other doesn't
        return { hasChanges: true, onlyDevDependencies: false };
      }
    }

    // Check package-lock.json for actual dependency changes
    if (shouldCheckPackageLock) {
      const basePackageLockRaw = await getFileAtRef(PACKAGE_LOCK_JSON_FILENAME, sanitizedBaseRef);
      const headPackageLockRaw = await getFileAtRef(PACKAGE_LOCK_JSON_FILENAME, sanitizedHeadRef);

      if (basePackageLockRaw && headPackageLockRaw) {
        try {
          const baseLock = JSON.parse(basePackageLockRaw);
          const headLock = JSON.parse(headPackageLockRaw);

          // Check for changes in dependencies object (npm v6 and earlier)
          const dependenciesChanged = !deepEqual(baseLock.dependencies, headLock.dependencies);

          // Check for changes in packages object (npm v7+)
          const packagesChanged = !deepEqual(baseLock.packages, headLock.packages);

          if (dependenciesChanged || packagesChanged) {
            logMessage('Debug: package-lock.json has changes', 'debug');

            // Determine which packages changed (excluding metadata-only changes)
            let changedKeys = new Set();

            if (packagesChanged) {
              changedKeys = getChangedPackageKeys(baseLock.packages, headLock.packages);
            } else if (dependenciesChanged) {
              changedKeys = getChangedPackageKeys(baseLock.dependencies, headLock.dependencies);
            }

            // If no actual changes after filtering out metadata-only changes, skip
            if (changedKeys.size === 0) {
              logMessage('Debug: package-lock.json changes were metadata-only, skipping', 'debug');
            } else {
              // Check if all changes are dev dependencies only
              const allChangesAreDevOnly = areAllChangesDevDependencies(baseLock, headLock, changedKeys);

              if (allChangesAreDevOnly) {
                hasAnyDevChanges = true;
                if (includeDevDependencies) {
                  logMessage(
                    'Debug: package-lock.json devDependencies change detected (include-dev-dependencies is true)',
                    'debug'
                  );
                  hasProductionChanges = true;
                } else {
                  logMessage('Debug: Only devDependencies changed in package-lock.json', 'debug');
                }
              } else {
                logMessage('Debug: package-lock.json has production dependency changes', 'debug');
                hasProductionChanges = true;
              }
            }
          }
        } catch (error) {
          // If JSON parsing fails, conservatively assume a change
          logMessage(`Warning: Could not parse package-lock.json for comparison: ${error.message}`, 'warning');
          return { hasChanges: true, onlyDevDependencies: false };
        }
      } else if (basePackageLockRaw !== headPackageLockRaw) {
        // One exists and the other doesn't
        return { hasChanges: true, onlyDevDependencies: false };
      }
    }

    // Return result based on what we found
    if (hasProductionChanges) {
      return { hasChanges: true, onlyDevDependencies: false };
    } else if (hasAnyDevChanges) {
      return { hasChanges: false, onlyDevDependencies: true };
    } else {
      return { hasChanges: false, onlyDevDependencies: false };
    }
  } catch (error) {
    // If we can't determine dependency changes, err on the side of caution
    logMessage(`Warning: Could not check package dependency changes: ${error.message}`, 'warning');
    return { hasChanges: true, onlyDevDependencies: false };
  }
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
 * @throws {Error} If the file does not exist, contains invalid JSON, or if the file lacks a version field (throws "Could not extract version from ${packagePath}").
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
    // Handle skip-version-keyword: empty string explicitly disables, undefined/not-set uses default
    const skipKeywordInput = core.getInput('skip-version-keyword');
    const skipVersionKeyword = skipKeywordInput === '' ? '' : skipKeywordInput || DEFAULT_SKIP_KEYWORD;
    const token = core.getInput('token') || process.env.GITHUB_TOKEN;

    logMessage(`Package path: ${packagePath}`);
    logMessage(`Tag prefix: ${tagPrefix}`);
    logMessage(`Skip files check: ${skipFilesCheck}`);
    if (skipVersionKeyword) {
      logMessage(`Skip version keyword: ${skipVersionKeyword}`);
    }

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

      // Get changed files, respecting skip-version-keyword in commit messages
      let changedFiles;
      if (skipVersionKeyword && token) {
        logMessage(`🔍 Analyzing commits for skip keyword: "${skipVersionKeyword}"`);
        const result = await getChangedFilesWithSkipSupport(skipVersionKeyword, token);
        logMessage(`📋 Found ${result.totalCommits} commits in PR`);
        // If no commits were found (API error fallback), use regular getChangedFiles
        if (result.totalCommits === 0) {
          logMessage('ℹ️  Could not analyze individual commits, using standard file diff');
          changedFiles = await getChangedFiles();
        } else {
          changedFiles = result.files;
          if (result.skippedCommits > 0) {
            logMessage(
              `⏭️  Skipped ${result.skippedCommits} of ${result.totalCommits} commits containing "${skipVersionKeyword}"`,
              'notice'
            );
          } else {
            logMessage(`ℹ️  No commits contained skip keyword, all ${result.totalCommits} commits included`);
          }
        }
      } else {
        if (skipVersionKeyword && !token) {
          logMessage(
            '⚠️  skip-version-keyword requires a token input for API access, using standard file diff',
            'warning'
          );
        }
        changedFiles = await getChangedFiles();
      }
      logMessage(`Files changed: ${changedFiles.join(', ')}`);

      // Check for regular relevant file changes (JS/TS files, package-lock.json)
      const hasRegularChanges = hasRelevantFileChanges(changedFiles);

      // Check specifically for package dependency changes (package.json and package-lock.json)
      const packageDepResult = await hasPackageDependencyChanges(changedFiles);
      const hasPackageDepChanges = packageDepResult.hasChanges;
      const onlyDevDependencies = packageDepResult.onlyDevDependencies;

      if (!hasRegularChanges && !hasPackageDepChanges) {
        if (onlyDevDependencies) {
          logMessage('⏭️  Only devDependency changes detected, skipping version check', 'warning');
        } else {
          logMessage(
            '⏭️  No JavaScript/TypeScript files or dependency changes detected, skipping version check',
            'warning'
          );
        }
        return;
      }

      if (hasPackageDepChanges) {
        logMessage('✅ Package dependency changes detected, proceeding with version check...');
      }
      if (hasRegularChanges) {
        logMessage('✅ JavaScript/TypeScript file changes detected, proceeding with version check...');
        const relevantFiles = changedFiles.filter(file => isRelevantFile(file));
        logMessage(`Changed files: ${relevantFiles.join(', ')}`);
      }
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

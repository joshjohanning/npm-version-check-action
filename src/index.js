import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';

// Shared constants for validation
const SAFE_GIT_COMMANDS = ['diff', 'diff-tree', 'fetch', 'log', 'rev-list', 'tag', 'show'];
const SAFE_GIT_OPTIONS = [
  '-1',
  '-l',
  '-r',
  '--format=%B',
  '--format=%H%x1f%B%x1e',
  '--name-only',
  '--no-commit-id',
  '--tags',
  '--root',
  '--'
];

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

// Node runtime detection constants
const RUNS_BLOCK_PATTERN = /^runs[^\S\r\n]*:/m;
const DEFAULT_ACTION_YML_PATH = 'action.yml';

// Git history fetching constants
const DEFAULT_PR_COMMIT_COUNT = 100; // Fallback when PR payload doesn't include commit count
const FETCH_DEPTH_BUFFER = 10; // Extra depth to ensure base commit is included

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

      // Allow SHA range specs (e.g., abc1234..def5678) for git rev-list/log
      if (/^[a-f0-9]{7,40}\.\.[a-f0-9]{7,40}$/i.test(arg)) {
        return arg;
      }

      // Allow safe numeric options like --depth=N and --deepen=N
      if (/^--(?:depth|deepen)=\d+$/.test(arg)) {
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
  // Use pull_request.head.sha (actual PR head) instead of context.sha (merge commit)
  // to be consistent with getCommitsWithMessages() and avoid including merge commit files
  const headRef = context.payload.pull_request?.head?.sha || context.sha;

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
 * Get commits in the current PR with their messages using git commands.
 * Uses git rev-list and git log instead of the GitHub Pulls API, so only
 * contents: read permission is needed (no pull-requests: read).
 * @returns {Promise<Array<{sha: string, message: string}>>} Array of commit objects with SHA and message
 */
export async function getCommitsWithMessages() {
  const context = github.context;

  if (context.eventName !== 'pull_request') {
    return [];
  }

  const baseRef = context.payload.pull_request?.base?.sha;
  const headRef = context.payload.pull_request?.head?.sha;

  if (!baseRef || !headRef) {
    logMessage('⚠️ Could not determine base and head refs for PR', 'warning');
    return [];
  }

  const sanitizedBaseRef = sanitizeSHA(baseRef, 'baseRef');
  const sanitizedHeadRef = sanitizeSHA(headRef, 'headRef');

  try {
    // Ensure sufficient git history for enumerating PR commits.
    // With shallow clones (default actions/checkout fetch-depth: 1),
    // intermediate commits between base and head may not be available.
    const prCommitCount = context.payload.pull_request?.commits || DEFAULT_PR_COMMIT_COUNT;
    try {
      await execGit(['fetch', `--deepen=${prCommitCount + FETCH_DEPTH_BUFFER}`]);
    } catch {
      // May already have full history, which is fine
    }

    // Verify base commit is reachable after deepening; if not, try fetching more history
    try {
      await execGit(['rev-list', '-1', sanitizedBaseRef]);
    } catch {
      logMessage('⚠️ Base commit not reachable after initial deepen, fetching more history...', 'warning');
      try {
        await execGit(['fetch', '--unshallow']);
      } catch {
        // Already unshallowed or fetch failed - will attempt log anyway
      }
    }

    // Get all commits with messages in a single command using ASCII delimiters.
    // %x1f (Unit Separator) separates SHA from body, %x1e (Record Separator) separates records.
    // This avoids N+1 round-trips (one rev-list + one log per commit).
    const output = await execGit(['log', '--format=%H%x1f%B%x1e', `${sanitizedBaseRef}..${sanitizedHeadRef}`]);

    if (!output || !output.trim()) {
      return [];
    }

    const records = output.split('\x1e').filter(r => r.trim());
    logMessage(`📋 Found ${records.length} commits in PR`, 'debug');

    const commits = records
      .map(record => {
        const sepIndex = record.indexOf('\x1f');
        if (sepIndex === -1) {
          logMessage(`⚠️ Skipping malformed commit record (no separator found)`, 'warning');
          return null;
        }
        const sha = record.substring(0, sepIndex).trim();
        const message = record.substring(sepIndex + 1).trim();
        return { sha: sanitizeSHA(sha, 'commitSha'), message };
      })
      .filter(Boolean);

    return commits;
  } catch (error) {
    logMessage(`⚠️ Could not fetch PR commits via git: ${error.message}`, 'warning');
    return [];
  }
}

/**
 * Get files changed in a specific commit using git diff-tree.
 * Uses local git commands instead of the GitHub API, so no API token is needed.
 * @param {string} sha - The commit SHA
 * @returns {Promise<string[]>} Array of file paths changed in the commit
 */
export async function getFilesForCommit(sha) {
  try {
    const sanitizedSha = sanitizeSHA(sha, 'commitSha');

    // --root handles initial commits (those with no parent)
    const output = await execGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sanitizedSha]);

    return output ? output.split('\n').filter(Boolean) : [];
  } catch (error) {
    logMessage(`⚠️ Could not fetch files for commit ${sha.substring(0, 7)}: ${error.message}`, 'warning');
    return [];
  }
}

/**
 * Get files changed in the PR, excluding files from commits that contain the skip keyword.
 * Uses git commands instead of the GitHub API, so no token or pull-requests permission is needed.
 * @param {string} skipKeyword - The keyword to look for in commit messages
 * @returns {Promise<{files: string[], skippedCommits: number, totalCommits: number}>}
 */
export async function getChangedFilesWithSkipSupport(skipKeyword) {
  const commits = await getCommitsWithMessages();

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
      logMessage(`⏭️ Skipping commit ${commit.sha.substring(0, 7)}: "${commit.message}"`, 'debug');
    } else {
      nonSkippedCommits.push(commit);
    }
  }

  // Fetch files for all non-skipped commits in parallel
  const fileResults = await Promise.all(nonSkippedCommits.map(commit => getFilesForCommit(commit.sha)));

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
 * Resolve a dependency name to its lockfile key using npm's node_modules resolution algorithm.
 * Given a parent package key and a dependency name, walks up the directory tree to find
 * where npm installed the dependency (nested or hoisted).
 * @param {Object} lockPackages - The packages section of a package-lock.json
 * @param {string} parentKey - The lockfile key of the parent package (e.g., 'node_modules/jest/node_modules/chalk')
 * @param {string} depName - The dependency name to resolve (e.g., 'ansi-regex')
 * @returns {string|null} The lockfile key where the dependency is installed, or null if not found
 */
function resolveDepKey(lockPackages, parentKey, depName) {
  // Try nested first: node_modules/jest/node_modules/chalk -> node_modules/jest/node_modules/chalk/node_modules/depName
  // Then walk up: node_modules/jest/node_modules/depName, then node_modules/depName
  let searchBase = parentKey;

  while (searchBase) {
    const candidate = `${searchBase}/node_modules/${depName}`;
    if (lockPackages[candidate] !== undefined) {
      return candidate;
    }

    // Walk up: strip the last /node_modules/xxx segment
    const lastNM = searchBase.lastIndexOf('/node_modules/');
    if (lastNM === -1) {
      break;
    }
    searchBase = searchBase.substring(0, lastNM);
  }

  // Finally try top-level
  const topLevel = `node_modules/${depName}`;
  if (lockPackages[topLevel] !== undefined) {
    return topLevel;
  }

  return null;
}

/**
 * Extract the package name from a lockfile key.
 * For 'node_modules/cliui/node_modules/ansi-regex' returns 'ansi-regex'.
 * For 'node_modules/@scope/pkg' returns '@scope/pkg'.
 * @param {string} lockfileKey - The lockfile package key
 * @returns {string|null} The package name, or null if not a valid key
 */
function extractPackageName(lockfileKey) {
  const prefix = 'node_modules/';
  const lastNM = lockfileKey.lastIndexOf(prefix);
  if (lastNM === -1) return null;
  return lockfileKey.substring(lastNM + prefix.length);
}

/**
 * Walk the dependency tree in a lockfile's packages section to find all transitive
 * dependencies reachable from a set of starting packages.
 * Uses npm's node_modules resolution algorithm to handle nested and hoisted packages.
 * @param {Object} lockPackages - The packages section of a package-lock.json
 * @param {string[]} startKeys - Array of package keys to start walking from (e.g., ['node_modules/jest'])
 * @returns {Set<string>} Set of all reachable package keys including the start keys
 */
function getTransitiveDeps(lockPackages, startKeys) {
  const visited = new Set();
  const queue = [...startKeys];
  let i = 0;

  while (i < queue.length) {
    const key = queue[i++];
    if (visited.has(key)) continue;
    visited.add(key);

    const pkg = lockPackages[key];
    if (!pkg) continue;

    // Follow dependencies, optionalDependencies, and peerDependencies to reach all transitives.
    // npm v7+ auto-installs peerDependencies, so they can be reshuffled by devDep updates.
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}), ...(pkg.peerDependencies || {}) };
    for (const depName of Object.keys(deps)) {
      const resolvedKey = resolveDepKey(lockPackages, key, depName);
      if (resolvedKey && !visited.has(resolvedKey)) {
        queue.push(resolvedKey);
      }
    }
  }

  return visited;
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
    const changedDevDepNames = new Set();

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

            // Collect names of changed dev dependencies for lockfile tree walking analysis
            const baseDevDeps = basePackageJson.devDependencies || {};
            const headDevDeps = headPackageJson.devDependencies || {};
            const allDevNames = new Set([...Object.keys(baseDevDeps), ...Object.keys(headDevDeps)]);
            for (const name of allDevNames) {
              if (baseDevDeps[name] !== headDevDeps[name]) {
                changedDevDepNames.add(name);
              }
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

    // After package.json analysis: if package.json was checked, showed zero production
    // dependency section changes, AND confirmed devDependency changes, record that fact.
    // This is used to gate the lockfile analysis below, because npm can reshuffle the
    // lockfile tree (hoisting, deduplication) as a side-effect of any dependency change,
    // and those reshuffled packages may lack "dev": true.
    const packageJsonHasOnlyDevChanges = shouldCheckPackageJson && !hasProductionChanges && hasAnyDevChanges;

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
              } else if (packageJsonHasOnlyDevChanges) {
                // package.json shows only devDependency changes. Walk the dependency tree
                // from changed devDeps to determine if non-dev lockfile changes are just
                // reshuffling (transitive deps of the changed devDeps) or genuine production
                // changes (e.g., intentional transitive bumps for security fixes).
                const headPkgs = headLock.packages || {};
                const basePkgs = baseLock.packages || {};

                if (Object.keys(headPkgs).length > 0 || Object.keys(basePkgs).length > 0) {
                  const startKeys = [...changedDevDepNames].map(n => `node_modules/${n}`);
                  const headTransitives = getTransitiveDeps(headPkgs, startKeys);
                  const baseTransitives = getTransitiveDeps(basePkgs, startKeys);
                  const devTransitives = new Set([...headTransitives, ...baseTransitives]);

                  // Build a set of package names that have a *confirmed* dev-attributable
                  // changed entry (either reachable via tree walk or marked dev: true).
                  // Used for fallback reshuffling detection: npm may nest the same package
                  // at a different path than the tree walk finds, but we only allow the
                  // name-based fallback if there's corroborating evidence that the dev
                  // update actually affected this package name.
                  const confirmedDevChangedNames = new Set();
                  for (const cKey of changedKeys) {
                    const cHeadPkg = headPkgs[cKey];
                    const cBasePkg = basePkgs[cKey];
                    const isDev = (cHeadPkg && cHeadPkg.dev) || (!cHeadPkg && cBasePkg && cBasePkg.dev);
                    if (isDev || devTransitives.has(cKey)) {
                      const name = extractPackageName(cKey);
                      if (name) confirmedDevChangedNames.add(name);
                    }
                  }

                  let hasNonAttributableChange = false;
                  for (const key of changedKeys) {
                    const headPkg = headPkgs[key];
                    const basePkg = basePkgs[key];
                    // Skip packages already known to be dev-only
                    if ((headPkg && headPkg.dev) || (!headPkg && basePkg && basePkg.dev)) continue;

                    if (!devTransitives.has(key)) {
                      // Fallback: check if the package name (regardless of nesting path)
                      // also changed at another path that IS confirmed as a dev change.
                      // This handles npm reshuffling where a package is moved to a different
                      // node_modules nesting level, but only when there's corroborating
                      // evidence (another changed instance of the same package that is
                      // reachable from dev deps or marked dev: true).
                      const pkgName = extractPackageName(key);
                      if (pkgName && confirmedDevChangedNames.has(pkgName)) {
                        logMessage(
                          `Debug: lockfile change at ${key} attributed to devDependency reshuffling (package name ${pkgName} also changed at a confirmed dev path)`,
                          'debug'
                        );
                        continue;
                      }

                      logMessage(`Debug: lockfile change not attributable to devDependency update: ${key}`, 'debug');
                      hasNonAttributableChange = true;
                      break;
                    }
                  }

                  if (hasNonAttributableChange) {
                    logMessage(
                      'Debug: package-lock.json has production changes alongside devDependency reshuffling',
                      'debug'
                    );
                    hasProductionChanges = true;
                  } else {
                    logMessage(
                      'Debug: all non-dev lockfile changes are transitives of changed devDependencies - treating as reshuffling',
                      'debug'
                    );
                    hasAnyDevChanges = true;
                  }
                } else {
                  // No packages section available (old lockfile format) - can't walk tree, be conservative
                  logMessage(
                    'Debug: package-lock.json has non-dev changes but no packages section for tree analysis - treating as production',
                    'debug'
                  );
                  hasProductionChanges = true;
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
 * Parse the Node.js runtime version from action.yml content.
 * Finds the runs: block and extracts the version from the using: field.
 * Handles flexible key ordering, comments, and \\r\\n line endings.
 * @param {string} content - The raw content of an action.yml file
 * @returns {number|null} The Node.js runtime version number, or null if not found or not a node runtime
 */
export function parseNodeRuntime(content) {
  if (!content || typeof content !== 'string') return null;

  // Find where the runs: block starts
  const runsMatch = content.match(RUNS_BLOCK_PATTERN);
  if (!runsMatch) return null;

  // Extract the runs: block (from runs: to the next top-level key or end of file)
  const runsStart = runsMatch.index + runsMatch[0].length;
  const runsContent = content.substring(runsStart);

  // Find using: within the runs block, stopping at the next top-level key (non-indented line with a colon)
  const lines = runsContent.split(/\r?\n/);
  for (const line of lines) {
    // Stop at the next top-level key (non-empty, non-comment, no leading whitespace, has a colon)
    if (/^[a-zA-Z]/.test(line) && line.includes(':')) break;

    // Skip YAML comments
    if (line.trimStart().startsWith('#')) continue;

    // Only match the using key at the start of the line (with indentation)
    const usingMatch = line.match(/^\s+using:[^\S\r\n]*['"]?(node(\d+))['"]?/);
    if (usingMatch) {
      const version = parseInt(usingMatch[2], 10);
      return isNaN(version) ? null : version;
    }
  }

  return null;
}

/**
 * Detect if the Node.js runtime version changed in action.yml between base and head refs.
 * @param {string} baseRef - The base git ref (SHA)
 * @param {string} headRef - The head git ref (SHA)
 * @param {string} actionYmlPath - Path to the action.yml file
 * @returns {Promise<{changed: boolean, baseVersion: number|null, headVersion: number|null}>}
 */
export async function detectNodeRuntimeChange(baseRef, headRef, actionYmlPath) {
  const result = { changed: false, baseVersion: null, headVersion: null };

  try {
    const sanitizedBaseRef = sanitizeSHA(baseRef, 'baseRef');
    const sanitizedHeadRef = sanitizeSHA(headRef, 'headRef');

    const baseContent = await getFileAtRef(actionYmlPath, sanitizedBaseRef);
    const headContent = await getFileAtRef(actionYmlPath, sanitizedHeadRef);

    if (!baseContent || !headContent) {
      // action.yml doesn't exist at one or both refs - skip check
      return result;
    }

    result.baseVersion = parseNodeRuntime(baseContent);
    result.headVersion = parseNodeRuntime(headContent);

    if (result.baseVersion !== null && result.headVersion !== null && result.baseVersion !== result.headVersion) {
      result.changed = true;
    }

    return result;
  } catch (error) {
    logMessage(`Warning: Could not check action.yml runtime change: ${error.message}`, 'warning');
    return result;
  }
}

/**
 * Check if the version bump is a major version bump.
 * @param {string} currentVersion - The current version string (e.g., '2.0.0')
 * @param {string} previousVersion - The previous version string (e.g., '1.2.3')
 * @returns {boolean} True if the major version increased
 */
export function isMajorVersionBump(currentVersion, previousVersion) {
  if (
    !currentVersion ||
    !previousVersion ||
    typeof currentVersion !== 'string' ||
    typeof previousVersion !== 'string'
  ) {
    return false;
  }
  const currentMajor = parseInt(currentVersion.split('.')[0], 10);
  const previousMajor = parseInt(previousVersion.split('.')[0], 10);
  return !isNaN(currentMajor) && !isNaN(previousMajor) && currentMajor > previousMajor;
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
 * Validates that package.json and package-lock.json have consistent versions.
 * This prevents issues where one file is updated but the other is not.
 *
 * @param {string} packagePath - Path to the package.json file
 * @returns {{isValid: boolean, packageVersion: string|null, lockVersion: string|null, error: string|null}} Validation result
 */
export function validatePackageVersionConsistency(packagePath) {
  const result = {
    isValid: true,
    packageVersion: null,
    lockVersion: null,
    error: null
  };

  try {
    // Read package.json
    if (!fs.existsSync(packagePath)) {
      result.isValid = false;
      result.error = `package.json not found at path: ${packagePath}`;
      return result;
    }

    const packageContent = fs.readFileSync(packagePath, 'utf8');
    const packageJson = JSON.parse(packageContent);
    result.packageVersion = packageJson.version || null;

    // Derive package-lock.json path from package.json path
    const packageDir = path.dirname(packagePath);
    const lockPath = path.join(packageDir, PACKAGE_LOCK_JSON_FILENAME);

    // Check if package-lock.json exists
    if (!fs.existsSync(lockPath)) {
      // package-lock.json doesn't exist - this is acceptable, some projects don't use it
      logMessage('ℹ️ No package-lock.json found, skipping version consistency check', 'debug');
      return result;
    }

    // Read package-lock.json
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    const lockJson = JSON.parse(lockContent);
    result.lockVersion = lockJson.version || null;

    // Compare versions
    if (result.packageVersion && result.lockVersion && result.packageVersion !== result.lockVersion) {
      result.isValid = false;
      result.error = `Version mismatch: package.json has version "${result.packageVersion}" but package-lock.json has version "${result.lockVersion}". Run 'npm install' to sync the versions.`;
    }

    return result;
  } catch (error) {
    if (error instanceof SyntaxError) {
      result.isValid = false;
      result.error = `Invalid JSON: ${error.message}`;
      return result;
    }
    result.isValid = false;
    result.error = error.message;
    return result;
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
    logMessage('🏷️ Fetching git tags...');
    await execGit(['fetch', '--tags']);
    logMessage('✅ Git tags fetched successfully');
  } catch (error) {
    core.warning(`Could not fetch git tags: ${error.message}. Some version comparisons may be limited.`);
    logMessage(`⚠️ Warning: Could not fetch git tags: ${error.message}`, 'warning');
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
    const skipVersionConsistencyCheck = core.getInput('skip-version-consistency-check') === 'true';
    const skipMajorOnActionsRuntimeChange = core.getInput('skip-major-on-actions-runtime-change') === 'true';
    // Handle skip-version-keyword: empty string explicitly disables, undefined/not-set uses default
    const skipKeywordInput = core.getInput('skip-version-keyword');
    const skipVersionKeyword = skipKeywordInput === '' ? '' : skipKeywordInput || DEFAULT_SKIP_KEYWORD;

    // Warn if deprecated token input is still provided
    const tokenInput = core.getInput('token');
    if (tokenInput) {
      core.setSecret(tokenInput);
      core.warning(
        'The `token` input is deprecated and ignored. The skip-version-keyword feature now uses local git commands instead of the GitHub API.'
      );
    }

    logMessage(`Package path: ${packagePath}`);
    logMessage(`Tag prefix: ${tagPrefix}`);
    logMessage(`Skip files check: ${skipFilesCheck}`);
    logMessage(`Skip version consistency check: ${skipVersionConsistencyCheck}`);
    logMessage(`Skip major on actions runtime change: ${skipMajorOnActionsRuntimeChange}`);
    if (skipVersionKeyword) {
      logMessage(`Skip version keyword: ${skipVersionKeyword}`);
    }

    // This action only works on pull request events
    if (github.context.eventName !== 'pull_request') {
      logMessage(
        `⏭️ This action is designed for pull_request events. Current event: ${github.context.eventName}. Skipping version check.`
      );
      return;
    }

    // Fetch git tags to ensure they're available for version comparison
    await fetchTags();

    // Initialize outputs
    core.setOutput('version-changed', 'false');
    core.setOutput('current-version', '');
    core.setOutput('previous-version', '');
    core.setOutput('runtime-changed', 'false');

    // Check if we should run based on file changes
    if (!skipFilesCheck) {
      logMessage('📁 Checking files changed in PR...');

      // Get changed files, respecting skip-version-keyword in commit messages
      let changedFiles;
      if (skipVersionKeyword) {
        logMessage(`🔍 Analyzing commits for skip keyword: "${skipVersionKeyword}"`);
        const result = await getChangedFilesWithSkipSupport(skipVersionKeyword);
        logMessage(`📋 Found ${result.totalCommits} commits in PR`);
        // If no commits were found (git error fallback), use regular getChangedFiles
        if (result.totalCommits === 0) {
          logMessage('ℹ️ Could not analyze individual commits, using standard file diff');
          logMessage(
            `⚠️ Skip keyword "${skipVersionKeyword}" will be ignored - falling back to full PR diff`,
            'warning'
          );
          changedFiles = await getChangedFiles();
        } else {
          changedFiles = result.files;
          if (result.skippedCommits > 0) {
            logMessage(
              `⏭️ Skipped ${result.skippedCommits} of ${result.totalCommits} commits containing "${skipVersionKeyword}"`,
              'notice'
            );
          } else {
            logMessage(`ℹ️ No commits contained skip keyword, all ${result.totalCommits} commits included`);
          }
        }
      } else {
        changedFiles = await getChangedFiles();
      }
      logMessage(`Files changed: ${changedFiles.join(', ')}`);

      // Check for regular relevant file changes (JS/TS files, package-lock.json)
      const hasRegularChanges = hasRelevantFileChanges(changedFiles);

      // Check specifically for package dependency changes (package.json and package-lock.json)
      const packageDepResult = await hasPackageDependencyChanges(changedFiles);
      const hasPackageDepChanges = packageDepResult.hasChanges;
      const onlyDevDependencies = packageDepResult.onlyDevDependencies;

      // Check if action.yml has an actual runtime change (not just metadata edits)
      let hasRuntimeChange = false;
      if (!skipMajorOnActionsRuntimeChange) {
        const actionYmlChanged = changedFiles.some(
          f => f === DEFAULT_ACTION_YML_PATH || f.endsWith(`/${DEFAULT_ACTION_YML_PATH}`)
        );
        if (actionYmlChanged) {
          const baseRef = github.context.payload.pull_request?.base?.sha;
          const headRef = github.context.payload.pull_request?.head?.sha || github.context.sha;
          if (baseRef && headRef) {
            const earlyRuntimeCheck = await detectNodeRuntimeChange(baseRef, headRef, DEFAULT_ACTION_YML_PATH);
            hasRuntimeChange = earlyRuntimeCheck.changed;
          }
        }
      }

      if (!hasRegularChanges && !hasPackageDepChanges && !hasRuntimeChange) {
        if (onlyDevDependencies) {
          logMessage('⏭️ Only devDependency changes detected, skipping version check', 'notice');
        } else {
          logMessage(
            '⏭️ No JavaScript/TypeScript files or dependency changes detected, skipping version check',
            'notice'
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
      if (hasRuntimeChange && !hasRegularChanges && !hasPackageDepChanges) {
        logMessage('✅ action.yml Node.js Actions runtime change detected, proceeding with version check...');
      }
    }

    // Validate package.json and package-lock.json version consistency
    if (!skipVersionConsistencyCheck) {
      logMessage('🔄 Checking package.json and package-lock.json version consistency...');
      const consistencyResult = validatePackageVersionConsistency(packagePath);
      if (!consistencyResult.isValid) {
        core.setFailed(`❌ ERROR: ${consistencyResult.error}`);
        logMessage(`💡 HINT: Run 'npm install' to regenerate package-lock.json with the correct version`, 'notice');
        return;
      }
      if (consistencyResult.lockVersion) {
        logMessage(`✅ Version consistency check passed (${consistencyResult.packageVersion})`);
      }
    } else {
      logMessage('⏭️ Skipping version consistency check (skip-version-consistency-check: true)');
    }

    // Read package.json
    const packageJson = readPackageJson(packagePath);
    const currentVersion = packageJson.version;

    logMessage(`📦 Current version: ${currentVersion}`);
    core.setOutput('current-version', currentVersion);

    // Get latest tag
    logMessage('🏷️ Fetching git tags...');
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
    logMessage('⚖️ Comparing versions...');
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

    // Check if action.yml node runtime changed and require major version bump
    if (!skipMajorOnActionsRuntimeChange) {
      const baseRef = github.context.payload.pull_request?.base?.sha;
      const headRef = github.context.payload.pull_request?.head?.sha || github.context.sha;

      if (baseRef && headRef) {
        const runtimeChange = await detectNodeRuntimeChange(baseRef, headRef, DEFAULT_ACTION_YML_PATH);

        if (runtimeChange.changed) {
          logMessage(
            `⚠️ Node.js Actions runtime changed: node${runtimeChange.baseVersion} -> node${runtimeChange.headVersion}`
          );
          core.setOutput('runtime-changed', 'true');

          if (!isMajorVersionBump(currentVersion, latestVersion)) {
            core.setFailed(
              `❌ ERROR: action.yml Node.js Actions runtime changed from node${runtimeChange.baseVersion} to node${runtimeChange.headVersion}. This requires a MAJOR version bump (current: ${currentVersion}, previous: ${latestVersion}).`
            );
            logMessage(
              `💡 HINT: Node.js Actions runtime changes are breaking changes for action consumers. Run 'npm version major' to increment the major version.`,
              'notice'
            );
            return;
          }

          logMessage(
            `✅ Major version bump detected for Node.js Actions runtime change (node${runtimeChange.baseVersion} -> node${runtimeChange.headVersion})`
          );
        }
      }
    }

    logMessage('🏁 Version check completed successfully');
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();

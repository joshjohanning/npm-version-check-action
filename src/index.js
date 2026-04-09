import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';

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
 * Get commits in the current PR with their messages
 * @param {object} octokit - Authenticated Octokit instance
 * @returns {Promise<Array<{sha: string, message: string}>>} Array of commit objects with SHA and message
 */
export async function getCommitsWithMessages(octokit) {
  const context = github.context;

  if (context.eventName !== 'pull_request') {
    return [];
  }

  const prNumber = context.payload.pull_request?.number;
  if (!prNumber) {
    logMessage('⚠️ Could not determine PR number', 'warning');
    return [];
  }

  try {
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
    logMessage(`⚠️ Could not fetch PR commits via API: ${error.message}`, 'warning');
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
    if (error.status === 404) {
      logMessage(`⚠️ Could not fetch files for commit ${sha.substring(0, 7)}: ${error.message}`, 'warning');
      return [];
    }
    throw error;
  }
}

/**
 * Get the PR diff files using the pulls.listFiles API (base...head comparison).
 * This is the source of truth for which files have a net change in the PR.
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Pull request number
 * @returns {Promise<string[]>} Array of file paths with net changes in the PR
 */
export async function getPRDiffFiles(octokit, owner, repo, prNumber) {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100
  });

  return files.map(f => f.filename);
}

/**
 * Apply skip-keyword filtering to PR diff files. Only call this when the PR
 * diff contains files that would actually trigger a version check — this avoids
 * unnecessary commit API calls when the PR has no relevant changes.
 * @param {string[]} prDiffFiles - Files from the PR diff
 * @param {string} skipKeyword - The keyword to look for in commit messages
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<{files: string[], skippedCommits: number, totalCommits: number}>}
 */
export async function applySkipKeywordFilter(prDiffFiles, skipKeyword, octokit, owner, repo) {
  // Guard against empty keyword — every string includes '', which would skip all commits
  if (!skipKeyword || !skipKeyword.trim()) {
    return { files: prDiffFiles, skippedCommits: 0, totalCommits: 0 };
  }

  const commits = await getCommitsWithMessages(octokit);

  if (commits.length === 0) {
    return { files: prDiffFiles, skippedCommits: 0, totalCommits: 0 };
  }

  // Use a Set of skipped SHAs for O(1) lookups
  let skippedCommits = 0;
  const skippedSHAs = new Set();
  for (const commit of commits) {
    if (commit.message.toLowerCase().includes(skipKeyword.toLowerCase())) {
      skippedCommits++;
      skippedSHAs.add(commit.sha);
      logMessage(`⏭️ Skipping commit ${commit.sha.substring(0, 7)}: "${commit.message}"`, 'debug');
    }
  }

  // If no commits were skipped, the PR diff is the final answer
  if (skippedCommits === 0) {
    return { files: prDiffFiles, skippedCommits: 0, totalCommits: commits.length };
  }

  // If ALL commits were skipped, no files to check
  if (skippedCommits === commits.length) {
    return { files: [], skippedCommits, totalCommits: commits.length };
  }

  // Some commits were skipped — we need per-commit file analysis to determine
  // which PR diff files should be excluded. A file is kept only if it appears
  // in at least one non-skipped commit.
  const nonSkippedCommits = commits.filter(c => !skippedSHAs.has(c.sha));

  // Fetch files for non-skipped commits with bounded concurrency.
  // If any fetch fails (rate limit, permissions), fall back to the full PR diff
  // to avoid incorrectly filtering out files.
  const BATCH_SIZE = 10;
  const filesFromNonSkippedCommits = new Set();
  try {
    for (let i = 0; i < nonSkippedCommits.length; i += BATCH_SIZE) {
      const batch = nonSkippedCommits.slice(i, i + BATCH_SIZE);
      const fileResults = await Promise.all(batch.map(commit => getFilesForCommit(commit.sha, octokit, owner, repo)));
      for (const files of fileResults) {
        for (const f of files) {
          filesFromNonSkippedCommits.add(f);
        }
      }
    }
  } catch (error) {
    logMessage(`⚠️ Could not fetch commit files, using full PR diff: ${error.message}`, 'warning');
    return { files: prDiffFiles, skippedCommits, totalCommits: commits.length };
  }

  // Keep only PR diff files that also appear in a non-skipped commit
  const filtered = prDiffFiles.filter(f => filesFromNonSkippedCommits.has(f));

  return {
    files: filtered,
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
 * Get file content at a specific git ref using the GitHub API
 * @param {string} filePath - The file path to retrieve
 * @param {string} ref - The git reference (SHA, branch, etc.)
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<string|null>} The file content or null if not found
 */
async function getFileAtRef(filePath, ref, octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref
    });

    if (data.type !== 'file' || !data.content) {
      return null;
    }

    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    // File doesn't exist at this ref — return null
    if (error.status === 404) {
      return null;
    }
    // Other errors (rate limit, permissions, etc.) — rethrow so callers
    // can conservatively treat the change as relevant
    throw error;
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
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<{hasChanges: boolean, onlyDevDependencies: boolean}>} Object indicating if there are changes and if they're dev-only
 */
export async function hasPackageDependencyChanges(changedFiles = null, octokit = null, owner = null, repo = null) {
  try {
    const context = github.context;
    if (context.eventName !== 'pull_request') {
      return { hasChanges: false, onlyDevDependencies: false };
    }

    const baseRef = context.payload.pull_request?.base?.sha;
    const headRef = context.payload.pull_request?.head?.sha || context.sha;

    if (!baseRef || !headRef) {
      return { hasChanges: false, onlyDevDependencies: false };
    }

    if (!octokit || !owner || !repo) {
      logMessage('⚠️ Missing API client for package dependency check, assuming changes exist', 'warning');
      return { hasChanges: true, onlyDevDependencies: false };
    }

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
      const basePackageJsonRaw = await getFileAtRef(PACKAGE_JSON_FILENAME, baseRef, octokit, owner, repo);
      const headPackageJsonRaw = await getFileAtRef(PACKAGE_JSON_FILENAME, headRef, octokit, owner, repo);

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
      const basePackageLockRaw = await getFileAtRef(PACKAGE_LOCK_JSON_FILENAME, baseRef, octokit, owner, repo);
      const headPackageLockRaw = await getFileAtRef(PACKAGE_LOCK_JSON_FILENAME, headRef, octokit, owner, repo);

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
 * @param {object} octokit - The authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<{changed: boolean, baseVersion: number|null, headVersion: number|null}>}
 */
export async function detectNodeRuntimeChange(baseRef, headRef, actionYmlPath, octokit, owner, repo) {
  const result = { changed: false, baseVersion: null, headVersion: null };

  try {
    const baseContent = await getFileAtRef(actionYmlPath, baseRef, octokit, owner, repo);
    const headContent = await getFileAtRef(actionYmlPath, headRef, octokit, owner, repo);

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
    // Conservative: treat API failures as a potential change to avoid
    // silently skipping a required major version bump
    logMessage(`⚠️ Could not check action.yml runtime change: ${error.message}. Assuming change occurred.`, 'warning');
    return { changed: true, baseVersion: null, headVersion: null };
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
 * Retrieves the latest version tag from the repository using the GitHub API.
 *
 * Uses `octokit.paginate(octokit.rest.repos.listTags)` to fetch all tags via the
 * GitHub REST API, eliminating the need for `git fetch --tags` and local git credentials.
 * This enables `persist-credentials: false` on `actions/checkout` for improved security.
 *
 * @param {string} tagPrefix - The prefix to filter version tags (e.g., 'v' for tags like 'v1.2.3').
 * @param {object} octokit - Authenticated Octokit instance.
 * @returns {Promise<string|null>} The latest version tag matching the prefix, or null if none found.
 * @throws {Error} If fetching or parsing tags fails.
 */
export async function getLatestVersionTag(tagPrefix, octokit) {
  try {
    const { owner, repo } = github.context.repo;

    // Fetch all tags via GitHub API with pagination
    const tags = await octokit.paginate(octokit.rest.repos.listTags, {
      owner,
      repo,
      per_page: 100
    });

    const tagNames = tags.map(tag => tag.name);

    // Build a list of tags with valid semver versions after the prefix
    const versionEntries = tagNames
      .filter(name => name.startsWith(tagPrefix))
      .map(name => {
        const version = name.substring(tagPrefix.length);
        const validVersion = semver.valid(version);
        if (!validVersion) {
          return null;
        }
        return { tag: name, version: validVersion };
      })
      .filter(entry => entry !== null);

    if (versionEntries.length === 0) {
      return null;
    }

    // Sort tags by version and get the latest
    const sortedEntries = versionEntries.sort((a, b) => semver.compare(a.version, b.version));

    return sortedEntries[sortedEntries.length - 1].tag;
  } catch (error) {
    throw new Error(`Failed to fetch repository tags: ${error.message}`);
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
 * Validate that a version increment is sequential (exactly +1 for the changed component).
 * From version X.Y.Z, valid sequential increments are:
 * - X.Y.(Z+1) — patch bump
 * - X.(Y+1).0 — minor bump
 * - (X+1).0.0 — major bump
 *
 * @param {string} current - The current (new) version string (e.g., '4.2.0')
 * @param {string} previous - The previous (released) version string (e.g., '4.0.0')
 * @returns {{ isSequential: boolean, incrementType: string|null, expectedVersion: string|null, message: string }}
 */
export function isSequentialVersion(current, previous) {
  if (!current || !previous || typeof current !== 'string' || typeof previous !== 'string') {
    return { isSequential: false, incrementType: null, expectedVersion: null, message: 'Invalid version input' };
  }

  const currentParsed = semver.parse(current);
  const previousParsed = semver.parse(previous);

  if (!currentParsed || !previousParsed) {
    return { isSequential: false, incrementType: null, expectedVersion: null, message: 'Invalid version format' };
  }

  const { major: curMajor, minor: curMinor, patch: curPatch } = currentParsed;
  const { major: prevMajor, minor: prevMinor, patch: prevPatch } = previousParsed;

  // Guard: only classify bump type when current is strictly higher
  const cmp = semver.compare(current, previous);
  if (cmp <= 0) {
    if (cmp === 0) {
      return {
        isSequential: false,
        incrementType: null,
        expectedVersion: null,
        message: `Versions are equal: ${current}`
      };
    }
    return {
      isSequential: false,
      incrementType: null,
      expectedVersion: null,
      message: `Version ${current} is lower than ${previous}`
    };
  }

  // Determine which component changed
  if (curMajor > prevMajor) {
    const expectedVersion = `${prevMajor + 1}.0.0`;
    if (curMajor === prevMajor + 1 && curMinor === 0 && curPatch === 0) {
      return {
        isSequential: true,
        incrementType: 'major',
        expectedVersion,
        message: `Major version bump: ${previous} → ${current}`
      };
    }
    return {
      isSequential: false,
      incrementType: 'major',
      expectedVersion,
      message: `Non-sequential major bump: expected ${expectedVersion}, got ${current}`
    };
  }

  if (curMajor === prevMajor && curMinor > prevMinor) {
    const expectedVersion = `${prevMajor}.${prevMinor + 1}.0`;
    if (curMinor === prevMinor + 1 && curPatch === 0) {
      return {
        isSequential: true,
        incrementType: 'minor',
        expectedVersion,
        message: `Minor version bump: ${previous} → ${current}`
      };
    }
    return {
      isSequential: false,
      incrementType: 'minor',
      expectedVersion,
      message: `Non-sequential minor bump: expected ${expectedVersion}, got ${current}`
    };
  }

  if (curMajor === prevMajor && curMinor === prevMinor && curPatch > prevPatch) {
    const expectedVersion = `${prevMajor}.${prevMinor}.${prevPatch + 1}`;
    if (curPatch === prevPatch + 1) {
      return {
        isSequential: true,
        incrementType: 'patch',
        expectedVersion,
        message: `Patch version bump: ${previous} → ${current}`
      };
    }
    return {
      isSequential: false,
      incrementType: 'patch',
      expectedVersion,
      message: `Non-sequential patch bump: expected ${expectedVersion}, got ${current}`
    };
  }

  // No major/minor/patch component increased — prerelease-only change
  // (e.g., 1.0.0-beta.1 → 1.0.0 or 1.0.0-beta.1 → 1.0.0-beta.2)
  return {
    isSequential: true,
    incrementType: null,
    expectedVersion: null,
    message: `Prerelease version change: ${previous} → ${current}`
  };
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
    const skipSequentialVersionCheck = core.getBooleanInput('skip-sequential-version-check');
    const skipVersionKeyword = core.getInput('skip-version-keyword');
    const token = (core.getInput('token') || process.env.GITHUB_TOKEN || '').trim();

    logMessage(`Package path: ${packagePath}`);
    logMessage(`Tag prefix: ${tagPrefix}`);
    logMessage(`Skip files check: ${skipFilesCheck}`);
    logMessage(`Skip version consistency check: ${skipVersionConsistencyCheck}`);
    logMessage(`Skip major on actions runtime change: ${skipMajorOnActionsRuntimeChange}`);
    logMessage(`Skip sequential version check: ${skipSequentialVersionCheck}`);
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

    // Token is required for GitHub API calls (PR diff, tags, commits)
    if (!token) {
      core.setFailed(
        '❌ ERROR: GitHub token is required. Ensure the token input is configured or GITHUB_TOKEN is available.'
      );
      return;
    }
    core.setSecret(token);

    // Initialize GitHub API client
    const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
    const octokit = github.getOctokit(token, { baseUrl: apiUrl });
    const { owner: repoOwner, repo: repoName } = github.context.repo;

    // Initialize outputs
    core.setOutput('version-changed', 'false');
    core.setOutput('current-version', '');
    core.setOutput('previous-version', '');
    core.setOutput('runtime-changed', 'false');
    core.setOutput('version-increment-type', '');

    // Check if we should run based on file changes
    if (!skipFilesCheck) {
      logMessage('📁 Checking files changed in PR...');

      // Get the PR diff (one API call — source of truth)
      const prNumber = github.context.payload.pull_request?.number;
      let changedFiles = prNumber ? await getPRDiffFiles(octokit, repoOwner, repoName, prNumber) : [];
      logMessage(`Files changed: ${changedFiles.join(', ')}`);

      // Check if the PR diff has any files that would trigger a version check
      const hasRegularChanges = hasRelevantFileChanges(changedFiles);
      const packageDepResult = await hasPackageDependencyChanges(changedFiles, octokit, repoOwner, repoName);
      const hasPackageDepChanges = packageDepResult.hasChanges;
      const onlyDevDependencies = packageDepResult.onlyDevDependencies;

      let hasRuntimeChange = false;
      if (!skipMajorOnActionsRuntimeChange) {
        const actionYmlChanged = changedFiles.some(
          f => f === DEFAULT_ACTION_YML_PATH || f.endsWith(`/${DEFAULT_ACTION_YML_PATH}`)
        );
        if (actionYmlChanged) {
          const baseRef = github.context.payload.pull_request?.base?.sha;
          const headRef = github.context.payload.pull_request?.head?.sha || github.context.sha;
          if (baseRef && headRef) {
            const earlyRuntimeCheck = await detectNodeRuntimeChange(
              baseRef,
              headRef,
              DEFAULT_ACTION_YML_PATH,
              octokit,
              repoOwner,
              repoName
            );
            hasRuntimeChange = earlyRuntimeCheck.changed;
          }
        }
      }

      const wouldTriggerVersionCheck = hasRegularChanges || hasPackageDepChanges || hasRuntimeChange;

      // Stage 2: Only do commit analysis if the PR has relevant changes AND
      // skip keyword is set — otherwise there's nothing to skip
      if (wouldTriggerVersionCheck && skipVersionKeyword) {
        const result = await applySkipKeywordFilter(changedFiles, skipVersionKeyword, octokit, repoOwner, repoName);
        changedFiles = result.files;
        if (result.skippedCommits > 0) {
          logMessage(
            `⏭️ Skipped ${result.skippedCommits} of ${result.totalCommits} commits containing "${skipVersionKeyword}"`,
            'notice'
          );

          // Re-evaluate relevance after filtering
          const filteredHasRegularChanges = hasRelevantFileChanges(changedFiles);
          const filteredPackageDepResult = await hasPackageDependencyChanges(
            changedFiles,
            octokit,
            repoOwner,
            repoName
          );

          // Recompute runtime change — action.yml may have been filtered out
          let filteredHasRuntimeChange = false;
          if (hasRuntimeChange) {
            const actionYmlStillChanged = changedFiles.some(
              f => f === DEFAULT_ACTION_YML_PATH || f.endsWith(`/${DEFAULT_ACTION_YML_PATH}`)
            );
            filteredHasRuntimeChange = actionYmlStillChanged;
          }

          if (!filteredHasRegularChanges && !filteredPackageDepResult.hasChanges && !filteredHasRuntimeChange) {
            if (filteredPackageDepResult.onlyDevDependencies) {
              logMessage('⏭️ Only devDependency changes detected, skipping version check', 'notice');
            } else {
              logMessage(
                '⏭️ No JavaScript/TypeScript files or dependency changes detected, skipping version check',
                'notice'
              );
            }
            return;
          }
        }
      }

      if (!wouldTriggerVersionCheck) {
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

    // Get latest tag via GitHub API
    logMessage('🏷️ Fetching repository tags...');
    const latestTag = await getLatestVersionTag(tagPrefix, octokit);

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

      case 'higher': {
        // Check if the version increment is sequential before declaring success
        const sequentialResult = isSequentialVersion(currentVersion, latestVersion);
        if (sequentialResult.incrementType) {
          core.setOutput('version-increment-type', sequentialResult.incrementType);
        }
        if (!sequentialResult.isSequential && sequentialResult.incrementType && !skipSequentialVersionCheck) {
          core.setFailed(`❌ ERROR: ${sequentialResult.message}`);
          logMessage(
            `💡 HINT: Use 'npm version ${sequentialResult.incrementType}' from version ${latestVersion} to get ${sequentialResult.expectedVersion}`,
            'notice'
          );
          return;
        }

        logMessage(`✅ Version has been properly incremented from ${latestVersion} to ${currentVersion}`);
        logMessage('🎯 Semantic versioning check passed!');
        core.setOutput('version-changed', 'true');
        break;
      }
    }

    // Check if action.yml node runtime changed and require major version bump
    if (!skipMajorOnActionsRuntimeChange) {
      const baseRef = github.context.payload.pull_request?.base?.sha;
      const headRef = github.context.payload.pull_request?.head?.sha || github.context.sha;

      if (baseRef && headRef) {
        const runtimeChange = await detectNodeRuntimeChange(
          baseRef,
          headRef,
          DEFAULT_ACTION_YML_PATH,
          octokit,
          repoOwner,
          repoName
        );

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

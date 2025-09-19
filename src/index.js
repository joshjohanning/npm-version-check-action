import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import semver from 'semver';

/**
 * Log a message using GitHub Actions core logging
 */
function logMessage(message, level = 'info') {
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
async function execGit(args) {
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
async function getChangedFiles() {
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
 * Check if any JavaScript/TypeScript or package files were changed
 */
function hasRelevantFileChanges(changedFiles) {
  const relevantExtensions = /\.(js|ts|jsx|tsx|json)$/;
  const packageFiles = /package.*\.json$/;

  return changedFiles.some(file => {
    return (
      relevantExtensions.test(file) &&
      (file.endsWith('.js') ||
        file.endsWith('.ts') ||
        file.endsWith('.jsx') ||
        file.endsWith('.tsx') ||
        packageFiles.test(file))
    );
  });
}

/**
 * Read and parse package.json
 */
function readPackageJson(packagePath) {
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
async function getLatestVersionTag(tagPrefix) {
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
function compareVersions(current, previous) {
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
async function fetchTags() {
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
async function run() {
  try {
    logMessage('🔍 npm Version Check Action');

    // Get inputs
    const packagePath = core.getInput('package-path') || 'package.json';
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const skipFilesCheck = core.getInput('skip-files-check') === 'true';

    logMessage(`Package path: ${packagePath}`);
    logMessage(`Tag prefix: ${tagPrefix}`);
    logMessage(`Skip files check: ${skipFilesCheck}`);

    // Fetch git tags to ensure they're available for version comparison
    await fetchTags();

    // Initialize outputs
    core.setOutput('version-changed', 'false');
    core.setOutput('current-version', '');
    core.setOutput('previous-version', '');

    // Check if we should run based on file changes
    if (!skipFilesCheck && github.context.eventName === 'pull_request') {
      logMessage('📁 Checking files changed in PR...');

      const changedFiles = await getChangedFiles();
      logMessage(`Files changed: ${changedFiles.join(', ')}`);

      if (!hasRelevantFileChanges(changedFiles)) {
        logMessage('⏭️  No JavaScript/TypeScript or package files changed, skipping version check', 'warning');
        return;
      }

      logMessage('✅ JavaScript/TypeScript or package files changed, proceeding with version check...');
      const relevantFiles = changedFiles.filter(file => {
        const relevantExtensions = /\.(js|ts|jsx|tsx|json)$/;
        const packageFiles = /package.*\.json$/;
        return (
          relevantExtensions.test(file) &&
          (file.endsWith('.js') ||
            file.endsWith('.ts') ||
            file.endsWith('.jsx') ||
            file.endsWith('.tsx') ||
            packageFiles.test(file))
        );
      });
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
        '💡 HINT: Run \'npm version patch\', \'npm version minor\', or \'npm version major\' to increment the version',
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

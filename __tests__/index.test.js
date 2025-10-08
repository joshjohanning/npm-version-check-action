/**
 * Tests for the npm Version Check Action
 */

import { jest } from '@jest/globals';

// Mock process.exit to prevent tests from exiting
// eslint-disable-next-line no-unused-vars
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});

// Mock @actions/core before importing index.js
const mockCore = {
  getInput: jest.fn(() => ''),
  getBooleanInput: jest.fn(() => false),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  notice: jest.fn()
};

// Mock @actions/exec
const mockExec = {
  exec: jest.fn()
};

// Mock @actions/github
const mockGithub = {
  context: {
    eventName: 'pull_request',
    sha: 'abc123',
    payload: {
      pull_request: {
        base: {
          sha: 'def456'
        }
      }
    }
  }
};

// Mock semver
const mockSemver = {
  compare: jest.fn()
};

// Mock fs
jest.unstable_mockModule('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}));

jest.unstable_mockModule('@actions/core', () => mockCore);
jest.unstable_mockModule('@actions/exec', () => mockExec);
jest.unstable_mockModule('@actions/github', () => mockGithub);
jest.unstable_mockModule('semver', () => ({ default: mockSemver }));

// Dynamic import since we're using ES modules
const indexModule = await import('../src/index.js');

describe('npm Version Check Action - Helper Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createDirectoryPatterns', () => {
    test('should create patterns for multiple directories', () => {
      const { createDirectoryPatterns } = indexModule;
      const patterns = createDirectoryPatterns(['dist', 'build', 'coverage']);
      
      expect(patterns).toHaveLength(3);
      expect(patterns[0].test('dist/index.js')).toBe(true);
      expect(patterns[0].test('src/dist/index.js')).toBe(true);
      expect(patterns[1].test('build/app.js')).toBe(true);
      expect(patterns[2].test('coverage/report.html')).toBe(true);
      expect(patterns[0].test('src/index.js')).toBe(false);
    });

    test('should handle special regex characters in directory names', () => {
      const { createDirectoryPatterns } = indexModule;
      const patterns = createDirectoryPatterns(['.github', '.vscode']);
      
      expect(patterns[0].test('.github/workflows/test.yml')).toBe(true);
      expect(patterns[1].test('.vscode/settings.json')).toBe(true);
      expect(patterns[0].test('xgithub/file.js')).toBe(false); // Should not match without dot
    });
  });

  describe('isRelevantFile', () => {
    test('should identify JavaScript files as relevant', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('src/index.js')).toBe(true);
      expect(isRelevantFile('lib/utils.js')).toBe(true);
    });

    test('should identify TypeScript files as relevant', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('src/types.ts')).toBe(true);
      expect(isRelevantFile('components/App.tsx')).toBe(true);
    });

    test('should identify package.json files as relevant', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('package.json')).toBe(true);
      expect(isRelevantFile('packages/core/package.json')).toBe(true);
    });

    test('should exclude test files', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('src/index.test.js')).toBe(false);
      expect(isRelevantFile('src/index.spec.ts')).toBe(false);
      expect(isRelevantFile('__tests__/utils.js')).toBe(false);
      expect(isRelevantFile('tests/integration.js')).toBe(false);
      expect(isRelevantFile('test/unit.js')).toBe(false);
    });

    test('should exclude config files', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('jest.config.js')).toBe(false);
      expect(isRelevantFile('eslint.config.js')).toBe(false);
      expect(isRelevantFile('webpack.config.js')).toBe(false);
    });

    test('should exclude documentation files', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('docs/README.md')).toBe(false);
      expect(isRelevantFile('doc/api.md')).toBe(false);
    });

    test('should exclude build and dist directories', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('dist/index.js')).toBe(false);
      expect(isRelevantFile('build/app.js')).toBe(false);
      expect(isRelevantFile('node_modules/package/index.js')).toBe(false);
    });

    test('should exclude non-JavaScript/TypeScript files', () => {
      const { isRelevantFile } = indexModule;
      expect(isRelevantFile('README.md')).toBe(false);
      expect(isRelevantFile('styles.css')).toBe(false);
      expect(isRelevantFile('data.xml')).toBe(false);
    });
  });

  describe('hasRelevantFileChanges', () => {
    test('should return true when relevant files are changed', () => {
      const { hasRelevantFileChanges } = indexModule;
      const changedFiles = ['src/index.js', 'README.md', 'tests/unit.test.js'];
      expect(hasRelevantFileChanges(changedFiles)).toBe(true);
    });

    test('should return false when no relevant files are changed', () => {
      const { hasRelevantFileChanges } = indexModule;
      const changedFiles = ['README.md', 'docs/api.md', '__tests__/unit.test.js'];
      expect(hasRelevantFileChanges(changedFiles)).toBe(false);
    });

    test('should return false for empty file list', () => {
      const { hasRelevantFileChanges } = indexModule;
      expect(hasRelevantFileChanges([])).toBe(false);
    });
  });

  describe('compareVersions', () => {
    beforeEach(() => {
      mockSemver.compare.mockClear();
    });

    test('should return "higher" when current version is greater', () => {
      const { compareVersions } = indexModule;
      mockSemver.compare.mockReturnValue(1);

      const result = compareVersions('1.1.0', '1.0.0');
      expect(result).toBe('higher');
      expect(mockSemver.compare).toHaveBeenCalledWith('1.1.0', '1.0.0');
    });

    test('should return "lower" when current version is less', () => {
      const { compareVersions } = indexModule;
      mockSemver.compare.mockReturnValue(-1);

      const result = compareVersions('1.0.0', '1.1.0');
      expect(result).toBe('lower');
      expect(mockSemver.compare).toHaveBeenCalledWith('1.0.0', '1.1.0');
    });

    test('should return "same" when versions are equal', () => {
      const { compareVersions } = indexModule;
      mockSemver.compare.mockReturnValue(0);

      const result = compareVersions('1.0.0', '1.0.0');
      expect(result).toBe('same');
      expect(mockSemver.compare).toHaveBeenCalledWith('1.0.0', '1.0.0');
    });
  });

  describe('readPackageJson', () => {
    let mockFs;

    beforeAll(async () => {
      mockFs = await import('fs');
    });

    beforeEach(() => {
      mockFs.existsSync.mockClear();
      mockFs.readFileSync.mockClear();
    });

    test('should successfully read and parse valid package.json', () => {
      const { readPackageJson } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '1.0.0' };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson));

      const result = readPackageJson('package.json');
      expect(result).toEqual(mockPackageJson);
      expect(mockFs.existsSync).toHaveBeenCalledWith('package.json');
      expect(mockFs.readFileSync).toHaveBeenCalledWith('package.json', 'utf8');
    });

    test('should throw error when package.json does not exist', () => {
      const { readPackageJson } = indexModule;
      mockFs.existsSync.mockReturnValue(false);

      expect(() => readPackageJson('package.json')).toThrow('package.json not found at path: package.json');
    });

    test('should throw error when package.json has invalid JSON', () => {
      const { readPackageJson } = indexModule;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json }');

      expect(() => readPackageJson('package.json')).toThrow('Invalid JSON in package.json');
    });

    test('should throw error when package.json has no version', () => {
      const { readPackageJson } = indexModule;
      const mockPackageJson = { name: 'test-package' };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson));

      expect(() => readPackageJson('package.json')).toThrow('Could not extract version from package.json');
    });
  });

  describe('logMessage', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should log info messages by default', () => {
      const { logMessage } = indexModule;
      logMessage('Test message');
      expect(mockCore.info).toHaveBeenCalledWith('Test message');
    });

    test('should log error messages', () => {
      const { logMessage } = indexModule;
      logMessage('Error message', 'error');
      expect(mockCore.error).toHaveBeenCalledWith('Error message');
    });

    test('should log warning messages', () => {
      const { logMessage } = indexModule;
      logMessage('Warning message', 'warning');
      expect(mockCore.warning).toHaveBeenCalledWith('Warning message');
    });

    test('should log debug messages', () => {
      const { logMessage } = indexModule;
      logMessage('Debug message', 'debug');
      expect(mockCore.debug).toHaveBeenCalledWith('Debug message');
    });

    test('should log notice messages', () => {
      const { logMessage } = indexModule;
      logMessage('Notice message', 'notice');
      expect(mockCore.notice).toHaveBeenCalledWith('Notice message');
    });
  });
});

describe('npm Version Check Action - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = 'abc123';
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: 'def456' }
      }
    };
  });

  describe('execGit function', () => {
    test('should execute git commands successfully', async () => {
      const { execGit } = indexModule;
      mockExec.exec.mockResolvedValue(0);

      // Mock the stdout listener
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (options.listeners && options.listeners.stdout) {
          options.listeners.stdout('git output\n');
        }
        return 0;
      });

      const result = await execGit(['status']);
      expect(result).toBe('git output');
      expect(mockExec.exec).toHaveBeenCalledWith(
        'git',
        ['status'],
        expect.objectContaining({
          listeners: expect.any(Object),
          silent: true
        })
      );
    });

    test('should handle git command failures with stderr', async () => {
      const { execGit } = indexModule;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (options.listeners && options.listeners.stderr) {
          options.listeners.stderr('git error message');
        }
        throw new Error('Command failed');
      });

      await expect(execGit(['invalid-command'])).rejects.toThrow('Git command failed: git error message');
    });
  });

  describe('getChangedFiles function', () => {
    test('should return changed files for pull request', async () => {
      const { getChangedFiles } = indexModule;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (options.listeners && options.listeners.stdout) {
          options.listeners.stdout('src/index.js\npackage.json\nREADME.md\n');
        }
        return 0;
      });

      const result = await getChangedFiles();
      expect(result).toEqual(['src/index.js', 'package.json', 'README.md']);
    });

    test('should return empty array for non-pull request events', async () => {
      const { getChangedFiles } = indexModule;
      mockGithub.context.eventName = 'push';

      const result = await getChangedFiles();
      expect(result).toEqual([]);
    });

    test('should throw error when base or head refs are missing', async () => {
      const { getChangedFiles } = indexModule;
      mockGithub.context.payload.pull_request.base = null;

      await expect(getChangedFiles()).rejects.toThrow('Could not determine base and head refs for PR');
    });
  });

  describe('getLatestVersionTag function', () => {
    test('should return latest version tag', async () => {
      const { getLatestVersionTag } = indexModule;

      let callCount = 0;
      mockExec.exec.mockImplementation(async (command, args, options) => {
        callCount++;
        if (callCount === 1) {
          // First call: git fetch --tags
          return 0;
        } else if (callCount === 2) {
          // Second call: git tag -l
          if (options.listeners && options.listeners.stdout) {
            options.listeners.stdout('v1.0.0\nv1.1.0\nv1.0.1\nother-tag\n');
          }
          return 0;
        }
      });

      // Mock semver.compare to simulate proper version comparison for sorting
      mockSemver.compare.mockImplementation((a, b) => {
        // Simulate proper semver comparison
        const versions = {
          '1.0.0': 1,
          '1.0.1': 2,
          '1.1.0': 3
        };
        return versions[a] - versions[b];
      });

      const result = await getLatestVersionTag('v');
      expect(result).toBe('v1.1.0');
    });

    test('should return null when no version tags exist', async () => {
      const { getLatestVersionTag } = indexModule;

      let callCount = 0;
      mockExec.exec.mockImplementation(async (command, args, options) => {
        callCount++;
        if (callCount === 1) {
          return 0; // git fetch --tags
        } else if (callCount === 2) {
          if (options.listeners && options.listeners.stdout) {
            options.listeners.stdout('other-tag\nnothing-relevant\n');
          }
          return 0;
        }
      });

      const result = await getLatestVersionTag('v');
      expect(result).toBeNull();
    });

    test('should handle git fetch failure gracefully', async () => {
      const { getLatestVersionTag } = indexModule;

      mockExec.exec.mockImplementation(async (command, args) => {
        if (args.includes('fetch')) {
          throw new Error('Network error');
        }
        return 0;
      });

      await expect(getLatestVersionTag('v')).rejects.toThrow('Failed to fetch git tags: Network error');
    });
  });

  describe('Version comparison scenarios', () => {
    test('should correctly identify version increments', () => {
      const { compareVersions } = indexModule;

      // Test patch increment
      mockSemver.compare.mockReturnValue(1);
      expect(compareVersions('1.0.1', '1.0.0')).toBe('higher');

      // Test minor increment
      mockSemver.compare.mockReturnValue(1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe('higher');

      // Test major increment
      mockSemver.compare.mockReturnValue(1);
      expect(compareVersions('2.0.0', '1.0.0')).toBe('higher');
    });

    test('should correctly identify version decrements', () => {
      const { compareVersions } = indexModule;
      mockSemver.compare.mockReturnValue(-1);

      expect(compareVersions('1.0.0', '1.0.1')).toBe('lower');
    });

    test('should correctly identify same versions', () => {
      const { compareVersions } = indexModule;
      mockSemver.compare.mockReturnValue(0);

      expect(compareVersions('1.0.0', '1.0.0')).toBe('same');
    });
  });

  describe('File relevance filtering', () => {
    test('should correctly filter relevant files from changed files list', () => {
      const { hasRelevantFileChanges } = indexModule;

      const changedFiles = [
        'src/index.js', // relevant
        'package.json', // relevant
        'README.md', // not relevant
        '__tests__/unit.test.js', // not relevant
        'docs/api.md', // not relevant
        'lib/utils.ts' // relevant
      ];

      expect(hasRelevantFileChanges(changedFiles)).toBe(true);
    });

    test('should return false when only non-relevant files changed', () => {
      const { hasRelevantFileChanges } = indexModule;

      const changedFiles = ['README.md', '__tests__/unit.test.js', 'docs/api.md', 'jest.config.js'];

      expect(hasRelevantFileChanges(changedFiles)).toBe(false);
    });
  });

  describe('Package.json parsing edge cases', () => {
    let mockFs;

    beforeAll(async () => {
      mockFs = await import('fs');
    });

    test('should handle package.json with extra whitespace', () => {
      const { readPackageJson } = indexModule;
      const mockPackageJson = `
        {
          "name": "test-package",
          "version": "1.0.0"  
        }
      `;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(mockPackageJson);

      const result = readPackageJson('package.json');
      expect(result.version).toBe('1.0.0');
    });

    test('should handle package.json with complex version strings', () => {
      const { readPackageJson } = indexModule;
      const mockPackageJson = {
        name: 'test-package',
        version: '1.0.0-beta.1+build.123'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson));

      const result = readPackageJson('package.json');
      expect(result.version).toBe('1.0.0-beta.1+build.123');
    });
  });
});

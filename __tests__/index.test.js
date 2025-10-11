/**
 * Tests for the npm Version Check Action
 */

import { jest } from '@jest/globals';

// Mock process.exit to prevent tests from exiting
jest.spyOn(process, 'exit').mockImplementation(() => {});

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
    sha: 'abc1234',
    payload: {
      pull_request: {
        base: {
          sha: 'def4567'
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

// Helper function to create a mock implementation that simulates exec.exec behavior
function createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock) {
  return async (command, args, options) => {
    let output = '';

    // Handle fetchTags calls
    if (args.includes('fetch') && args.includes('--tags')) {
      output = '';
    }
    // Handle getChangedFiles calls
    else if (args.includes('diff') && args.includes('--name-only')) {
      output = '';
    }
    // Handle package.json file retrieval
    else if (args.includes('show') && args.includes('def4567:package.json')) {
      output = basePackageJson ? JSON.stringify(basePackageJson) : '';
    } else if (args.includes('show') && args.includes('abc1234:package.json')) {
      output = headPackageJson ? JSON.stringify(headPackageJson) : '';
    }
    // Handle package-lock.json file retrieval
    else if (args.includes('show') && args.includes('def4567:package-lock.json')) {
      if (basePackageLock) {
        output = JSON.stringify(basePackageLock);
      } else {
        throw new Error('File not found');
      }
    } else if (args.includes('show') && args.includes('abc1234:package-lock.json')) {
      if (headPackageLock) {
        output = JSON.stringify(headPackageLock);
      } else {
        throw new Error('File not found');
      }
    }

    // Simulate the stdout listener behavior from execGit
    if (options?.listeners?.stdout && output) {
      options.listeners.stdout(Buffer.from(output));
    }

    return 0; // Return exit code 0 for success
  };
}

describe('npm Version Check Action - Helper Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeSHA', () => {
    test('should accept valid SHA values', () => {
      const { sanitizeSHA } = indexModule;

      expect(() => sanitizeSHA('abc123d', 'testRef')).not.toThrow();
      expect(() => sanitizeSHA('1234567890abcdef', 'testRef')).not.toThrow();
      expect(() => sanitizeSHA('a'.repeat(40), 'testRef')).not.toThrow();
      expect(sanitizeSHA('  abc123d  ', 'testRef')).toBe('abc123d'); // Trims whitespace

      // Should accept both uppercase and lowercase but preserve original case
      expect(sanitizeSHA('ABC123D', 'testRef')).toBe('ABC123D');
      expect(sanitizeSHA('1234567890ABCDEF', 'testRef')).toBe('1234567890ABCDEF');
      expect(sanitizeSHA('  ABC123D  ', 'testRef')).toBe('ABC123D'); // Trims but preserves case
    });

    test('should reject invalid SHA formats', () => {
      const { sanitizeSHA } = indexModule;

      expect(() => sanitizeSHA('invalid', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123!', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('123', 'testRef')).toThrow('Invalid testRef format'); // Too short
      expect(() => sanitizeSHA('a'.repeat(41), 'testRef')).toThrow('Invalid testRef format'); // Too long
    });

    test('should reject dangerous characters', () => {
      const { sanitizeSHA } = indexModule;

      // These inputs contain dangerous characters and will be caught by SHA format validation first
      expect(() => sanitizeSHA('abc123; rm -rf /', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123 && echo evil', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123|cat /etc/passwd', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123`whoami`', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123$(id)', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123"evil"', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA(`abc123'evil'`, 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123<evil', 'testRef')).toThrow('Invalid testRef format');
      expect(() => sanitizeSHA('abc123>evil', 'testRef')).toThrow('Invalid testRef format');
    });

    test('should reject null, undefined, or non-string values', () => {
      const { sanitizeSHA } = indexModule;

      expect(() => sanitizeSHA(null, 'testRef')).toThrow('Invalid testRef: must be a non-empty string');
      expect(() => sanitizeSHA(undefined, 'testRef')).toThrow('Invalid testRef: must be a non-empty string');
      expect(() => sanitizeSHA('', 'testRef')).toThrow('Invalid testRef: must be a non-empty string');
      expect(() => sanitizeSHA(123, 'testRef')).toThrow('Invalid testRef: must be a non-empty string');
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

    test('should exclude package files from regular checking (handled by smart dependency logic)', () => {
      const { isRelevantFile } = indexModule;
      // Both package.json and package-lock.json are now handled separately via smart dependency checking
      expect(isRelevantFile('package.json')).toBe(false);
      expect(isRelevantFile('packages/core/package.json')).toBe(false);
      expect(isRelevantFile('package-lock.json')).toBe(false);
      expect(isRelevantFile('packages/utils/package-lock.json')).toBe(false);

      // Invalid package file names should still be rejected
      expect(isRelevantFile('my-package.json')).toBe(false); // Should not match
      expect(isRelevantFile('packagejson')).toBe(false); // Should not match
      expect(isRelevantFile('some-package.json')).toBe(false); // Should not match
      expect(isRelevantFile('custom-package-lock.json')).toBe(false); // Should not match
      expect(isRelevantFile('nested/path/package.json')).toBe(false); // package.json excluded
      expect(isRelevantFile('deep/nested/path/package-lock.json')).toBe(false); // package-lock.json excluded
    });

    test('should handle package.json pattern without ReDoS vulnerability', () => {
      const { isRelevantFile } = indexModule;

      // Test potentially problematic inputs that could cause ReDoS with the old pattern
      const startTime = Date.now();

      // These inputs should not cause exponential backtracking
      expect(isRelevantFile(`package${'a'.repeat(100)}.txt`)).toBe(false);
      expect(isRelevantFile(`package${'a'.repeat(100)}.json`)).toBe(false); // Not valid package file
      expect(isRelevantFile(`${'a'.repeat(100)}package.json`)).toBe(false); // Not a valid path

      const endTime = Date.now();

      // Should complete quickly (under 100ms) - ReDoS would take much longer
      expect(endTime - startTime).toBeLessThan(100);
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

    test('should handle edge cases with improved boundary checks', () => {
      const { isRelevantFile } = indexModule;

      // These should NOT be excluded (they are legitimate files)
      expect(isRelevantFile('scripts.js')).toBe(true); // Not the scripts/ directory
      expect(isRelevantFile('test-utils.js')).toBe(true); // Not a test file
      expect(isRelevantFile('myscript/file.js')).toBe(true); // Not the script/ directory
      expect(isRelevantFile('docs-generator.js')).toBe(true); // Not the docs/ directory
      expect(isRelevantFile('build-config.js')).toBe(true); // Not the build/ directory

      // These should still be excluded (they are in excluded directories/patterns)
      expect(isRelevantFile('script/build.js')).toBe(false); // In script/ directory
      expect(isRelevantFile('scripts/deploy.js')).toBe(false); // In scripts/ directory
      expect(isRelevantFile('test/helper.js')).toBe(false); // In test/ directory
      expect(isRelevantFile('my-component.test.js')).toBe(false); // Test file
      expect(isRelevantFile('docs/readme.js')).toBe(false); // In docs/ directory
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

describe('hasPackageDependencyChanges', () => {
  beforeEach(() => {
    // Reset to default PR context
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = 'abc1234';
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: 'def4567' }
      }
    };

    // Set default behavior for include-dev-dependencies (false)
    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false; // Default for other boolean inputs
    });
  });

  test('should return false for non-pull-request events', async () => {
    const { hasPackageDependencyChanges } = indexModule;
    mockGithub.context.eventName = 'push';

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return false when base or head refs are missing', async () => {
    const { hasPackageDependencyChanges } = indexModule;
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.payload = { pull_request: {} }; // No base ref

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return false when package.json has no changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const samePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0'
      }
    };

    mockExec.exec.mockImplementation(async (command, args, _options) => {
      if (args.includes('show') && (args.includes('def4567:package.json') || args.includes('abc1234:package.json'))) {
        return JSON.stringify(samePackageJson);
      }
      return '';
    });

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return true when dependencies section is changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.19.0',
        lodash: '^4.17.21'
      }
    };

    mockExec.exec.mockImplementation(async (command, args, options) => {
      let output = '';

      // Handle fetchTags calls
      if (args.includes('fetch') && args.includes('--tags')) {
        output = '';
      }
      // Handle getChangedFiles calls
      else if (args.includes('diff') && args.includes('--name-only')) {
        output = '';
      }
      // Handle package.json file retrieval
      else if (args.includes('show') && args.includes('def4567:package.json')) {
        output = JSON.stringify(basePackageJson);
      } else if (args.includes('show') && args.includes('abc1234:package.json')) {
        output = JSON.stringify(headPackageJson);
      }
      // Handle package-lock.json (return error to indicate no file)
      else if (args.includes('show') && args.includes('package-lock.json')) {
        throw new Error('File not found');
      }

      // Simulate the stdout listener behavior from execGit
      if (options?.listeners?.stdout && output) {
        options.listeners.stdout(Buffer.from(output));
      }

      return 0; // Return exit code 0 for success
    });

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when peerDependencies section is changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      peerDependencies: {
        react: '^18.0.0'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      peerDependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0'
      }
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when optionalDependencies section is changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      optionalDependencies: {
        'some-optional': '^1.0.0'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      optionalDependencies: {
        'some-optional': '^1.0.0',
        fsevents: '^2.3.0'
      }
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when bundleDependencies section is changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      bundleDependencies: ['existing-lib']
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      bundleDependencies: ['existing-lib', 'my-internal-lib']
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when bundledDependencies section is changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      bundledDependencies: ['existing-lib']
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      bundledDependencies: ['existing-lib', 'my-other-lib']
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return false when only metadata changes are present', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Base package.json with original metadata
    const basePackageJson = {
      name: 'my-package',
      version: '1.0.0',
      description: 'Original description',
      author: 'John Doe'
    };

    // Head package.json with only metadata changes (no dependency changes)
    const headPackageJson = {
      name: 'my-package',
      version: '1.0.1',
      description: 'Updated description',
      author: 'John Doe',
      keywords: ['test', 'package']
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return false when only devDependencies are changed (default behavior)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      devDependencies: {
        jest: '^29.0.0'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      devDependencies: {
        jest: '^29.5.0',
        eslint: '^8.0.0'
      }
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return true when devDependencies are changed and include-dev-dependencies is true', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      devDependencies: {
        jest: '^29.0.0'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      devDependencies: {
        jest: '^29.5.0',
        eslint: '^8.0.0'
      }
    };

    // Configure to include devDependencies in version bump requirement
    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return true;
      return false;
    });

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return false when only scripts are changed', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      scripts: {
        test: 'jest',
        build: 'webpack'
      }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      scripts: {
        test: 'jest',
        build: 'webpack --mode=production',
        dev: 'webpack --mode=development'
      }
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return true when mixed changes include dependencies', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'my-package',
      version: '1.0.0',
      description: 'Old description',
      dependencies: {
        express: '^4.18.0'
      },
      devDependencies: {
        jest: '^29.0.0'
      }
    };

    const headPackageJson = {
      name: 'my-package',
      version: '1.1.0',
      description: 'Updated description',
      dependencies: {
        express: '^4.19.0',
        lodash: '^4.17.21'
      },
      devDependencies: {
        jest: '^29.5.0'
      }
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when git command fails (err on side of caution)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Simulate a critical error that happens before getFileAtRef is called,
    // such as during SHA sanitization or context setup
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = 'abc1234';
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: 'invalid;injection' } // This should trigger sanitizeSHA error
      }
    };

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Could not check package dependency changes')
    );
  });

  test('should sanitize SHA values properly', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    mockExec.exec.mockImplementation(async (command, args, options) => {
      // Simulate successful response for package.json to avoid null content
      if (args.includes('show') && args.includes('package.json')) {
        const mockPackageJson = { name: 'test', version: '1.0.0' };
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from(JSON.stringify(mockPackageJson)));
        }
      }
      return 0;
    });

    await hasPackageDependencyChanges();
    // Verify that the git show commands are called with sanitized SHA values
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', 'def4567:package.json'], expect.any(Object));
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', 'abc1234:package.json'], expect.any(Object));
  });

  test('should handle complex dependency diffs with multiple sections', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const basePackageJson = {
      name: 'complex-package',
      dependencies: {
        express: '^4.18.0'
      },
      peerDependencies: {},
      scripts: {
        test: 'jest',
        build: 'webpack'
      },
      optionalDependencies: {}
    };

    const headPackageJson = {
      name: 'complex-package',
      dependencies: {
        express: '^4.19.0'
      },
      peerDependencies: {
        react: '^18.0.0'
      },
      scripts: {
        test: 'jest',
        build: 'webpack --mode=production'
      },
      optionalDependencies: {
        fsevents: '^2.3.0'
      }
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return true when package-lock.json has actual dependency changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Base package-lock.json with existing dependencies
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 2,
      dependencies: {
        'some-package': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/some-package/-/some-package-1.0.0.tgz',
          integrity: 'sha512-oldintegrity'
        }
      }
    };

    // Head package-lock.json with new dependencies
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 2,
      dependencies: {
        'some-package': {
          version: '1.1.0',
          resolved: 'https://registry.npmjs.org/some-package/-/some-package-1.1.0.tgz',
          integrity: 'sha512-newintegrity'
        },
        'new-dependency': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/new-dependency/-/new-dependency-2.0.0.tgz',
          integrity: 'sha512-newdepintegrity',
          dependencies: {
            'sub-dep': '^1.0.0'
          }
        }
      }
    };

    // No package.json changes, only package-lock.json changes
    const packageJson = {
      name: 'test-package',
      version: '1.0.0'
    };

    mockExec.exec.mockImplementation(createExecMock(packageJson, packageJson, basePackageLock, headPackageLock));

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });

  test('should return false when package-lock.json has only version metadata changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Base package.json - no changes
    const basePackageJson = {
      name: 'my-package',
      version: '1.0.0'
    };

    const headPackageJson = {
      name: 'my-package',
      version: '1.0.0'
    };

    // Base package-lock.json with dependencies
    const basePackageLock = {
      name: 'my-package',
      version: '1.0.0',
      lockfileVersion: 2,
      requires: true,
      dependencies: {
        express: {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz',
          integrity: 'sha512-example'
        }
      }
    };

    // Head package-lock.json with same dependencies, only top-level version changed
    const headPackageLock = {
      name: 'my-package',
      version: '1.0.1',
      lockfileVersion: 2,
      requires: true,
      dependencies: {
        express: {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz',
          integrity: 'sha512-example'
        }
      }
    };

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(false);
  });

  test('should return true when both package.json and package-lock.json have changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Base package.json
    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0'
      }
    };

    // Head package.json with new dependency
    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.19.0',
        lodash: '^4.17.21'
      }
    };

    // Base package-lock.json
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 2,
      dependencies: {
        express: {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz'
        }
      }
    };

    // Head package-lock.json with updated and new dependencies
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 2,
      dependencies: {
        express: {
          version: '4.19.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.19.0.tgz'
        },
        lodash: {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-newintegrity'
        }
      }
    };

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();
    expect(result).toBe(true);
  });
});

describe('npm Version Check Action - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = 'abc1234';
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: 'def4567' }
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

      const result = await execGit(['diff', '--name-only', 'abc1234', 'def4567']);
      expect(result).toBe('git output');
      expect(mockExec.exec).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'abc1234', 'def4567'],
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

      await expect(execGit(['diff', '--name-only', 'abc1234', 'def4567'])).rejects.toThrow(
        'Git command failed: git error message'
      );
    });

    test('should reject dangerous git arguments', async () => {
      const { execGit } = indexModule;

      await expect(execGit(['diff', '--upload-pack=/bin/sh'])).rejects.toThrow('Dangerous git option detected');
      await expect(execGit(['diff', '--exec=/bin/sh'])).rejects.toThrow('Dangerous git option detected');
      await expect(execGit(['diff', 'abc123; rm -rf /'])).rejects.toThrow('Argument contains shell metacharacters');
    });

    test('should reject unsupported git commands', async () => {
      const { execGit } = indexModule;

      await expect(execGit(['clone', 'https://example.com/repo.git'])).rejects.toThrow(
        'Unsupported git command: clone'
      );
      await expect(execGit(['push', 'origin', 'main'])).rejects.toThrow('Unsupported git command: push');
    });

    test('should reject dangerous options', async () => {
      const { execGit } = indexModule;

      await expect(execGit(['diff', '--dangerous-option'])).rejects.toThrow('Potentially dangerous git option');
      await expect(execGit(['fetch', '--upload-pack'])).rejects.toThrow('Dangerous git option detected');
    });

    test('should allow valid SHA hashes', async () => {
      const { execGit } = indexModule;
      mockExec.exec.mockResolvedValue(0);

      // Should not throw for valid SHA patterns
      await expect(execGit(['diff', '--name-only', 'a1b2c3d', 'f4e5d6c7b8a9'])).resolves.not.toThrow();
      await expect(execGit(['diff', '--name-only', 'abc123def456', '1234567890abcdef'])).resolves.not.toThrow();
    });

    test('should reject non-string arguments', async () => {
      const { execGit } = indexModule;

      await expect(execGit(['diff', null])).rejects.toThrow('All git arguments must be strings');
      await expect(execGit(['diff', 123])).rejects.toThrow('All git arguments must be strings');
      await expect(execGit(['diff', {}])).rejects.toThrow('All git arguments must be strings');
    });

    test('should reject empty arguments array', async () => {
      const { execGit } = indexModule;

      await expect(execGit([])).rejects.toThrow('Git command arguments cannot be empty');
      await expect(execGit(null)).rejects.toThrow('Git command arguments cannot be empty');
      await expect(execGit(undefined)).rejects.toThrow('Git command arguments cannot be empty');
    });

    test('should allow safe git commands and arguments', async () => {
      const { execGit } = indexModule;
      mockExec.exec.mockResolvedValue(0);

      await expect(execGit(['diff', '--name-only', 'abc1234', 'def4567'])).resolves.not.toThrow();
      await expect(execGit(['fetch', '--tags'])).resolves.not.toThrow();
      await expect(execGit(['tag', '-l'])).resolves.not.toThrow();
    });

    test('should allow double dash separator for file paths', async () => {
      const { execGit } = indexModule;
      mockExec.exec.mockResolvedValue(0);

      // Should not throw for the double dash separator used in hasPackageDependencyChanges
      await expect(execGit(['diff', 'abc1234', 'def4567', '--', 'package.json'])).resolves.not.toThrow();
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

    test('should sanitize SHA values and reject malicious input', async () => {
      const { getChangedFiles } = indexModule;

      // Test with malicious baseRef - will be caught by SHA format validation
      mockGithub.context.payload.pull_request.base.sha = 'abc123; rm -rf /';
      await expect(getChangedFiles()).rejects.toThrow('Invalid baseRef format');

      // Test with invalid SHA format
      mockGithub.context.payload.pull_request.base.sha = 'invalid-sha';
      await expect(getChangedFiles()).rejects.toThrow('Invalid baseRef format');

      // Reset to valid values
      mockGithub.context.payload.pull_request.base.sha = 'def4567';
      mockGithub.context.sha = 'abc1234';
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

  describe('fetchTags function', () => {
    test('should handle fetchTags success', async () => {
      const { fetchTags } = indexModule;

      mockExec.exec.mockResolvedValue(0);

      await fetchTags();

      expect(mockExec.exec).toHaveBeenCalledWith('git', ['fetch', '--tags'], expect.any(Object));
      expect(mockCore.warning).not.toHaveBeenCalled();
    });

    test('should handle fetchTags error gracefully', async () => {
      const { fetchTags } = indexModule;

      mockExec.exec.mockRejectedValue(new Error('Network error'));

      await fetchTags();

      expect(mockCore.warning).toHaveBeenCalledWith(
        'Could not fetch git tags: Network error. Some version comparisons may be limited.'
      );
    });
  });

  describe('hasPackageDependencyChanges JSON parsing errors', () => {
    test('should handle JSON parsing error in package.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock execGit to return invalid JSON for package.json
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === 'def4567:package.json') {
          options.listeners.stdout('{ invalid json }');
        } else if (args.includes('show') && args[1] === 'abc1234:package.json') {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      const result = await hasPackageDependencyChanges();
      expect(result).toBe(true); // Should conservatively assume change on parse error
    });

    test('should handle JSON parsing error in package-lock.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock execGit to return valid package.json but invalid package-lock.json
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1].includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        } else if (args.includes('show') && args[1] === 'def4567:package-lock.json') {
          options.listeners.stdout('{ invalid lock json }');
        } else if (args.includes('show') && args[1] === 'abc1234:package-lock.json') {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0", "dependencies": {} }');
        }
        return 0;
      });

      const result = await hasPackageDependencyChanges();
      expect(result).toBe(true); // Should conservatively assume change on parse error
    });
  });

  describe('run function integration tests', () => {
    let mockFs;

    beforeAll(async () => {
      mockFs = await import('fs');
    });

    beforeEach(() => {
      // Reset all mocks
      jest.clearAllMocks();

      // Set default successful mocks
      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'false';
          default:
            return '';
        }
      });
      mockCore.getBooleanInput.mockReturnValue(false);

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      mockExec.exec.mockResolvedValue(0);
    });

    test('should handle package dependency changes logging', async () => {
      const { run } = indexModule;

      // Mock changed files to include package.json with dependency changes
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('package.json\nsrc/index.js');
        } else if (args.includes('show') && args[1] === 'def4567:package.json') {
          options.listeners.stdout('{ "name": "test", "dependencies": { "lodash": "^4.0.0" } }');
        } else if (args.includes('show') && args[1] === 'abc1234:package.json') {
          options.listeners.stdout('{ "name": "test", "dependencies": { "lodash": "^4.1.0" } }');
        } else if (args.includes('tag')) {
          options.listeners.stdout('v1.0.0');
        }
        return 0;
      });

      await run();

      // Should log package dependency changes detected
      expect(mockCore.info).toHaveBeenCalledWith(
        '✅ Package dependency changes detected, proceeding with version check...'
      );
    });

    test('should handle regular file changes logging', async () => {
      const { run } = indexModule;

      // Mock changed files to include JS files
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js\nlib/utils.ts');
        } else if (args.includes('show') && args[1].includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        } else if (args.includes('tag')) {
          options.listeners.stdout('v1.0.0');
        }
        return 0;
      });

      await run();

      // Should log JS/TS file changes detected
      expect(mockCore.info).toHaveBeenCalledWith(
        '✅ JavaScript/TypeScript file changes detected, proceeding with version check...'
      );
      expect(mockCore.info).toHaveBeenCalledWith('Changed files: src/index.js, lib/utils.ts');
    });

    test('should handle first release scenario', async () => {
      const { run } = indexModule;

      // Mock no existing tags
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js');
        } else if (args.includes('tag')) {
          options.listeners.stdout(''); // No tags
        }
        return 0;
      });

      await run();

      expect(mockCore.notice).toHaveBeenCalledWith(
        '🎉 No previous version tag found, this appears to be the first release.'
      );
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
    });

    test('should handle version comparison - same version failure', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.0.0' }));

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js');
        } else if (args.includes('tag')) {
          options.listeners.stdout('v1.0.0');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(0); // Same version

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        '❌ ERROR: Package version (1.0.0) is the same as the latest release. You need to increment it.'
      );
      expect(mockCore.notice).toHaveBeenCalledWith(
        `💡 HINT: Run 'npm version patch', 'npm version minor', or 'npm version major' to increment the version`
      );
    });

    test('should handle version comparison - lower version failure', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '0.9.0' }));

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js');
        } else if (args.includes('tag')) {
          options.listeners.stdout('v1.0.0');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(-1); // Lower version

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        '❌ ERROR: Package version (0.9.0) is lower than the latest release (1.0.0)'
      );
      expect(mockCore.notice).toHaveBeenCalledWith(
        '💡 HINT: Version should be higher than the previous release. Consider using semantic versioning.'
      );
    });

    test('should handle version comparison - higher version success', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js');
        } else if (args.includes('tag')) {
          options.listeners.stdout('v1.0.0');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1); // Higher version

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('✅ Version has been properly incremented from 1.0.0 to 1.1.0');
      expect(mockCore.info).toHaveBeenCalledWith('🎯 Semantic versioning check passed!');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should handle general error in run function', async () => {
      const { run } = indexModule;

      // Mock fetchTags to throw an error that propagates up
      mockExec.exec.mockRejectedValue(new Error('Git command failed'));

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith('Action failed with error: Git command failed');
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

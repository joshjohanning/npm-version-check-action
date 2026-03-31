/**
 * Tests for the npm Version Check Action
 */

import { jest } from '@jest/globals';

// Test constants for consistent SHA values
const TEST_HEAD_SHA = 'abc1234';
const TEST_BASE_SHA = 'def4567';

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

// Mock Octokit methods
const mockOctokit = {
  rest: {
    pulls: {
      listCommits: jest.fn()
    },
    repos: {
      getCommit: jest.fn(),
      listTags: jest.fn()
    }
  },
  paginate: jest.fn()
};

// Mock @actions/github
const mockGithub = {
  context: {
    eventName: 'pull_request',
    sha: TEST_HEAD_SHA,
    payload: {
      pull_request: {
        base: {
          sha: TEST_BASE_SHA
        },
        number: 123
      }
    },
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    }
  },
  getOctokit: jest.fn(() => mockOctokit)
};

// Mock semver
const mockSemver = {
  compare: jest.fn(),
  valid: jest.fn(v => {
    const semverRegex =
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
    return semverRegex.test(v) ? v : null;
  })
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

    // Handle getChangedFiles calls
    if (args.includes('diff') && args.includes('--name-only')) {
      output = '';
    }
    // Handle package.json file retrieval
    else if (args.includes('show') && args.includes(`${TEST_BASE_SHA}:package.json`)) {
      output = basePackageJson ? JSON.stringify(basePackageJson) : '';
    } else if (args.includes('show') && args.includes(`${TEST_HEAD_SHA}:package.json`)) {
      output = headPackageJson ? JSON.stringify(headPackageJson) : '';
    }
    // Handle package-lock.json file retrieval
    else if (args.includes('show') && args.includes(`${TEST_BASE_SHA}:package-lock.json`)) {
      if (basePackageLock) {
        output = JSON.stringify(basePackageLock);
      } else {
        throw new Error('File not found');
      }
    } else if (args.includes('show') && args.includes(`${TEST_HEAD_SHA}:package-lock.json`)) {
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

  describe('sanitizeFilePath', () => {
    test('should accept valid file paths', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath('package.json', 'testPath')).not.toThrow();
      expect(() => sanitizeFilePath('package-lock.json', 'testPath')).not.toThrow();
      expect(() => sanitizeFilePath('src/index.js', 'testPath')).not.toThrow();
      expect(() => sanitizeFilePath('nested/dir/file.ts', 'testPath')).not.toThrow();
      expect(sanitizeFilePath('  package.json  ', 'testPath')).toBe('package.json'); // Trims whitespace
    });

    test('should reject dangerous file paths with shell metacharacters', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath('package.json; rm -rf /', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json && echo evil', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json|cat /etc/passwd', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json`whoami`', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json$(id)', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json"evil"', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath(`package.json'evil'`, 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json<evil', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
      expect(() => sanitizeFilePath('package.json>evil', 'testPath')).toThrow(
        'Invalid testPath: contains dangerous characters'
      );
    });

    test('should reject path traversal attempts', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath('../../../etc/passwd', 'testPath')).toThrow(
        'Invalid testPath: path traversal not allowed'
      );
      expect(() => sanitizeFilePath('package.json/../secret', 'testPath')).toThrow(
        'Invalid testPath: path traversal not allowed'
      );
      expect(() => sanitizeFilePath('./../../config', 'testPath')).toThrow(
        'Invalid testPath: path traversal not allowed'
      );
    });

    test('should reject absolute paths', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath('/etc/passwd', 'testPath')).toThrow('Invalid testPath: absolute paths not allowed');
      expect(() => sanitizeFilePath('/var/log/app.log', 'testPath')).toThrow(
        'Invalid testPath: absolute paths not allowed'
      );
    });

    test('should reject paths starting with dash', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath('-rf', 'testPath')).toThrow(
        `Invalid testPath: paths starting with '-' not allowed`
      );
      expect(() => sanitizeFilePath('--help', 'testPath')).toThrow(
        `Invalid testPath: paths starting with '-' not allowed`
      );
    });

    test('should reject null, undefined, or non-string values', () => {
      const { sanitizeFilePath } = indexModule;

      expect(() => sanitizeFilePath(null, 'testPath')).toThrow('Invalid testPath: must be a non-empty string');
      expect(() => sanitizeFilePath(undefined, 'testPath')).toThrow('Invalid testPath: must be a non-empty string');
      expect(() => sanitizeFilePath('', 'testPath')).toThrow('Invalid testPath: must be a non-empty string');
      expect(() => sanitizeFilePath(123, 'testPath')).toThrow('Invalid testPath: must be a non-empty string');
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

  describe('parseNodeRuntime', () => {
    test('should parse node version from standard action.yml content', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBe(20);
    });

    test('should parse node24 runtime', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBe(24);
    });

    test('should parse runtime without quotes', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using: node20\n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBe(20);
    });

    test('should parse runtime with double quotes', () => {
      const { parseNodeRuntime } = indexModule;

      const content = 'name: "my-action"\nruns:\n  using: "node20"\n  main: "dist/index.js"\n';
      expect(parseNodeRuntime(content)).toBe(20);
    });

    test('should return null for composite actions', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;
      expect(parseNodeRuntime(content)).toBeNull();
    });

    test('should return null for null/undefined/empty input', () => {
      const { parseNodeRuntime } = indexModule;

      expect(parseNodeRuntime(null)).toBeNull();
      expect(parseNodeRuntime(undefined)).toBeNull();
      expect(parseNodeRuntime('')).toBeNull();
      expect(parseNodeRuntime(123)).toBeNull();
    });

    test('should return null when runs section is missing', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\ndescription: 'A test action'\n`;
      expect(parseNodeRuntime(content)).toBeNull();
    });

    test('should handle action.yml with extra whitespace around using value', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using:   'node20'  \n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBe(20);
    });

    test('should return null for docker runtime', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  using: 'docker'\n  image: 'Dockerfile'\n`;
      expect(parseNodeRuntime(content)).toBeNull();
    });

    test('should handle node12 and node16 (older runtimes)', () => {
      const { parseNodeRuntime } = indexModule;

      expect(parseNodeRuntime(`runs:\n  using: 'node12'\n`)).toBe(12);
      expect(parseNodeRuntime(`runs:\n  using: 'node16'\n`)).toBe(16);
    });

    test('should ignore commented-out using lines', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  # using: 'node20'\n  using: 'node24'\n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBe(24);
    });

    test('should return null when using is only in a comment', () => {
      const { parseNodeRuntime } = indexModule;

      const content = `name: 'my-action'\nruns:\n  # using: 'node20'\n  main: 'dist/index.js'\n`;
      expect(parseNodeRuntime(content)).toBeNull();
    });
  });

  describe('isMajorVersionBump', () => {
    test('should return true for major version bump', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('2.0.0', '1.0.0')).toBe(true);
      expect(isMajorVersionBump('3.0.0', '2.5.1')).toBe(true);
      expect(isMajorVersionBump('10.0.0', '9.99.99')).toBe(true);
    });

    test('should return false for minor version bump', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('1.1.0', '1.0.0')).toBe(false);
      expect(isMajorVersionBump('1.5.0', '1.4.3')).toBe(false);
    });

    test('should return false for patch version bump', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('1.0.1', '1.0.0')).toBe(false);
      expect(isMajorVersionBump('1.0.5', '1.0.4')).toBe(false);
    });

    test('should return false for same version', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('1.0.0', '1.0.0')).toBe(false);
    });

    test('should return false for invalid versions', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('invalid', '1.0.0')).toBe(false);
      expect(isMajorVersionBump('1.0.0', 'invalid')).toBe(false);
    });

    test('should return false for null or undefined versions', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump(null, '1.0.0')).toBe(false);
      expect(isMajorVersionBump('1.0.0', null)).toBe(false);
      expect(isMajorVersionBump(undefined, '1.0.0')).toBe(false);
      expect(isMajorVersionBump(null, null)).toBe(false);
    });

    test('should return true for major bump with prerelease versions', () => {
      const { isMajorVersionBump } = indexModule;

      expect(isMajorVersionBump('2.0.0-beta.1', '1.5.0')).toBe(true);
    });

    test('should return false for version downgrade across major', () => {
      const { isMajorVersionBump } = indexModule;

      // 1.0.0 -> 0.9.0 is NOT a major bump, it is a downgrade
      expect(isMajorVersionBump('0.9.0', '1.0.0')).toBe(false);
    });
  });

  describe('detectNodeRuntimeChange', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should detect runtime change from node20 to node24', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(true);
      expect(result.baseVersion).toBe(20);
      expect(result.headVersion).toBe(24);
    });

    test('should return no change when runtime is the same', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (
          args.includes('show') &&
          (args[1] === `${TEST_BASE_SHA}:action.yml` || args[1] === `${TEST_HEAD_SHA}:action.yml`)
        ) {
          options.listeners.stdout(Buffer.from(actionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
      expect(result.baseVersion).toBe(20);
      expect(result.headVersion).toBe(20);
    });

    test('should return no change when action.yml does not exist at base ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          throw new Error('File not found');
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(
            Buffer.from(`name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`)
          );
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
    });

    test('should return no change for composite action', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const actionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (
          args.includes('show') &&
          (args[1] === `${TEST_BASE_SHA}:action.yml` || args[1] === `${TEST_HEAD_SHA}:action.yml`)
        ) {
          options.listeners.stdout(Buffer.from(actionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
      expect(result.baseVersion).toBeNull();
      expect(result.headVersion).toBeNull();
    });

    test('should return no change when action.yml does not exist at head ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(
            Buffer.from(`name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`)
          );
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          throw new Error('File not found');
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
    });

    test('should return no change when action.yml does not exist at either ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockExec.exec.mockImplementation(async (command, args) => {
        if (args.includes('show') && args[1]?.includes('action.yml')) {
          throw new Error('File not found');
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
    });

    test('should detect runtime downgrade from node24 to node20', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(true);
      expect(result.baseVersion).toBe(24);
      expect(result.headVersion).toBe(20);
    });

    test('should return no change when runtime switches from node to composite', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
    });

    test('should return no change when runtime switches from composite to node', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        }
        return 0;
      });

      const result = await detectNodeRuntimeChange(TEST_BASE_SHA, TEST_HEAD_SHA, 'action.yml');
      expect(result.changed).toBe(false);
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

  describe('validatePackageVersionConsistency', () => {
    let mockFs;

    beforeAll(async () => {
      mockFs = await import('fs');
    });

    beforeEach(() => {
      mockFs.existsSync.mockClear();
      mockFs.readFileSync.mockClear();
    });

    test('should return valid when versions match', () => {
      const { validatePackageVersionConsistency } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '1.2.3' };
      const mockPackageLock = { name: 'test-package', version: '1.2.3', lockfileVersion: 3 };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'package.json') {
          return JSON.stringify(mockPackageJson);
        }
        if (filePath === 'package-lock.json') {
          return JSON.stringify(mockPackageLock);
        }
        throw new Error(`Unexpected file: ${filePath}`);
      });

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(true);
      expect(result.packageVersion).toBe('1.2.3');
      expect(result.lockVersion).toBe('1.2.3');
      expect(result.error).toBeNull();
    });

    test('should return invalid when versions do not match', () => {
      const { validatePackageVersionConsistency } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '1.2.4' };
      const mockPackageLock = { name: 'test-package', version: '1.2.3', lockfileVersion: 3 };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'package.json') {
          return JSON.stringify(mockPackageJson);
        }
        if (filePath === 'package-lock.json') {
          return JSON.stringify(mockPackageLock);
        }
        throw new Error(`Unexpected file: ${filePath}`);
      });

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(false);
      expect(result.packageVersion).toBe('1.2.4');
      expect(result.lockVersion).toBe('1.2.3');
      expect(result.error).toContain('Version mismatch');
      expect(result.error).toContain('1.2.4');
      expect(result.error).toContain('1.2.3');
    });

    test('should return valid when package-lock.json does not exist', () => {
      const { validatePackageVersionConsistency } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '1.2.3' };

      mockFs.existsSync.mockImplementation(filePath => {
        if (filePath === 'package.json') return true;
        if (filePath === 'package-lock.json') return false;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson));

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(true);
      expect(result.packageVersion).toBe('1.2.3');
      expect(result.lockVersion).toBeNull();
      expect(result.error).toBeNull();
    });

    test('should return invalid when package.json does not exist', () => {
      const { validatePackageVersionConsistency } = indexModule;

      mockFs.existsSync.mockReturnValue(false);

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('package.json not found');
    });

    test('should return invalid for invalid JSON in package.json', () => {
      const { validatePackageVersionConsistency } = indexModule;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json }');

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    test('should return invalid for invalid JSON in package-lock.json', () => {
      const { validatePackageVersionConsistency } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '1.2.3' };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'package.json') {
          return JSON.stringify(mockPackageJson);
        }
        if (filePath === 'package-lock.json') {
          return '{ invalid json }';
        }
        throw new Error(`Unexpected file: ${filePath}`);
      });

      const result = validatePackageVersionConsistency('package.json');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    test('should handle nested package.json path correctly', () => {
      const { validatePackageVersionConsistency } = indexModule;
      const mockPackageJson = { name: 'test-package', version: '2.0.0' };
      const mockPackageLock = { name: 'test-package', version: '2.0.0', lockfileVersion: 3 };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'packages/subproject/package.json') {
          return JSON.stringify(mockPackageJson);
        }
        if (filePath === 'packages/subproject/package-lock.json') {
          return JSON.stringify(mockPackageLock);
        }
        throw new Error(`Unexpected file: ${filePath}`);
      });

      const result = validatePackageVersionConsistency('packages/subproject/package.json');
      expect(result.isValid).toBe(true);
      expect(result.packageVersion).toBe('2.0.0');
      expect(result.lockVersion).toBe('2.0.0');
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
    mockGithub.context.sha = TEST_HEAD_SHA;
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: TEST_BASE_SHA }
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
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
  });

  test('should return false when base or head refs are missing', async () => {
    const { hasPackageDependencyChanges } = indexModule;
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.payload = { pull_request: {} }; // No base ref

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
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
      if (
        args.includes('show') &&
        (args.includes(`${TEST_BASE_SHA}:package.json`) || args.includes(`${TEST_HEAD_SHA}:package.json`))
      ) {
        return JSON.stringify(samePackageJson);
      }
      return '';
    });

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
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

      // Handle getChangedFiles calls
      if (args.includes('diff') && args.includes('--name-only')) {
        output = '';
      }
      // Handle package.json file retrieval
      else if (args.includes('show') && args.includes(`${TEST_BASE_SHA}:package.json`)) {
        output = JSON.stringify(basePackageJson);
      } else if (args.includes('show') && args.includes(`${TEST_HEAD_SHA}:package.json`)) {
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should return true when git command fails (err on side of caution)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Simulate a critical error that happens before getFileAtRef is called,
    // such as during SHA sanitization or context setup
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = TEST_HEAD_SHA;
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: 'invalid;injection' } // This should trigger sanitizeSHA error
      }
    };

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', `${TEST_BASE_SHA}:package.json`], expect.any(Object));
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', `${TEST_HEAD_SHA}:package.json`], expect.any(Object));
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
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
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should ignore package-lock.json changes when only devDependencies changed in package.json (your original scenario)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Base package.json with devDependencies
    const basePackageJson = {
      name: 'my-awesome-project',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0',
        lodash: '^4.17.21'
      },
      devDependencies: {
        jest: '^29.0.0',
        eslint: '^8.20.0'
      }
    };

    // Head package.json - ONLY devDependencies changed (your scenario: "I'm only updating devDependencies :(")
    const headPackageJson = {
      name: 'my-awesome-project',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0', // Same
        lodash: '^4.17.21' // Same
      },
      devDependencies: {
        jest: '^29.7.0', // Updated
        eslint: '^8.50.0', // Updated
        prettier: '^3.0.0' // Added new dev dependency
      }
    };

    // Base package-lock.json
    const basePackageLock = {
      name: 'my-awesome-project',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-awesome-project',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0',
            lodash: '^4.17.21'
          },
          devDependencies: {
            jest: '^29.0.0',
            eslint: '^8.20.0'
          }
        },
        'node_modules/express': {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz'
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true
        }
      }
    };

    // Head package-lock.json - SIGNIFICANTLY different due to dev dependency updates
    const headPackageLock = {
      name: 'my-awesome-project',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-awesome-project',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0',
            lodash: '^4.17.21'
          },
          devDependencies: {
            jest: '^29.7.0', // Updated
            eslint: '^8.50.0', // Updated
            prettier: '^3.0.0' // New
          }
        },
        'node_modules/express': {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz'
        },
        'node_modules/jest': {
          version: '29.7.0', // Different version
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.7.0.tgz',
          dev: true
        },
        'node_modules/prettier': {
          // New dev dependency
          version: '3.0.0',
          resolved: 'https://registry.npmjs.org/prettier/-/prettier-3.0.0.tgz',
          dev: true
        },
        'node_modules/eslint': {
          // New in lock file
          version: '8.50.0',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-8.50.0.tgz',
          dev: true
        }
      }
    };

    // Ensure include-dev-dependencies is false (your configuration)
    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // This should return onlyDevDependencies: true
    // Even though package-lock.json has significant changes, we're ignoring them
    // because only devDependencies changed and include-dev-dependencies is false
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
  });

  test('should treat lockfile reshuffling as dev-only when package.json shows no production changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // This reproduces the real-world scenario from PR #74: updating jest (devDep) causes npm
    // to reshuffle shared transitive dependencies like ansi-regex/strip-ansi between the
    // yargs (prod) and jest (dev) trees. The hoisted packages lack "dev": true because they
    // are shared. The tree walk must follow the full chain: jest -> jest-cli -> yargs ->
    // cliui -> wrap-ansi -> strip-ansi -> ansi-regex, handling nested node_modules resolution.

    // Base package.json
    const basePackageJson = {
      name: 'my-org-tool',
      version: '2.0.0',
      dependencies: {
        yargs: '^17.0.0'
      },
      devDependencies: {
        jest: '^29.0.0'
      }
    };

    // Head package.json - ONLY devDependencies updated
    const headPackageJson = {
      name: 'my-org-tool',
      version: '2.0.0',
      dependencies: {
        yargs: '^17.0.0' // unchanged
      },
      devDependencies: {
        jest: '^30.3.0' // bumped
      }
    };

    // Base package-lock.json -- ansi-regex at v5.0.1, hoisted at top level (shared between yargs and jest trees)
    const basePackageLock = {
      name: 'my-org-tool',
      version: '2.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '2.0.0',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^29.0.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          resolved: 'https://registry.npmjs.org/yargs/-/yargs-17.7.2.tgz',
          dependencies: { cliui: '^8.0.1' }
        },
        'node_modules/cliui': {
          version: '8.0.1',
          resolved: 'https://registry.npmjs.org/cliui/-/cliui-8.0.1.tgz',
          dependencies: { 'wrap-ansi': '^7.0.0', 'strip-ansi': '^6.0.1' }
        },
        'node_modules/wrap-ansi': {
          version: '7.0.0',
          resolved: 'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz',
          dependencies: { 'strip-ansi': '^6.0.0' }
        },
        'node_modules/strip-ansi': {
          version: '6.0.1',
          resolved: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.1.tgz',
          dependencies: { 'ansi-regex': '^5.0.1' }
        },
        'node_modules/ansi-regex': {
          version: '5.0.1',
          resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz'
          // No dev: true -- shared between yargs (prod) and jest (dev)
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true,
          dependencies: { 'jest-cli': '^29.0.0' }
        },
        'node_modules/jest-cli': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest-cli/-/jest-cli-29.0.0.tgz',
          dev: true,
          dependencies: { yargs: '^17.0.0' }
        }
      }
    };

    // Head package-lock.json -- jest bumped to 30.3.0, npm reshuffled ansi-regex to 6.2.2
    // (now hoisted, version changed, still no dev: true because shared with yargs prod tree)
    const headPackageLock = {
      name: 'my-org-tool',
      version: '2.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '2.0.0',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^30.3.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          resolved: 'https://registry.npmjs.org/yargs/-/yargs-17.7.2.tgz',
          dependencies: { cliui: '^8.0.1' }
        },
        'node_modules/cliui': {
          version: '8.0.1',
          resolved: 'https://registry.npmjs.org/cliui/-/cliui-8.0.1.tgz',
          dependencies: { 'wrap-ansi': '^7.0.0', 'strip-ansi': '^6.0.1' }
        },
        'node_modules/wrap-ansi': {
          version: '7.0.0',
          resolved: 'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz',
          dependencies: { 'strip-ansi': '^6.0.0' }
        },
        'node_modules/strip-ansi': {
          version: '7.1.0', // version changed by reshuffling
          resolved: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-7.1.0.tgz',
          dependencies: { 'ansi-regex': '^6.0.0' }
        },
        'node_modules/ansi-regex': {
          version: '6.2.2', // version changed by reshuffling
          resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-6.2.2.tgz'
          // Still no dev: true -- shared between yargs (prod) and jest (dev)
        },
        'node_modules/jest': {
          version: '30.3.0', // bumped
          resolved: 'https://registry.npmjs.org/jest/-/jest-30.3.0.tgz',
          dev: true,
          dependencies: { 'jest-cli': '^30.3.0' }
        },
        'node_modules/jest-cli': {
          version: '30.3.0', // bumped
          resolved: 'https://registry.npmjs.org/jest-cli/-/jest-cli-30.3.0.tgz',
          dev: true,
          dependencies: { yargs: '^17.0.0' }
        }
      }
    };

    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // package.json shows only devDependencies changed, so the lockfile reshuffling
    // of shared packages (without dev: true) should NOT be treated as production changes
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
  });

  test('should handle nested node_modules keys when walking the dependency tree', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Tests resolveDepKey with nested node_modules paths. jest-cli has a nested
    // copy of chalk (different version), which itself depends on strip-ansi.
    // The hoisted strip-ansi (shared with yargs, no dev: true) gets reshuffled.
    // The tree walk must: 1) find the nested chalk via jest-cli, 2) from nested
    // chalk find strip-ansi (resolving up to top-level), marking it reachable.

    const basePackageJson = {
      name: 'my-tool',
      version: '1.0.0',
      dependencies: { yargs: '^17.0.0' },
      devDependencies: { jest: '^29.0.0' }
    };

    const headPackageJson = {
      name: 'my-tool',
      version: '1.0.0',
      dependencies: { yargs: '^17.0.0' },
      devDependencies: { jest: '^30.3.0' }
    };

    const basePackageLock = {
      name: 'my-tool',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-tool',
          version: '1.0.0',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^29.0.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          resolved: 'https://registry.npmjs.org/yargs/-/yargs-17.7.2.tgz',
          dependencies: { 'strip-ansi': '^6.0.0' }
        },
        'node_modules/strip-ansi': {
          version: '6.0.1',
          resolved: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.1.tgz'
          // No dev: true -- shared between yargs (prod) and jest (dev) trees
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true,
          dependencies: { 'jest-cli': '^29.0.0' }
        },
        'node_modules/jest-cli': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest-cli/-/jest-cli-29.0.0.tgz',
          dev: true,
          dependencies: { chalk: '^4.0.0' }
        },
        // jest-cli has its own nested chalk (different major than any top-level chalk)
        'node_modules/jest-cli/node_modules/chalk': {
          version: '4.1.2',
          resolved: 'https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz',
          dev: true,
          dependencies: { 'strip-ansi': '^6.0.0' }
        }
      }
    };

    // After jest bump: nested chalk updated, and the shared top-level strip-ansi
    // got reshuffled (new patch version, lost dev: true because shared with yargs)
    const headPackageLock = {
      name: 'my-tool',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-tool',
          version: '1.0.0',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^30.3.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          resolved: 'https://registry.npmjs.org/yargs/-/yargs-17.7.2.tgz',
          dependencies: { 'strip-ansi': '^6.0.0' }
        },
        'node_modules/strip-ansi': {
          version: '6.0.2', // reshuffled, new patch, no dev: true (shared)
          resolved: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.2.tgz'
        },
        'node_modules/jest': {
          version: '30.3.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-30.3.0.tgz',
          dev: true,
          dependencies: { 'jest-cli': '^30.3.0' }
        },
        'node_modules/jest-cli': {
          version: '30.3.0',
          resolved: 'https://registry.npmjs.org/jest-cli/-/jest-cli-30.3.0.tgz',
          dev: true,
          dependencies: { chalk: '^4.0.0' }
        },
        'node_modules/jest-cli/node_modules/chalk': {
          version: '4.1.3', // nested, changed version
          resolved: 'https://registry.npmjs.org/chalk/-/chalk-4.1.3.tgz',
          dev: true,
          dependencies: { 'strip-ansi': '^6.0.0' }
        }
      }
    };

    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // strip-ansi at top level (no dev: true, shared with yargs) changed version but
    // is reachable via jest -> jest-cli -> nested chalk -> strip-ansi (resolving up
    // to top-level via resolveDepKey). The nested chalk also changed but is dev: true.
    // All changes should be attributed to the jest devDep update.
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
  });

  test('should attribute reshuffled packages nested under prod deps via package-name fallback', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Reproduces the real-world scenario from organization-readme-badge-generator PR #74:
    // A jest devDep bump causes npm to reshuffle ansi-regex. The changed copy lives at
    // node_modules/cliui/node_modules/ansi-regex (nested under the production dep cliui).
    // The exact-key tree walk from jest cannot reach this path because cliui is reached
    // through the prod yargs chain, not the dev jest chain in this lockfile layout.
    // The fallback checks that the package NAME "ansi-regex" appears elsewhere in the
    // dev transitive set, confirming it's reshuffling rather than a new production dep.

    const basePackageJson = {
      name: 'my-org-tool',
      version: '1.0.8',
      dependencies: { yargs: '^17.0.0' },
      devDependencies: { jest: '^29.0.0' }
    };

    const headPackageJson = {
      name: 'my-org-tool',
      version: '1.0.8',
      dependencies: { yargs: '^17.0.0' },
      devDependencies: { jest: '^30.3.0' }
    };

    const basePackageLock = {
      name: 'my-org-tool',
      version: '1.0.8',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '1.0.8',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^29.0.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          dependencies: { cliui: '^8.0.1' }
        },
        'node_modules/cliui': {
          version: '8.0.1',
          dependencies: { 'strip-ansi': '^6.0.1' }
        },
        'node_modules/cliui/node_modules/ansi-regex': {
          version: '5.0.1'
          // no dev: true - nested under prod dep cliui
        },
        'node_modules/cliui/node_modules/strip-ansi': {
          version: '6.0.1',
          dependencies: { 'ansi-regex': '^5.0.1' }
        },
        'node_modules/jest': {
          version: '29.0.0',
          dev: true,
          dependencies: { 'jest-cli': '^29.0.0' }
        },
        'node_modules/jest-cli': {
          version: '29.0.0',
          dev: true,
          dependencies: { chalk: '^4.0.0' }
        },
        'node_modules/jest-cli/node_modules/chalk': {
          version: '4.1.2',
          dev: true,
          dependencies: { 'ansi-styles': '^4.0.0' }
        },
        // ansi-regex also exists as a transitive of jest (through a different path)
        'node_modules/ansi-regex': {
          version: '5.0.1',
          dev: true
        }
      }
    };

    const headPackageLock = {
      name: 'my-org-tool',
      version: '1.0.8',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '1.0.8',
          dependencies: { yargs: '^17.0.0' },
          devDependencies: { jest: '^30.3.0' }
        },
        'node_modules/yargs': {
          version: '17.7.2',
          dependencies: { cliui: '^8.0.1' }
        },
        'node_modules/cliui': {
          version: '8.0.1',
          dependencies: { 'strip-ansi': '^6.0.1' }
        },
        'node_modules/cliui/node_modules/ansi-regex': {
          version: '5.0.2' // reshuffled - version changed but same package name
          // no dev: true - nested under prod dep cliui
        },
        'node_modules/cliui/node_modules/strip-ansi': {
          version: '6.0.1',
          dependencies: { 'ansi-regex': '^5.0.1' }
        },
        'node_modules/jest': {
          version: '30.3.0',
          dev: true,
          dependencies: { 'jest-cli': '^30.3.0' }
        },
        'node_modules/jest-cli': {
          version: '30.3.0',
          dev: true,
          dependencies: { chalk: '^4.0.0' }
        },
        'node_modules/jest-cli/node_modules/chalk': {
          version: '4.1.2',
          dev: true,
          dependencies: { 'ansi-styles': '^4.0.0', 'strip-ansi': '^6.0.0' }
        },
        // jest-cli/chalk now depends on strip-ansi which depends on ansi-regex
        'node_modules/jest-cli/node_modules/strip-ansi': {
          version: '6.0.1',
          dev: true,
          dependencies: { 'ansi-regex': '^5.0.1' }
        },
        'node_modules/jest-cli/node_modules/ansi-regex': {
          version: '5.0.2',
          dev: true
        },
        'node_modules/ansi-regex': {
          version: '5.0.2',
          dev: true
        }
      }
    };

    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // node_modules/cliui/node_modules/ansi-regex changed and has no dev: true,
    // but the package name "ansi-regex" also changed at a confirmed dev path
    // (node_modules/ansi-regex has dev: true and changed version), so the
    // tightened name-based fallback correctly identifies this as reshuffling.
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
  });

  test('should detect prod transitive changes even when package.json shows only devDependency changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // This reproduces the combined scenario: devDep bump + intentional prod transitive
    // update (e.g., fixing a vulnerability in undici) in the same PR. The tree walking
    // should correctly identify that undici is NOT a transitive of the changed devDep,
    // while @octokit/core IS (and is just reshuffling).

    const basePackageJson = {
      name: 'my-org-tool',
      version: '2.0.0',
      dependencies: {
        '@octokit/rest': '^20.0.0'
      },
      devDependencies: {
        '@octokit/webhooks-types': '^7.1.0'
      }
    };

    // Head package.json - ONLY devDependencies updated
    const headPackageJson = {
      name: 'my-org-tool',
      version: '2.0.0',
      dependencies: {
        '@octokit/rest': '^20.0.0'
      },
      devDependencies: {
        '@octokit/webhooks-types': '^7.6.0'
      }
    };

    const basePackageLock = {
      name: 'my-org-tool',
      version: '2.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '2.0.0',
          dependencies: { '@octokit/rest': '^20.0.0' },
          devDependencies: { '@octokit/webhooks-types': '^7.1.0' }
        },
        'node_modules/@octokit/rest': {
          version: '20.0.2',
          resolved: 'https://registry.npmjs.org/@octokit/rest/-/rest-20.0.2.tgz',
          dependencies: {
            '@octokit/core': '^5.0.0',
            undici: '^6.0.0'
          }
        },
        'node_modules/@octokit/core': {
          version: '5.0.0',
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-5.0.0.tgz'
        },
        'node_modules/@octokit/webhooks-types': {
          version: '7.1.0',
          resolved: 'https://registry.npmjs.org/@octokit/webhooks-types/-/webhooks-types-7.1.0.tgz',
          dev: true,
          dependencies: {
            '@octokit/core': '^5.0.0'
          }
        },
        'node_modules/undici': {
          version: '6.19.0',
          resolved: 'https://registry.npmjs.org/undici/-/undici-6.19.0.tgz'
        }
      }
    };

    // Head lockfile: webhooks-types bumped (dev), @octokit/core reshuffled (shared),
    // and undici intentionally bumped for a vulnerability fix (prod transitive)
    const headPackageLock = {
      name: 'my-org-tool',
      version: '2.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'my-org-tool',
          version: '2.0.0',
          dependencies: { '@octokit/rest': '^20.0.0' },
          devDependencies: { '@octokit/webhooks-types': '^7.6.0' }
        },
        'node_modules/@octokit/rest': {
          version: '20.0.2',
          resolved: 'https://registry.npmjs.org/@octokit/rest/-/rest-20.0.2.tgz',
          dependencies: {
            '@octokit/core': '^5.0.0',
            undici: '^6.0.0'
          }
        },
        'node_modules/@octokit/core': {
          version: '5.2.0', // reshuffled - transitive of changed devDep
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-5.2.0.tgz'
        },
        'node_modules/@octokit/webhooks-types': {
          version: '7.6.0',
          resolved: 'https://registry.npmjs.org/@octokit/webhooks-types/-/webhooks-types-7.6.0.tgz',
          dev: true,
          dependencies: {
            '@octokit/core': '^5.0.0'
          }
        },
        'node_modules/undici': {
          version: '6.21.0', // intentional prod transitive bump (vuln fix)
          resolved: 'https://registry.npmjs.org/undici/-/undici-6.21.0.tgz'
        }
      }
    };

    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // undici is NOT a transitive of @octokit/webhooks-types, so it's a genuine
    // production change that should be flagged even though package.json only shows devDep changes
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should still detect production changes when both package.json prod deps and lockfile change', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // This ensures the fix does not create a false negative when package.json actually
    // has production dependency changes alongside lockfile reshuffling.

    const basePackageJson = {
      name: 'my-tool',
      version: '1.0.0',
      dependencies: {
        '@octokit/rest': '^19.0.0'
      },
      devDependencies: {
        jest: '^29.0.0'
      }
    };

    const headPackageJson = {
      name: 'my-tool',
      version: '1.0.0',
      dependencies: {
        '@octokit/rest': '^20.0.0' // production dep changed
      },
      devDependencies: {
        jest: '^29.7.0' // dev dep also changed
      }
    };

    const basePackageLock = {
      name: 'my-tool',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-tool',
          version: '1.0.0',
          dependencies: { '@octokit/rest': '^19.0.0' },
          devDependencies: { jest: '^29.0.0' }
        },
        'node_modules/@octokit/rest': {
          version: '19.0.13',
          resolved: 'https://registry.npmjs.org/@octokit/rest/-/rest-19.0.13.tgz'
        },
        'node_modules/@octokit/core': {
          version: '4.0.0',
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-4.0.0.tgz'
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true
        }
      }
    };

    const headPackageLock = {
      name: 'my-tool',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'my-tool',
          version: '1.0.0',
          dependencies: { '@octokit/rest': '^20.0.0' },
          devDependencies: { jest: '^29.7.0' }
        },
        'node_modules/@octokit/rest': {
          version: '20.0.2',
          resolved: 'https://registry.npmjs.org/@octokit/rest/-/rest-20.0.2.tgz'
        },
        'node_modules/@octokit/core': {
          version: '5.2.0',
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-5.2.0.tgz'
        },
        'node_modules/jest': {
          version: '29.7.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.7.0.tgz',
          dev: true
        }
      }
    };

    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return false;
      return false;
    });

    mockExec.exec.mockImplementation(
      createExecMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges();

    // package.json shows production dependency change, so lockfile changes are real
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should return onlyDevDependencies=true when package-lock.json has only devDependency changes (npm v7+ format)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // No package.json changes
    const packageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: {
        express: '^4.18.0'
      }
    };

    // Base package-lock.json with both production and dev dependencies
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0'
          },
          devDependencies: {
            jest: '^29.0.0'
          }
        },
        'node_modules/express': {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz',
          integrity: 'sha512-example'
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          integrity: 'sha512-jestexample',
          dev: true
        }
      }
    };

    // Head package-lock.json with updated devDependency only
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0'
          },
          devDependencies: {
            jest: '^29.5.0',
            eslint: '^8.0.0'
          }
        },
        'node_modules/express': {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz',
          integrity: 'sha512-example'
        },
        'node_modules/jest': {
          version: '29.5.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.5.0.tgz',
          integrity: 'sha512-jestnewexample',
          dev: true
        },
        'node_modules/eslint': {
          version: '8.0.0',
          resolved: 'https://registry.npmjs.org/eslint/-/eslint-8.0.0.tgz',
          integrity: 'sha512-eslintexample',
          dev: true
        }
      }
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(packageJson, packageJson, basePackageLock, headPackageLock));

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: true });
  });

  test('should return hasChanges=true when package-lock.json has devDependency changes and include-dev-dependencies is true', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // No package.json changes
    const packageJson = {
      name: 'test-package',
      version: '1.0.0'
    };

    // Base package-lock.json
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0',
          devDependencies: {
            jest: '^29.0.0'
          }
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true
        }
      }
    };

    // Head package-lock.json with updated devDependency
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0',
          devDependencies: {
            jest: '^29.5.0'
          }
        },
        'node_modules/jest': {
          version: '29.5.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.5.0.tgz',
          dev: true
        }
      }
    };

    // Configure to include devDependencies in version bump requirement
    mockCore.getBooleanInput.mockImplementation(input => {
      if (input === 'include-dev-dependencies') return true;
      return false;
    });

    mockExec.exec.mockImplementation(createExecMock(packageJson, packageJson, basePackageLock, headPackageLock));

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should return hasChanges=true when package-lock.json has mixed production and dev changes', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // No package.json changes
    const packageJson = {
      name: 'test-package',
      version: '1.0.0'
    };

    // Base package-lock.json
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0'
        },
        'node_modules/express': {
          version: '4.18.0',
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz'
        },
        'node_modules/jest': {
          version: '29.0.0',
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.0.0.tgz',
          dev: true
        }
      }
    };

    // Head package-lock.json with both production and dev changes
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0'
        },
        'node_modules/express': {
          version: '4.19.0', // Production dependency updated
          resolved: 'https://registry.npmjs.org/express/-/express-4.19.0.tgz'
        },
        'node_modules/jest': {
          version: '29.5.0', // Dev dependency also updated
          resolved: 'https://registry.npmjs.org/jest/-/jest-29.5.0.tgz',
          dev: true
        }
      }
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(packageJson, packageJson, basePackageLock, headPackageLock));

    const result = await hasPackageDependencyChanges();
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should return false when package-lock.json has only peer flag metadata changes (npm v7+ format)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const packageJson = {
      name: 'test-package',
      version: '1.0.0'
    };

    // Base package-lock.json with peer: true flag
    const basePackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0'
        },
        'node_modules/@octokit/core': {
          version: '5.2.2',
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-5.2.2.tgz',
          integrity: 'sha512-example123',
          peer: true,
          dependencies: {
            '@octokit/auth-token': '^4.0.0'
          }
        },
        'node_modules/typescript': {
          version: '5.0.0',
          resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.0.0.tgz',
          integrity: 'sha512-typescriptexample',
          peer: true
        }
      }
    };

    // Head package-lock.json with peer: true flag removed (only metadata change)
    const headPackageLock = {
      name: 'test-package',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'test-package',
          version: '1.0.0'
        },
        'node_modules/@octokit/core': {
          version: '5.2.2',
          resolved: 'https://registry.npmjs.org/@octokit/core/-/core-5.2.2.tgz',
          integrity: 'sha512-example123',
          // peer: true removed - this is just a metadata change
          dependencies: {
            '@octokit/auth-token': '^4.0.0'
          }
        },
        'node_modules/typescript': {
          version: '5.0.0',
          resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.0.0.tgz',
          integrity: 'sha512-typescriptexample'
          // peer: true removed - this is just a metadata change
        }
      }
    };

    // Ensure include-dev-dependencies is false (default)
    mockCore.getBooleanInput.mockReturnValue(false);

    mockExec.exec.mockImplementation(createExecMock(packageJson, packageJson, basePackageLock, headPackageLock));

    const result = await hasPackageDependencyChanges();
    // Should return false because only peer metadata changed, no actual dependency changes
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
  });

  test('should return false when changedFiles array does not contain package files', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Clear any previous mock calls
    jest.clearAllMocks();

    // Even though there may be actual package.json changes in git,
    // passing a changedFiles array without package files should skip the check
    const result = await hasPackageDependencyChanges(['src/index.js', 'lib/utils.ts']);

    // Git commands should NOT be called since no package files in the list
    expect(mockExec.exec).not.toHaveBeenCalled();
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
  });

  test('should only check package.json when changedFiles contains only package.json', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Clear any previous mock calls
    jest.clearAllMocks();

    const basePackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' }
    };

    const headPackageJson = {
      name: 'test-package',
      version: '1.0.0',
      dependencies: { express: '^4.19.0' }
    };

    mockExec.exec.mockImplementation(createExecMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(['src/index.js', 'package.json']);

    // Should detect changes since package.json is in the list
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
    // Should check package.json
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', `${TEST_BASE_SHA}:package.json`], expect.any(Object));
    expect(mockExec.exec).toHaveBeenCalledWith('git', ['show', `${TEST_HEAD_SHA}:package.json`], expect.any(Object));
  });
});

describe('npm Version Check Action - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = TEST_HEAD_SHA;
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: TEST_BASE_SHA }
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

      const result = await execGit(['diff', '--name-only', TEST_HEAD_SHA, TEST_BASE_SHA]);
      expect(result).toBe('git output');
      expect(mockExec.exec).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', TEST_HEAD_SHA, TEST_BASE_SHA],
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

      await expect(execGit(['diff', '--name-only', TEST_HEAD_SHA, TEST_BASE_SHA])).rejects.toThrow(
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
      await expect(execGit(['diff', '--upload-pack'])).rejects.toThrow('Dangerous git option detected');
      await expect(execGit(['show', '--exec=/bin/sh'])).rejects.toThrow('Dangerous git option detected');
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

      await expect(execGit(['diff', '--name-only', TEST_HEAD_SHA, TEST_BASE_SHA])).resolves.not.toThrow();
    });

    test('should allow double dash separator for file paths', async () => {
      const { execGit } = indexModule;
      mockExec.exec.mockResolvedValue(0);

      // Should not throw for the double dash separator used in hasPackageDependencyChanges
      await expect(execGit(['diff', TEST_HEAD_SHA, TEST_BASE_SHA, '--', 'package.json'])).resolves.not.toThrow();
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
      mockGithub.context.payload.pull_request.base.sha = TEST_BASE_SHA;
      mockGithub.context.sha = TEST_HEAD_SHA;
    });
  });
  describe('getLatestVersionTag function', () => {
    test('should return latest version tag', async () => {
      const { getLatestVersionTag } = indexModule;

      // Mock octokit.paginate to return tags from the API
      mockOctokit.paginate.mockResolvedValue([
        { name: 'v1.0.0' },
        { name: 'v1.1.0' },
        { name: 'v1.0.1' },
        { name: 'other-tag' }
      ]);

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

      const result = await getLatestVersionTag('v', 'fake-token');
      expect(result).toBe('v1.1.0');
      expect(mockGithub.getOctokit).toHaveBeenCalledWith('fake-token');
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.repos.listTags, {
        owner: 'test-owner',
        repo: 'test-repo',
        per_page: 100
      });
    });

    test('should return null when no version tags exist', async () => {
      const { getLatestVersionTag } = indexModule;

      mockOctokit.paginate.mockResolvedValue([{ name: 'other-tag' }, { name: 'nothing-relevant' }]);

      const result = await getLatestVersionTag('v', 'fake-token');
      expect(result).toBeNull();
    });

    test('should handle API failure gracefully', async () => {
      const { getLatestVersionTag } = indexModule;

      mockOctokit.paginate.mockRejectedValue(new Error('API error'));

      await expect(getLatestVersionTag('v', 'fake-token')).rejects.toThrow(
        'Failed to fetch repository tags: API error'
      );
    });

    test('should throw a clear error when token is empty or undefined', async () => {
      const { getLatestVersionTag } = indexModule;

      await expect(getLatestVersionTag('v', '')).rejects.toThrow(
        'Failed to fetch repository tags: GitHub token is required for fetching repository tags'
      );
      await expect(getLatestVersionTag('v', undefined)).rejects.toThrow(
        'Failed to fetch repository tags: GitHub token is required for fetching repository tags'
      );
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

  describe('getCommitsWithMessages function', () => {
    beforeEach(() => {
      mockGithub.context.eventName = 'pull_request';
      mockGithub.context.sha = TEST_HEAD_SHA;
      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA }, number: 123 };
      mockGithub.context.repo = { owner: 'test-owner', repo: 'test-repo' };
    });

    test('should return commits with their messages using GitHub API', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: 'Add feature\n\nDetailed description' }
        },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Fix bug' } }
      ]);

      const commits = await getCommitsWithMessages('test-token');

      expect(commits).toHaveLength(2);
      // Full message is returned for keyword matching
      expect(commits[0]).toEqual({
        sha: 'abc1234567890abcdef1234567890abcdef1234',
        message: 'Add feature\n\nDetailed description'
      });
      expect(commits[1]).toEqual({ sha: 'def4567890abcdef1234567890abcdef123456', message: 'Fix bug' });
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.pulls.listCommits, {
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        per_page: 100
      });
    });

    test('should return empty array for non-pull request events', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockGithub.context.eventName = 'push';

      const commits = await getCommitsWithMessages('test-token');
      expect(commits).toEqual([]);
    });

    test('should return empty array when API returns no commits', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockOctokit.paginate.mockResolvedValue([]);

      const commits = await getCommitsWithMessages('test-token');
      expect(commits).toEqual([]);
    });

    test('should return empty array when no token is provided', async () => {
      const { getCommitsWithMessages } = indexModule;

      const commits = await getCommitsWithMessages(null);
      expect(commits).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ No token provided, cannot fetch PR commits via API');
    });

    test('should return empty array when PR number is missing', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA } }; // No number

      const commits = await getCommitsWithMessages('test-token');
      expect(commits).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ Could not determine PR number');
    });

    test('should return empty array when API call fails', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockOctokit.paginate.mockRejectedValue(new Error('API rate limit exceeded'));

      const commits = await getCommitsWithMessages('test-token');
      expect(commits).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ Could not fetch PR commits via API: API rate limit exceeded');
    });
  });

  describe('getFilesForCommit function', () => {
    test('should return files changed in a commit using GitHub API', async () => {
      const { getFilesForCommit } = indexModule;

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: {
          files: [{ filename: 'src/index.js' }, { filename: 'lib/utils.ts' }, { filename: 'package.json' }]
        }
      });

      const files = await getFilesForCommit(
        'abc1234567890abcdef1234567890abcdef1234',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(files).toEqual(['src/index.js', 'lib/utils.ts', 'package.json']);
      expect(mockOctokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        ref: 'abc1234567890abcdef1234567890abcdef1234'
      });
    });

    test('should return empty array for commit with no files', async () => {
      const { getFilesForCommit } = indexModule;

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: null }
      });

      const files = await getFilesForCommit(
        'abc1234567890abcdef1234567890abcdef1234',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(files).toEqual([]);
    });

    test('should return empty array when API call fails', async () => {
      const { getFilesForCommit } = indexModule;

      mockOctokit.rest.repos.getCommit.mockRejectedValue(new Error('Not found'));

      const files = await getFilesForCommit(
        'abc1234567890abcdef1234567890abcdef1234',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(files).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ Could not fetch files for commit abc1234: Not found');
    });
  });

  describe('getChangedFilesWithSkipSupport function', () => {
    beforeEach(() => {
      mockGithub.context.eventName = 'pull_request';
      mockGithub.context.sha = TEST_HEAD_SHA;
      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA }, number: 123 };
      mockGithub.context.repo = { owner: 'test-owner', repo: 'test-repo' };
    });

    test('should exclude files from commits with skip keyword', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[skip version] Fix typo' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Add feature' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({
            data: { files: [{ filename: 'src/utils.js' }, { filename: 'lib/helper.ts' }] }
          });
        }
        // Should not be called for skipped commit
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual(['src/utils.js', 'lib/helper.ts']);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should include all files when no commits have skip keyword', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Fix bug' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'abc1234567890abcdef1234567890abcdef1234') {
          return Promise.resolve({ data: { files: [{ filename: 'src/index.js' }] } });
        } else if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/utils.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toContain('src/index.js');
      expect(result.files).toContain('src/utils.js');
      expect(result.skippedCommits).toBe(0);
      expect(result.totalCommits).toBe(2);
    });

    test('should return empty files when all commits are skipped', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[skip version] Fix typo' } }
      ]);

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual([]);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(1);
    });

    test('should deduplicate files changed in multiple commits', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Fix bug' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'abc1234567890abcdef1234567890abcdef1234') {
          return Promise.resolve({ data: { files: [{ filename: 'src/index.js' }, { filename: 'src/utils.js' }] } });
        } else if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/index.js' }] } }); // Same file as in first commit
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      // Should contain only unique files
      expect(result.files).toHaveLength(2);
      expect(result.files).toContain('src/index.js');
      expect(result.files).toContain('src/utils.js');
    });

    test('should include file if changed in both skipped and non-skipped commits', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[skip version] Fix typo in index' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Add feature to index' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        // Only the non-skipped commit should have files retrieved
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/index.js' }] } }); // Non-skipped commit changes this
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      // File should be included because it was changed in a non-skipped commit
      expect(result.files).toContain('src/index.js');
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should return empty when no commits in PR', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([]);

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual([]);
      expect(result.skippedCommits).toBe(0);
      expect(result.totalCommits).toBe(0);
    });

    test('should detect skip keyword in commit body (multi-line message)', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      // Simulate a conventional commit with [skip version] in the body/footer
      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: {
            message:
              'refactor: extract functions to improve testability\n\n- Extract helper functions\n- Improve coverage\n\n[skip version]'
          }
        },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'feat: add new feature' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/feature.js' }] } });
        }
        // Skipped commit should not have files retrieved
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual(['src/feature.js']);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should detect skip keyword in single-line commit message (subject)', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: '[skip version] fix: typo in documentation' }
        },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'feat: add new feature' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/feature.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual(['src/feature.js']);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should skip all commits when all have skip keyword in body', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: 'docs: update README\n\n[skip version]' }
        },
        {
          sha: 'def4567890abcdef1234567890abcdef123456',
          commit: { message: 'chore: fix linting\n\nMinor fixes\n\n[skip version]' }
        }
      ]);

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual([]);
      expect(result.skippedCommits).toBe(2);
      expect(result.totalCommits).toBe(2);
    });

    test('should match skip keyword case-insensitively', async () => {
      const { getChangedFilesWithSkipSupport } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: '[SKIP VERSION] uppercase keyword' }
        },
        {
          sha: 'def4567890abcdef1234567890abcdef123456',
          commit: { message: '[Skip Version] mixed case keyword' }
        },
        {
          sha: 'ccc7890abcdef1234567890abcdef1234567890',
          commit: { message: 'feat: add feature' }
        }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'ccc7890abcdef1234567890abcdef1234567890') {
          return Promise.resolve({ data: { files: [{ filename: 'src/feature.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await getChangedFilesWithSkipSupport('[skip version]', 'test-token');

      expect(result.files).toEqual(['src/feature.js']);
      expect(result.skippedCommits).toBe(2);
      expect(result.totalCommits).toBe(3);
    });
  });

  describe('hasPackageDependencyChanges JSON parsing errors', () => {
    test('should handle JSON parsing error in package.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock execGit to return invalid JSON for package.json
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:package.json`) {
          options.listeners.stdout('{ invalid json }');
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:package.json`) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      const result = await hasPackageDependencyChanges();
      expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false }); // Should conservatively assume change on parse error
    });

    test('should handle JSON parsing error in package-lock.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock execGit to return valid package.json but invalid package-lock.json
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1].includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        } else if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:package-lock.json`) {
          options.listeners.stdout('{ invalid lock json }');
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:package-lock.json`) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0", "dependencies": {} }');
        }
        return 0;
      });

      const result = await hasPackageDependencyChanges();
      expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false }); // Should conservatively assume change on parse error
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
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return '[skip version]';
          default:
            return '';
        }
      });
      mockCore.getBooleanInput.mockReturnValue(false);

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      mockExec.exec.mockResolvedValue(0);

      // Set up GitHub context for PR
      mockGithub.context.eventName = 'pull_request';
      mockGithub.context.sha = TEST_HEAD_SHA;
      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA }, number: 123 };
      mockGithub.context.repo = { owner: 'test-owner', repo: 'test-repo' };
    });

    test('should handle package dependency changes logging', async () => {
      const { run } = indexModule;

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'package.json' }, { filename: 'src/index.js' }] }
      });

      // Mock git commands for package.json diff comparison
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:package.json`) {
          options.listeners.stdout('{ "name": "test", "dependencies": { "lodash": "^4.0.0" } }');
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:package.json`) {
          options.listeners.stdout('{ "name": "test", "dependencies": { "lodash": "^4.1.0" } }');
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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }, { filename: 'lib/utils.ts' }] }
      });

      // Mock git commands
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1].includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
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

      // Mock API responses for commits and no existing tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return []; // No tags
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockExec.exec.mockResolvedValue(0);

      await run();

      expect(mockCore.notice).toHaveBeenCalledWith(
        '🎉 No previous version tag found, this appears to be the first release.'
      );
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
    });

    test('should handle version comparison - same version failure', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.0.0' }));

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockExec.exec.mockResolvedValue(0);

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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockExec.exec.mockResolvedValue(0);

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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockExec.exec.mockResolvedValue(0);

      mockSemver.compare.mockReturnValue(1); // Higher version

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('✅ Version has been properly incremented from 1.0.0 to 1.1.0');
      expect(mockCore.info).toHaveBeenCalledWith('🎯 Semantic versioning check passed!');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should fail when runtime changes but version bump is not major', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1); // Higher version (but only minor bump)

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('action.yml Node.js Actions runtime changed from node20 to node24')
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('requires a MAJOR version bump'));
      expect(mockCore.notice).toHaveBeenCalledWith(expect.stringContaining(`Run 'npm version major'`));
    });

    test('should pass when runtime changes with major version bump', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '2.0.0' }));

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1); // Higher version (major bump)

      await run();

      expect(mockCore.info).toHaveBeenCalledWith(
        '✅ Major version bump detected for Node.js Actions runtime change (node20 -> node24)'
      );
      expect(mockCore.setOutput).toHaveBeenCalledWith('runtime-changed', 'true');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should skip runtime check when skip-major-on-actions-runtime-change is true', async () => {
      const { run } = indexModule;

      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'true';
          case 'skip-major-on-actions-runtime-change':
            return 'true';
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return '[skip version]';
          default:
            return '';
        }
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Mock API response for tags (skip-files-check: true, so no commit fetching)
      mockOctokit.paginate.mockResolvedValue([{ name: 'v1.0.0' }]);

      mockExec.exec.mockResolvedValue(0);

      mockSemver.compare.mockReturnValue(1); // Higher version

      await run();

      // Should not mention runtime checks at all
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should not check runtime when no action.yml exists (non-Actions repo)', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1]?.includes('action.yml')) {
          throw new Error('File not found');
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1);

      await run();

      // Should pass without any runtime-related failure
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.setOutput).toHaveBeenCalledWith('runtime-changed', 'false');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should set runtime-changed output to false when runtime does not change', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1]?.includes('action.yml')) {
          options.listeners.stdout(Buffer.from(actionYml));
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1);

      await run();

      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.setOutput).toHaveBeenCalledWith('runtime-changed', 'false');
    });

    test('should handle runtime detection failure gracefully without crashing', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      // Make action.yml retrieval fail with an unexpected error on both refs
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1]?.includes('action.yml')) {
          throw new Error('Unexpected git error');
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1);

      await run();

      // Should still complete successfully since action.yml not found = no runtime change
      expect(mockCore.setOutput).toHaveBeenCalledWith('runtime-changed', 'false');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should proceed with version check when only action.yml changed and runtime check is enabled', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Only action.yml changed - no JS/TS or package dependency changes
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1] === `${TEST_BASE_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(baseActionYml));
        } else if (args.includes('show') && args[1] === `${TEST_HEAD_SHA}:action.yml`) {
          options.listeners.stdout(Buffer.from(headActionYml));
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1); // Higher version (but only minor bump)

      await run();

      // Should NOT skip the check - action.yml runtime change should trigger version check
      expect(mockCore.info).toHaveBeenCalledWith(
        '✅ action.yml Node.js Actions runtime change detected, proceeding with version check...'
      );
      // Should fail because runtime changed but no major version bump
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('action.yml Node.js Actions runtime changed from node20 to node24')
      );
    });

    test('should skip when only action.yml changed but runtime check is disabled', async () => {
      const { run } = indexModule;

      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'false';
          case 'skip-major-on-actions-runtime-change':
            return 'true';
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return '[skip version]';
          default:
            return '';
        }
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Only action.yml changed
      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      await run();

      // Should skip since runtime check is disabled and no other relevant files changed
      expect(mockCore.notice).toHaveBeenCalledWith(
        '⏭️ No JavaScript/TypeScript files or dependency changes detected, skipping version check'
      );
    });

    test('should skip when only action.yml metadata changed without runtime change', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '1.1.0' }));

      // Only action.yml changed but runtime is the same
      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Update description' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show') && args[1]?.includes('action.yml')) {
          options.listeners.stdout(Buffer.from(actionYml));
        } else if (args.includes('show') && args[1]?.includes('package.json')) {
          options.listeners.stdout('{ "name": "test", "version": "1.0.0" }');
        }
        return 0;
      });

      await run();

      // Should skip since runtime didn't actually change
      expect(mockCore.notice).toHaveBeenCalledWith(
        '⏭️ No JavaScript/TypeScript files or dependency changes detected, skipping version check'
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    test('should handle general error in run function', async () => {
      const { run } = indexModule;

      // Skip files check so we proceed directly to getLatestVersionTag which will throw
      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'skip-files-check':
            return 'true';
          case 'token':
            return 'test-token';
          default:
            return '';
        }
      });

      // Mock the GitHub API (paginate) to throw an error
      mockOctokit.paginate.mockRejectedValue(new Error('API request failed'));

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        'Action failed with error: Failed to fetch repository tags: API request failed'
      );
    });

    test('should skip commit analysis when skip-version-keyword is empty string', async () => {
      const { run } = indexModule;

      // Override to return empty string for skip-version-keyword
      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'false';
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return ''; // Empty string disables the feature
          default:
            return '';
        }
      });

      // Mock git commands for standard file diff (not commit analysis)
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('diff') && args.includes('--name-only')) {
          options.listeners.stdout('src/index.js\n');
        } else if (args.includes('show')) {
          options.listeners.stdout('{}');
        }
        return 0;
      });

      // Mock API response for tags (getLatestVersionTag still uses paginate)
      mockOctokit.paginate.mockResolvedValue([{ name: 'v1.0.0' }]);

      mockSemver.compare.mockReturnValue(1);

      await run();

      // Should NOT call paginate with listCommits when skip-version-keyword is empty
      expect(mockOctokit.paginate).not.toHaveBeenCalledWith(mockOctokit.rest.pulls.listCommits, expect.any(Object));
      // Should still call paginate for tags
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.repos.listTags, expect.any(Object));
      // Should use standard file diff instead
      expect(mockCore.info).toHaveBeenCalledWith('📁 Checking files changed in PR...');
    });

    test('should use standard file diff when all commits contain skip keyword', async () => {
      const { run } = indexModule;

      // Mock API responses where all commits have skip keyword
      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Fix [skip version]' } },
        { sha: 'def5678901234567890abcdef1234567890abcd', commit: { message: 'Update [skip version]' } }
      ]);

      mockOctokit.rest.repos.getCommit
        .mockResolvedValueOnce({
          data: { files: [{ filename: 'src/file1.js' }] }
        })
        .mockResolvedValueOnce({
          data: { files: [{ filename: 'src/file2.ts' }] }
        });

      // Mock git commands for show (version check not reached in this flow)
      mockExec.exec.mockImplementation(async (command, args, options) => {
        if (args.includes('show')) {
          options.listeners.stdout('{}');
        }
        return 0;
      });

      mockSemver.compare.mockReturnValue(1);

      await run();

      // Should log that all commits were skipped
      expect(mockCore.notice).toHaveBeenCalledWith('⏭️ Skipped 2 of 2 commits containing "[skip version]"');
      // When all files are skipped, changedFiles is empty so no relevant changes detected
      expect(mockCore.notice).toHaveBeenCalledWith(
        '⏭️ No JavaScript/TypeScript files or dependency changes detected, skipping version check'
      );
    });

    test('should skip version consistency check when skip-version-consistency-check is true', async () => {
      const { run } = indexModule;

      // Override to return true for skip-version-consistency-check
      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'true'; // Skip files check to simplify test
          case 'skip-version-consistency-check':
            return 'true'; // Skip consistency check
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return '[skip version]';
          default:
            return '';
        }
      });

      // Mock package.json and package-lock.json with DIFFERENT versions
      // If the check was running, this would fail
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'package.json') {
          return JSON.stringify({ name: 'test', version: '1.1.0' });
        }
        if (filePath === 'package-lock.json') {
          return JSON.stringify({ name: 'test', version: '1.0.0', lockfileVersion: 3 }); // Different version!
        }
        return '{}';
      });

      mockExec.exec.mockResolvedValue(0);

      // Mock API response for tags (skip-files-check: true, so no commit fetching)
      mockOctokit.paginate.mockResolvedValue([{ name: 'v1.0.0' }]);

      mockSemver.compare.mockReturnValue(1); // Higher version

      await run();

      // Should log that consistency check was skipped
      expect(mockCore.info).toHaveBeenCalledWith(
        '⏭️ Skipping version consistency check (skip-version-consistency-check: true)'
      );
      // Should NOT fail due to version mismatch
      expect(mockCore.setFailed).not.toHaveBeenCalledWith(expect.stringContaining('Version mismatch'));
      // Should complete successfully
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should fail when package.json and package-lock.json versions do not match', async () => {
      const { run } = indexModule;

      // Default config (consistency check enabled)
      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'tag-prefix':
            return 'v';
          case 'skip-files-check':
            return 'true'; // Skip files check to simplify test
          case 'skip-version-consistency-check':
            return 'false'; // Consistency check enabled (default)
          case 'token':
            return 'test-token';
          case 'skip-version-keyword':
            return '[skip version]';
          default:
            return '';
        }
      });

      // Mock package.json and package-lock.json with DIFFERENT versions
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(filePath => {
        if (filePath === 'package.json') {
          return JSON.stringify({ name: 'test', version: '1.1.0' });
        }
        if (filePath === 'package-lock.json') {
          return JSON.stringify({ name: 'test', version: '1.0.0', lockfileVersion: 3 }); // Different version!
        }
        return '{}';
      });

      mockExec.exec.mockResolvedValue(0);

      await run();

      // Should fail due to version mismatch
      expect(mockCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('Version mismatch'));
      expect(mockCore.notice).toHaveBeenCalledWith(
        `💡 HINT: Run 'npm install' to regenerate package-lock.json with the correct version`
      );
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

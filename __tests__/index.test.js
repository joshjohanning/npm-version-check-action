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
  setSecret: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  notice: jest.fn()
};

// Mock Octokit methods
const mockOctokit = {
  rest: {
    pulls: {
      listCommits: jest.fn(),
      listFiles: jest.fn()
    },
    repos: {
      getCommit: jest.fn(),
      listTags: jest.fn(),
      getContent: jest.fn()
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
    const semverRegex = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
    return semverRegex.test(v) ? v : null;
  }),
  parse: jest.fn(v => {
    const validVersion = mockSemver.valid(v);
    if (!validVersion) return null;
    const match = validVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  })
};

// Mock fs
jest.unstable_mockModule('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn()
}));

jest.unstable_mockModule('@actions/core', () => mockCore);
jest.unstable_mockModule('@actions/github', () => mockGithub);
jest.unstable_mockModule('semver', () => ({ default: mockSemver }));

// Dynamic import since we're using ES modules
const indexModule = await import('../src/index.js');

// Helper function to create a mock implementation that simulates repos.getContent API behavior
function createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock) {
  return ({ path, ref }) => {
    // Handle package.json file retrieval
    if (path === 'package.json' && ref === TEST_BASE_SHA) {
      if (basePackageJson) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(basePackageJson)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    }
    if (path === 'package.json' && ref === TEST_HEAD_SHA) {
      if (headPackageJson) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(headPackageJson)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    }
    // Handle package-lock.json file retrieval
    if (path === 'package-lock.json' && ref === TEST_BASE_SHA) {
      if (basePackageLock) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(basePackageLock)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    }
    if (path === 'package-lock.json' && ref === TEST_HEAD_SHA) {
      if (headPackageLock) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(headPackageLock)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    }

    return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(true);
      expect(result.baseVersion).toBe(20);
      expect(result.headVersion).toBe(24);
    });

    test('should return no change when runtime is the same', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(actionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
      expect(result.baseVersion).toBe(20);
      expect(result.headVersion).toBe(20);
    });

    test('should return no change when action.yml does not exist at base ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: {
              type: 'file',
              content: Buffer.from(`name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`).toString(
                'base64'
              )
            }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
    });

    test('should return no change for composite action', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const actionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(actionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
      expect(result.baseVersion).toBeNull();
      expect(result.headVersion).toBeNull();
    });

    test('should return no change when action.yml does not exist at head ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: {
              type: 'file',
              content: Buffer.from(`name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`).toString(
                'base64'
              )
            }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
    });

    test('should return no change when action.yml does not exist at either ref', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      mockOctokit.rest.repos.getContent.mockImplementation(() => {
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
    });

    test('should detect runtime downgrade from node24 to node20', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(true);
      expect(result.baseVersion).toBe(24);
      expect(result.headVersion).toBe(20);
    });

    test('should return no change when runtime switches from node to composite', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(result.changed).toBe(false);
    });

    test('should return no change when runtime switches from composite to node', async () => {
      const { detectNodeRuntimeChange } = indexModule;

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hello\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await detectNodeRuntimeChange(
        TEST_BASE_SHA,
        TEST_HEAD_SHA,
        'action.yml',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
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

  describe('isSequentialVersion', () => {
    beforeEach(() => {
      mockSemver.compare.mockClear();
      mockSemver.compare.mockReturnValue(1);
    });

    test('should accept sequential patch bump', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('1.0.1', '1.0.0');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('patch');
      expect(result.expectedVersion).toBe('1.0.1');
    });

    test('should accept sequential minor bump', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('1.1.0', '1.0.0');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('minor');
      expect(result.expectedVersion).toBe('1.1.0');
    });

    test('should accept sequential major bump', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('2.0.0', '1.0.0');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('major');
      expect(result.expectedVersion).toBe('2.0.0');
    });

    test('should reject skipped patch version', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('1.0.3', '1.0.1');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('patch');
      expect(result.expectedVersion).toBe('1.0.2');
    });

    test('should reject skipped minor version', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('4.2.0', '4.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('minor');
      expect(result.expectedVersion).toBe('4.1.0');
    });

    test('should reject skipped major version', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('6.0.0', '4.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('major');
      expect(result.expectedVersion).toBe('5.0.0');
    });

    test('should reject major bump with non-zero minor', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('5.1.0', '4.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('major');
      expect(result.expectedVersion).toBe('5.0.0');
    });

    test('should reject major bump with non-zero patch', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('5.0.1', '4.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('major');
      expect(result.expectedVersion).toBe('5.0.0');
    });

    test('should reject minor bump with non-zero patch', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('4.1.1', '4.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBe('minor');
      expect(result.expectedVersion).toBe('4.1.0');
    });

    test('should handle sequential bump from non-zero patch', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('1.2.4', '1.2.3');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('patch');
    });

    test('should handle sequential minor bump from non-zero patch', () => {
      const { isSequentialVersion } = indexModule;
      const result = isSequentialVersion('1.3.0', '1.2.3');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('minor');
    });

    test('should handle invalid version input', () => {
      const { isSequentialVersion } = indexModule;
      expect(isSequentialVersion(null, '1.0.0').isSequential).toBe(false);
      expect(isSequentialVersion('1.0.0', null).isSequential).toBe(false);
      expect(isSequentialVersion('', '1.0.0').isSequential).toBe(false);
      expect(isSequentialVersion(123, '1.0.0').isSequential).toBe(false);
    });

    test('should handle invalid version format', () => {
      const { isSequentialVersion } = indexModule;
      expect(isSequentialVersion('abc', '1.0.0').isSequential).toBe(false);
      expect(isSequentialVersion('1.0', '1.0.0').isSequential).toBe(false);
    });

    test('should handle same version', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(0);
      const result = isSequentialVersion('1.0.0', '1.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBeNull();
      expect(result.message).toContain('Versions are equal');
    });

    test('should handle prerelease versions', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(1);
      const result = isSequentialVersion('1.0.1-beta.1', '1.0.0');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('patch');
    });

    test('should handle build metadata versions', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(1);
      const result = isSequentialVersion('1.0.1+build.1', '1.0.0');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBe('patch');
    });

    test('should handle prerelease-only bump (same numeric components)', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(1);
      const result = isSequentialVersion('1.0.0-beta.2', '1.0.0-beta.1');
      expect(result.isSequential).toBe(true);
      expect(result.incrementType).toBeNull();
    });

    test('should handle downgrade between prereleases', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(-1);
      const result = isSequentialVersion('1.0.0-beta.1', '1.0.0-beta.2');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBeNull();
      expect(result.message).toContain('lower');
    });

    test('should handle stable to prerelease transition', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(-1);
      const result = isSequentialVersion('1.0.0-beta.1', '1.0.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBeNull();
      expect(result.message).toContain('lower');
    });

    test('should correctly reject lower version with higher minor component', () => {
      const { isSequentialVersion } = indexModule;
      mockSemver.compare.mockReturnValue(-1);
      const result = isSequentialVersion('1.10.0', '2.9.0');
      expect(result.isSequential).toBe(false);
      expect(result.incrementType).toBeNull();
      expect(result.message).toContain('lower');
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

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
  });

  test('should return false when base or head refs are missing', async () => {
    const { hasPackageDependencyChanges } = indexModule;
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.payload = { pull_request: {} }; // No base ref

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
      if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(samePackageJson)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    });

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
      if (path === 'package.json' && ref === TEST_BASE_SHA) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(basePackageJson)).toString('base64') }
        });
      }
      if (path === 'package.json' && ref === TEST_HEAD_SHA) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(headPackageJson)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    });

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should return true when API calls fail (conservative handling)', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Simulate API failures (rate limit, permissions, etc.)
    // Non-404 errors should conservatively assume changes exist
    mockGithub.context.eventName = 'pull_request';
    mockGithub.context.sha = TEST_HEAD_SHA;
    mockGithub.context.payload = {
      pull_request: {
        base: { sha: TEST_BASE_SHA }
      }
    };

    mockOctokit.rest.repos.getContent.mockRejectedValue(
      Object.assign(new Error('API rate limit exceeded'), { status: 403 })
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
  });

  test('should pass SHA refs to repos.getContent API', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    const mockPackageJson = { name: 'test', version: '1.0.0' };
    mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
      if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(JSON.stringify(mockPackageJson)).toString('base64') }
        });
      }
      return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    });

    await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
    // Verify that the repos.getContent API is called with the correct refs
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package.json', ref: TEST_BASE_SHA })
    );
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package.json', ref: TEST_HEAD_SHA })
    );
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(packageJson, packageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(basePackageJson, headPackageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');

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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(packageJson, packageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(packageJson, packageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(packageJson, packageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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

    mockOctokit.rest.repos.getContent.mockImplementation(
      createGetContentMock(packageJson, packageJson, basePackageLock, headPackageLock)
    );

    const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
    // Should return false because only peer metadata changed, no actual dependency changes
    expect(result).toEqual({ hasChanges: false, onlyDevDependencies: false });
  });

  test('should return false when changedFiles array does not contain package files', async () => {
    const { hasPackageDependencyChanges } = indexModule;

    // Clear any previous mock calls
    jest.clearAllMocks();

    // Even though there may be actual package.json changes in git,
    // passing a changedFiles array without package files should skip the check
    const result = await hasPackageDependencyChanges(
      ['src/index.js', 'lib/utils.ts'],
      mockOctokit,
      'test-owner',
      'test-repo'
    );

    // API should NOT be called since no package files in the list
    expect(mockOctokit.rest.repos.getContent).not.toHaveBeenCalled();
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

    mockOctokit.rest.repos.getContent.mockImplementation(createGetContentMock(basePackageJson, headPackageJson));

    const result = await hasPackageDependencyChanges(
      ['src/index.js', 'package.json'],
      mockOctokit,
      'test-owner',
      'test-repo'
    );

    // Should detect changes since package.json is in the list
    expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false });
    // Should check package.json via API
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package.json', ref: TEST_BASE_SHA })
    );
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package.json', ref: TEST_HEAD_SHA })
    );
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

      const result = await getLatestVersionTag('v', mockOctokit);
      expect(result).toBe('v1.1.0');
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.repos.listTags, {
        owner: 'test-owner',
        repo: 'test-repo',
        per_page: 100
      });
    });

    test('should return null when no version tags exist', async () => {
      const { getLatestVersionTag } = indexModule;

      mockOctokit.paginate.mockResolvedValue([{ name: 'other-tag' }, { name: 'nothing-relevant' }]);

      const result = await getLatestVersionTag('v', mockOctokit);
      expect(result).toBeNull();
    });

    test('should handle API failure gracefully', async () => {
      const { getLatestVersionTag } = indexModule;

      mockOctokit.paginate.mockRejectedValue(new Error('API error'));

      await expect(getLatestVersionTag('v', mockOctokit)).rejects.toThrow('Failed to fetch repository tags: API error');
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

      const commits = await getCommitsWithMessages(mockOctokit);

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

      const commits = await getCommitsWithMessages(mockOctokit);
      expect(commits).toEqual([]);
    });

    test('should return empty array when API returns no commits', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockOctokit.paginate.mockResolvedValue([]);

      const commits = await getCommitsWithMessages(mockOctokit);
      expect(commits).toEqual([]);
    });

    test('should return empty array when PR number is missing', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA } }; // No number

      const commits = await getCommitsWithMessages(mockOctokit);
      expect(commits).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ Could not determine PR number');
    });

    test('should return empty array when API call fails', async () => {
      const { getCommitsWithMessages } = indexModule;

      mockOctokit.paginate.mockRejectedValue(new Error('API rate limit exceeded'));

      const commits = await getCommitsWithMessages(mockOctokit);
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

    test('should return empty array when commit is not found (404)', async () => {
      const { getFilesForCommit } = indexModule;

      mockOctokit.rest.repos.getCommit.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

      const files = await getFilesForCommit(
        'abc1234567890abcdef1234567890abcdef1234',
        mockOctokit,
        'test-owner',
        'test-repo'
      );
      expect(files).toEqual([]);
      expect(mockCore.warning).toHaveBeenCalledWith('⚠️ Could not fetch files for commit abc1234: Not found');
    });

    test('should throw on non-404 API errors', async () => {
      const { getFilesForCommit } = indexModule;

      mockOctokit.rest.repos.getCommit.mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), { status: 403 })
      );

      await expect(
        getFilesForCommit('abc1234567890abcdef1234567890abcdef1234', mockOctokit, 'test-owner', 'test-repo')
      ).rejects.toThrow('API rate limit exceeded');
    });
  });

  describe('applySkipKeywordFilter function', () => {
    beforeEach(() => {
      mockGithub.context.eventName = 'pull_request';
      mockGithub.context.sha = TEST_HEAD_SHA;
      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA }, number: 123 };
      mockGithub.context.repo = { owner: 'test-owner', repo: 'test-repo' };
    });

    test('should exclude files from commits with skip keyword', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/utils.js', 'lib/helper.ts'];

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
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual(['src/utils.js', 'lib/helper.ts']);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should return PR diff files when no commits match keyword', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/index.js', 'src/utils.js'];

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Fix bug' } }
      ]);

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toContain('src/index.js');
      expect(result.files).toContain('src/utils.js');
      expect(result.skippedCommits).toBe(0);
      expect(result.totalCommits).toBe(2);
      expect(mockOctokit.rest.repos.getCommit).not.toHaveBeenCalled();
    });

    test('should return empty files when all commits are skipped', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/index.js'];

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[skip version] Fix typo' } }
      ]);

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual([]);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(1);
    });

    test('should include file if changed in both skipped and non-skipped commits', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/index.js'];

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[skip version] Fix typo in index' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'Add feature to index' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/index.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toContain('src/index.js');
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should return PR diff files when no commits found via API', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/index.js'];

      mockOctokit.paginate.mockResolvedValue([]);

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual(['src/index.js']);
      expect(result.skippedCommits).toBe(0);
      expect(result.totalCommits).toBe(0);
    });

    test('should detect skip keyword in commit body (multi-line message)', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/feature.js'];

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: 'refactor: extract functions\n\n- Extract helpers\n\n[skip version]' }
        },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'feat: add new feature' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'def4567890abcdef1234567890abcdef123456') {
          return Promise.resolve({ data: { files: [{ filename: 'src/feature.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual(['src/feature.js']);
      expect(result.skippedCommits).toBe(1);
      expect(result.totalCommits).toBe(2);
    });

    test('should skip all commits when all have skip keyword', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['README.md', 'src/lint-fix.js'];

      mockOctokit.paginate.mockResolvedValue([
        {
          sha: 'abc1234567890abcdef1234567890abcdef1234',
          commit: { message: 'docs: update README\n\n[skip version]' }
        },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: 'chore: fix linting\n\n[skip version]' } }
      ]);

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual([]);
      expect(result.skippedCommits).toBe(2);
      expect(result.totalCommits).toBe(2);
    });

    test('should match skip keyword case-insensitively', async () => {
      const { applySkipKeywordFilter } = indexModule;
      const prDiffFiles = ['src/feature.js'];

      mockOctokit.paginate.mockResolvedValue([
        { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: '[SKIP VERSION] uppercase' } },
        { sha: 'def4567890abcdef1234567890abcdef123456', commit: { message: '[Skip Version] mixed case' } },
        { sha: 'ccc7890abcdef1234567890abcdef1234567890', commit: { message: 'feat: add feature' } }
      ]);

      mockOctokit.rest.repos.getCommit.mockImplementation(({ ref }) => {
        if (ref === 'ccc7890abcdef1234567890abcdef1234567890') {
          return Promise.resolve({ data: { files: [{ filename: 'src/feature.js' }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await applySkipKeywordFilter(
        prDiffFiles,
        '[skip version]',
        mockOctokit,
        'test-owner',
        'test-repo'
      );

      expect(result.files).toEqual(['src/feature.js']);
      expect(result.skippedCommits).toBe(2);
      expect(result.totalCommits).toBe(3);
    });
  });

  describe('getPRDiffFiles function', () => {
    beforeEach(() => {
      mockGithub.context.eventName = 'pull_request';
      mockGithub.context.sha = TEST_HEAD_SHA;
      mockGithub.context.payload.pull_request = { base: { sha: TEST_BASE_SHA }, number: 123 };
      mockGithub.context.repo = { owner: 'test-owner', repo: 'test-repo' };
    });

    test('should return array of files from PR diff', async () => {
      const { getPRDiffFiles } = indexModule;

      mockOctokit.paginate.mockResolvedValue([
        { filename: 'src/index.js' },
        { filename: 'src/utils.js' },
        { filename: 'package.json' }
      ]);

      const result = await getPRDiffFiles(mockOctokit, 'test-owner', 'test-repo', 123);

      expect(result).toEqual(['src/index.js', 'src/utils.js', 'package.json']);
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.pulls.listFiles, {
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        per_page: 100
      });
    });

    test('should propagate error when API call fails', async () => {
      const { getPRDiffFiles } = indexModule;

      mockOctokit.paginate.mockRejectedValue(new Error('Not found'));

      await expect(getPRDiffFiles(mockOctokit, 'test-owner', 'test-repo', 123)).rejects.toThrow('Not found');
    });

    test('should return empty array for PR with no files', async () => {
      const { getPRDiffFiles } = indexModule;

      mockOctokit.paginate.mockResolvedValue([]);

      const result = await getPRDiffFiles(mockOctokit, 'test-owner', 'test-repo', 123);

      expect(result).toEqual([]);
    });
  });

  describe('hasPackageDependencyChanges JSON parsing errors', () => {
    test('should handle JSON parsing error in package.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock getContent to return invalid JSON for base package.json
      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ invalid json }').toString('base64') }
          });
        }
        if (path === 'package.json' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
      expect(result).toEqual({ hasChanges: true, onlyDevDependencies: false }); // Should conservatively assume change on parse error
    });

    test('should handle JSON parsing error in package-lock.json gracefully', async () => {
      const { hasPackageDependencyChanges } = indexModule;

      // Mock getContent to return valid package.json but invalid package-lock.json
      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        if (path === 'package-lock.json' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ invalid lock json }').toString('base64') }
          });
        }
        if (path === 'package-lock.json' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: {
              type: 'file',
              content: Buffer.from('{ "name": "test", "version": "1.0.0", "dependencies": {} }').toString('base64')
            }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      const result = await hasPackageDependencyChanges(null, mockOctokit, 'test-owner', 'test-repo');
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'package.json' }, { filename: 'src/index.js' }] }
      });

      // Mock API for package.json diff comparison
      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: {
              type: 'file',
              content: Buffer.from('{ "name": "test", "dependencies": { "lodash": "^4.0.0" } }').toString('base64')
            }
          });
        }
        if (path === 'package.json' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: {
              type: 'file',
              content: Buffer.from('{ "name": "test", "dependencies": { "lodash": "^4.1.0" } }').toString('base64')
            }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'src/index.js' }, { filename: 'lib/utils.ts' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }, { filename: 'lib/utils.ts' }] }
      });

      // Mock API for package.json content
      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
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

      // Mock API responses for commits and tags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add new feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockSemver.compare.mockReturnValue(1); // Higher version

      await run();

      expect(mockCore.info).toHaveBeenCalledWith('✅ Version has been properly incremented from 1.0.0 to 1.1.0');
      expect(mockCore.info).toHaveBeenCalledWith('🎯 Semantic versioning check passed!');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-increment-type', 'minor');
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should fail on non-sequential version increment by default', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '4.2.0' }));

      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v4.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });
      mockSemver.compare.mockReturnValue(1);

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('version-increment-type', 'minor');
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Non-sequential minor bump: expected 4.1.0, got 4.2.0')
      );
      expect(mockCore.notice).toHaveBeenCalledWith(
        expect.stringContaining(`Use 'npm version minor' from version 4.0.0 to get 4.1.0`)
      );
      // version-changed should NOT be set to true when sequential check fails
      expect(mockCore.setOutput).not.toHaveBeenCalledWith('version-changed', 'true');
    });

    test('should skip sequential version check when skip-sequential-version-check is true', async () => {
      const { run } = indexModule;

      mockCore.getBooleanInput.mockImplementation(input => {
        if (input === 'skip-sequential-version-check') return true;
        return false;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '4.2.0' }));

      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v4.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });
      mockSemver.compare.mockReturnValue(1);

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-increment-type', 'minor');
      expect(mockCore.setFailed).not.toHaveBeenCalled();
      expect(mockCore.info).toHaveBeenCalledWith('🏁 Version check completed successfully');
    });

    test('should not warn on sequential version increment', async () => {
      const { run } = indexModule;

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ name: 'test', version: '4.0.1' }));

      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v4.0.0' }];
        }
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Fix bug' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });
      mockSemver.compare.mockReturnValue(1);

      await run();

      expect(mockCore.setOutput).toHaveBeenCalledWith('version-changed', 'true');
      expect(mockCore.setOutput).toHaveBeenCalledWith('version-increment-type', 'patch');
      expect(mockCore.warning).not.toHaveBeenCalled();
      expect(mockCore.setFailed).not.toHaveBeenCalled();
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(actionYml).toString('base64') }
          });
        }
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [
            { filename: 'package.json' },
            { filename: 'src/index.js' },
            { filename: 'lib/utils.ts' },
            { filename: 'action.yml' },
            { filename: 'src/file1.js' },
            { filename: 'src/file2.ts' }
          ];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Add feature' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'src/index.js' }] }
      });

      // Make action.yml retrieval fail with an unexpected error on both refs
      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'action.yml' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      const baseActionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;
      const headActionYml = `name: 'my-action'\nruns:\n  using: 'node24'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && ref === TEST_BASE_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(baseActionYml).toString('base64') }
          });
        }
        if (path === 'action.yml' && ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(headActionYml).toString('base64') }
          });
        }
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'action.yml' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Upgrade runtime' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'action.yml' }];
        }
        return [{ sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Update description' } }];
      });

      mockOctokit.rest.repos.getCommit.mockResolvedValue({
        data: { files: [{ filename: 'action.yml' }] }
      });

      const actionYml = `name: 'my-action'\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n`;

      mockOctokit.rest.repos.getContent.mockImplementation(({ path, ref }) => {
        if (path === 'action.yml' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from(actionYml).toString('base64') }
          });
        }
        if (path === 'package.json' && (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA)) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{ "name": "test", "version": "1.0.0" }').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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

    test('should fail early when no token is provided', async () => {
      const { run } = indexModule;

      mockCore.getInput.mockImplementation(input => {
        switch (input) {
          case 'package-path':
            return 'package.json';
          case 'token':
            return '';
          default:
            return '';
        }
      });

      // Clear GITHUB_TOKEN env var
      const originalToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      await run();

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        '❌ ERROR: GitHub token is required. Ensure the token input is configured or GITHUB_TOKEN is available.'
      );

      // Restore env
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      }
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

      // Mock paginate for listFiles (PR diff) and listTags
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'src/index.js' }];
        }
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        return [];
      });

      mockOctokit.rest.repos.getContent.mockImplementation(({ path: _path, ref }) => {
        if (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{}').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      });

      mockSemver.compare.mockReturnValue(1);

      await run();

      // Should NOT call paginate with listCommits when skip-version-keyword is empty
      expect(mockOctokit.paginate).not.toHaveBeenCalledWith(mockOctokit.rest.pulls.listCommits, expect.any(Object));
      // Should still call paginate for listFiles and tags
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.pulls.listFiles, expect.any(Object));
      expect(mockOctokit.paginate).toHaveBeenCalledWith(mockOctokit.rest.repos.listTags, expect.any(Object));
    });

    test('should use PR file list when all commits contain skip keyword', async () => {
      const { run } = indexModule;

      // Mock API responses where all commits have skip keyword
      mockOctokit.paginate.mockImplementation(async method => {
        if (method === mockOctokit.rest.pulls.listFiles) {
          return [{ filename: 'src/file1.js' }, { filename: 'src/file2.ts' }];
        }
        if (method === mockOctokit.rest.repos.listTags) {
          return [{ name: 'v1.0.0' }];
        }
        // listCommits
        return [
          { sha: 'abc1234567890abcdef1234567890abcdef1234', commit: { message: 'Fix [skip version]' } },
          { sha: 'def5678901234567890abcdef1234567890abcd', commit: { message: 'Update [skip version]' } }
        ];
      });

      // Mock API for file content (version check not reached in this flow)
      mockOctokit.rest.repos.getContent.mockImplementation(({ path: _path, ref }) => {
        if (ref === TEST_BASE_SHA || ref === TEST_HEAD_SHA) {
          return Promise.resolve({
            data: { type: 'file', content: Buffer.from('{}').toString('base64') }
          });
        }
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
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

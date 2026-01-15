// Jest setup file
import { jest } from '@jest/globals';

// Mock child_process
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
}));

// Mock fs
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
  },
}));

// Mock path
jest.mock('path', () => ({
  join: jest.fn(),
  resolve: jest.fn(),
  relative: jest.fn(),
}));

// Mock util
jest.mock('util', () => ({
  promisify: jest.fn(),
}));
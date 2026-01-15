"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Jest setup file
const globals_1 = require("@jest/globals");
// Mock child_process
globals_1.jest.mock('child_process', () => ({
    exec: globals_1.jest.fn(),
    execFile: globals_1.jest.fn(),
}));
// Mock fs
globals_1.jest.mock('fs', () => ({
    promises: {
        readFile: globals_1.jest.fn(),
        writeFile: globals_1.jest.fn(),
        readdir: globals_1.jest.fn(),
        stat: globals_1.jest.fn(),
    },
}));
// Mock path
globals_1.jest.mock('path', () => ({
    join: globals_1.jest.fn(),
    resolve: globals_1.jest.fn(),
    relative: globals_1.jest.fn(),
}));
// Mock util
globals_1.jest.mock('util', () => ({
    promisify: globals_1.jest.fn(),
}));
//# sourceMappingURL=setup.js.map
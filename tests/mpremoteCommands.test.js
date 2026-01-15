"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mpremoteCommands_1 = require("../src/commands/mpremoteCommands");
describe('mpremoteCommands.isVersionCompatible', () => {
    describe('版本兼容性检查', () => {
        it('应该接受版本 1.20.0 及以上', () => {
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.20.0')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.20.1')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.21.0')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('2.0.0')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('2.1.5')).toBe(true);
        });
        it('应该拒绝版本低于 1.20.0', () => {
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.19.9')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.19.0')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.10.0')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('0.9.0')).toBe(false);
        });
        it('应该处理不完整的版本号', () => {
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.20')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('2.0')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('2')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('')).toBe(false);
        });
        it('应该处理无效的版本字符串', () => {
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('invalid')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.invalid.0')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('a.b.c')).toBe(false);
        });
        it('应该正确处理边界情况', () => {
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.19.99')).toBe(false);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.20.0')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.20')).toBe(true);
            expect(mpremoteCommands_1.mpremoteCommands.isVersionCompatible('1.19')).toBe(false);
        });
    });
});
//# sourceMappingURL=mpremoteCommands.test.js.map
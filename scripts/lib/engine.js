const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'src', 'solvency-engine.js');

const src = fs.readFileSync(ENGINE_PATH, 'utf8');
const factory = new Function(
    src + '\nreturn { runSolvencyOnDailyPath, isLastDayOfMonth };'
);
const engine = factory();

const engineSha256 = crypto.createHash('sha256').update(src).digest('hex');

module.exports = {
    runSolvencyOnDailyPath: engine.runSolvencyOnDailyPath,
    isLastDayOfMonth: engine.isLastDayOfMonth,
    enginePath: path.relative(path.resolve(__dirname, '..', '..'), ENGINE_PATH).split(path.sep).join('/'),
    engineSha256,
    engineByteLength: Buffer.byteLength(src, 'utf8'),
};

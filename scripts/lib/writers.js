const fs = require('fs');
const path = require('path');

function escapeCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        return String(v);
    }
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function writeCsv(filePath, columns, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'w');
    let byteLength = 0;
    const writeChunk = (s) => {
        const buf = Buffer.from(s, 'utf8');
        fs.writeSync(fd, buf, 0, buf.length);
        byteLength += buf.length;
    };
    try {
        writeChunk(columns.join(',') + '\n');
        const lineParts = new Array(columns.length);
        const CHUNK_ROWS = 10000;
        let pending = [];
        for (const r of rows) {
            for (let i = 0; i < columns.length; i++) lineParts[i] = escapeCell(r[columns[i]]);
            pending.push(lineParts.join(','));
            if (pending.length >= CHUNK_ROWS) {
                writeChunk(pending.join('\n') + '\n');
                pending = [];
            }
        }
        if (pending.length > 0) writeChunk(pending.join('\n') + '\n');
    } finally {
        fs.closeSync(fd);
    }
    return { path: filePath, rowCount: rows.length, byteLength };
}

function writeJson(filePath, obj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const s = JSON.stringify(obj, null, 2);
    fs.writeFileSync(filePath, s + '\n', 'utf8');
    return { path: filePath, byteLength: Buffer.byteLength(s, 'utf8') + 1 };
}

function headOfCsv(filePath, n) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const collected = [];
    let leftover = '';
    let lineCount = 0;
    try {
        while (lineCount <= n) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            const chunk = leftover + buf.toString('utf8', 0, bytesRead);
            const parts = chunk.split('\n');
            leftover = parts.pop();
            for (const line of parts) {
                collected.push(line);
                lineCount++;
                if (lineCount > n) break;
            }
        }
        if (lineCount <= n && leftover.length > 0) collected.push(leftover);
    } finally {
        fs.closeSync(fd);
    }
    return collected.slice(0, n + 1).join('\n');
}

module.exports = { writeCsv, writeJson, headOfCsv };
